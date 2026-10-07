const test = require('node:test');
const assert = require('node:assert/strict');
const { requestObservationLocation, selected } = require('../lib/observation-location');
const { createAssessmentController } = require('../pages/assessment/controller');
const { createSession } = require('../lib/session');

function fixture() {
  const calls = [], session = createSession({});
  session.save({ token: 'account-a', user: { id: 'a' } });
  const application = { session, globalData: {}, api: { async request(path, options) {
    calls.push({ path, options });
    if (path === 'health/') return { data: {} };
    if (path === 'nearby-water-bodies/') return { data: { match: { water_body_id: 'candidate', water_body_name: '候选水体' } } };
    return { data: [] };
  } } };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, showToast() {} };
  const definition = createAssessmentController();
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { application, page, calls };
}

test('observation location requests explicitly select GCJ02 and never pass provider metadata onward', async () => {
  let options;
  const current = requestObservationLocation({ getFuzzyLocation(input) { options = input; } }, 'current');
  assert.equal(options.type, 'gcj02'); assert.equal(options.isHighAccuracy, undefined);
  options.success({ latitude: 39.9, longitude: 116.4, speed: 9, altitude: 50, accuracy: 12 });
  assert.deepEqual(await current, { status: 'selected', location: { latitude: 39.9, longitude: 116.4, coordinate_system: 'GCJ02' }, source: 'fuzzy', label: '模糊参考位置', accuracy_m: 12 });
  const map = requestObservationLocation({ chooseLocation(input) { options = input; } }, 'map');
  assert.equal(options.latitude, undefined); assert.equal(options.longitude, undefined);
  options.success({ latitude: 39.8, longitude: 116.3, name: '水岸步道', address: '不会上传的详细地址' });
  assert.deepEqual(await map, { status: 'selected', location: { latitude: 39.8, longitude: 116.3, coordinate_system: 'GCJ02' }, source: 'map', label: '水岸步道' });
});

test('POI city-only and missing/deprecated coordinates are not converted into fabricated observation points', () => {
  assert.deepEqual(selected('poi', { type: 1, city: '天津市', latitude: 39, longitude: 117 }), { status: 'city-only', label: '天津市' });
  for (const value of [{ type: 2, name: '河边' }, { type: 0, latitude: 39, longitude: 117 }, { type: 2, latitude: '39', longitude: 117 }, { type: 2, latitude: 91, longitude: 117 }]) {
    assert.deepEqual(selected('poi', value), { status: 'invalid' });
  }
  assert.equal(selected('poi', { type: 2, latitude: 39, longitude: 117 }).location.coordinate_system, 'GCJ02');
});

test('cancel, denied, unavailable and thrown native API calls return bounded public statuses', async () => {
  assert.deepEqual(await requestObservationLocation({}, 'map'), { status: 'unavailable' });
  assert.deepEqual(await requestObservationLocation({ choosePoi() { throw Error('private internals'); } }, 'poi'), { status: 'unavailable' });
  for (const [errMsg, status] of [['chooseLocation:fail cancel', 'cancelled'], ['auth deny', 'denied'], ['private native failure', 'unavailable']]) {
    assert.deepEqual(await requestObservationLocation({ chooseLocation(o) { o.fail({ errMsg }); } }, 'map'), { status });
  }
  let callbacks; const pending = requestObservationLocation({ chooseLocation(o) { callbacks = o; } }, 'map');
  pending.cancel(); callbacks.success({ latitude: 39, longitude: 117 });
  assert.deepEqual(await pending, { status: 'cancelled' });
});

test('fuzzy acquisition times out once and ignores a late success', async t => {
  const original = { set: global.setTimeout, clear: global.clearTimeout }; let timeout, callbacks, cleared = 0;
  global.setTimeout = (callback, ms) => { assert.equal(ms, 12000); timeout = callback; return 1; };
  global.clearTimeout = () => { cleared++; };
  t.after(() => { global.setTimeout = original.set; global.clearTimeout = original.clear; });
  const result = requestObservationLocation({ getFuzzyLocation(o) { callbacks = o; } }, 'current');
  timeout(); callbacks.success({ latitude: 39, longitude: 117 });
  assert.deepEqual(await result, { status: 'timeout' }); assert.equal(cleared, 1);
});

test('native map picker result waits for page return before storing a point or making any query', async () => {
  const { page, calls } = fixture(); await page.onShow(); calls.length = 0;
  let picker;
  global.wx.chooseLocation = options => { picker = options; };
  global.wx.getFuzzyLocation = () => assert.fail('a map choice must not acquire GPS separately');
  const choosing = page.chooseMapLocation(); page.onHide();
  picker.success({ latitude: 39.9, longitude: 116.4, name: '河岸', address: 'private address' }); await choosing;
  assert.equal(page.data.location, null); assert.equal(calls.length, 0);
  await page.onShow();
  assert.deepEqual(page.data.location, { latitude: 39.9, longitude: 116.4, coordinate_system: 'GCJ02' });
  const nearby = calls.filter(row => row.path === 'nearby-water-bodies/');
  assert.equal(nearby.length, 1); assert.deepEqual(nearby[0].options.data, page.data.location);
  assert.doesNotMatch(JSON.stringify(calls), /private address|河岸/);
  assert.equal(page.data.locating, false); assert.equal(page.data.waterIndex, 0);
});

test('cancelling a new choice preserves the prior optional point and causes no nearby query', async () => {
  const { page, calls } = fixture(); await page.onShow(); calls.length = 0;
  const previous = { latitude: 39.8, longitude: 116.2, coordinate_system: 'GCJ02' };
  page.data.location = previous;
  global.wx.chooseLocation = options => options.fail({ errMsg: 'cancel' });
  await page.chooseMapLocation();
  assert.deepEqual(page.data.location, previous); assert.equal(calls.length, 0); assert.equal(page.data.locating, false);
});

test('POI city selection cannot attach coordinates or trigger GPS/nearby requests', async () => {
  const { page, calls } = fixture(); await page.onShow(); calls.length = 0;
  global.wx.choosePoi = options => options.success({ type: 1, city: '天津市', latitude: 39, longitude: 117 });
  global.wx.getFuzzyLocation = () => assert.fail('must not upgrade a city-only selection');
  await page.choosePoiLocation();
  assert.equal(page.data.location, null); assert.equal(calls.length, 0); assert.match(page.data.locationNotice, /选择的是城市/);
});

test('hidden fuzzy callback and unloaded native picker cannot write or send coordinates', async () => {
  for (const kind of ['current', 'map']) {
    const { page, calls } = fixture(); await page.onShow(); calls.length = 0;
    let callback; global.wx[kind === 'current' ? 'getFuzzyLocation' : 'chooseLocation'] = options => { callback = options; };
    const choosing = page.pickObservationLocation(kind);
    if (kind === 'current') page.onHide(); else page.onUnload();
    page.setData = () => assert.fail('late position must not write to hidden/unloaded page');
    callback.success({ latitude: 39, longitude: 117 }); await choosing;
    assert.equal(calls.length, 0);
  }
});

test('changing identity while native map is open discards its point before page return', async () => {
  const { page, application, calls } = fixture(); await page.onShow(); calls.length = 0;
  let picker; global.wx.chooseLocation = options => { picker = options; };
  const choosing = page.chooseMapLocation(); page.onHide();
  picker.success({ latitude: 39, longitude: 117 }); await choosing;
  application.session.save({ token: 'account-b', user: { id: 'b' } });
  await page.onShow();
  assert.equal(page.data.location, null); assert.equal(page.data.locating, false);
  assert.equal(calls.some(row => row.path === 'nearby-water-bodies/'), false);
});

test('registered private interfaces match one-shot code and permission descriptions fit platform limits', () => {
  const manifest = require('../app.json');
  assert.deepEqual(manifest.requiredPrivateInfos.sort(), ['chooseLocation', 'choosePoi', 'getFuzzyLocation'].sort());
  for (const name of ['scope.userLocation', 'scope.userFuzzyLocation']) assert.ok(Array.from(manifest.permission[name].desc).length <= 30);
  assert.equal(manifest.requiredPrivateInfos.includes('onLocationChange'), false);
  assert.equal(manifest.requiredPrivateInfos.includes('getLocation'), false);
});

test('fuzzy GCJ02 is only a nearby search reference and is never saved with an observation', async () => {
  const { page, calls, application } = fixture(); await page.onShow(); calls.length = 0;
  global.wx.getFuzzyLocation = options => options.success({ latitude: 39.9, longitude: 116.4, accuracy: 3000, altitude: 12 });
  await page.locate();
  assert.equal(page.data.location, null); assert.equal(page.data.locationSource, '');
  assert.equal(page.data.referenceLabel, '模糊参考位置'); assert.equal(page.data.referenceAccuracy, '定位精度约 3000 米');
  assert.match(page.data.locationNotice, /不保存为观察位置/);
  assert.deepEqual(calls[0].options.data, { latitude: 39.9, longitude: 116.4, coordinate_system: 'GCJ02' });
  page.acceptNearby();
  let submitted; application.api.upload = async () => ({ id: 'photo' });
  application.api.request = async (path, options) => { submitted = { path, data: options.data }; return { data: { id: 'job', status: 'queued' } }; };
  Object.assign(page.data, { capabilityKnown: true, capability: { enabled: true }, imageOrigin: 'selected', imagePath: '/photo.jpg' });
  page.poll = async () => {};
  await page.submit();
  assert.deepEqual(submitted, { path: 'assessment-jobs/', data: { asset_id: 'photo', water_body_id: 'candidate' } });
});

test('a specific map point stays distinct from a later fuzzy query and is the only point submitted', async () => {
  const { page, application } = fixture(); await page.onShow();
  global.wx.chooseLocation = options => options.success({ latitude: 39.8, longitude: 116.2, name: '观察河岸' });
  await page.chooseMapLocation();
  assert.equal(page.data.locationSource, 'map');
  global.wx.getFuzzyLocation = options => options.success({ latitude: 39.9, longitude: 116.4 });
  await page.locate();
  assert.deepEqual(page.data.location, { latitude: 39.8, longitude: 116.2, coordinate_system: 'GCJ02' });
  assert.match(page.data.locationNotice, /具体观察点保持不变/); assert.equal(page.data.referenceAccuracy, '定位精度未提供');
  let payload; application.api.upload = async () => ({ id: 'photo' });
  application.api.request = async (_, options) => { payload = options.data; return { data: { id: 'job', status: 'queued' } }; };
  Object.assign(page.data, { capabilityKnown: true, capability: { enabled: true }, imageOrigin: 'selected', imagePath: '/photo.jpg' });
  page.poll = async () => {}; await page.submit();
  assert.deepEqual(payload, { latitude: 39.8, longitude: 116.2, coordinate_system: 'GCJ02', asset_id: 'photo' });
  page.clearLocation(); assert.equal(page.data.referenceLabel, ''); assert.equal(page.data.referenceAccuracy, ''); assert.equal(page.data.locationSource, '');
});

test('unknown point provenance cannot be saved and missing fuzzy precision is not invented', async () => {
  assert.equal(selected('current', { latitude: 39, longitude: 117 }).accuracy_m, null);
  assert.equal(selected('current', { latitude: 39, longitude: 117, accuracy: Infinity }).accuracy_m, null);
  const { page, application } = fixture(); await page.onShow();
  let payload; application.api.upload = async () => ({ id: 'photo' });
  application.api.request = async (_, options) => { payload = options.data; return { data: { id: 'job', status: 'queued' } }; };
  Object.assign(page.data, { capabilityKnown: true, capability: { enabled: true }, imageOrigin: 'selected', imagePath: '/photo.jpg', location: { latitude: 39, longitude: 117, coordinate_system: 'GCJ02' }, locationSource: 'fuzzy' });
  page.poll = async () => {}; await page.submit(); assert.deepEqual(payload, { asset_id: 'photo' });
});
