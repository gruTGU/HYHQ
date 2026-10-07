const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { time, value } = require('../lib/format');

function page(name, application) {
  let definition;
  global.Page = (input) => { definition = input; };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, showToast() {}, showModal() {}, setNavigationBarTitle() {} };
  const path = require.resolve('../pages/' + name + '/index');
  delete require.cache[path];
  require(path);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return instance;
}
function session() {
  const storage = new Map();
  return createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, val) => storage.set(key, val), removeStorageSync: (key) => storage.delete(key) });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function loggedApp(api) {
  const current = session();
  current.save({ token: 'active-token', user: { id: 'active-user' } });
  return { globalData: {}, config: { maxUploadBytes: 5 * 1024 * 1024 }, session: current, api };
}

test('home obtains real API fixtures, preserves zero values and warns that official alerts are not connected', async () => {
  const calls = [];
  const fixtures = {
    'health/': { status: 'ok', mode: 'simulation' },
    'regions/': [{ id: 'region1', name: '示范区域' }],
    'weather/': { temperature: 0, humidity: 0, source_type: 'simulation', status: 'available' },
    'air-quality/': { pm25: 0, pm10: 10, source_type: 'simulation' },
    'weather-alerts/': { status: 'not_connected', alerts: [], notice: '官方气象预警尚未接入' },
  };
  const app = { globalData: {}, api: { request: async (url, options) => { calls.push({ url, options }); return { data: fixtures[url] }; } } };
  const instance = page('home', app);
  instance.data.observationExpanded = true;
  await instance.load();
  assert.equal(instance.data.weather.temp_label, '0°');
  assert.equal(instance.data.air.pm25_label, '0');
  assert.equal(instance.data.alertNotice, '官方气象预警尚未接入');
  assert.equal(calls.find((call) => call.url === 'weather/').options.data.region, 'region1');
  assert.equal(instance.data.loading, false);
});

test('home displays partial failure instead of silently replacing upstream data', async () => {
  const app = { globalData: {}, api: { request: async (url) => {
    if (url === 'health/') return { data: { mode: 'simulation' } };
    if (url === 'regions/') return { data: [{ id: 'region' }] };
    if (url === 'weather/') throw new Error('weather unavailable');
    return { data: { source_type: 'simulation', alerts: [] } };
  } } };
  const instance = page('home', app);
  instance.data.observationExpanded = true;
  await instance.load();
  assert.equal(instance.data.weather, null);
  assert.equal(instance.data.sections[0].key, 'weather');
  assert.equal(instance.data.sections[0].error, 'weather unavailable');
});

test('development login is offered only when both client and server enable it', async () => {
  for (const [local, remote, expected] of [[true, true, true], [false, true, false], [true, false, false]]) {
    const app = { config: { development: local }, globalData: {}, session: session(), api: { request: async () => ({ data: { dev_auth_enabled: remote } }) } };
    const instance = page('profile', app);
    await instance.load();
    assert.equal(instance.data.devAvailable, expected);
  }
});

test('recognition clears private task data when identity changes or authorization fails', async () => {
  const current = session();
  current.save({ token: 'a', user: { id: 'user-a' } });
  const app = { globalData: {}, session: current, api: { request: async (url) => ({ data: url === 'health/' ? { features: { recognition: false } } : [] }) } };
  const instance = page('recognize', app);
  instance._userId = 'user-before';
  instance.data.task = { id: 'private-old-task' };
  await instance.onShow();
  assert.equal(instance.data.task, null);
  instance.data.task = { id: 'private-new-task' };
  instance.data.jobs = [{ id: 'private-new-task' }];
  current.clear();
  instance.authError(new Error('请重新登录'));
  assert.equal(instance.data.task, null);
  assert.deepEqual(instance.data.jobs, []);
});

test('formatters preserve missing data and use fixed UTC+8 display', () => {
  assert.equal(value(null), '—');
  assert.equal(value(0, 'mg/L'), '0mg/L');
  assert.equal(time('2026-09-16T00:00:00Z'), '2026-09-16 08:00 UTC+8');
});

test('guest recognition page reads live capability and coverage without requiring login', async () => {
  const app = { globalData: {}, session: session(), api: { request: async (url) => {
    assert.equal(url, 'health/');
    return { data: { features: { recognition: true }, recognition: { enabled: true, scope: '五类花卉原型', labels: [{ id: 'daisy', name: '雏菊类' }], model_name: 'Flower prototype', model_version: '1.0' } } };
  } } };
  const instance = page('recognize', app);
  await instance.load();
  assert.equal(instance.data.loggedIn, false);
  assert.equal(instance.data.capabilityKnown, true);
  assert.equal(instance.data.capability.enabled, true);
  assert.equal(instance.data.capability.labels[0].name, '雏菊类');
  assert.equal(instance.data.loading, false);
});

test('recognition page keeps successful uncertain results distinct from disabled model failures', async () => {
  const current = session();
  current.save({ token: 'a', user: { id: 'user-a' } });
  const app = { globalData: {}, session: current, api: { request: async (url) => ({ data: url === 'health/' ? { features: { recognition: true } } : [
    { id: 'job-1', status: 'succeeded', result: { decision: 'uncertain', candidates: [{ label: 'daisy', name: '雏菊类', score: .2 }], model: { name: 'Flower prototype', version: '1.0' } } },
    { id: 'job-2', status: 'failed', error_code: 'MODEL_NOT_CONFIGURED' },
  ] }) } };
  const instance = page('recognize', app);
  instance.data.task = { id: 'job-1' };
  await instance.load();
  assert.equal(instance.data.task.result_view.heading, '暂时无法确认');
  assert.equal(instance.data.task.status, 'succeeded');
  assert.equal(instance.data.jobs[1].result_view, null);
});

test('repeat refresh discards an older polling response and does not overwrite newer task state', async () => {
  const first = deferred(), second = deferred();
  let requestCount = 0;
  const instance = page('recognize', loggedApp({ request: () => (++requestCount === 1 ? first.promise : second.promise) }));
  instance._visible = true;
  instance._pollCount = 9;
  instance.data.task = { id: 'job', status: 'queued' };
  const oldPoll = instance.poll('job');
  const newPoll = instance.poll('job');
  second.resolve({ data: { id: 'job', status: 'running' } });
  await newPoll;
  first.resolve({ data: { id: 'job', status: 'queued' } });
  await oldPoll;
  assert.equal(instance.data.task.status, 'running');
  assert.equal(instance._pollCount, 10);
  assert.equal(instance._timer, null);
});

test('an in-flight poll cannot touch an unloaded page or start another timer', async () => {
  const pending = deferred();
  const instance = page('recognize', loggedApp({ request: () => pending.promise }));
  instance._visible = true;
  instance.data.task = { id: 'job', status: 'queued' };
  const polling = instance.poll('job');
  instance.onUnload();
  instance.setData = () => { throw new Error('setData after unload'); };
  pending.resolve({ data: { id: 'job', status: 'running' } });
  await polling;
  assert.equal(instance._timer, null);
});

test('unloading during upload prevents creating a new recognition job', async () => {
  const upload = deferred();
  let requests = 0;
  const instance = page('recognize', loggedApp({ upload: () => upload.promise, request: async () => { requests += 1; return { data: {} }; } }));
  Object.assign(instance.data, { imagePath: '/tmp/chosen.jpg', imageOrigin: 'selected' });
  const submitting = instance.submit();
  instance.onUnload();
  instance.setData = () => { throw new Error('setData after unload'); };
  upload.resolve({ id: 'uploaded' });
  await submitting;
  assert.equal(requests, 0);
});

test('canceling image selection preserves the current photo and result without error feedback', () => {
  const instance = page('recognize', loggedApp({}));
  Object.assign(instance.data, { imagePath: '/tmp/current.jpg', task: { id: 'current' } });
  let options;
  global.wx.chooseMedia = (value) => { options = value; };
  global.wx.showToast = () => { throw new Error('Cancel should be silent'); };
  instance.choose();
  options.fail({ errMsg: 'chooseMedia:fail cancel' });
  assert.equal(instance.data.imagePath, '/tmp/current.jpg');
  assert.equal(instance.data.task.id, 'current');
});

test('flower selection stays a native user action and uploads only on submit without an agreement gate', async () => {
  const uploads = [], jobs = [], selections = [];
  const instance = page('recognize', loggedApp({
    upload: async (image, purpose) => { uploads.push([image, purpose]); return { id: 'chosen-asset' }; },
    request: async (path, options) => { jobs.push([path, options]); return { data: { id: 'new-job', status: 'queued' } }; },
  }));
  global.wx.chooseMedia = (options) => selections.push(options);
  assert.equal(Object.hasOwn(instance.data, 'consent'), false);
  assert.equal(uploads.length, 0);
  instance.choose();
  assert.equal(selections.length, 1);
  assert.deepEqual(selections[0].sourceType, ['album', 'camera']);
  selections[0].success({ tempFiles: [{ tempFilePath: '/tmp/selected-flower.jpg', size: 2048 }] });
  assert.equal(uploads.length, 0);
  instance.poll = async () => {};
  await instance.submit();
  assert.deepEqual(uploads, [['/tmp/selected-flower.jpg', 'recognition']]);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0][1].data, { asset_id: 'chosen-asset' });
});

test('expired historical thumbnail keeps the original model version and provides an image notice', async () => {
  const instance = page('recognize', loggedApp({
    request: async () => ({ data: { id: 'historical', asset_id: 'asset', status: 'succeeded', result: { decision: 'recognized', candidates: [{ label: 'daisy', name: '雏菊类', score: .9 }], model: { name: 'Historical model', version: 'old-1' } } } }),
    download: async () => { throw Object.assign(new Error('gone'), { status: 404 }); },
  }));
  instance.data.capability.modelVersion = 'new-2';
  await instance.selectJob('historical');
  assert.equal(instance.data.task.result_view.model_version, 'old-1');
  assert.equal(instance.data.imagePath, '');
  assert.match(instance.data.imageUnavailable, /暂不可访问/);
  assert.equal(instance.data.busy, false);
});

test('a deleted selected job is cleared on reload, including its cached private thumbnail', async () => {
  const instance = page('recognize', loggedApp({ request: async (url) => {
    if (url === 'health/') return { data: { features: { recognition: true } } };
    if (url === 'recognition-jobs/') return { data: [] };
    throw Object.assign(new Error('Not found'), { status: 404 });
  } }));
  Object.assign(instance.data, { task: { id: 'deleted' }, imageOrigin: 'history', imagePath: '/tmp/private.jpg' });
  await instance.load();
  assert.equal(instance.data.task, null);
  assert.equal(instance.data.imagePath, '');
  assert.match(instance.data.error, /已删除/);
});

test('401 during submission clears private data and releases the busy state', async () => {
  const app = loggedApp({});
  app.api.upload = async () => { app.session.clear(); throw Object.assign(new Error('Session expired'), { status: 401 }); };
  const instance = page('recognize', app);
  Object.assign(instance.data, { imagePath: '/tmp/chosen.jpg' });
  await instance.submit();
  assert.equal(instance.data.imagePath, '');
  assert.equal(instance.data.loggedIn, false);
  assert.equal(instance.data.busy, false);
  assert.match(instance.data.error, /Session expired/);
});

test('renewing the same account session during upload releases stale busy state without creating a job', async () => {
  const upload = deferred();
  let created = 0;
  const app = loggedApp({
    upload: () => upload.promise,
    request: async (url, options) => {
      if (options && options.method === 'POST') created += 1;
      return { data: url === 'health/' ? { features: { recognition: true } } : [] };
    },
  });
  const instance = page('recognize', app);
  await instance.onShow();
  Object.assign(instance.data, { imagePath: '/tmp/chosen.jpg', imageOrigin: 'selected' });
  const submitting = instance.submit();
  assert.equal(instance.data.busy, true);
  instance.onHide();
  app.session.save({ token: 'renewed-token', user: { id: 'active-user' } });
  await instance.onShow();
  assert.equal(instance.data.busy, false);
  assert.equal(instance.data.imagePath, '');
  upload.resolve({ id: 'old-session-upload' });
  await submitting;
  assert.equal(created, 0);
  assert.equal(instance.data.task, null);
});

test('record responses from a previous session never populate the new account view', async () => {
  const pending = deferred();
  const app = loggedApp({ request: () => pending.promise });
  const instance = page('records', app);
  Object.assign(instance.data, { kind: 'recognition-jobs', records: [{ id: 'cached-private' }], next: 'recognition-jobs/?page=2' });
  const loading = instance.load();
  app.session.save({ token: 'new-token', user: { id: 'new-user' } });
  pending.resolve({ data: [{ id: 'old-private', status: 'succeeded' }], meta: { next: '/api/v1/recognition-jobs/?page=2' } });
  await loading;
  assert.deepEqual(instance.data.records, []);
  assert.equal(instance.data.next, null);
  assert.equal(instance.data.loading, false);
  assert.match(instance.data.error, /登录状态已变化/);
});

test('an in-flight records request does not write to an unloaded page', async () => {
  const pending = deferred();
  const instance = page('records', loggedApp({ request: () => pending.promise }));
  instance.data.kind = 'recognition-jobs';
  const loading = instance.load();
  instance.onUnload();
  instance.setData = () => { throw new Error('setData after unload'); };
  pending.resolve({ data: [] });
  await loading;
});

test('record pagination clears all private items and next URL when a 401 expires the session', async () => {
  const app = loggedApp({});
  app.api.request = async () => { app.session.clear(); throw Object.assign(new Error('Session expired'), { status: 401 }); };
  const instance = page('records', app);
  Object.assign(instance.data, { kind: 'recognition-jobs', records: [{ id: 'private' }], next: 'recognition-jobs/?page=2' });
  await instance.load(true);
  assert.deepEqual(instance.data.records, []);
  assert.equal(instance.data.next, null);
  assert.equal(instance.data.loadingMore, false);
});

test('record deletion confirmation cannot send a request after the page is unloaded', async () => {
  let options;
  const instance = page('records', loggedApp({ request: async () => { throw new Error('request after unload'); } }));
  instance.data.kind = 'recognition-jobs';
  global.wx.showModal = (value) => { options = value; };
  instance.remove({ currentTarget: { dataset: { id: 'private-job' } } });
  instance.onUnload();
  instance.setData = () => { throw new Error('setData after unload'); };
  await options.success({ confirm: true });
});
