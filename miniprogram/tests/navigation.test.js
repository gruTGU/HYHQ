const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAll, loadRegions } = require('../lib/region');
const { createSession } = require('../lib/session');
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function session() {
  const values = new Map();
  return createSession({ getStorageSync: (key) => values.get(key), setStorageSync: (key, value) => values.set(key, value), removeStorageSync: (key) => values.delete(key) });
}
function page(name, application) {
  let definition;
  global.Page = (input) => { definition = input; };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, showToast() {}, showModal() {}, setNavigationBarTitle() {}, navigateTo() {}, switchTab() {} };
  const filename = require.resolve('../pages/' + name + '/index');
  delete require.cache[filename]; require(filename);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return instance;
}
const regions = [{ id: 'a', slug: 'demo-campus', name: '示范区 A' }, { id: 'b', name: '区域 B' }];
function publicAPI(extra = async () => null) {
  return { request: async (path, options) => {
    const custom = await extra(path, options);
    if (custom) return custom;
    if (path === 'health/') return { data: { status: 'ok', mode: 'simulation' } };
    if (path === 'regions/') return { data: regions };
    if (path === 'weather-alerts/') return { data: { alerts: [], notice: '真实预警未接入' } };
    return { data: { temperature: 0, source_type: 'simulation', region: options && options.data.region } };
  } };
}

test('public catalogues follow pagination with filters only on the first request', async () => {
  const calls = [];
  const api = { request: async (path, options) => {
    calls.push([path, options]);
    return path === 'regions/' ? { data: [regions[0]], meta: { next: '/api/v1/regions/?page=2' } } : { data: [regions[1]], meta: { next: null } };
  } };
  assert.deepEqual(await loadAll(api, 'regions/', { region: 'a' }), regions);
  assert.deepEqual(calls[0][1].data, { page_size: 100, region: 'a' });
  assert.equal(calls[1][1], undefined);
});
test('malformed or cyclic catalogues fail visibly rather than presenting a partial directory', async () => {
  await assert.rejects(loadAll({ request: async () => ({ data: {} }) }, 'regions/'), /格式/);
  await assert.rejects(loadAll({ request: async () => ({ data: [regions[0]], meta: { next: 'regions/' } }) }, 'regions/'), /分页/);
});
test('removed region selection falls back to the demo region without mutating global state before the caller accepts it', async () => {
  const old = { id: 'removed' };
  const application = { globalData: { region: old }, api: { request: async () => ({ data: [regions[1], regions[0]] }) } };
  assert.equal((await loadRegions(application)).region.id, 'a');
  assert.equal(application.globalData.region, old);
});
test('changing region while an earlier weather request is pending cannot overwrite the new region', async () => {
  const pending = deferred();
  const application = { globalData: {}, api: publicAPI(async (path, options) => path === 'weather/' && options.data.region === 'a' ? pending.promise : null) };
  const instance = page('home', application);
  instance.data.observationExpanded = true;
  const oldLoad = instance.load();
  await new Promise(setImmediate);
  await instance.changeRegion({ detail: { value: '1' } });
  assert.equal(instance.data.region.id, 'b');
  pending.resolve({ data: { temperature: 99, region: 'a' } });
  await oldLoad;
  assert.equal(instance.data.weather.region, 'b');
  assert.equal(application.globalData.region.id, 'b');
  assert.equal(instance.data.loading, false);
});
test('returning home respects the region selected by another screen', async () => {
  const application = { globalData: {}, api: publicAPI() };
  const instance = page('home', application);
  instance.data.observationExpanded = true;
  await instance.onLoad();
  instance.onHide(); application.globalData.region = regions[1];
  await instance.onShow();
  assert.equal(instance.data.region.id, 'b');
  assert.equal(instance.data.weather.region, 'b');
});
test('late home catalogue response cannot mutate a hidden page or global region', async () => {
  const pending = deferred();
  const application = { globalData: { region: regions[1] }, api: publicAPI(async (path) => path === 'regions/' ? pending.promise : null) };
  const instance = page('home', application);
  const loading = instance.load();
  instance.onHide(); instance.setData = () => { throw new Error('setData after hide'); };
  pending.resolve({ data: [regions[0]] });
  await loading;
  assert.equal(application.globalData.region.id, 'b');
});
test('home measurement links carry the selected region and keep native tabs separate', () => {
  const instance = page('home', { globalData: {} });
  instance.data.region = { id: 'region id' };
  const urls = []; global.wx.navigateTo = ({ url }) => urls.push(url);
  instance.measurements({ currentTarget: { dataset: { page: 'water' } } });
  instance.measurements({ currentTarget: { dataset: { page: 'data-center' } } });
  instance.measurements({ currentTarget: { dataset: { page: 'invalid' } } });
  assert.deepEqual(urls, ['/pages/water/index?region=region%20id', '/pages/data-center/index?region=region%20id']);
});
test('hidden and unloaded home ignores queued refresh and navigation events', async () => {
  const application = { globalData: {}, api: publicAPI() };
  const instance = page('home', application); await instance.onLoad(); instance.onHide();
  instance.setData = () => { throw new Error('write after hide'); };
  application.api.request = () => { throw new Error('request after hide'); };
  global.wx.navigateTo = global.wx.switchTab = () => { throw new Error('navigation after hide'); };
  for (const unload of [false, true]) {
    if (unload) instance.onUnload();
    await instance.onPullDownRefresh(); await instance.load();
    await instance.changeRegion({ detail: { value: 1 } });
    instance.navigate({ currentTarget: { dataset: { page: 'explore' } } });
    instance.measurements({ currentTarget: { dataset: { page: 'water' } } }); instance.assessment();
  }
});
function detailApp(extra) {
  return { globalData: {}, session: session(), api: { request: async (path, options) => {
    const custom = extra && await extra(path, options);
    if (custom) return custom;
    if (path === 'places/p/') return { data: { id: 'p', name: '湖泊', region: 'r', water_body_id: 'w' } };
    if (path === 'stations/') return { data: [{ id: 's1', kind: 'water' }, { id: 's2', kind: 'water' }] };
    return { data: [] };
  } } };
}
test('place links open its water body and currently selected station', async () => {
  const instance = page('detail', detailApp()); await instance.onLoad({ kind: 'place', id: 'p' });
  const urls = []; global.wx.navigateTo = ({ url }) => urls.push(url);
  instance.openWater(); instance.data.stationIndex = 1; instance.openDataCenter();
  assert.equal(urls[0], '/pages/water/index?region=r&waterBodyId=w');
  assert.equal(urls[1], '/pages/data-center/index?region=r&stationId=s2&kind=water');
});
test('detail station races preserve current results and keep suspect values missing', async () => {
  const pending = deferred(); let delayed = false;
  const application = detailApp(async (path, options) => {
    if (path !== 'observations/') return null;
    if (delayed && options.data.station === 's1') return pending.promise;
    return { data: [{ id: options.data.station, value: 0, quality_status: 'suspect' }] };
  });
  const instance = page('detail', application); await instance.onLoad({ kind: 'place', id: 'p' });
  delayed = true;
  const oldLoad = instance.changeStation({ detail: { value: 0 } });
  await instance.changeStation({ detail: { value: 1 } });
  pending.resolve({ data: [{ id: 'old', value: 99, quality_status: 'valid' }] }); await oldLoad;
  assert.equal(instance.data.observations[0].id, 's2');
  assert.equal(instance.data.observations[0].value_label, '—');
});
test('detail never writes old-account favorites or browse history into a renewed session', async () => {
  const pending = deferred(); let writes = 0;
  const application = detailApp(async (path, options) => {
    if (path === 'favorites/') return pending.promise;
    if (options && options.method === 'POST') writes += 1;
    return null;
  });
  application.session.save({ token: 'a', user: { id: 'owner-a', record_history: true } });
  const instance = page('detail', application), loading = instance.onLoad({ kind: 'place', id: 'p' });
  await new Promise(setImmediate);
  application.session.save({ token: 'b', user: { id: 'owner-b', record_history: true } });
  pending.resolve({ data: [{ id: 'private-old', place_id: 'p' }] }); await loading;
  assert.equal(instance.data.favoriteId, ''); assert.equal(writes, 0);
  assert.match(instance.data.recordError, /登录状态/);
});
test('detail visit confirmation cannot submit after the page is unloaded', async () => {
  let writes = 0, confirm;
  const application = detailApp(async (path, options) => { if (options && options.method === 'POST') writes += 1; return null; });
  application.session.save({ token: 'a', user: { id: 'a', record_history: false } });
  const instance = page('detail', application); await instance.onLoad({ kind: 'place', id: 'p' });
  global.wx.showModal = (options) => { confirm = options.success; };
  instance.visit(); instance.onUnload(); instance.setData = () => { throw new Error('write after unload'); };
  await confirm({ confirm: true }); assert.equal(writes, 0);
});
test('history write failure preserves the confirmed favorite so the next action removes it', async () => {
  const mutations = [];
  const application = detailApp(async (path, options) => {
    if (options && options.method) mutations.push([path, options.method]);
    if (path === 'histories/') throw new Error('浏览记录保存失败');
    if (path === 'favorites/') return { data: [{ id: 'favorite-existing', place_id: 'p' }] };
    return null;
  });
  application.session.save({ token: 'a', user: { id: 'a', record_history: true } });
  const instance = page('detail', application); await instance.onLoad({ kind: 'place', id: 'p' });
  assert.equal(instance.data.favoriteId, 'favorite-existing');
  assert.match(instance.data.recordError, /浏览记录/);
  await instance.toggleFavorite();
  assert.deepEqual(mutations, [['histories/', 'POST'], ['favorites/favorite-existing/', 'DELETE']]);
  assert.equal(instance.data.favoriteId, '');
});
test('hidden and unloaded detail pages ignore queued selection and navigation events', async () => {
  const instance = page('detail', detailApp()); await instance.onLoad({ kind: 'place', id: 'p' });
  instance.onHide();
  instance.setData = () => { throw new Error('write after hide'); };
  global.wx.navigateTo = () => { throw new Error('navigation after hide'); };
  for (const unload of [false, true]) {
    if (unload) instance.onUnload();
    instance.changeStation({ detail: { value: 1 } });
    await instance.onPullDownRefresh(); await instance.load();
    instance.openWater(); instance.openDataCenter();
    instance.openPlace({ currentTarget: { dataset: { id: 'p' } } });
  }
});
test('late detail response cannot write to an unloaded page', async () => {
  const pending = deferred();
  const instance = page('detail', detailApp(async (path) => path === 'places/p/' ? pending.promise : null));
  const loading = instance.onLoad({ kind: 'place', id: 'p' });
  instance.onUnload(); instance.setData = () => { throw new Error('write after unload'); };
  pending.resolve({ data: { id: 'p' } }); await loading;
});
