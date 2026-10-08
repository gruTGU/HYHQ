'use strict';
const { ApiError, response, uuid } = require('./core');
const providers = require('./providers');
const DAY = 86400000;
const TTL = Object.freeze({ weather: 3600000, air: 3600000, alerts: 3600000, daily: 6 * 3600000 });
const CURRENT_KINDS = Object.freeze(['weather', 'air', 'alerts']);
const LOCATIONS = Object.freeze([
  { slug: 'tianjin', name: '天津市', kind: 'city', latitude: 39.09, longitude: 117.20 },
  { slug: 'beijing', name: '北京市', kind: 'city', latitude: 39.90, longitude: 116.41 },
  { slug: 'shanghai', name: '上海市', kind: 'city', latitude: 31.23, longitude: 121.47 },
  { slug: 'guangzhou', name: '广州市', kind: 'city', latitude: 23.13, longitude: 113.26 },
  { slug: 'shenzhen', name: '深圳市', kind: 'city', latitude: 22.54, longitude: 114.06 },
  { slug: 'hangzhou', name: '杭州市', kind: 'city', latitude: 30.27, longitude: 120.16 },
  { slug: 'chengdu', name: '成都市', kind: 'city', latitude: 30.57, longitude: 104.07 },
  { slug: 'chongqing', name: '重庆市', kind: 'city', latitude: 29.56, longitude: 106.55 },
  { slug: 'wuhan', name: '武汉市', kind: 'city', latitude: 30.59, longitude: 114.30 },
  { slug: 'nanjing', name: '南京市', kind: 'city', latitude: 32.06, longitude: 118.80 },
  { slug: 'tiangong', name: '天津工业大学', kind: 'campus', latitude: 39.06, longitude: 117.11 },
  { slug: 'tianjin-normal', name: '天津师范大学', kind: 'campus', latitude: 39.06, longitude: 117.12 },
  { slug: 'tianjin-technology', name: '天津理工大学', kind: 'campus', latitude: 39.06, longitude: 117.13 },
].map((x) => Object.freeze({ ...x, coordinate_system: 'WGS84', scope_note: x.kind === 'city' ? '城市代表点附近区域天气，不是你当前位置的实测天气。' : '校园所在区域的天气网格查询，不是校园内实测或导航坐标。' })));
const PUBLIC_LOCATIONS = Object.freeze(LOCATIONS.filter(x => ['tianjin', 'beijing'].includes(x.slug)));
function supportedLocationFor(slug) { return PUBLIC_LOCATIONS.find(x => x.slug === slug); }
function timestamp(ctx) { const n = Date.parse(ctx.now); return Number.isFinite(n) ? n : Date.now(); }
function dayOf(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function dailyToday(payload, now) {
  const days = payload && payload.data && payload.data.days;
  if (!Array.isArray(days)) return null;
  const matches = days.filter(row => row && Number.isFinite(Date.parse(row.starts_at)) && Number.isFinite(Date.parse(row.ends_at))
    && dayOf(Date.parse(row.starts_at)) === dayOf(now) && Date.parse(row.starts_at) <= now && now < Date.parse(row.ends_at));
  return matches.length === 1 ? matches[0] : null;
}
function expiryFor(kind, payload, fetched) {
  let expires = fetched + TTL[kind];
  if (kind === 'alerts') {
    // An active warning ending sooner must not be held as active for an hour.
    const items = payload && payload.data && payload.data.items;
    for (const item of Array.isArray(items) ? items : []) {
      const end = Date.parse(item && item.expires_at);
      if (Number.isFinite(end) && end > fetched) expires = Math.min(expires, end);
    }
  }
  if (kind === 'daily') {
    expires = Math.min(expires, Date.parse(dayOf(fetched) + 'T00:00:00+08:00') + DAY);
    const today = dailyToday(payload, fetched);
    if (today) expires = Math.min(expires, Date.parse(today.ends_at));
    else for (const row of Array.isArray(payload && payload.data && payload.data.days) ? payload.data.days : []) {
      const start = Date.parse(row && row.starts_at);
      if (Number.isFinite(start) && start > fetched) expires = Math.min(expires, start);
    }
  }
  return expires;
}
function cacheDeadline(cache) {
  const fetched = Date.parse(cache && cache.fetched_at), stored = Date.parse(cache && cache.expires_at);
  if (!cache || !Object.hasOwn(TTL, cache.kind) || !Number.isFinite(fetched) || !Number.isFinite(stored) || stored <= fetched) return NaN;
  return Math.min(stored, expiryFor(cache.kind, cache.payload, fetched));
}
function freshCache(cache, now) { return !!(cache && (cache.kind !== 'daily' || cache.payload && cache.payload.data && cache.payload.data.schema_version === 2) && cache.payload && Date.parse(cache.fetched_at) <= now && cacheDeadline(cache) > now); }
function configured(config = {}) { return config.qweatherEnabled === true && config.qweatherBudgetConfirmed === true && typeof config.qweatherApiKey === 'string' && !!config.qweatherApiKey && providers.WEATHER_HOST.test(config.qweatherApiHost || '') && Number.isInteger(config.qweatherMonthlyLimit) && config.qweatherMonthlyLimit > 0 && config.qweatherMonthlyLimit <= 30000; }
function locationFor(slug) { return LOCATIONS.find((x) => x.slug === slug); }
function publicCache(cache, reason = '', now = Date.now()) {
  const value = cache && cache.payload && typeof cache.payload === 'object' ? cache.payload : null;
  const deadline = cacheDeadline(cache), stale = !!(value && !freshCache(cache, now));
  let status = value ? (stale ? 'stale' : 'fresh') : 'unavailable';
  let data = value && value.data, omitted = false;
  if (value && cache.kind === 'alerts' && data && Array.isArray(data.items)) {
    const items = data.items.filter(item => Number.isFinite(Date.parse(item && item.expires_at)) && Date.parse(item.expires_at) > now);
    omitted = items.length !== data.items.length;
    data = { ...data, items };
    if (!stale && data.zero_result === true && !data.items.length) status = 'empty';
    else if (!items.length && data.zero_result !== true) { status = stale ? 'stale' : 'unavailable'; reason = reason || 'no_valid_alerts'; }
  }
  if (value && cache.kind === 'daily' && data) data = { ...data, today: stale ? null : dailyToday(value, now) };
  return { ...(value || { data: null, attributions: [], refer: { sources: ['QWeather'] }, observed_at: null }), ...(value ? { data } : {}), status, stale,
    ...(omitted ? { expired_or_invalid_alerts_omitted: true } : {}),
    reason: reason || (cache && cache.last_reason) || '', fetched_at: cache && cache.fetched_at || null, expires_at: Number.isFinite(deadline) ? new Date(deadline).toISOString() : cache && cache.expires_at || null, source_label: '和风天气', source_kind: 'api' };
}
async function component(ctx, location, kind, fetcher = providers.fetchWeather, { forceRefresh = false } = {}) {
  if (!Object.hasOwn(TTL, kind)) throw new ApiError('WEATHER_KIND_INVALID', '天气接口不在允许范围。');
  const now = timestamp(ctx), id = `${location.slug}_${kind}`;
  const reserved = await ctx.store.transaction(async (tx) => {
    const cache = await tx.get('weather_cache', id) || { id, kind, location: location.slug, payload: null };
    if (!forceRefresh && freshCache(cache, now)) return { cache };
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
  if (!reserved.requestId) return { ...publicCache(reserved.cache, reserved.reason, now), refresh_attempted: false };
  let payload = null, error = null;
  try { payload = await fetcher(ctx.config, kind, location); } catch (failure) { error = failure instanceof providers.ProviderError ? failure : new providers.ProviderError('upstream_unavailable'); }
  // Function invocation time is the stable admission clock; no external retry.
  const cache = await ctx.store.transaction(async (tx) => {
    const current = await tx.get('weather_cache', id);
    await tx.update('weather_requests', reserved.requestId, { completed_at: new Date(now).toISOString(), outcome: error ? error.code : 'succeeded', http_status: error && error.status || (error ? null : 200) });
    if (!current || current.lease_token !== reserved.requestId) return current;
    current.lease_token = null; current.lease_until = null;
    if (error) {
      // A forecast entitlement denial is product-specific. It must not switch
      // off already-authorized current weather; credential/balance/rate errors
      // still stop all subsequent paid requests through the global gate.
      const dailyDenied = kind === 'daily' && error.status === 403;
      Object.assign(current, { last_reason: dailyDenied ? 'daily_access_denied' : error.code, retry_at: new Date(now + (dailyDenied ? DAY : 600000)).toISOString() });
      if ([401, 402, 403, 429].includes(error.status) && !dailyDenied) {
        const gate = await tx.get('weather_gate', 'budget');
        Object.assign(gate, { blocked_until: new Date(now + (error.status === 429 ? 3600000 : DAY)).toISOString(), block_reason: error.status === 429 ? 'upstream_rate_limited' : 'upstream_access_denied' });
        await tx.set('weather_gate', 'budget', gate);
      }
    } else Object.assign(current, { payload, fetched_at: new Date(now).toISOString(), expires_at: new Date(expiryFor(kind, payload, now)).toISOString(), retry_at: null, last_reason: '' });
    await tx.set('weather_cache', id, current);
    return current;
  });
  return { ...publicCache(cache, '', now), refresh_attempted: true };
}
function safeContextComponent(cache, now) {
  if (!cache) return { status: 'unavailable', data: null, reason: 'not_cached', source_label: '和风天气', fetched_at: null, expires_at: null };
  const out = publicCache(cache, '', now), unavailable = (reason, stale = false) => ({ ...out, data: null, status: stale ? 'stale' : 'unavailable', stale, reason });
  if (!out.data) return out;
  if (out.status === 'unavailable') return { ...out, data: null };
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
  // Forecast has its own page and appointment flow. RAG remains a
  // cache-only read of these three current products and never triggers refresh.
  out.components = Object.fromEntries(await Promise.all(CURRENT_KINDS.map(async kind => [kind, safeContextComponent(await ctx.store.get('weather_cache', `${slug}_${kind}`), timestamp(ctx))])));
  out.components.forecast = { status: 'unavailable', data: null, reason: 'forecast_not_in_context', source_label: '和风天气', fetched_at: null, expires_at: null };
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
async function readCached(ctx, location, kind) {
  const cache = await ctx.store.get('weather_cache', `${location.slug}_${kind}`);
  const reason = cache && cache.last_reason || (cache && cache.payload ? '' : 'not_cached');
  return publicCache(cache, reason, timestamp(ctx));
}
async function handle(ctx, adapters = ctx.providers || {}) {
  ctx = { ...ctx, path: '/' + String(ctx.path || '').replace(/^\/+/, '') };
  if (!ctx.path.startsWith('/weather-data/')) return undefined;
  const query = ctx.query || new URLSearchParams();
  if (ctx.method === 'GET' && ctx.path === '/weather-data/locations/') {
    if (query.size) throw new ApiError('VALIDATION_ERROR', '地点列表不接受额外参数。');
    return response({ items: PUBLIC_LOCATIONS.map((x) => ({ ...x })), enabled: configured(ctx.config), forecast_enabled: configured(ctx.config) });
  }
  if (ctx.method === 'GET' && ctx.path === '/weather-data/summary/') {
    if ([...query.keys()].join(',') !== 'location' || Object.keys(ctx.body || {}).length) throw new ApiError('VALIDATION_ERROR', '仅允许提供一个管理员已配置的 location。');
    const location = locationFor(query.get('location')); if (!location) throw new ApiError('NOT_FOUND', '天气查询地点不存在。', 404);
    const value = { location, source_label: '和风天气', source_kind: 'api' };
    // Browser traffic is strictly read-only, including misses and stale data.
    // Only the private background worker can reach component()/the provider.
    const pairs = await Promise.all(Object.keys(TTL).map(async kind => [kind, await readCached(ctx, location, kind)]));
    Object.assign(value, Object.fromEntries(pairs), { cache_only: true, refresh_policy: 'background' });
    return response(value);
  }
  const forecast = ctx.path.match(/^\/weather-data\/([a-z0-9-]+)\/forecast\/$/);
  if (ctx.method === 'GET' && forecast) {
    if (query.size) throw new ApiError('VALIDATION_ERROR', '预报不接受额外参数。');
    const location = locationFor(forecast[1]); if (!location) throw new ApiError('NOT_FOUND', '天气查询地点不存在。', 404);
    const value = await readCached(ctx, location, 'daily');
    return response({ location, enabled: configured(ctx.config), forecast: value, cache_only: true, refresh_policy: 'background' });
  }
  if (ctx.path.startsWith('/weather-data/reminders/')) return require('./weather-reminders').handle({ ...ctx, providers: adapters });
  return undefined;
}
module.exports = { readCached, PUBLIC_LOCATIONS, supportedLocationFor, handle, readContext, safeContextComponent, configured, component, publicCache, LOCATIONS, locationFor, dayOf };
