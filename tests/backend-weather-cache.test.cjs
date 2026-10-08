"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { SQLiteStore } = require('../backend/store.cjs');
const weather = require('../backend/vendor/lib/weather');
const refresh = require('../backend/weather-refresh.cjs');
const { ProviderError } = require('../backend/vendor/lib/providers');
const { uuid } = require('../backend/vendor/lib/core');
const NOW = '2026-10-10T04:00:00.000Z';
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyhq-weather-cache-'));
  const filename = path.join(dir, 'test.sqlite3'), h = { store: new SQLiteStore(filename), filename, now: NOW,
    config: { weatherBackgroundEnabled: true, qweatherEnabled: true, qweatherBudgetConfirmed: true,
      qweatherApiKey: 'fake-key-never-networked', qweatherApiHost: 'fixture.qweatherapi.com', qweatherMonthlyLimit: 15000 }, providers: {} };
  t.after(async () => { await h.store.close(); await fs.rm(dir, { recursive: true, force: true }); }); return h;
}
function later(h, seconds) { h.now = new Date(Date.parse(h.now) + seconds * 1000).toISOString(); }
function payload(kind, now) {
  const day = weather.dayOf(Date.parse(now)), start = Date.parse(day + 'T00:00:00+08:00');
  return { data: kind === 'alerts' ? { items: [], zero_result: true }
    : kind === 'daily' ? { schema_version: 2, timezone: 'Asia/Shanghai', days: [0, 1, 2].map(i => ({ date: weather.dayOf(start + i * 86400000), starts_at: new Date(start + i * 86400000).toISOString(), ends_at: new Date(start + (i + 1) * 86400000).toISOString(), temperature_min: 15, temperature_max: 25, temperature_unit: '°C' })) }
    : { temperature: 22, condition: '晴' }, attributions: ['Fixture attribution'], refer: { sources: ['QWeather'] }, observed_at: now };
}
function get(h, route, query = '') { return weather.handle({ ...h, path: route, method: 'GET', body: {}, query: new URLSearchParams(query) }, { fetchWeather: () => assert.fail('browser must never call QWeather') }); }
function adapter(h, calls) { return async (_config, kind, location) => { calls.push([location.slug, kind]); return payload(kind, h.now); }; }
test('all browser weather reads are cache-only on cold misses, stale caches, forecasts and old location slugs', async t => {
  const h = await setup(t), before = h.store.db.prepare('SELECT total_changes() n').get().n;
  for (const slug of ['tianjin', 'beijing', 'shanghai', 'tiangong']) {
    const summary = (await get(h, 'weather-data/summary/', 'location=' + slug)).data.data;
    assert.equal(summary.cache_only, true); assert.equal(summary.weather.status, 'unavailable');
    const forecast = (await get(h, `weather-data/${slug}/forecast/`)).data.data;
    assert.equal(forecast.cache_only, true); assert.equal(forecast.forecast.status, 'unavailable');
  }
  assert.equal(h.store.db.prepare('SELECT total_changes() n').get().n, before);
  await h.store.set('weather_cache', 'tianjin_weather', { kind: 'weather', payload: payload('weather', '2026-10-09T04:00:00Z'), fetched_at: '2026-10-09T04:00:00Z', expires_at: '2026-10-09T05:00:00Z' });
  const changes = h.store.db.prepare('SELECT total_changes() n').get().n;
  const old = (await get(h, 'weather-data/summary/', 'location=tianjin')).data.data.weather;
  assert.equal(old.status, 'stale'); assert.equal(old.data.temperature, 22); assert.equal(old.fetched_at, '2026-10-09T04:00:00Z');
  assert.equal((await weather.readContext(h, 'tianjin')).components.weather.data, null);
  assert.equal(h.store.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(await h.store.count('weather_requests'), 0);
  const locations = (await get(h, 'weather-data/locations/')).data.data.items;
  assert.deepEqual(locations.map(x => x.slug), ['tianjin', 'beijing']); assert.equal(weather.LOCATIONS.length, 13);
});
test('background disabled or zero budget does not initialize worker state or make provider requests', async t => {
  const h = await setup(t); h.config.weatherBackgroundEnabled = false;
  assert.equal((await refresh.runBatch(h, { fetchWeather: () => assert.fail() })).reason, 'background_disabled');
  h.config.weatherBackgroundEnabled = true; h.config.qweatherMonthlyLimit = 0;
  assert.equal((await refresh.runBatch(h, { fetchWeather: () => assert.fail() })).reason, 'not_configured');
  assert.equal(await h.store.count('weather_requests'), 0); assert.equal(await h.store.count('weather_refresh_state'), 0);
});
test('scheduler refreshes Tianjin first in bounded four-request batches and shares all front-end cached reads', async t => {
  const h = await setup(t), calls = [], fetchWeather = adapter(h, calls);
  const first = await refresh.runBatch(h, { fetchWeather }); assert.equal(first.requests, 4); assert.ok(calls.every(x => x[0] === 'tianjin'));
  for (let i = 0; i < 20; i++) await get(h, 'weather-data/summary/', 'location=tianjin');
  await get(h, 'weather-data/tianjin/forecast/'); assert.equal(calls.length, 4);
  later(h, 30); assert.equal((await refresh.runBatch(h, { fetchWeather })).requests, 4);
  assert.deepEqual(calls.slice(4).map(x => x[0]), Array(4).fill('beijing'));
  later(h, 30); assert.equal((await refresh.runBatch(h, { fetchWeather })).requests, 0);
  assert.equal(await h.store.count('weather_requests'), 8); assert.equal(await h.store.count('weather_refresh_jobs'), 8);
  assert.equal((await get(h, 'weather-data/beijing/forecast/')).data.data.forecast.status, 'fresh');
});
test('current products refresh each hour, forecast every six Beijing hours, and slots persist across reopen', async t => {
  const h = await setup(t), calls = [], fetchWeather = adapter(h, calls);
  await refresh.runBatch(h, { fetchWeather }); later(h, 30); await refresh.runBatch(h, { fetchWeather });
  await h.store.close(); h.store = new SQLiteStore(h.filename);
  assert.equal((await refresh.runBatch(h, { fetchWeather })).requests, 0);
  h.now = '2026-10-10T05:00:00Z'; await refresh.runBatch(h, { fetchWeather }); later(h, 30); await refresh.runBatch(h, { fetchWeather });
  assert.equal(calls.length, 14); assert.equal(calls.filter(x => x[1] === 'daily').length, 2);
  h.now = '2026-10-10T10:00:00Z'; await refresh.runBatch(h, { fetchWeather }); later(h, 30); await refresh.runBatch(h, { fetchWeather });
  assert.equal(calls.length, 22); assert.equal(calls.filter(x => x[1] === 'daily').length, 4);
  // Offline hours are not replayed. Midnight is a fresh forecast slot in Beijing.
  h.now = '2026-10-10T16:00:00Z'; await refresh.runBatch(h, { fetchWeather }); later(h, 30); await refresh.runBatch(h, { fetchWeather });
  assert.equal(calls.length, 30); assert.equal(calls.filter(x => x[1] === 'daily').length, 6);
  assert.equal((await get(h, 'weather-data/tianjin/forecast/')).data.data.forecast.data.today.date, '2026-10-11');
});
test('two overlapping workers cannot double-refresh or exceed the same persisted component reservation', async t => {
  const h = await setup(t), calls = []; let release, entered;
  const entry = new Promise(resolve => { entered = resolve; }), block = new Promise(resolve => { release = resolve; });
  const first = refresh.runBatch(h, { fetchWeather: async (_config, kind, location) => { calls.push([location.slug, kind]); entered(); await block; return payload(kind, h.now); } });
  await entry;
  assert.equal((await refresh.runBatch(h, { fetchWeather: () => assert.fail() })).reason, 'worker_busy');
  release(); await first; assert.equal(calls.length, 4); assert.equal(await h.store.count('weather_requests'), 4);
});
test('failed refreshes retain billed attempts and retry at most once in the slot; browser polling never retries them', async t => {
  const h = await setup(t), calls = []; let failures = 0;
  const fetchWeather = async (_config, kind, location) => { calls.push([location.slug, kind]); if (kind === 'weather' && location.slug === 'tianjin') { failures++; throw new ProviderError('timeout'); } return payload(kind, h.now); };
  await refresh.runBatch(h, { fetchWeather }); later(h, 30); await refresh.runBatch(h, { fetchWeather });
  for (let i = 0; i < 5; i++) await get(h, 'weather-data/summary/', 'location=tianjin');
  assert.equal(failures, 1); h.now = '2026-10-10T04:11:00Z'; await refresh.runBatch(h, { fetchWeather }); assert.equal(failures, 2);
  h.now = '2026-10-10T04:25:00Z'; await refresh.runBatch(h, { fetchWeather }); assert.equal(failures, 2);
  assert.equal(await h.store.count('weather_requests'), 9); assert.equal((await h.store.get('weather_gate', 'budget')).days['2026-10-10'], 9);
});
test('old paid ledger and provider access cooldown continue to bind the background scheduler', async t => {
  const h = await setup(t), calls = []; h.config.qweatherMonthlyLimit = 5;
  await h.store.set('weather_gate', 'budget', { days: { '2026-09-30': 4 }, recent: [] });
  const result = await refresh.runBatch(h, { fetchWeather: adapter(h, calls) });
  assert.equal(result.reason, 'budget_exhausted'); assert.equal(calls.length, 1);
  assert.equal((await h.store.get('weather_gate', 'budget')).days['2026-09-30'], 4);
  h.config.qweatherMonthlyLimit = 15000; h.now = '2026-10-10T05:00:00Z';
  const blocked = await refresh.runBatch(h, { fetchWeather: async () => { calls.push(['denied']); throw new ProviderError('upstream_http', { status: 401 }); } });
  assert.equal(blocked.requests, 1); assert.equal(calls.length, 2);
  later(h, 30); await refresh.runBatch(h, { fetchWeather: () => assert.fail('global access cooldown must remain binding') });
  assert.equal(await h.store.count('weather_requests'), 2);
});
test('stale worker lease recovers only the current slot and old fresh manual caches are reused inside their slot', async t => {
  const h = await setup(t), calls = [];
  await h.store.set('weather_refresh_state', 'background', { lease_token: 'abandoned', lease_until: '2026-10-10T03:00:00Z' });
  await h.store.set('weather_cache', 'tianjin_weather', { kind: 'weather', payload: payload('weather', h.now), fetched_at: h.now, expires_at: '2026-10-10T05:00:00Z' });
  await refresh.runBatch(h, { fetchWeather: adapter(h, calls) });
  assert.equal(calls.length, 4); assert.ok(!calls.some(x => x[0] === 'tianjin' && x[1] === 'weather'));
  assert.equal((await h.store.get('weather_refresh_state', 'background')).lease_token, null);
});
test('new manual and AI weather bookings allow only Tianjin/Beijing; old-location bookings remain readable and cancellable', async t => {
  const h = await setup(t), reminders = require('../backend/reminders.cjs'), parser = require('../backend/vendor/lib/weather-booking-ai');
  h.user = { id: uuid(), is_active: true, quota_key: 'a'.repeat(64) }; await h.store.set('users', h.user.id, h.user);
  const scheduled_for = '2026-10-10T06:00:00Z';
  for (const location of ['tianjin', 'beijing']) {
    const r = await reminders.handle({ ...h, method: 'POST', path: 'weather-data/reminders/intents/', query: new URLSearchParams(), body: { location, scheduled_for } });
    assert.equal(r.statusCode, 201);
    await reminders.handle({ ...h, method: 'POST', path: `weather-data/reminders/${r.data.data.id}/cancel/`, query: new URLSearchParams(), body: {} });
  }
  await assert.rejects(reminders.handle({ ...h, method: 'POST', path: 'weather-data/reminders/intents/', body: { location: 'shanghai', scheduled_for } }), { code: 'REMINDER_TIME_INVALID' });
  const ai = parser.messages('明天八点提醒', 'tianjin', Date.parse(h.now))[0].content;
  assert.match(ai, /tianjin/); assert.match(ai, /beijing/); assert.doesNotMatch(ai, /shanghai|tiangong/);
  assert.equal(parser.decode(JSON.stringify({ needs_clarification: false, location: 'shanghai', local_date: '2026-10-10', local_time: '14:00', frequency: 'once' }), Date.parse(h.now)).needs_clarification, true);
  const id = uuid(); await h.store.set('web_reminders', id, { id, owner_id: h.user.id, location: 'shanghai', state: 'pending', scheduled_for, created_at: h.now });
  const old = await reminders.handle({ ...h, method: 'GET', path: 'weather-data/reminders/' }); assert.ok(old.data.data.items.some(x => x.id === id && x.location.slug === 'shanghai'));
  const cancelled = await reminders.handle({ ...h, method: 'POST', path: `weather-data/reminders/${id}/cancel/`, body: {} }); assert.equal(cancelled.data.data.state, 'cancelled');
  assert.equal(await h.store.count('weather_requests'), 0);
});
test('a slow background provider does not lock cached reads or unrelated maintenance writes', async t => {
  const h = await setup(t); let release, entered, timer;
  const entry = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const running = refresh.runBatch(h, { fetchWeather: async (_config, kind) => { entered(); await wait; return payload(kind, h.now); } });
  await entry;
  try {
    const work = (async () => {
      await h.store.transaction(tx => tx.set('test_maintenance', 'independent', { completed: true }));
      const summary = await get(h, 'weather-data/summary/', 'location=tianjin');
      assert.equal(summary.data.data.weather.reason, 'refreshing');
    })();
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Background provider blocked independent work')), 1000); })]);
  } finally { clearTimeout(timer); release(); }
  await running;
  assert.equal((await h.store.get('test_maintenance', 'independent')).completed, true);
});
test('actual HTTP summary and forecast routes cannot dispatch provider calls, even with enabled credentials', async t => {
  const h = await setup(t), { createServer } = require('../backend/server.cjs');
  let calls = 0;
  const server = createServer({ store: h.store, config: h.config, cloud: {}, timers: false,
    providers: { fetchWeather: () => { calls++; throw new Error('Forbidden browser-triggered weather request'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/';
    for (const endpoint of ['weather-data/locations/', 'weather-data/summary/?location=tianjin', 'weather-data/summary/?location=beijing', 'weather-data/tianjin/forecast/', 'weather-data/beijing/forecast/', 'weather-data/shanghai/forecast/']) {
      const r = await fetch(base + endpoint); assert.equal(r.status, 200, endpoint);
      const body = await r.json(); assert.ok(body.data);
      if (!endpoint.includes('locations')) assert.equal(body.data.cache_only, true);
    }
    assert.equal(calls, 0); assert.equal(await h.store.count('weather_requests'), 0);
    assert.equal(await h.store.count('weather_refresh_state'), 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
