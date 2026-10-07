'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const weather = require('../../cloudfunctions/hyhqApi/lib/weather');
const provider = require('../../cloudfunctions/hyhqApi/lib/providers');
const NOW = '2026-10-03T04:00:00.000Z';
function context(options = {}) { return { method: 'GET', path: 'weather-data/summary/', query: new URLSearchParams('location=tianjin'), body: {}, now: NOW, store: new MemoryStore(), config: { qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'fake-test-only-key', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 30 }, ...options }; }
function payload(kind) { return { data: kind === 'alerts' ? { items: [], zero_result: true } : kind === 'daily' ? { days: [{ date: '2026-10-03', starts_at: '2026-10-02T16:00:00.000Z', ends_at: '2026-10-03T16:00:00.000Z', temperature_min: 15, temperature_max: 25, temperature_unit: '°C' }], timezone: 'Asia/Shanghai', schema_version: 2 } : { temperature: 22, condition: '晴' }, attributions: ['Official fixture attribution'], refer: { sources: ['QWeather'] }, observed_at: null }; }
function cached(kind, extra = {}) { return { id: `tianjin_${kind}`, kind, location: 'tianjin', payload: payload(kind), fetched_at: '2026-10-03T03:55:00.000Z', expires_at: '2026-10-03T04:15:00.000Z', ...extra }; }
test('fixed ten cities and three compatible campus locations expose configured forecast', async () => {
  const ctx = context({ path: 'weather-data/locations/', query: new URLSearchParams() }), result = (await weather.handle(ctx)).data.data;
  assert.equal(result.items.length, 13); assert.equal(new Set(result.items.map(x => x.slug)).size, 13);
  assert.deepEqual(result.items.filter(x => x.kind === 'city').map(x => x.slug).sort(), ['beijing', 'chengdu', 'chongqing', 'guangzhou', 'hangzhou', 'nanjing', 'shanghai', 'shenzhen', 'tianjin', 'wuhan']);
  assert.deepEqual(result.items.filter(x => x.kind === 'campus').map(x => x.slug), ['tiangong', 'tianjin-normal', 'tianjin-technology']);
  assert.equal(result.forecast_enabled, true); assert.ok(result.items.every(x => x.coordinate_system === 'WGS84'));
  assert.match(result.items.find(x => x.slug === 'tiangong').scope_note, /不是校园内实测/);
  assert.match(result.items.find(x => x.slug === 'beijing').scope_note, /城市代表点/);
});
test('zero budget or missing confirmation never calls upstream', async () => { for (const config of [{ qweatherMonthlyLimit: 0 }, { qweatherBudgetConfirmed: false }, { qweatherApiHost: 'attacker.example' }, { qweatherEnabled: false }]) { const ctx = context(); Object.assign(ctx.config, config); const result = await weather.handle(ctx, { fetchWeather: () => assert.fail('network must remain disabled') }); assert.equal(result.data.data.weather.status, 'unavailable'); assert.equal(await ctx.store.count('weather_requests'), 0); } });
test('unknown location, duplicate query, and arbitrary query are rejected', async () => { for (const query of ['location=other', 'location=tianjin&location=beijing', 'location=tianjin&host=bad']) await assert.rejects(weather.handle(context({ query: new URLSearchParams(query) }))); });
test('weather summary reserves four independent products and reuses caches', async () => { const ctx = context(); let calls = 0; const adapters = { fetchWeather: async (_, kind) => { calls++; return payload(kind); } }; const result = (await weather.handle(ctx, adapters)).data.data; assert.equal(result.weather.status, 'fresh'); assert.equal(result.alerts.status, 'empty'); assert.equal(result.daily.data.today.temperature_min, 15); await weather.handle(ctx, adapters); assert.equal(calls, 4); assert.equal(await ctx.store.count('weather_requests'), 4); });
test('concurrent cache misses issue only one upstream call per component', async () => { const ctx = context(); let calls = 0; const fetcher = async (_, kind) => { calls++; await new Promise((r) => setTimeout(r, 10)); return payload(kind); }; const replies = await Promise.all(Array.from({ length: 10 }, () => weather.component(ctx, weather.LOCATIONS[0], 'weather', fetcher))); assert.equal(calls, 1); assert.equal(await ctx.store.count('weather_requests'), 1); assert.ok(replies.some((x) => x.reason === 'refreshing')); });
test('concurrent different locations cannot overrun project allocation', async () => { const ctx = context(); ctx.config.qweatherMonthlyLimit = 2; let calls = 0; await Promise.all(weather.LOCATIONS.map((location) => weather.component(ctx, location, 'weather', async (_, kind) => { calls++; return payload(kind); }))); assert.equal(calls, 2); assert.equal(await ctx.store.count('weather_requests'), 2); });
test('rolling 31 days remains binding after calendar month changes', async () => { const ctx = context(); ctx.config.qweatherMonthlyLimit = 3; await ctx.store.set('weather_gate', 'budget', { id: 'budget', days: { '2026-09-30': 3 }, recent: [] }); const reply = await weather.component(ctx, weather.LOCATIONS[0], 'weather', () => assert.fail()); assert.equal(reply.reason, 'budget_exhausted'); });
test('failures retain reservations and impose cooldown', async () => { const ctx = context(); const fetcher = async () => { throw new provider.ProviderError('timeout'); }; assert.equal((await weather.component(ctx, weather.LOCATIONS[0], 'weather', fetcher)).reason, 'timeout'); await weather.component(ctx, weather.LOCATIONS[0], 'weather', () => assert.fail()); assert.equal(await ctx.store.count('weather_requests'), 1); assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 1); });
test('provider quota/auth failures block subsequent components without extra spend', async () => { const ctx = context(); let calls = 0; const result = await weather.handle(ctx, { fetchWeather: async () => { calls++; throw new provider.ProviderError('upstream_http', { status: 429 }); } }); assert.equal(calls, 1); assert.equal(result.data.data.air.reason, 'upstream_rate_limited'); });
test('minute burst limit caps upstream requests', async () => { const ctx = context(); await ctx.store.set('weather_gate', 'budget', { id: 'budget', days: {}, recent: Array(15).fill(Date.parse(NOW) - 1000) }); const out = await weather.component(ctx, weather.LOCATIONS[0], 'air', () => assert.fail()); assert.equal(out.reason, 'rate_limited'); });
test('cache context performs reads only and withholds expired facts', async () => { const ctx = context(); await ctx.store.set('weather_cache', 'tianjin_weather', cached('weather', { expires_at: '2026-10-03T03:59:00.000Z' })); const before = JSON.stringify([...ctx.store.data]); const out = await weather.readContext(ctx, 'tianjin'); assert.equal(out.components.weather.status, 'stale'); assert.equal(out.components.weather.data, null); assert.equal(out.cache_only, true); assert.equal(JSON.stringify([...ctx.store.data]), before); });
test('future and old observation times cannot become current weather', () => { for (const value of ['2026-10-04T00:00:00Z', '2026-10-02T00:00:00Z', 'invalid']) { const cache = cached('weather'); cache.payload.observed_at = value; assert.equal(weather.safeContextComponent(cache, Date.parse(NOW)).data, null); } });
test('context keeps full attribution or omits whole oversized component', async () => { const ctx = context(), cache = cached('weather'); cache.payload.attributions = ['x'.repeat(5000)]; await ctx.store.set('weather_cache', 'tianjin_weather', cache); const out = await weather.readContext(ctx, 'tianjin'); assert.equal(out.components.weather.reason, 'context_budget_exceeded'); assert.equal(out.components.weather.data, null); assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 3500); });
test('unselected or unknown location never guesses current city', async () => { const ctx = context(); assert.equal((await weather.readContext(ctx, '')).reason, 'weather_location_required'); assert.equal((await weather.readContext(ctx, 'unknown')).reason, 'location_unavailable'); });
test('forecast uses daily product while unconfigured subscription endpoints stay closed', async () => {
  const ctx = context({ path: 'weather-data/beijing/forecast/', query: new URLSearchParams() });
  const out = (await weather.handle(ctx, { fetchWeather: async (_, kind) => payload(kind) })).data.data;
  assert.equal(out.enabled, true); assert.equal(out.forecast.status, 'fresh');
  ctx.path = 'weather-data/reminders/'; assert.equal((await weather.handle(ctx)).data.data.reason, 'subscriptions_not_configured');
  ctx.path = 'weather-data/reminders/intents/'; ctx.method = 'POST'; ctx.user = { id: 'user' };
  await assert.rejects(weather.handle(ctx), (e) => e.code === 'SUBSCRIPTIONS_DISABLED');
});
test('all excluded weather products and forecast are absent from transport allowlist', async () => { for (const kind of ['cyclone', 'marine', 'solar', 'radiation', 'forecast', '../weather']) await assert.rejects(provider.fetchWeather(context().config, kind, weather.LOCATIONS[0], () => assert.fail()), (e) => e.code === 'unsupported_kind'); });
test('provider request uses fixed host/path and exact secret header without URL credentials', async () => { let request; const config = context().config; const result = await provider.fetchWeather(config, 'weather', weather.LOCATIONS[0], async (options, _, bounds) => { request = options; assert.equal(bounds.timeoutMs, 5000); return { metadata: { attributions: ['source'] }, temperature: { value: 21, unit: '°C' }, condition: { text: '晴' }, humidity: 0.6 }; }); assert.equal(request.hostname, 'unit.qweatherapi.com'); assert.equal(request.path, '/weather/v1/current/39.09/117.20?lang=zh'); assert.equal(request.headers['X-QW-Api-Key'], config.qweatherApiKey); assert.equal(result.data.humidity_percent, 60); });
test('foreign AQI retains its index, missing weather is not converted to zero', () => { const result = provider.normalizeWeather('air', { metadata: { attributions: [] }, indexes: [{ code: 'us-epa', name: 'US AQI', aqi: 5 }] }); assert.equal(result.data.index_code, 'us-epa'); assert.throws(() => provider.normalizeWeather('weather', { metadata: { attributions: [] }, temperature: { value: null }, condition: { text: '晴' } })); });
test('alerts only become empty on explicit valid zero flag', () => { assert.equal(provider.normalizeWeather('alerts', { metadata: { zeroResult: true } }).data.zero_result, true); assert.throws(() => provider.normalizeWeather('alerts', { metadata: { attributions: [] }, alerts: [] })); });
test('GPS coordinates and alternate endpoint requests cannot create weather records or bypass slug allowlist', async () => {
  for (const options of [{ query: new URLSearchParams('location=beijing&latitude=39.9088&longitude=116.3973') }, { query: new URLSearchParams('latitude=39.9088&longitude=116.3973') }, { body: { latitude: 39.9088, longitude: 116.3973 } }, { query: new URLSearchParams('location=39.9088,116.3973') }]) {
    const ctx = context(options); await assert.rejects(weather.handle(ctx, { fetchWeather: () => assert.fail('coordinate request cannot reach provider') }));
    assert.equal(ctx.store.data.size, 0);
  }
});
test('all cities use four allowlisted products with the same shared cache and budget', async () => {
  for (const slug of ['shanghai', 'guangzhou', 'shenzhen', 'hangzhou', 'chengdu', 'chongqing', 'wuhan', 'nanjing']) {
    const ctx = context({ query: new URLSearchParams('location=' + slug) }), calls = [];
    const adapters = { fetchWeather: async (_, kind, location) => { calls.push({ kind, slug: location.slug }); assert.deepEqual(location, weather.locationFor(slug)); return payload(kind); } };
    const out = (await weather.handle(ctx, adapters)).data.data;
    assert.equal(out.location.slug, slug); assert.deepEqual(calls.map(x => x.kind), ['weather', 'air', 'alerts', 'daily']);
    await weather.handle(ctx, adapters); assert.equal(calls.length, 4);
    assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 4);
    assert.ok((await ctx.store.list('weather_requests')).every(row => row.location === slug && !('latitude' in row) && !('longitude' in row)));
  }
});

test('warm summary and RAG weather caches read concurrently without transactions or provider requests', async () => {
  const ctx = context(), started = [], waits = new Map();
  ctx.store.get = async (kind, id) => { started.push(id); return new Promise(resolve => waits.set(id, resolve)); };
  ctx.store.transaction = () => assert.fail('fresh cache reads need no transaction');
  const request = weather.handle(ctx, { fetchWeather: () => assert.fail('fresh cache needs no provider') });
  await new Promise(setImmediate); assert.equal(started.length, 4);
  for (const kind of ['alerts', 'weather', 'air', 'daily']) waits.get('tianjin_' + kind)(cached(kind));
  const result = (await request).data.data; assert.deepEqual(Object.keys(result), ['location', 'source_label', 'source_kind', 'weather', 'air', 'alerts', 'daily']);
  started.length = 0; waits.clear(); const rag = weather.readContext(ctx, 'tianjin');
  await new Promise(setImmediate); assert.equal(started.length, 3);
  for (const kind of ['air', 'alerts', 'weather']) waits.get('tianjin_' + kind)(cached(kind));
  assert.deepEqual(Object.keys((await rag).components), ['weather', 'air', 'alerts', 'forecast']);
});
test('overlapping full summaries preserve per-component leases and a shared budget even on provider failures', async () => {
  const ctx = context(); ctx.config.qweatherMonthlyLimit = 2; let calls = 0;
  const adapter = { fetchWeather: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); throw new provider.ProviderError('timeout'); } };
  const results = await Promise.all(Array.from({ length: 8 }, () => weather.handle(ctx, adapter)));
  assert.equal(calls, 2); assert.equal(await ctx.store.count('weather_requests'), 2);
  assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 2);
  assert.ok(results.every(result => result.data.data.weather.status === 'unavailable'));
  await weather.handle(ctx, adapter); assert.equal(calls, 2);
});

test('current weather air and zero warnings are shared for exactly one hour, daily extrema for six hours', async () => {
  const ctx = context(), calls = [];
  const adapters = { fetchWeather: async (_, kind) => { calls.push(kind); return payload(kind); } };
  const first = (await weather.handle(ctx, adapters)).data.data;
  for (const kind of ['weather', 'air', 'alerts']) assert.equal(first[kind].expires_at, '2026-10-03T05:00:00.000Z');
  assert.equal(first.daily.expires_at, '2026-10-03T10:00:00.000Z');
  assert.equal(first.weather.observed_at, null); // Fetch time is not measurement time.
  await weather.handle({ ...ctx, user: { id: 'different-account' }, now: '2026-10-03T04:59:59.999Z' }, adapters);
  assert.deepEqual(calls, ['weather', 'air', 'alerts', 'daily']);
  await weather.handle({ ...ctx, now: '2026-10-03T05:00:00.000Z' }, adapters);
  assert.deepEqual(calls, ['weather', 'air', 'alerts', 'daily', 'weather', 'air', 'alerts']);
  assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 7);
  await weather.component({ ...ctx, now: '2026-10-03T10:00:00.000Z' }, weather.LOCATIONS[0], 'daily', adapters.fetchWeather);
  assert.equal(calls.at(-1), 'daily'); assert.equal(calls.length, 8);
});
test('active warning expiry shortens the shared cache and expired or undated alerts are never exposed as active', async () => {
  const ctx = context(), warning = payload('alerts');
  warning.data = { zero_result: false, items: [
    { id: 'active', title: '测试公告', expires_at: '2026-10-03T04:10:00.000Z' },
    { id: 'expired', title: '过期公告', expires_at: '2026-10-03T03:59:59.000Z' },
    { id: 'undated', title: '缺少有效期' },
  ] };
  const first = await weather.component(ctx, weather.LOCATIONS[0], 'alerts', async () => warning);
  assert.equal(first.expires_at, '2026-10-03T04:10:00.000Z'); assert.equal(first.status, 'fresh');
  assert.deepEqual(first.data.items.map(x => x.id), ['active']); assert.equal(first.expired_or_invalid_alerts_omitted, true);
  const second = await weather.component({ ...ctx, now: '2026-10-03T04:10:00.000Z', config: { ...ctx.config, qweatherEnabled: false } }, weather.LOCATIONS[0], 'alerts', () => assert.fail());
  assert.equal(second.stale, true); assert.deepEqual(second.data.items, []); assert.equal(second.data.zero_result, false);
  const facts = await weather.readContext({ ...ctx, now: '2026-10-03T04:10:00.000Z' }, 'tianjin');
  assert.equal(facts.components.alerts.data, null); assert.equal(await ctx.store.count('weather_requests'), 1);
});
test('all-expired upstream warnings mean unknown current warning state rather than a confirmed empty result', async () => {
  const ctx = context(), warning = payload('alerts'); warning.data = { zero_result: false, items: [{ id: 'old', expires_at: '2026-10-03T03:00:00Z' }] };
  const out = await weather.component(ctx, weather.LOCATIONS[0], 'alerts', async () => warning);
  assert.equal(out.status, 'unavailable'); assert.equal(out.reason, 'no_valid_alerts'); assert.equal(out.data.zero_result, false); assert.deepEqual(out.data.items, []);
  assert.equal((await weather.readContext(ctx, 'tianjin')).components.alerts.data, null);
});
test('today extrema use Beijing dates and actual inclusive-start exclusive-end periods, without guessing yesterday or future', () => {
  const value = payload('daily'); value.data.days = [
    { ...value.data.days[0], date: '2026-10-03', starts_at: '2026-10-02T22:00:00.000Z', ends_at: '2026-10-03T22:00:00.000Z' },
    { ...value.data.days[0], date: '2026-10-04', starts_at: '2026-10-03T22:00:00.000Z', ends_at: '2026-10-04T22:00:00.000Z' },
  ];
  const at = time => weather.publicCache(cached('daily', { payload: value, fetched_at: time, expires_at: new Date(Date.parse(time) + 3600000).toISOString() }), '', Date.parse(time));
  assert.equal(at('2026-10-02T21:59:59.999Z').data.today, null); // Beijing 05:59: not in today's forecast yet.
  assert.equal(at('2026-10-02T22:00:00.000Z').data.today.date, '2026-10-03');
  assert.equal(at('2026-10-03T15:59:59.999Z').data.today.date, '2026-10-03');
  assert.equal(at('2026-10-03T16:00:00.000Z').data.today, null); // New Beijing date, old forecast period.
  assert.equal(at('2026-10-03T22:00:00.000Z').data.today.date, '2026-10-04');
});
test('daily cache stops at Beijing midnight or forecast end even if a stored expiry is too generous', async () => {
  const ctx = context({ now: '2026-10-03T15:00:00.000Z' });
  const out = await weather.component(ctx, weather.LOCATIONS[0], 'daily', async () => payload('daily'));
  assert.equal(out.expires_at, '2026-10-03T16:00:00.000Z');
  const cache = await ctx.store.get('weather_cache', 'tianjin_daily'); cache.expires_at = '2026-10-04T15:00:00.000Z';
  const nextDay = weather.publicCache(cache, '', Date.parse('2026-10-03T16:00:00.000Z'));
  assert.equal(nextDay.status, 'stale'); assert.equal(nextDay.data.today, null); assert.equal(nextDay.expires_at, '2026-10-03T16:00:00.000Z');
  const short = payload('daily'); short.data.days[0].ends_at = '2026-10-03T04:30:00.000Z';
  const limited = await weather.component(context(), weather.LOCATIONS[0], 'daily', async () => short);
  assert.equal(limited.expires_at, '2026-10-03T04:30:00.000Z');
});
test('missing daily extrema are not filled by available current temperature', async () => {
  const ctx = context(); const result = (await weather.handle(ctx, { fetchWeather: async (_, kind) => {
    const value = payload(kind); if (kind === 'daily') value.data.days[0].temperature_min = value.data.days[0].temperature_max = null; return value;
  } })).data.data;
  assert.equal(result.weather.data.temperature, 22); assert.equal(result.daily.data.today.temperature_min, null); assert.equal(result.daily.data.today.temperature_max, null);
});
test('daily provider failures and database failures do not discard existing current weather', async () => {
  for (const failure of ['provider', 'database']) {
    const ctx = context(); let calls = 0;
    for (const kind of ['weather', 'air', 'alerts']) await ctx.store.set('weather_cache', 'tianjin_' + kind, cached(kind));
    if (failure === 'database') ctx.store.transaction = async () => { throw new Error('fixture unavailable'); };
    const out = (await weather.handle(ctx, { fetchWeather: async () => { calls++; throw new provider.ProviderError('timeout'); } })).data.data;
    assert.equal(out.weather.status, 'fresh'); assert.equal(out.air.status, 'fresh'); assert.equal(out.alerts.status, 'empty'); assert.equal(out.daily.status, 'unavailable');
    assert.equal(out.daily.reason, failure === 'provider' ? 'timeout' : 'daily_unavailable');
    assert.equal(calls, failure === 'provider' ? 1 : 0);
    if (failure === 'provider') { await weather.handle(ctx, { fetchWeather: () => assert.fail('daily retry must wait for cooldown') }); assert.equal(await ctx.store.count('weather_requests'), 1); }
  }
});
test('daily budget uses the same allocation and follows current products without consuming beyond the limit', async () => {
  const ctx = context(); ctx.config.qweatherMonthlyLimit = 3; const calls = [];
  const out = (await weather.handle(ctx, { fetchWeather: async (_, kind) => { calls.push(kind); return payload(kind); } })).data.data;
  assert.deepEqual(calls, ['weather', 'air', 'alerts']); assert.equal(out.weather.status, 'fresh'); assert.equal(out.daily.reason, 'budget_exhausted');
  assert.equal(await ctx.store.count('weather_requests'), 3); assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 3);
});
test('upstream 401 and 429 stop the optional daily call and daily failures still consume reservations', async () => {
  for (const status of [401, 429]) {
    const ctx = context(), calls = [];
    const result = (await weather.handle(ctx, { fetchWeather: async (_, kind) => { calls.push(kind); throw new provider.ProviderError('upstream_http', { status }); } })).data.data;
    assert.deepEqual(calls, ['weather']); assert.equal(result.daily.reason, status === 401 ? 'upstream_access_denied' : 'upstream_rate_limited');
    assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 1);
    const daily = context(); const out = await weather.component(daily, weather.LOCATIONS[0], 'daily', async () => { throw new provider.ProviderError('upstream_http', { status }); });
    assert.equal(out.status, 'unavailable'); assert.equal((await daily.store.get('weather_gate', 'budget')).days['2026-10-03'], 1);
    await weather.component(daily, weather.LOCATIONS[1], 'weather', () => assert.fail('project cooldown applies across products and locations'));
    assert.equal(await daily.store.count('weather_requests'), 1);
  }
});
test('concurrent daily misses use one persisted location lease, including a failed request', async () => {
  for (const fails of [false, true]) {
    const ctx = context(); let calls = 0;
    const fetcher = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); if (fails) throw new provider.ProviderError('timeout'); return payload('daily'); };
    await Promise.all(Array.from({ length: 12 }, () => weather.component(ctx, weather.LOCATIONS[0], 'daily', fetcher)));
    assert.equal(calls, 1); assert.equal(await ctx.store.count('weather_requests'), 1); assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 1);
  }
});
test('daily does not extend the LLM weather context or cause provider calls when RAG reads existing weather', async () => {
  const ctx = context(); await ctx.store.set('weather_cache', 'tianjin_daily', cached('daily'));
  const calls = [], get = ctx.store.get.bind(ctx.store); ctx.store.get = (collection, id) => { calls.push(id); return get(collection, id); };
  const out = await weather.readContext(ctx, 'tianjin'); assert.deepEqual(calls.sort(), ['tianjin_air', 'tianjin_alerts', 'tianjin_weather']);
  assert.equal(out.components.daily, undefined); assert.equal(out.components.forecast.reason, 'forecast_not_in_context'); assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('daily-only 403 entitlement failure cools down that product for 24 hours without blocking current weather', async () => {
  const ctx = context(), calls = [];
  const adapter = async (_, kind) => { calls.push(kind); if (kind === 'daily') throw new provider.ProviderError('upstream_http', { status: 403 }); return payload(kind); };
  const out = (await weather.handle(ctx, { fetchWeather: adapter })).data.data;
  assert.equal(out.weather.status, 'fresh'); assert.equal(out.daily.status, 'unavailable'); assert.equal(out.daily.reason, 'daily_access_denied');
  assert.equal((await ctx.store.get('weather_cache', 'tianjin_daily')).retry_at, '2026-10-04T04:00:00.000Z');
  assert.equal((await ctx.store.get('weather_gate', 'budget')).blocked_until, undefined);
  await weather.handle({ ...ctx, now: '2026-10-03T05:00:00.000Z' }, { fetchWeather: adapter });
  assert.deepEqual(calls, ['weather', 'air', 'alerts', 'daily', 'weather', 'air', 'alerts']);
  assert.equal((await ctx.store.get('weather_gate', 'budget')).days['2026-10-03'], 7);
  await weather.component({ ...ctx, now: '2026-10-04T04:00:00.000Z' }, weather.LOCATIONS[0], 'daily', adapter);
  assert.equal(calls.at(-1), 'daily'); assert.equal(calls.length, 8);
});
test('forecast upgrades extrema-only caches once through the same budget gate and shared lease', async () => {
  const ctx = context({ path: 'weather-data/tianjin/forecast/', query: new URLSearchParams() });
  const old = cached('daily'); delete old.payload.data.schema_version; await ctx.store.set('weather_cache', old.id, old);
  let calls = 0; const adapters = { fetchWeather: async (_, kind) => { assert.equal(kind, 'daily'); calls++; await new Promise(resolve => setTimeout(resolve, 5)); return payload(kind); } };
  const responses = await Promise.all(Array.from({ length: 8 }, () => weather.handle(ctx, adapters)));
  assert.equal(calls, 1); assert.equal(await ctx.store.count('weather_requests'), 1);
  assert.ok(responses.some(x => x.data.data.forecast.status === 'fresh'));
  const fresh = (await weather.handle(ctx, adapters)).data.data; assert.equal(fresh.forecast.data.schema_version, 2); assert.equal(calls, 1);
  const summary = (await weather.handle({ ...ctx, path: 'weather-data/summary/', query: new URLSearchParams('location=tianjin') }, { fetchWeather: async (_, kind) => { assert.notEqual(kind, 'daily'); return payload(kind); } })).data.data;
  assert.equal(summary.daily.data.schema_version, 2);
});
test('forecast route rejects extra parameters and cannot spend beyond existing monthly allowance', async () => {
  const ctx = context({ path: 'weather-data/tianjin/forecast/', query: new URLSearchParams() });
  await ctx.store.set('weather_gate', 'budget', { id: 'budget', days: { '2026-10-03': 30 }, recent: [] });
  const out = (await weather.handle(ctx, { fetchWeather: () => assert.fail('budget exhausted') })).data.data;
  assert.equal(out.enabled, true); assert.equal(out.forecast.reason, 'budget_exhausted'); assert.equal(await ctx.store.count('weather_requests'), 0);
  await assert.rejects(weather.handle({ ...ctx, query: new URLSearchParams('days=10') }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(weather.handle({ ...ctx, path: 'weather-data/other/forecast/' }), { code: 'NOT_FOUND' });
});
