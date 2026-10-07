const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeatherSnapshotStore, scope, HOUR, RETRY } = require('../lib/weather-snapshot');
const { weatherView } = require('../lib/weather');
const START = Date.parse('2026-10-07T03:00:00Z');
const config = { transport: 'cloud-function', cloud: { env: 'env-one', function: 'hyhqApi' } };
const locations = { enabled: true, items: [{ slug: 'tianjin', name: '天津市' }, { slug: 'beijing', name: '北京市' }] };
function summary(slug, now = START, temperature = 21.9) {
  const component = data => ({ status: 'fresh', fetched_at: new Date(now).toISOString(), expires_at: new Date(now + HOUR).toISOString(), data });
  return { location: { slug, name: slug }, weather: component({ temperature, temperature_unit: '°C', condition: '晴' }),
    air: component({ aqi: 20 }), alerts: { ...component({ zero_result: true, items: [] }), status: 'empty' } };
}
function fixture() {
  let stamp = START; const values = new Map(), calls = [];
  const platform = { getStorageSync: key => structuredClone(values.get(key)), setStorageSync: (key, value) => values.set(key, structuredClone(value)) };
  const api = { async request(path, options) { calls.push({ path, options }); return { data: path === 'weather-data/locations/' ? locations : summary(options.data.location, stamp) }; } };
  return { platform, values, calls, api, now: () => stamp, advance: n => { stamp += n; }, store: () => createWeatherSnapshotStore(platform, config, () => stamp) };
}
test('public weather and directory survive restart, reuse for one hour and never renew source expiry on a hit', async () => {
  const f = fixture(), first = f.store();
  await first.locations(f.api); await first.load('tianjin', f.api); first.select('tianjin');
  const expiry = first.read('tianjin').data.weather.expires_at;
  f.advance(HOUR - 1);
  const restarted = f.store();
  assert.equal(restarted.selected(), 'tianjin');
  await restarted.locations(f.api); await restarted.load('tianjin', f.api);
  assert.equal(f.calls.length, 2);
  assert.equal(restarted.read('tianjin').data.weather.expires_at, expiry);
  f.advance(1); await restarted.locations(f.api); await restarted.load('tianjin', f.api);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.options.cache === false));
});
test('same-city requests coalesce and city switching reuses only the matching summary', async () => {
  const f = fixture(), cache = f.store();
  const [a, b] = await Promise.all([cache.load('tianjin', f.api), cache.load('tianjin', f.api)]);
  assert.equal(a.location.slug, b.location.slug); assert.equal(f.calls.length, 1);
  await cache.load('beijing', f.api); await cache.load('tianjin', f.api);
  assert.equal(f.calls.length, 2); assert.equal(cache.read('beijing').data.location.slug, 'beijing');
});
test('cache keys distinguish transport, cloud env, function and HTTP address; stored data excludes identity and raw GPS', async () => {
  const f = fixture(), cache = f.store();
  const raw = summary('tianjin'); raw.token = 'private-token'; raw.openid = 'private-openid'; raw.location.latitude = 39.908888;
  await cache.load('tianjin', { request: async () => ({ data: raw }) });
  const disk = JSON.stringify([...f.values.values()]);
  assert.doesNotMatch(disk, /private-token|private-openid|39\.908888/);
  for (const cfg of [{ ...config, cloud: { env: 'env-two', function: 'hyhqApi' } }, { ...config, cloud: { env: 'env-one', function: 'other' } }, { transport: 'http', baseURL: 'https://one.example/api' }]) {
    assert.equal(createWeatherSnapshotStore(f.platform, cfg, f.now).read('tianjin'), null);
  }
  assert.notEqual(scope({ baseURL: 'https://one.example/api' }), scope({ baseURL: 'https://two.example/api' }));
});
test('snapshot copies cannot mutate future reads, and invalid or unavailable storage falls back safely', async () => {
  const f = fixture(), cache = f.store(); await cache.load('tianjin', f.api);
  cache.read('tianjin').data.weather.data.temperature = 99;
  assert.equal(cache.read('tianjin').data.weather.data.temperature, 21.9);
  for (const bad of ['broken', { version: 1, summaries: { tianjin: { writtenAt: START + 1, refreshAt: START + HOUR, data: summary('tianjin') } } }, { version: 999 }]) {
    const value = createWeatherSnapshotStore({ getStorageSync: () => bad }, config, f.now);
    assert.equal(value.read('tianjin'), null);
  }
  const noDisk = createWeatherSnapshotStore({ getStorageSync() { throw Error('denied'); }, setStorageSync() { throw Error('full'); } }, config, f.now);
  await noDisk.load('tianjin', f.api); await noDisk.load('tianjin', f.api);
  assert.equal(f.calls.length, 2);
});
test('early alert expiry limits reuse; expired data stays historical and never becomes a fresh empty warning', async () => {
  const f = fixture(), cache = f.store(), raw = summary('tianjin');
  raw.alerts = { ...raw.alerts, status: 'fresh', expires_at: new Date(START + 60000).toISOString(), data: { zero_result: false, items: [{ id: 'a', expires_at: new Date(START + 60000).toISOString() }] } };
  await cache.load('tianjin', { request: async () => ({ data: raw }) });
  assert.equal(cache.read('tianjin').refreshAt, START + 60000);
  f.advance(60000);
  const view = weatherView(cache.read('tianjin').data, f.now());
  assert.equal(view.alerts.stale, true); assert.equal(view.alerts.empty, false);
});
test('damaged nested lists are discarded from persistent snapshots and fetched again safely', async () => {
  for (const [slot, field, damaged] of [['alerts', 'items', {}], ['alerts', 'items', [null]], ['air', 'pollutants', 'broken'], ['daily', 'days', [false]]]) {
    const f = fixture(), data = summary('tianjin');
    data[slot] = { ...(data[slot] || data.weather), data: { [field]: damaged } };
    const saved = { version: 1, summaries: { tianjin: { writtenAt: START, refreshAt: START + HOUR, data } } };
    const cache = createWeatherSnapshotStore({ ...f.platform, getStorageSync: () => saved }, config, f.now);
    assert.equal(cache.read('tianjin'), null);
    await cache.load('tianjin', f.api);
    assert.equal(cache.read('tianjin').data.weather.data.temperature, 21.9);
    assert.equal(f.calls.length, 1);
  }
});
test('failed automatic refresh backs off without changing successful timestamps; manual retry can bypass', async () => {
  const f = fixture(), cache = f.store(); await cache.load('tianjin', f.api);
  const fetched = cache.read('tianjin').data.weather.fetched_at; f.advance(HOUR);
  let failures = 0; const broken = { request: async () => { failures++; throw Error('offline'); } };
  await assert.rejects(cache.load('tianjin', broken), /offline/);
  const restored = await cache.load('tianjin', broken);
  assert.equal(failures, 1); assert.equal(restored.weather.fetched_at, fetched);
  assert.equal(weatherView(restored, f.now()).weather.stale, true);
  assert.equal(cache.read('tianjin').refreshAt, f.now() + RETRY);
  await assert.rejects(cache.load('tianjin', broken, true), /offline/); assert.equal(failures, 2);
  f.advance(RETRY); await cache.load('tianjin', f.api); assert.equal(f.calls.length, 2);
});
test('failed first request also backs off and a disabled directory clears stored summaries', async () => {
  const f = fixture(), cache = f.store(); let tries = 0;
  const bad = { request: async () => { tries++; throw Error('offline'); } };
  await assert.rejects(cache.load('tianjin', bad)); await assert.rejects(cache.load('tianjin', bad)); assert.equal(tries, 1);
  await cache.load('tianjin', f.api, true);
  await cache.locations({ request: async () => ({ data: { ...locations, enabled: false } }) }, true);
  assert.equal(cache.read('tianjin'), null);
});

function homeFixture(f) {
  let definition;
  const application = { config, globalData: {}, api: { request: async (path, options) => path === 'regions/' ? { data: [{ id: 'demo', name: '示范校园' }] } : f.api.request(path, options) }, weatherSnapshots: f.store() };
  global.wx = { ...f.platform, stopPullDownRefresh() {} }; global.getApp = () => application; global.Page = value => { definition = value; };
  delete require.cache[require.resolve('../pages/home/index')]; require('../pages/home/index');
  const instance = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { instance, application };
}
test('home renders saved weather synchronously before waiting for cloud, and tab return makes zero weather calls', async t => {
  const f = fixture(), cache = f.store(); await cache.locations(f.api); await cache.load('tianjin', f.api); f.calls.length = 0;
  const { instance } = homeFixture(f); t.after(() => instance.onUnload());
  const old = Date.now; Date.now = f.now; t.after(() => { Date.now = old; });
  const first = instance.onLoad();
  assert.equal(instance.data.cityLoading, false); assert.equal(instance.data.citySummary.weather.temp_label, '21℃');
  await first; instance.onHide(); await instance.onShow();
  assert.equal(f.calls.length, 0); assert.equal(instance.data.alertBadge.visible, false);
});
test('visible page schedules one expiry refresh; hiding cancels it and resuming after expiry reloads', async t => {
  const f = fixture(); let nextId = 0; const timers = new Map();
  const original = { now: Date.now, set: global.setTimeout, clear: global.clearTimeout };
  Date.now = f.now; global.setTimeout = (fn, delay) => { timers.set(++nextId, { fn, delay }); return nextId; }; global.clearTimeout = id => timers.delete(id);
  t.after(() => { Date.now = original.now; global.setTimeout = original.set; global.clearTimeout = original.clear; });
  const { instance } = homeFixture(f); t.after(() => instance.onUnload());
  await instance.onLoad(); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, HOUR);
  const callback = [...timers.values()][0].fn; timers.clear(); f.advance(HOUR); callback(); await new Promise(setImmediate);
  assert.equal(f.calls.filter(x => x.path === 'weather-data/summary/').length, 2); assert.equal(timers.size, 1);
  instance.onHide(); assert.equal(timers.size, 0); f.advance(HOUR); await instance.onShow();
  assert.equal(f.calls.filter(x => x.path === 'weather-data/summary/').length, 3);
  assert.equal(timers.size, 1);
});
test('removed selected city cannot leave the old temperature under the fallback city when its request fails', async t => {
  const f = fixture(), cache = f.store(); await cache.locations(f.api); await cache.load('beijing', f.api); cache.select('beijing');
  const { instance, application } = homeFixture(f); t.after(() => instance.onUnload());
  application.api.request = async path => {
    if (path === 'weather-data/locations/') return { data: { enabled: true, items: [locations.items[0]] } };
    throw Error('new city unavailable');
  };
  await instance.loadCityLocations(true);
  assert.equal(instance.data.city.slug, 'tianjin');
  assert.equal(instance.data.citySummary, null); assert.equal(instance.data.alertBadge, null);
  assert.equal(instance.data.cityError, 'new city unavailable');
});
