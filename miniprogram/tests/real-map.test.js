const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const real = require('../lib/real-map');
// Synthetic test coordinates only; these are never placed in the public catalogue.
const city = { id: 'test-tj', slug: 'tianjin-nature', name: '天津', is_demo: false, real_map: { center_latitude: 39.1, center_longitude: 117.2, scale: 12, coordinate_system: 'GCJ02' } };
const beijing = { ...city, id: 'test-bj', slug: 'beijing-nature', name: '北京', real_map: { ...city.real_map, center_latitude: 39.9, center_longitude: 116.4 } };
const demo = { id: 'demo', slug: 'demo-campus', name: '虚构校园', is_demo: true };
function place(id = 'p', extra = {}) { return { id, region: city.id, name: '合成测试点', kind: 'river', is_demo: false, is_published: true, latitude: 39.15, longitude: 117.25, coordinate_system: 'GCJ02', coordinates_verified: true, source_note: '仅测试', access_note: '测试说明', ...extra }; }
function river(extra = {}) { return { id: 'r', region: city.id, name: '合成测试河段', is_published: true, coordinate_system: 'GCJ02', geometry_verified: true, path: [{ latitude: 39.1, longitude: 117.2 }, { latitude: 39.2, longitude: 117.3 }], ...extra }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup({ selected = null, points = [place()], rivers = [], request, regions = [demo, city, beijing], detail = false } = {}) {
  let definition;
  const calls = [], native = [], urls = [];
  const application = { config: { mapSubkey: 'public-test-client-key' }, globalData: { region: selected }, session: { token: () => '', get: () => ({ user: null }) }, api: { async request(url, options) {
    calls.push({ url, options });
    if (request) { const custom = await request(url, options); if (custom) return custom; }
    if (url === 'regions/') return { data: regions };
    if (url === 'places/') return { data: points };
    if (url === 'rivers/') return { data: rivers };
    if (url.startsWith('places/')) return { data: points[0] };
    return { data: [] };
  } } };
  global.getApp = () => application; global.Page = (value) => { definition = value; };
  global.wx = { stopPullDownRefresh() {}, setNavigationBarTitle() {}, getWindowInfo: () => ({ windowWidth: 375 }), navigateTo: ({ url }) => urls.push(url), openLocation: (options) => native.push(options), getFuzzyLocation: () => assert.fail('location must require an explicit tap') };
  const modulePath = require.resolve(detail ? '../pages/detail/index' : '../pages/explore/index'); delete require.cache[modulePath]; require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { page, application, calls, native, urls };
}
function mapEvent(page, markerId = 1) { return { currentTarget: { dataset: { generation: page.data.realMapGeneration } }, detail: { markerId } }; }

test('navigation requires published real verified finite GCJ02 coordinates; pixels and demo coords never qualify', () => {
  assert.equal(real.navigable(place()), true);
  assert.equal(real.navigable(place('lower', { coordinate_system: 'gcj02' })), true);
  for (const patch of [{ is_published: false }, { is_demo: true }, { is_demo: undefined }, { coordinates_verified: false }, { coordinate_system: 'WGS84' }, { latitude: '39.15' }, { latitude: Infinity }, { longitude: NaN }, { longitude: 181 }, { latitude: 91 }, { latitude: null }, { latitude: undefined, x_ratio: .5, y_ratio: .5 }]) {
    const point = place('bad', patch); assert.equal(real.navigable(point), false); assert.equal(real.openLocation({ openLocation() { assert.fail('unsafe navigation'); } }, point), false);
  }
  assert.equal(real.cityMap({ ...city, is_demo: true }), null);
  assert.equal(real.cityMap({ ...city, real_map: { ...city.real_map, coordinate_system: 'WGS84' } }), null);
});

test('real map starts in Tianjin without login or location and filters drafts, simulated records and invalid coordinates', async () => {
  const { page, calls } = setup({ points: [place(), place('list-only', { coordinates_verified: false }), place('draft', { is_published: false }), place('demo', { is_demo: true }), place('foreign', { region: beijing.id })] });
  await page.onShow();
  assert.equal(page.data.region.id, city.id); assert.equal(page.data.region.name, '天津'); assert.equal(page.data.regions.some(region => region.slug === 'demo-campus'), false); assert.equal(page.data.useRealMap, true); assert.equal(page.data.viewMode, 'map');
  assert.equal(page.data.mapSubkey, 'public-test-client-key'); assert.equal(page.data.mapImage, ''); assert.equal(page.data.realLatitude, 39.1);
  assert.deepEqual(page.data.places.map((point) => point.id), ['p', 'list-only']); assert.equal(page.data.realMarkers.length, 1);
  assert.equal(calls.some((call) => call.url === 'maps/'), false);
  assert.deepEqual(calls.find((call) => call.url === 'rivers/').options.data, { page_size: 100, region: city.id });
});

test('real marker popup, public detail, RAG scope and native navigation use the selected current point', async () => {
  const { page, native, urls } = setup(); await page.onShow();
  page.selectRealPoint(mapEvent(page)); assert.equal(page.data.selectedPoint.id, 'p');
  page.open({ currentTarget: { dataset: { id: 'p' } } }); page.openAI(); page.navigatePoint();
  assert.match(urls[0], /kind=place&id=p/); assert.match(urls[1], /source_type=place&source_id=p/);
  assert.equal(native.length, 1); assert.equal(native[0].latitude, 39.15); assert.equal(native[0].longitude, 117.25);
  assert.equal(native[0].address, '测试说明');
  page.chooseType({ currentTarget: { dataset: { type: 'park' } } }); assert.equal(page.data.selectedPoint, null); assert.deepEqual(page.data.realMarkers, []);
  page.selectRealPoint(mapEvent(page)); assert.equal(page.data.selectedPoint, null);
});

test('only reviewed river geometry in the selected city draws lines; observation points do not fabricate lines', async () => {
  const lines = real.riverLines([river(), river({ is_published: false }), river({ is_demo: true }), river({ geometry_verified: false }), river({ region: beijing.id }), river({ path: [place()] }), river({ path: [place(), { latitude: 1000, longitude: 117 }] }), river({ coordinate_system: 'WGS84' })], city);
  assert.equal(lines.length, 1); assert.equal(lines[0].points.length, 2);
  assert.equal(real.riverLines([river({ path: Array.from({ length: 200 }, () => ({ latitude: 39, longitude: 117 })) })], city).length, 1);
  assert.equal(real.riverLines([river({ path: Array.from({ length: 201 }, () => ({ latitude: 39, longitude: 117 })) })], city).length, 0);
  const { page } = setup({ rivers: [river()] }); await page.onShow(); assert.equal(page.data.realPolyline.length, 1);
  page.chooseType({ currentTarget: { dataset: { type: 'park' } } }); assert.equal(page.data.realPolyline.length, 0);
  page.chooseType({ currentTarget: { dataset: { type: 'water' } } }); assert.equal(page.data.realPolyline.length, 1);
  page.setData({ rivers: [] }); page.filter(); assert.equal(page.data.realPolyline.length, 0); assert.equal(page.data.realMarkers.length, 1);
});

test('location is one user-triggered fuzzy GCJ02 request, remains local, and reset restores the city after native dragging', async () => {
  const { page, application, calls } = setup(); await page.onShow(); let options;
  global.wx.getFuzzyLocation = (input) => { options = input; };
  const beforeCalls = calls.length; const locating = page.locateMe(); assert.equal(options.type, 'gcj02');
  options.success({ latitude: 39.3, longitude: 117.4, speed: 100, altitude: 20 }); await locating;
  assert.deepEqual(page.data.currentLocation, { latitude: 39.3, longitude: 117.4 }); assert.equal(page.data.realLatitude, 39.3); assert.equal(page.data.realScale, 13);
  assert.equal(page.data.realMarkers.find((marker) => marker.id === 0).callout.content, '本次附近位置');
  assert.equal(calls.length, beforeCalls); assert.deepEqual(Object.keys(application.globalData), ['region']);
  const event = mapEvent(page); page.resetCity(); assert.equal(page.data.currentLocation, null); assert.equal(page.data.realLatitude, 39.1);
  assert.notEqual(page.data.realMapGeneration, event.currentTarget.dataset.generation); page.selectRealPoint(event); assert.equal(page.data.selectedPoint, null);
});

test('declined and unavailable location leave manual map browsing available', async () => {
  for (const getFuzzyLocation of [(options) => options.fail({ errMsg: 'auth deny' }), undefined, () => { throw Error('native unavailable'); }]) {
    const { page } = setup(); await page.onShow(); global.wx.getFuzzyLocation = getFuzzyLocation; await page.locateMe();
    assert.equal(page.data.locating, false); assert.equal(page.data.useRealMap, true); assert.equal(page.data.realLatitude, 39.1); assert.equal(page.data.error, '');
    assert.match(page.data.locationNotice, /仍可手动/); assert.equal(page.data.currentLocation, null);
  }
});

test('switching cities clears the position and selection and ignores old location/marker/error callbacks', async () => {
  const { page } = setup({ points: [place(), place('bj', { region: beijing.id, latitude: 39.9, longitude: 116.4 })] }); await page.onShow();
  const staleEvent = mapEvent(page); page.selectRealPoint(staleEvent); let options;
  global.wx.getFuzzyLocation = (input) => { options = input; }; const locating = page.locateMe();
  await page.changeRegion({ detail: { value: page.data.regions.findIndex(region => region.id === beijing.id) } }); options.success({ latitude: 30, longitude: 100 }); await locating;
  assert.equal(page.data.region.id, beijing.id); assert.equal(page.data.realLatitude, 39.9); assert.equal(page.data.currentLocation, null); assert.equal(page.data.selectedPoint, null);
  page.selectRealPoint(staleEvent); page.realMapError(staleEvent); assert.equal(page.data.selectedPoint, null); assert.equal(page.data.realMapFailed, false);
  page.selectRealPoint(mapEvent(page)); assert.equal(page.data.selectedPoint.id, 'bj');
});

test('hide and unload cancel location work and reject queued native events or UI actions', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const { page, native } = setup(); await page.onShow(); const event = mapEvent(page); let options;
    global.wx.getFuzzyLocation = (input) => { options = input; }; const locating = page.locateMe();
    page[lifecycle](); assert.equal(page.data.realLatitude, null); assert.equal(page.data.currentLocation, null);
    page.setData = () => assert.fail('write after leaving'); options.success({ latitude: 39, longitude: 117 }); await locating;
    page.selectRealPoint(event); page.realMapError(event); page.resetCity(); page.navigatePoint(); await page.locateMe(); assert.equal(native.length, 0);
  }
});

test('an older city catalogue cannot replace a newer selection', async () => {
  const pending = deferred(); const { page } = setup({ request: async (url, options) => url === 'places/' && options.data.region === city.id ? pending.promise : null });
  const loading = page.onShow(); await new Promise(setImmediate); await page.changeRegion({ detail: { value: page.data.regions.findIndex(region => region.id === beijing.id) } });
  pending.resolve({ data: [place()] }); await loading; assert.equal(page.data.region.id, beijing.id); assert.equal(page.data.realLatitude, 39.9); assert.equal(page.data.places.length, 0);
});

test('map service error falls back to the public list and a retry replaces the failed native node', async () => {
  const { page, urls } = setup(); await page.onShow(); const old = mapEvent(page); page.realMapError(old);
  assert.equal(page.data.viewMode, 'list'); assert.equal(page.data.filtered.length, 1); assert.equal(page.data.mapImage, ''); assert.deepEqual(page.data.realMapFrames, []);
  page.open({ currentTarget: { dataset: { id: 'p' } } }); assert.equal(urls.length, 1);
  page.changeView({ currentTarget: { dataset: { mode: 'map' } } }); assert.equal(page.data.realMapFailed, false); assert.equal(page.data.realMapFrames.length, 1);
  page.realMapError(old); assert.equal(page.data.realMapFailed, false);
});

test('empty real city retains its real map and a failed river catalogue keeps public places usable', async () => {
  const empty = setup({ points: [] }).page; await empty.onShow(); assert.equal(empty.data.useRealMap, true); assert.equal(empty.data.viewMode, 'map'); assert.equal(empty.data.realMarkers.length, 0); assert.equal(empty.data.mapImage, '');
  const { page } = setup({ request: async (url) => { if (url === 'rivers/') throw Error('offline'); } }); await page.onShow();
  assert.equal(page.data.places.length, 1); assert.equal(page.data.error, ''); assert.match(page.data.riversError, /暂不可用/);
});

test('real place detail has public coordinate navigation without simulated observations or login', async () => {
  const { page, calls, native } = setup({ detail: true }); await page.onLoad({ kind: 'place', id: 'p' });
  assert.equal(page.data.canNavigate, true); assert.equal(calls.some((call) => ['stations/', 'observations/'].includes(call.url)), false);
  page.navigatePlace(); assert.equal(native.length, 1); assert.equal(native[0].latitude, 39.15);
  page.onHide(); page.navigatePlace(); assert.equal(native.length, 1);
  const second = setup({ detail: true, points: [place('unverified', { coordinates_verified: false })] }); await second.page.onLoad({ kind: 'place', id: 'unverified' });
  assert.equal(second.page.data.canNavigate, false); second.page.navigatePlace(); assert.equal(second.native.length, 0);
});

test('bounded location request ignores a late native callback after timeout', async (t) => {
  const original = { set: global.setTimeout, clear: global.clearTimeout }; let timeout, options;
  global.setTimeout = (fn, ms) => { assert.equal(ms, 12000); timeout = fn; return 123; }; global.clearTimeout = () => {};
  t.after(() => { global.setTimeout = original.set; global.clearTimeout = original.clear; });
  const pending = real.locationRequest({ getFuzzyLocation(input) { options = input; } }); timeout(); options.success({ latitude: 39, longitude: 117 });
  assert.deepEqual(await pending, { status: 'timeout' });
});

test('native map carries keyed events and optional subkey but never starts continuous positioning', () => {
  const template = fs.readFileSync(path.join(__dirname, '../pages/explore/index.wxml'), 'utf8');
  const native = template.match(/<map\b[^>]*>/)[0]; assert.match(native, /wx:key="generation"/); assert.match(native, /data-generation="{{frame.generation}}"/); assert.match(native, /subkey="{{mapSubkey}}"/); assert.match(native, /show-location="{{false}}"/);
  const source = fs.readFileSync(path.join(__dirname, '../pages/explore/index.js'), 'utf8'); assert.doesNotMatch(source, /startLocationUpdate|onLocationChange/);
  const privateInfos = require('../app.json').requiredPrivateInfos;
  assert.ok(privateInfos.includes('getFuzzyLocation'));
  assert.equal(privateInfos.includes('getLocation'), false, 'WeChat forbids declaring precise and fuzzy location together');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../lib/real-map.js'), 'utf8'), /api\.getLocation\s*\(/, 'map must never fall back to precise positioning');
  assert.ok(fs.statSync(path.join(__dirname, '..', real.MARKER_ICON)).size < 2048);
});


test('home-first initialization and a full refresh both retain the real Tianjin map', async () => {
  const { loadRegions, selectRegion } = require('../lib/region');
  const { page, application } = setup({ regions: [beijing, demo, city] });
  for (let launch = 0; launch < 2; launch += 1) {
    application.globalData.region = null;
    const homeSelection = await loadRegions(application);
    selectRegion(application, homeSelection.region);
    await page.onShow();
    assert.equal(page.data.region.id, city.id);
    assert.equal(page.data.useRealMap, true);
    assert.equal(page.data.mapImage, '');
    page.onHide();
  }
  selectRegion(application, beijing);
  await page.onShow();
  assert.equal(page.data.region.id, beijing.id, 'manual city choice is respected within the session');
});
