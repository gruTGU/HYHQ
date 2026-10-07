'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createPublicReadCache } = require('../lib/public-read-cache'); const { apiError } = require('../lib/client');
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(summary) {
  let page; const calls = [], session = { token: () => '', revision: () => 0 };
  const raw = { async request(path) {
    calls.push(path);
    if (path === 'regions/') return { data: [{ id: 'r1', slug: 'demo-campus', name: '示范区域' }] };
    if (path === 'weather-data/locations/') return { data: { enabled: true, items: [{ slug: 'tianjin', name: '天津市' }] } };
    if (path === 'weather-data/summary/') return summary;
    return { data: { source_type: 'simulation', status: 'available', temperature: 0, alerts: [] } };
  } };
  const application = { globalData: {}, session, api: createPublicReadCache(raw, session, apiError, () => 10000) };
  global.getApp = () => application; global.wx = { stopPullDownRefresh() {} }; global.Page = value => { page = value; };
  delete require.cache[require.resolve('../pages/home/index')]; require('../pages/home/index');
  const instance = { ...page, data: structuredClone(page.data), setData(patch) { Object.assign(this.data, patch); } };
  return { instance, application, calls };
}
const summary = { data: { location: { slug: 'tianjin', name: '天津市' }, ...Object.fromEntries(['weather', 'air', 'alerts'].map(kind => [kind, { status: 'fresh', fetched_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00Z', data: { temperature: 21, humidity_percent: 20, condition: '晴', items: [] } }])) } };
test('home first screen uses three reads, and AI/navigation are ready before a slow weather response', async () => {
  const slow = deferred(), { instance, calls } = fixture(slow.promise);
  const loading = instance.onLoad(); await new Promise(setImmediate);
  assert.deepEqual(calls.sort(), ['regions/', 'weather-data/locations/', 'weather-data/summary/']);
  assert.equal(instance.data.loading, false); assert.equal(instance.data.cityLoading, true); assert.equal(instance.data.region.id, 'r1');
  slow.resolve(summary); await loading;
  instance.onHide(); await instance.onShow(); assert.equal(calls.length, 3);
  await instance.toggleObservations(); assert.equal(calls.length, 6);
  instance.toggleObservations(); await instance.toggleObservations(); assert.equal(calls.length, 6);
  assert.equal(instance.data.weather.temp_label, '0°');
});
test('home pull refresh invalidates warm cache and retries the current public selection', async () => {
  const { instance, calls } = fixture(summary); await instance.onLoad(); await instance.onPullDownRefresh(); assert.equal(calls.length, 6);
});
