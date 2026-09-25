const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { capability, resultView } = require('../lib/assessment');
const { summaryView } = require('../pages/assessment/summary');

const health = { features: { assessment: true }, assessment: { enabled: true, model_name: 'IWHR prototype', model_version: 'iwhr-1', rule_version: 'rules-1' } };
const detection = { class_id: 9, label: '漂浮物', eval_category: 'floating_debris', confidence: .91, bbox: [200, 100, 600, 300], area_ratio: .04 };
const succeeded = { id: 'job', asset_id: 'asset', status: 'succeeded', image_width: 2000, image_height: 1000, detections: [detection], score: 85, model: { name: 'IWHR prototype', version: 'iwhr-old' }, model_version: 'bad-uuid-do-not-display', rule_version: 'rules-old', created_at: '2026-09-20T00:00:00Z', causes: [{ rule: 'float', text: '画面中存在漂浮物候选，需人工核对。' }] };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function application(api, guest) {
  const storage = new Map();
  const session = createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) });
  if (!guest) session.save({ token: 'token-a', user: { id: 'user-a' } });
  return { session, globalData: {}, config: { maxUploadBytes: 5 * 1024 * 1024 }, api: api || {} };
}
function page(app, name) {
  let definition;
  global.Page = (value) => { definition = value; };
  global.getApp = () => app;
  global.wx = { stopPullDownRefresh() {}, showToast() {}, showModal() {}, setNavigationBarTitle() {} };
  const path = require.resolve('../pages/' + (name || 'assessment') + '/index');
  delete require.cache[path];
  require(path);
  return Object.assign({}, definition, { data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } });
}
function fixtureAPI(jobs) {
  return { request: async (url) => {
    if (url === 'health/') return { data: health };
    if (url === 'water-bodies/') return { data: [{ id: 'water', name: '示范河' }] };
    if (url === 'assessment-jobs/') return { data: jobs || [] };
    return { data: succeeded };
  } };
}
function ready(instance) {
  Object.assign(instance.data, { capabilityKnown: true, capability: capability(health), imageOrigin: 'selected', imagePath: '/tmp/photo.png' });
}

test('assessment advertises only the trained floating-debris scope and respects disabled health', () => {
  assert.equal(capability({ assessment: { enabled: false }, features: { assessment: true } }).enabled, false);
  assert.equal(capability(health).modelVersion, 'iwhr-1');
  assert.match(capability({ assessment: { scope: '15 classes' } }).scope, /仅支持.*漂浮物/);
});

test('boxes use original dimensions even when a thumbnail is displayed and filter untrained classes', () => {
  const view = resultView({ ...succeeded, detections: [detection, { ...detection, class_id: 0, label: 'plastic bottle' }, { ...detection, class_id: 8, eval_category: 'outfall_discharge' }] });
  assert.equal(view.detections.length, 1);
  assert.equal(view.boxes[0].box_style, 'left:10%;top:10%;width:20%;height:20%;');
  assert.equal(view.detections[0].label, '水面漂浮物');
  assert.equal(view.detections[0].confidence_label, '0.910');
  assert.equal(view.model_version, 'iwhr-old');
  assert.equal(view.rule_version, 'rules-old');
  assert.match(view.disclaimer, /不是水面覆盖率/);
});

test('no detections never display a perfect score or good-water conclusion, including legacy jobs', () => {
  const view = resultView({ ...succeeded, detections: [], score: 100, grade: '优' });
  assert.equal(view.score_label, '—');
  assert.equal(view.has_score, false);
  assert.equal(view.heading, '暂时无法确认');
  assert.match(view.explanation, /不能据此/);
  assert.equal(resultView({ ...succeeded, status: 'failed' }), null);
});

test('invalid original dimensions or boxes are never painted as plausible coordinates', () => {
  assert.deepEqual(resultView({ ...succeeded, image_width: null }).boxes, []);
  assert.deepEqual(resultView({ ...succeeded, detections: [{ ...detection, bbox: [-1, 0, 10, 10] }, { ...detection, bbox: [0, 0, 3000, 1] }] }).boxes, []);
});

test('guest loads scope and manual water choices without requesting location or private history', async () => {
  const calls = [];
  const app = application({ request: async (url) => { calls.push(url); return { data: url === 'health/' ? health : [{ id: 'water', name: '示范河' }] }; } }, true);
  const instance = page(app);
  global.wx.getLocation = () => { throw new Error('Unexpected automatic location'); };
  await instance.onShow();
  assert.deepEqual(calls, ['health/', 'water-bodies/']);
  assert.equal(instance.data.waterIndex, 0);
  assert.equal(instance.data.location, null);
  assert.equal(instance.data.capability.enabled, true);
});

test('optional location uses GCJ02, presents a suggestion and waits for manual association', async () => {
  let locationRequest, nearbyQuery;
  const app = application({ request: async (url, options) => { nearbyQuery = { url, options }; return { data: { match: { water_body_id: 'nearby', water_body_name: '候选河', suggestion_only: true } } }; } });
  const instance = page(app);
  global.wx.getLocation = (value) => { locationRequest = value; };
  instance.locate();
  assert.equal(locationRequest.type, 'gcj02');
  await locationRequest.success({ latitude: 30.123, longitude: 120.456 });
  assert.deepEqual(nearbyQuery.options.data, { latitude: 30.123, longitude: 120.456, coordinate_system: 'GCJ02' });
  assert.equal(nearbyQuery.url, 'nearby-water-bodies/');
  assert.equal(instance.data.waterIndex, 0);
  instance.acceptNearby();
  assert.equal(instance.data.waterBodies[instance.data.waterIndex].id, 'nearby');
  instance.clearLocation();
  assert.equal(instance.data.location, null);
  assert.equal(instance.data.waterBodies[instance.data.waterIndex].id, 'nearby');
});

test('denied location still allows photo submission and never fabricates zero coordinates', async () => {
  let created;
  const app = application({ upload: async (file, purpose) => { assert.equal(purpose, 'recognition'); return { id: 'fresh-asset' }; }, request: async (url, options) => { created = { url, data: options.data }; return { data: { id: 'new', status: 'queued' } }; } });
  const instance = page(app);
  ready(instance);
  global.wx.getLocation = (options) => options.fail({ errMsg: 'auth deny' });
  instance.locate();
  assert.match(instance.data.locationNotice, /仍可/);
  await instance.submit();
  assert.deepEqual(created, { url: 'assessment-jobs/', data: { asset_id: 'fresh-asset' } });
  assert.equal(instance.data.busy, false);
});

test('clearing location discards an in-flight nearby suggestion and never reattaches coordinates', async () => {
  const nearby = deferred();
  let locationRequest;
  const instance = page(application({ request: () => nearby.promise }));
  global.wx.getLocation = (value) => { locationRequest = value; };
  instance.locate();
  const finding = locationRequest.success({ latitude: 30, longitude: 120 });
  instance.clearLocation();
  nearby.resolve({ data: { match: { water_body_id: 'stale-water', water_body_name: '旧候选' } } });
  await finding;
  assert.equal(instance.data.location, null);
  assert.equal(instance.data.nearby, null);
  assert.equal(instance.data.locating, false);
});

test('a late location permission callback cannot write after page unload', async () => {
  let locationRequest;
  const instance = page(application({ request: async () => { throw new Error('request after unload'); } }));
  global.wx.getLocation = (value) => { locationRequest = value; };
  instance.locate();
  instance.onUnload();
  instance.setData = () => { throw new Error('write after unload'); };
  await locationRequest.success({ latitude: 30, longitude: 120 });
});

test('manual water association submits independently without requesting GPS', async () => {
  let payload;
  const instance = page(application({ upload: async () => ({ id: 'fresh' }), request: async (url, options) => { payload = options.data; return { data: { id: 'queued', status: 'queued' } }; } }));
  ready(instance);
  instance.data.waterBodies.push({ id: 'manual-water', name: '示范河' });
  instance.changeWater({ detail: { value: '1' } });
  await instance.submit();
  assert.deepEqual(payload, { asset_id: 'fresh', water_body_id: 'manual-water' });
});

test('river upload needs a selected photo and explicit submit but no repeated agreement checkbox', async () => {
  const uploads = [], requests = [], selections = [];
  const instance = page(application({
    upload: async (file) => { uploads.push(file); return { id: 'river-asset' }; },
    request: async (url, options) => { requests.push([url, options]); return { data: { id: 'river-job', status: 'queued' } }; },
  }));
  ready(instance);
  instance.data.imagePath = ''; instance.data.imageOrigin = '';
  global.wx.getLocation = () => { throw new Error('GPS must not be acquired automatically'); };
  global.wx.chooseMedia = (options) => selections.push(options);
  instance.poll = async () => {};
  assert.equal(Object.hasOwn(instance.data, 'consent'), false);
  await instance.submit();
  assert.equal(uploads.length, 0);
  instance.choose();
  assert.equal(selections.length, 1);
  selections[0].success({ tempFiles: [{ tempFilePath: '/tmp/selected-river.jpg', size: 2048 }] });
  assert.equal(uploads.length, 0);
  await instance.submit();
  assert.deepEqual(uploads, ['/tmp/selected-river.jpg']);
  assert.deepEqual(requests[0][1].data, { asset_id: 'river-asset' });
});

test('disabled assessment never uploads a new photo', async () => {
  const instance = page(application({ upload: async () => { throw new Error('must not upload'); } }));
  ready(instance);
  instance.data.capability.enabled = false;
  await instance.submit();
  assert.match(instance.data.error, /未启用/);
  assert.equal(instance.data.busy, false);
});

test('historical preview uses private download and original historical model metadata', async () => {
  const app = application({ request: async () => ({ data: succeeded }), download: async (url) => { assert.equal(url, 'uploads/asset/content/?variant=thumbnail'); return '/tmp/private-thumb.jpg'; } });
  const instance = page(app);
  instance.data.capability = capability(health);
  await instance.selectJob('job');
  assert.equal(instance.data.imagePath, '/tmp/private-thumb.jpg');
  assert.equal(instance.data.task.result_view.model_version, 'iwhr-old');
  assert.equal(instance.data.imageOrigin, 'history');
});

test('401 during private image download clears the record, preview, location and history', async () => {
  const app = application({ request: async () => ({ data: succeeded }) });
  app.api.download = async () => { app.session.clear(); throw Object.assign(new Error('expired'), { status: 401 }); };
  const instance = page(app);
  instance.data.jobs = [succeeded];
  instance.data.location = { latitude: 30, longitude: 120, coordinate_system: 'GCJ02' };
  await instance.selectJob('job');
  assert.equal(instance.data.task, null);
  assert.equal(instance.data.imagePath, '');
  assert.equal(instance.data.location, null);
  assert.deepEqual(instance.data.jobs, []);
  assert.equal(instance.data.busy, false);
});

test('a late old-session download cannot overwrite or clear the new account state', async () => {
  const download = deferred();
  const app = application({ ...fixtureAPI(), download: () => download.promise });
  const instance = page(app);
  await instance.onShow();
  const selecting = instance.selectJob('old-private');
  await Promise.resolve();
  app.session.save({ token: 'token-b', user: { id: 'user-b' } });
  await instance.onShow();
  instance.setData({ imagePath: '/tmp/new-account-photo.jpg', imageOrigin: 'selected' });
  download.resolve('/tmp/old-private.jpg');
  await selecting;
  assert.equal(instance.data.imagePath, '/tmp/new-account-photo.jpg');
  assert.equal(instance.data.task, null);
});

test('unloading during upload prevents assessment creation and later state writes', async () => {
  const upload = deferred();
  let creates = 0;
  const instance = page(application({ upload: () => upload.promise, request: async () => { creates += 1; return { data: {} }; } }));
  ready(instance);
  const submitting = instance.submit();
  instance.onUnload();
  instance.setData = () => { throw new Error('write after unload'); };
  upload.resolve({ id: 'uploaded' });
  await submitting;
  assert.equal(creates, 0);
});

test('hiding during a poll prevents a stale result and any new polling timer', async () => {
  const response = deferred();
  const instance = page(application({ request: () => response.promise }));
  instance._visible = true;
  instance.data.task = { id: 'job', status: 'queued' };
  const polling = instance.poll('job');
  instance.onHide();
  response.resolve({ data: { id: 'job', status: 'running' } });
  await polling;
  assert.equal(instance.data.task.status, 'queued');
  assert.equal(instance._timer, null);
});

test('an old poll response cannot overwrite a newer manual refresh', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const instance = page(application({ request: () => ++count === 1 ? first.promise : second.promise }));
  instance._visible = true;
  instance._pollCount = 19;
  instance.data.task = { id: 'job', status: 'queued' };
  const oldPoll = instance.poll('job'), newPoll = instance.poll('job');
  second.resolve({ data: { id: 'job', status: 'running' } });
  await newPoll;
  first.resolve({ data: { id: 'job', status: 'queued' } });
  await oldPoll;
  assert.equal(instance.data.task.status, 'running');
  assert.equal(instance._timer, null);
});

test('deletion of a selected assessment clears its private image and reloads history', async () => {
  let deleted = false, modal;
  const app = application(fixtureAPI());
  const original = app.api.request;
  app.api.request = async (url, options) => {
    if (options && options.method === 'DELETE') { deleted = true; assert.equal(url, 'assessment-jobs/job/'); return { data: null }; }
    return original(url, options);
  };
  const instance = page(app);
  Object.assign(instance.data, { task: succeeded, imagePath: '/tmp/private.jpg', imageOrigin: 'history' });
  global.wx.showModal = (value) => { modal = value; };
  instance.remove({ currentTarget: { dataset: { id: 'job' } } });
  await modal.success({ confirm: true });
  assert.equal(deleted, true);
  assert.equal(instance.data.task, null);
  assert.equal(instance.data.imagePath, '');
  assert.equal(instance.data.imageReady, false);
});

test('deleted or expired selected jobs clear the cached thumbnail on reload', async () => {
  const app = application(fixtureAPI());
  const original = app.api.request;
  app.api.request = async (url, options) => { if (url === 'assessment-jobs/job/') throw Object.assign(new Error('gone'), { status: 404 }); return original(url, options); };
  const instance = page(app);
  Object.assign(instance.data, { task: succeeded, imagePath: '/tmp/private.jpg', imageOrigin: 'history' });
  await instance.load();
  assert.equal(instance.data.task, null);
  assert.equal(instance.data.imagePath, '');
  assert.match(instance.data.error, /已删除/);
});

test('assessment record rows link to the independent page and retain uncertain semantics', async () => {
  const instance = page(application({ request: async () => ({ data: [{ ...succeeded, detections: [], score: null }] }) }), 'records');
  instance.data.kind = 'assessment-jobs';
  await instance.load();
  assert.equal(instance.data.records[0].title, '河道图像观察');
  assert.equal(instance.data.records[0].result_view.heading, '暂时无法确认');
  let navigation;
  global.wx.navigateTo = (value) => { navigation = value.url; };
  instance.open({ currentTarget: { dataset: { id: 'job' } } });
  assert.equal(navigation, '/pages/assessment/index?jobId=job');
});

function observationSummary() {
  return { schema_version: 1, status: 'ready', candidate_count: 2, excluded_count: 0, box_area_ratio: .15,
    confidence: { min: .4, max: .8, mean: .6 },
    grid: Array.from({ length: 9 }, (_, index) => ({ key: String(index), count: index === 4 ? 2 : 0 })) };
}

test('observation summary displays image-only area, confidence and nine original-image cells', () => {
  const view = summaryView({ ...succeeded, observation_summary: observationSummary() });
  assert.equal(view.ready, true);
  assert.equal(view.count, 2);
  assert.equal(view.area, '15.00%');
  assert.equal(view.confidence, '0.400 – 0.800');
  assert.equal(view.grid[4].label, '中央');
  assert.equal(view.grid[4].count, 2);
  assert.equal(view.grid[4].active, true);
  assert.equal(view.grid[0].active, false);
  assert.equal(summaryView({ ...succeeded, observation_summary: { ...observationSummary(), box_area_ratio: .00000001 } }).area, '< 0.01%');
});

test('inconsistent, legacy, unknown and empty summaries never display plausible zero metrics', () => {
  const valid = observationSummary();
  for (const summary of [null, { ...valid, schema_version: 2 }, { ...valid, candidate_count: 0 },
    { ...valid, confidence: { min: .8, max: .4, mean: .6 } }, { ...valid, box_area_ratio: Infinity },
    { ...valid, grid: valid.grid.slice(1) }, { ...valid, candidate_count: 3 },
    { ...valid, grid: valid.grid.map((item) => ({ ...item, key: '0' })) },
    { ...valid, excluded_count: -1 }, { ...valid, status: 'unavailable', reason: 'NO_SUPPORTED_DETECTIONS' }]) {
    const view = summaryView({ ...succeeded, observation_summary: summary });
    assert.equal(view.ready, false);
    assert.equal(view.area, undefined);
    assert.match(view.message, /不能|不完整/);
  }
  assert.equal(summaryView({ ...succeeded, status: 'running', observation_summary: valid }), null);
});

test('private history loads the observation summary through the normal identity guards', async () => {
  const job = { ...succeeded, observation_summary: observationSummary() };
  const instance = page(application({ request: async () => ({ data: job }), download: async () => '/tmp/private-summary.jpg' }));
  await instance.selectJob('job');
  assert.equal(instance.data.task.summary_view.count, 2);
  assert.equal(instance.data.task.summary_view.grid.length, 9);
  instance.clearPrivate();
  assert.equal(instance.data.task, null);
});
