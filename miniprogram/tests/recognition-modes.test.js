const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { capability } = require('../lib/assessment');
const health = { recognition: { enabled: true }, assessment: { enabled: true } };
const finished = { id: 'river-result', status: 'succeeded', asset_id: 'river-asset', detections: [], created_at: '2026-10-03T00:00:00Z' };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
function setup(handler, guest = false) {
  const storage = new Map(), calls = [], navigations = [], events = [], media = [], locations = [], nextTicks = [];
  const flushNextTick = () => { while (nextTicks.length) nextTicks.shift()(); };
  const session = createSession({ getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) });
  if (!guest) session.save({ token: 'account-a', user: { id: 'a' } });
  const app = { session, config: { maxUploadBytes: 5 * 1024 * 1024 }, globalData: {}, api: {
    request: async (path, options = {}) => { calls.push({ path, options, token: session.token() }); if (handler) { const result = await handler(path, options); if (result !== undefined) return result; }
      if (path === 'health/') return { data: health };
      if (path === 'water-bodies/' || !options.method && ['recognition-jobs/', 'assessment-jobs/'].includes(path)) return { data: [] };
      return { data: finished };
    }, upload: async (file, purpose) => { calls.push({ upload: file, purpose }); if (handler) { const result = await handler('upload', { file, purpose }); if (result !== undefined) return result; } return { id: 'new-asset' }; },
    download: async () => '/private/thumbnail.jpg',
  } };
  global.getApp = () => app;
  global.wx = { nextTick: callback => nextTicks.push(callback), stopPullDownRefresh() {}, showToast() {}, showModal() {}, navigateTo: options => navigations.push(options.url), switchTab: options => navigations.push(options.url), chooseMedia: options => media.push(options), getFuzzyLocation: options => locations.push(options) };
  let pageDef; global.Page = definition => { pageDef = definition; };
  const filename = require.resolve('../pages/recognize/index'); delete require.cache[filename]; require(filename);
  const page = { ...pageDef, data: structuredClone(pageDef.data) }; page.setData = patch => Object.assign(page.data, patch);
  let componentDef; global.Component = definition => { componentDef = definition; };
  const componentFile = require.resolve('../components/river-observer/index'); delete require.cache[componentFile]; require(componentFile);
  const observer = { ...componentDef.methods, properties: { jobId: '' }, data: structuredClone(componentDef.data), triggerEvent: (name, detail) => events.push({ name, detail }) };
  observer.setData = patch => { Object.assign(observer.data, patch); if ('busy' in patch || 'locating' in patch) componentDef.observers['busy, locating'].call(observer, observer.data.busy, observer.data.locating); };
  return { app, page, observer, componentDef, calls, navigations, events, media, locations, nextTicks, flushNextTick };
}
const mode = value => ({ currentTarget: { dataset: { mode: value } } });

test('flower and river selection stay on the same tab and switch off hidden flower polling', async () => {
  const f = setup(); await f.page.onShow(); f.page._timer = setTimeout(() => { throw new Error('hidden polling'); }, 10000);
  f.page.data.imagePath = '/private/flower.jpg'; f.page.data.imageOrigin = 'selected';
  f.page.assessment(); assert.equal(f.page.data.mode, 'assessment'); assert.equal(f.page._timer, null); assert.deepEqual(f.navigations, []);
  const before = f.calls.length; await f.page.load(); await f.page.submit(); assert.equal(f.calls.length, before);
  await f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'recognition'); assert.equal(f.page.data.imagePath, '/private/flower.jpg');
  assert.deepEqual(f.navigations, []);
});

test('uploads and optional location work prevent mode changes, including programmatic taps', async () => {
  const f = setup(); await f.page.onShow(); f.page.data.busy = true; f.page.assessment(); assert.equal(f.page.data.mode, 'recognition');
  f.page.data.busy = false; f.page.assessment(); f.page.riverBusyChange({ detail: { busy: true } });
  f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'assessment');
  f.page.riverBusyChange({ detail: { busy: false } }); await f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'recognition');
  f.page.changeMode(mode('unknown')); assert.equal(f.page.data.mode, 'recognition');
});

test('late flower list and picker callbacks cannot refill state after switching modes', async () => {
  const pending = deferred(); const f = setup(path => path === 'recognition-jobs/' ? pending.promise : undefined);
  const loading = f.page.onShow(); f.page.choose(); assert.equal(f.media.length, 1);
  f.page.assessment(); pending.resolve({ data: [{ id: 'old-flower', status: 'succeeded' }] }); await loading;
  f.media[0].success({ tempFiles: [{ size: 100, tempFilePath: '/old-picker.jpg' }] });
  assert.deepEqual(f.page.data.jobs, []); assert.equal(f.page.data.imagePath, ''); assert.equal(f.page.data.loading, false);
});

test('opening a flower record while the tab remembers river mode selects the correct workflow', async () => {
  const f = setup(); f.page.data.mode = 'assessment'; f.app.globalData.recognitionJobId = 'old-flower';
  await f.page.onShow(); assert.equal(f.page.data.mode, 'recognition');
  assert.ok(f.calls.some(row => row.path === 'recognition-jobs/old-flower/'));
  assert.equal(f.app.globalData.recognitionJobId, null); assert.equal(f.page.data.riverBusy, false);
});

test('embedded guest observation loads public capabilities without login, location or private history', async () => {
  const f = setup(undefined, true); await f.componentDef.lifetimes.attached.call(f.observer);
  const calls = f.calls.length; await f.componentDef.pageLifetimes.show.call(f.observer);
  assert.equal(f.calls.length, calls); assert.deepEqual(f.calls.map(row => row.path).sort(), ['health/', 'water-bodies/']);
  assert.equal(f.locations.length, 0); assert.equal(f.observer.data.loggedIn, false); assert.equal(f.observer.data.embedded, true);
});

test('embedded observation keeps a separate freshly uploaded asset and posts only its own association', async () => {
  const f = setup(); await f.componentDef.lifetimes.attached.call(f.observer);
  Object.assign(f.observer.data, { capabilityKnown: true, capability: capability(health), imageOrigin: 'selected', imagePath: '/river.jpg', waterBodies: [{ id: '' }, { id: 'selected-water' }], waterIndex: 1, location: null });
  const submission = f.observer.submit(); f.flushNextTick(); await submission; f.flushNextTick();
  assert.deepEqual(f.calls.find(row => row.options && row.options.method === 'POST').options.data, { water_body_id: 'selected-water', asset_id: 'new-asset' });
  assert.deepEqual(f.calls.find(row => row.upload), { upload: '/river.jpg', purpose: 'recognition' });
  assert.ok(f.events.some(row => row.name === 'busychange' && row.detail.busy)); assert.equal(f.events.at(-1).detail.busy, false);
});

test('detaching the embedded observer while upload is pending stops task creation and late state writes', async () => {
  const pending = deferred(), f = setup(path => path === 'upload' ? pending.promise : undefined);
  await f.componentDef.lifetimes.attached.call(f.observer);
  Object.assign(f.observer.data, { capabilityKnown: true, capability: capability(health), imageOrigin: 'selected', imagePath: '/river.jpg' });
  const upload = f.observer.submit(); f.componentDef.lifetimes.detached.call(f.observer);
  f.observer.setData = () => { throw new Error('late detached update'); }; pending.resolve({ id: 'unused-upload' }); await upload;
  assert.equal(f.calls.some(row => row.options && row.options.method === 'POST'), false); assert.equal(f.observer._timer, null);
});

test('detached location callback cannot save coordinates or send a nearby lookup', async () => {
  const f = setup(); await f.componentDef.lifetimes.attached.call(f.observer); f.observer.locate(); f.flushNextTick();
  assert.equal(f.locations.length, 1); assert.equal(f.events.at(-1).detail.busy, true);
  f.componentDef.lifetimes.detached.call(f.observer); await f.locations[0].success({ latitude: 39, longitude: 117 });
  assert.equal(f.observer.data.location, null); assert.equal(f.calls.some(row => row.path === 'nearby-water-bodies/'), false);
});

test('returning under another account clears embedded images, task and optional location', async () => {
  const f = setup(); await f.componentDef.lifetimes.attached.call(f.observer);
  Object.assign(f.observer.data, { task: finished, imagePath: '/account-a.jpg', location: { latitude: 39 }, jobs: [finished] });
  f.componentDef.pageLifetimes.hide.call(f.observer); f.app.session.save({ token: 'account-b', user: { id: 'b' } });
  await f.componentDef.pageLifetimes.show.call(f.observer);
  assert.equal(f.observer.data.task, null); assert.equal(f.observer.data.imagePath, ''); assert.equal(f.observer.data.location, null); assert.deepEqual(f.observer.data.jobs, []);
});

test('legacy river record links and embedded jobs use the same guarded controller', async () => {
  const f = setup(); let legacy; global.Page = value => { legacy = value; };
  const file = require.resolve('../pages/assessment/index'); delete require.cache[file]; require(file);
  const page = { ...legacy, data: structuredClone(legacy.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad({ jobId: 'legacy-job' }); await page.onShow(); assert.ok(f.calls.some(row => row.path === 'assessment-jobs/legacy-job/'));
  f.observer.properties.jobId = 'component-job'; await f.componentDef.lifetimes.attached.call(f.observer);
  assert.ok(f.calls.some(row => row.path === 'assessment-jobs/component-job/')); assert.equal(f.observer.data.task.id, page.data.task.id);
});

test('pull-to-refresh routes to only the currently visible observation workflow', async () => {
  const f = setup(); f.page.data.mode = 'assessment'; let refreshed = 0;
  f.page.selectComponent = id => { assert.equal(id, '#river-observer'); return { refresh: async () => { refreshed++; } }; };
  await f.page.onPullDownRefresh(); assert.equal(refreshed, 1); assert.equal(f.calls.length, 0);
});

test('river busy events do not update the parent recursively and coalesce repeated child changes', async () => {
  const f = setup(); f.page.data.mode = 'assessment';
  let applying = false, parentUpdates = 0;
  const originalSetData = f.observer.setData;
  f.observer.setData = patch => { applying = true; try { originalSetData(patch); } finally { applying = false; } };
  f.page.setData = patch => { assert.equal(applying, false, 'no parent update inside child data observer'); parentUpdates++; Object.assign(f.page.data, patch); };
  f.observer.triggerEvent = (name, detail) => { assert.equal(applying, false); f.events.push({ name, detail }); f.page.riverBusyChange({ detail }); };
  await f.componentDef.lifetimes.attached.call(f.observer);
  assert.equal(f.events.length, 0); assert.equal(f.nextTicks.length, 1);
  f.flushNextTick(); assert.deepEqual(f.events.map(row => row.detail.busy), [false]); assert.equal(parentUpdates, 0);
  f.observer.setData({ busy: true }); f.observer.setData({ locating: true });
  assert.equal(f.page.data.riverBusy, false); assert.equal(f.nextTicks.length, 1);
  f.flushNextTick(); assert.equal(f.page.data.riverBusy, true); assert.equal(parentUpdates, 1);
  f.observer.setData({ busy: false }); f.flushNextTick(); assert.equal(parentUpdates, 1);
  f.observer.setData({ locating: false }); f.flushNextTick();
  assert.deepEqual(f.events.map(row => row.detail.busy), [false, true, false]); assert.equal(parentUpdates, 2);
});

test('a deferred busy event cannot outlive a detached river component', async () => {
  const f = setup(); await f.componentDef.lifetimes.attached.call(f.observer); f.flushNextTick(); f.events.length = 0;
  f.observer.setData({ busy: true }); assert.equal(f.nextTicks.length, 1);
  f.componentDef.lifetimes.detached.call(f.observer); f.flushNextTick();
  assert.deepEqual(f.events, []);
});

test('mode switching checks live river state before its deferred busy notification', async () => {
  const f = setup(); f.page.data.mode = 'assessment'; f.page.selectComponent = () => f.observer;
  await f.componentDef.lifetimes.attached.call(f.observer); f.flushNextTick();
  f.observer.setData({ busy: true }); assert.equal(f.page.data.riverBusy, false);
  f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'assessment');
  f.observer.setData({ busy: false, locating: true });
  f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'assessment');
  f.observer.setData({ locating: false });
  await f.page.changeMode(mode('recognition')); assert.equal(f.page.data.mode, 'recognition');
});
