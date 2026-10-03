'use strict';
const { ApiError, response, requireUser, uuid } = require('./core');
const providers = require('./providers');
const DAY = 86400000;
const TTL = Object.freeze({ weather: 1800000, air: 3600000, alerts: 900000 });
const LOCATIONS = Object.freeze([
  { slug: 'tianjin', name: '天津市', latitude: 39.09, longitude: 117.20 },
  { slug: 'tiangong', name: '天津工业大学', latitude: 39.06, longitude: 117.11 },
  { slug: 'tianjin-normal', name: '天津师范大学', latitude: 39.06, longitude: 117.12 },
  { slug: 'tianjin-technology', name: '天津理工大学', latitude: 39.06, longitude: 117.13 },
  { slug: 'beijing', name: '北京市', latitude: 39.90, longitude: 116.41 },
].map((x) => Object.freeze({ ...x, coordinate_system: 'WGS84', scope_note: x.slug === 'beijing' || x.slug === 'tianjin' ? '城市代表点附近区域天气，非具体地点实时实测。' : '校园所在区域的天气网格查询，不是校园内实测或导航坐标。' })));
function timestamp(ctx) { const n = Date.parse(ctx.now); return Number.isFinite(n) ? n : Date.now(); }
function dayOf(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function configured(config = {}) { return config.qweatherEnabled === true && config.qweatherBudgetConfirmed === true && typeof config.qweatherApiKey === 'string' && !!config.qweatherApiKey && providers.WEATHER_HOST.test(config.qweatherApiHost || '') && Number.isInteger(config.qweatherMonthlyLimit) && config.qweatherMonthlyLimit > 0 && config.qweatherMonthlyLimit <= 30000; }
function locationFor(slug) { return LOCATIONS.find((x) => x.slug === slug); }
function publicCache(cache, reason = '', now = Date.now()) {
  const value = cache && cache.payload && typeof cache.payload === 'object' ? cache.payload : null;
  const stale = !!(value && (!cache.expires_at || Date.parse(cache.expires_at) <= now));
  let status = value ? (stale ? 'stale' : 'fresh') : 'unavailable';
  if (value && !stale && cache.kind === 'alerts' && value.data && value.data.zero_result === true) status = 'empty';
  return { ...(value || { data: null, attributions: [], refer: { sources: ['QWeather'] }, observed_at: null }), status, stale,
    reason: reason || (cache && cache.last_reason) || '', fetched_at: cache && cache.fetched_at || null, expires_at: cache && cache.expires_at || null, source_label: '和风天气', source_kind: 'api' };
}
async function component(ctx, location, kind, fetcher = providers.fetchWeather) {
  if (!Object.hasOwn(TTL, kind)) throw new ApiError('WEATHER_KIND_INVALID', '天气接口不在允许范围。');
  const now = timestamp(ctx), id = `${location.slug}_${kind}`;
  const reserved = await ctx.store.transaction(async (tx) => {
    const cache = await tx.get('weather_cache', id) || { id, kind, location: location.slug, payload: null };
    if (cache.payload && Date.parse(cache.expires_at) > now) return { cache };
    if (!configured(ctx.config)) return { cache, reason: 'not_configured' };
    const gate = await tx.get('weather_gate', 'budget') || { id: 'budget', days: {}, recent: [] };
    if (Date.parse(cache.lease_until) > now) return { cache, reason: 'refreshing' };
    if (Date.parse(cache.retry_at) > now) return { cache, reason: cache.last_reason || 'cooldown' };
    if (Date.parse(gate.blocked_until) > now) return { cache, reason: gate.block_reason || 'upstream_cooldown' };
    const day = dayOf(now), oldest = dayOf(now - 31 * DAY), month = day.slice(0, 7);
    gate.days = Object.fromEntries(Object.entries(gate.days || {}).filter(([key]) => key >= oldest));
    const total = Object.values(gate.days).reduce((sum, value) => sum + value, 0);
    const monthly = Object.entries(gate.days).filter(([key]) => key.startsWith(month)).reduce((sum, [, value]) => sum + value, 0);
    if (monthly >= ctx.config.qweatherMonthlyLimit || total >= ctx.config.qweatherMonthlyLimit) return { cache, reason: 'budget_exhausted' };
    gate.recent = (gate.recent || []).filter((x) => x > now - 60000);
    if (gate.recent.length >= 15) return { cache, reason: 'rate_limited' };
    gate.days[day] = (gate.days[day] || 0) + 1; gate.recent.push(now);
    const requestId = uuid();
    Object.assign(cache, { lease_token: requestId, lease_until: new Date(now + 60000).toISOString(), last_reason: 'refreshing' });
    await tx.set('weather_gate', 'budget', gate);
    await tx.set('weather_cache', id, cache);
    await tx.set('weather_requests', requestId, { id: requestId, kind, location: location.slug, reserved_at: new Date(now).toISOString(), outcome: 'reserved', completed_at: null });
    return { cache, requestId };
  });
  if (!reserved.requestId) return publicCache(reserved.cache, reserved.reason, now);
  let payload = null, error = null;
  try { payload = await fetcher(ctx.config, kind, location); } catch (failure) { error = failure instanceof providers.ProviderError ? failure : new providers.ProviderError('upstream_unavailable'); }
  // Function invocation time is the stable admission clock; no external retry.
  const cache = await ctx.store.transaction(async (tx) => {
    const current = await tx.get('weather_cache', id);
    await tx.update('weather_requests', reserved.requestId, { completed_at: new Date(now).toISOString(), outcome: error ? error.code : 'succeeded', http_status: error && error.status || (error ? null : 200) });
    if (!current || current.lease_token !== reserved.requestId) return current;
    current.lease_token = null; current.lease_until = null;
    if (error) {
      Object.assign(current, { last_reason: error.code, retry_at: new Date(now + 600000).toISOString() });
      if ([401, 402, 403, 429].includes(error.status)) {
        const gate = await tx.get('weather_gate', 'budget');
        Object.assign(gate, { blocked_until: new Date(now + (error.status === 429 ? 3600000 : DAY)).toISOString(), block_reason: error.status === 429 ? 'upstream_rate_limited' : 'upstream_access_denied' });
        await tx.set('weather_gate', 'budget', gate);
      }
    } else Object.assign(current, { payload, fetched_at: new Date(now).toISOString(), expires_at: new Date(now + TTL[kind]).toISOString(), retry_at: null, last_reason: '' });
    await tx.set('weather_cache', id, current);
    return current;
  });
  return publicCache(cache, '', now);
}
function safeContextComponent(cache, now) {
  if (!cache) return { status: 'unavailable', data: null, reason: 'not_cached', source_label: '和风天气', fetched_at: null, expires_at: null };
  const out = publicCache(cache, '', now), unavailable = (reason, stale = false) => ({ ...out, data: null, status: stale ? 'stale' : 'unavailable', stale, reason });
  if (!out.data) return out;
  if (typeof out.data !== 'object' || Array.isArray(out.data) || (cache.kind === 'alerts' && typeof out.data.zero_result !== 'boolean')) return unavailable('invalid_cached_payload');
  const fetched = Date.parse(out.fetched_at), expires = Date.parse(out.expires_at);
  if (!Number.isFinite(fetched) || !Number.isFinite(expires) || fetched > now || expires <= fetched) return unavailable('invalid_cache_time');
  if (expires <= now) return unavailable('cache_expired', true);
  if (['weather', 'air'].includes(cache.kind)) {
    if (fetched <= now - 3 * 3600000) return unavailable('cache_too_old', true);
    if (out.observed_at !== null && out.observed_at !== undefined) {
      const observed = Date.parse(out.observed_at);
      if (!Number.isFinite(observed) || observed > now + 600000) return unavailable('invalid_observation_time');
      if (observed <= now - 3 * 3600000) return unavailable('observation_too_old', true);
    }
  }
  return out;
}
async function readContext(ctx, slug) {
  const out = { source_label: '和风天气', source_kind: 'api', cache_only: true, location: null, components: {}, status: 'unavailable', reason: 'weather_location_required',
    notice: '只读缓存；不得当作校园内实测或示范河湖天气，过期数据不能当作当前事实。没有预警缓存不代表没有预警；不是联网搜索或天气工具。' };
  if (!slug) return out;
  const location = locationFor(slug); if (!location) return { ...out, reason: 'location_unavailable' };
  out.location = { slug: location.slug, name: location.name, scope_note: location.scope_note };
  for (const kind of Object.keys(TTL)) out.components[kind] = safeContextComponent(await ctx.store.get('weather_cache', `${slug}_${kind}`), timestamp(ctx));
  out.components.forecast = { status: 'unavailable', data: null, reason: 'forecast_disabled', source_label: '和风天气', fetched_at: null, expires_at: null };
  while (Buffer.byteLength(JSON.stringify(out)) > 3500) {
    const candidates = Object.entries(out.components).filter(([, value]) => value.reason !== 'context_budget_exceeded').sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
    if (!candidates.length) break;
    const [kind, previous] = candidates[0];
    // Omit the whole provider component rather than clipping mandatory attribution.
    out.components[kind] = { status: 'unavailable', data: null, reason: 'context_budget_exceeded', fetched_at: previous.fetched_at, expires_at: previous.expires_at, observed_at: previous.observed_at || null, source_label: '和风天气' };
    out.material_omitted = true;
  }
  out.status = Object.values(out.components).some((x) => ['fresh', 'empty'].includes(x.status)) ? 'available' : 'unavailable';
  out.reason = out.status === 'available' ? '' : 'no_fresh_cache'; return out;
}
async function handle(ctx, adapters = ctx.providers || {}) {
  const originalPath = ctx.path;
  ctx = { ...ctx, path: '/' + String(ctx.path || '').replace(/^\/+/, '') };
  if (!ctx.path.startsWith('/weather-data/')) return undefined;
  const query = ctx.query || new URLSearchParams();
  if (ctx.method === 'GET' && ctx.path === '/weather-data/locations/') {
    if (query.size) throw new ApiError('VALIDATION_ERROR', '地点列表不接受额外参数。');
    return response({ items: LOCATIONS.map((x) => ({ ...x })), enabled: configured(ctx.config), forecast_enabled: false });
  }
  if (ctx.method === 'GET' && ctx.path === '/weather-data/summary/') {
    if ([...query.keys()].join(',') !== 'location') throw new ApiError('VALIDATION_ERROR', '仅允许提供一个管理员已配置的 location。');
    const location = locationFor(query.get('location')); if (!location) throw new ApiError('NOT_FOUND', '天气查询地点不存在。', 404);
    const value = { location, source_label: '和风天气', source_kind: 'api' };
    for (const kind of Object.keys(TTL)) value[kind] = await component(ctx, location, kind, adapters.fetchWeather);
    return response(value);
  }
  const forecast = ctx.path.match(/^\/weather-data\/([a-z0-9-]+)\/forecast\/$/);
  if (ctx.method === 'GET' && forecast) {
    if (query.size) throw new ApiError('VALIDATION_ERROR', '预报不接受额外参数。');
    const location = locationFor(forecast[1]); if (!location) throw new ApiError('NOT_FOUND', '天气查询地点不存在。', 404);
    return response({ location, enabled: false, forecast: publicCache(null, 'forecast_disabled', timestamp(ctx)) });
  }
  if (ctx.method === 'GET' && ctx.path === '/weather-data/reminders/') {
    if (query.size) throw new ApiError('VALIDATION_ERROR', '提醒状态不接受额外参数。');
    return response({ enabled: false, reason: 'native_subscription_not_implemented', template_id: '', mode: 'once', notice: '天气提醒暂未开放。', items: [], wechat_login: !!ctx.user });
  }
  if (ctx.method === 'POST' && /^\/weather-data\/reminders\//.test(ctx.path)) {
    requireUser(ctx); throw new ApiError('SUBSCRIPTIONS_DISABLED', '个人版天气订阅发送尚未开放。', 503);
  }
  return undefined;
}
module.exports = { handle, readContext, safeContextComponent, configured, component, publicCache, LOCATIONS, locationFor, dayOf };
