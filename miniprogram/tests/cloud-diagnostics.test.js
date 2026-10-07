const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSession } = require('../lib/session');
const tick = () => new Promise(resolve => setImmediate(resolve));
const PRIVATE = 'alice@example.test-secret';
const UUID = '12345678-1234-4567-8123-123456789abc';
function fixture(options = {}, logger) {
  const events = [], calls = [], storage = new Map();
  const sandbox = { module: { exports: {} }, require: name => { assert.equal(name, './public-read-policy'); return require('../lib/public-read-policy'); }, setTimeout, clearTimeout, console: { info: logger || ((...args) => events.push(JSON.parse(JSON.stringify(args)))) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/cloud-client.js'), 'utf8'), sandbox);
  const platform = { cloud: { init() {}, callFunction: request => { calls.push(request); } }, getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) };
  const session = createSession(platform, 'diagnostic-fixture'); session.save({ token: PRIVATE, user: { id: PRIVATE } });
  const config = { transport: 'cloud-function', cloud: { env: 'private-env-name', function: 'private-function-name' }, baseURL: 'https://private.example.test/api/v1', timeout: 1000, ...options };
  const client = sandbox.module.exports.createCloudClient(platform, config, session, (code, message) => Object.assign(new Error(message), { code }));
  const success = (request, data = PRIVATE) => request.success({ result: { statusCode: 200, data: { data, request_id: PRIVATE } } });
  return { platform, session, client, config, events, calls, success };
}
function safe(events) {
  const text = JSON.stringify(events);
  for (const secret of [PRIVATE, UUID, 'private-env-name', 'private-function-name', 'one-use-login-code', 'private-question', 'private-body', 'Bearer', 'file_base64_secret', 'errMsg', 'request_id']) assert.equal(text.includes(secret), false, secret);
  for (const [prefix, event] of events) { assert.equal(prefix, '[HYHQ cloud]'); assert.deepEqual(Object.keys(event).sort(), ['local_request', 'method', 'path', 'duration_ms', 'outcome', 'error_code', 'phase'].sort()); assert.ok(Number.isInteger(event.duration_ms) && event.duration_ms >= 0); }
}
test('cloud diagnostics are silent unless the explicit boolean option is true', async () => {
  for (const cloudDiagnostics of [undefined, false, 'true', 1]) { const f = fixture({ cloudDiagnostics }); const pending = f.client.request('regions/'); await tick(); f.success(f.calls[0]); await pending; assert.equal(f.events.length, 0); }
});
test('successful diagnostic logs only route name and elapsed time, never query/body/headers/session/response', async () => {
  const f = fixture({ cloudDiagnostics: true });
  const a = f.client.request('routes/?search=' + encodeURIComponent(PRIVATE), { data: { keyword: 'private-question' } }); await tick(); f.success(f.calls[0]); await a;
  const b = f.client.request('auth/wechat/', { method: 'POST', data: { code: 'one-use-login-code', text: 'private-body', image: 'file_base64_secret' } }); await tick(); f.success(f.calls[1]); await b;
  assert.equal(f.events[0][1].path, '/api/v1/routes/'); assert.equal(f.events[0][1].outcome, 'success'); assert.equal(f.events[0][1].phase, 'response'); assert.equal(f.events[0][1].error_code, null);
  assert.deepEqual(f.events.map(row => row[1].local_request), [1, 2]); safe(f.events);
});
test('SDK failures retain bounded numeric provider code and distinguish SDK timeout from local deadline', async () => {
  const f = fixture({ cloudDiagnostics: true });
  const pending = f.client.request('contents/' + UUID + '/?keyword=' + PRIVATE); await tick();
  f.calls[0].fail({ errCode: -504003, errMsg: 'timeout raw ' + PRIVATE, headers: { Authorization: PRIVATE }, requestID: PRIVATE });
  await assert.rejects(pending, { code: 'TIMEOUT' });
  assert.equal(f.events[0][1].phase, 'SDKfailure'); assert.equal(f.events[0][1].error_code, 'SDK_-504003'); assert.equal(f.events[0][1].path, '/api/v1/contents/:id/'); safe(f.events);
});
test('client deadline produces one safe record and late callbacks cannot log or clear another session', async () => {
  const f = fixture({ cloudDiagnostics: true, timeout: 5 });
  await assert.rejects(f.client.request('regions/'), { code: 'TIMEOUT' });
  assert.equal(f.events.length, 1); assert.equal(f.events[0][1].phase, 'clientDeadline'); assert.equal(f.events[0][1].error_code, 'TIMEOUT');
  f.session.save({ token: 'new-token', user: { id: 'new-user' } });
  f.calls[0].success({ result: { statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: PRIVATE } } } }); f.calls[0].fail({ errMsg: PRIVATE });
  assert.equal(f.events.length, 1); assert.equal(f.session.token(), 'new-token'); safe(f.events);
});
test('arbitrary resource segments and arbitrary backend error codes cannot expose private values', async () => {
  const f = fixture({ cloudDiagnostics: true });
  const pending = f.client.request('contents/' + PRIVATE + '/'); await tick();
  f.calls[0].success({ result: { statusCode: 500, data: { error: { code: PRIVATE, message: PRIVATE, details: PRIVATE }, request_id: PRIVATE } } });
  await assert.rejects(pending); assert.equal(f.events[0][1].path, '/api/v1/contents/:id/'); assert.equal(f.events[0][1].error_code, 'UNKNOWN_ERROR'); safe(f.events);
});
test('cancellation and session changes remain distinguishable without logging account identity', async () => {
  const f = fixture({ cloudDiagnostics: true }); const cancelled = f.client.request('routes/'); await tick(); cancelled.abort(); await assert.rejects(cancelled, { code: 'CANCELLED' });
  const switched = f.client.request('me/'); await tick(); const checked = assert.rejects(switched, { code: 'SESSION_CHANGED' }); f.session.save({ token: 'next-token' }); await checked;
  assert.deepEqual(f.events.map(row => row[1].phase), ['cancelled', 'sessionChanged']); safe(f.events);
});
test('dual SDK promise/callback delivery records one result; a broken console never changes behavior', async () => {
  const f = fixture({ cloudDiagnostics: true });
  f.platform.cloud.callFunction = request => { const value = { result: { statusCode: 200, data: { data: 42 } } }; request.success(value); return Promise.resolve(value); };
  assert.equal((await f.client.request('routes/')).data, 42); await tick(); assert.equal(f.events.length, 1); safe(f.events);
  const broken = fixture({ cloudDiagnostics: true }, () => { throw new Error('console unavailable'); });
  const pending = broken.client.request('regions/'); await tick(); broken.success(broken.calls[0], 7); assert.equal((await pending).data, 7); assert.equal(broken.calls.length, 1);
});
test('cloud initialization failure logs only its controlled code', async () => {
  const f = fixture({ cloudDiagnostics: true }); f.platform.cloud.init = () => Promise.reject({ errMsg: PRIVATE, private: PRIVATE });
  await assert.rejects(f.client.request('regions/'), { code: 'CLOUD_INIT_FAILED' });
  assert.equal(f.events[0][1].phase, 'cloudInit'); assert.equal(f.events[0][1].error_code, 'CLOUD_INIT_FAILED'); assert.equal(f.calls.length, 0); safe(f.events);
});
