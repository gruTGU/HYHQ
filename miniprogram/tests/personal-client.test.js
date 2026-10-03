const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/client');
const { createSession } = require('../lib/session');
const { CHUNK_BYTES } = require('../lib/cloud-client');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ID = '12345678-1234-4567-8123-123456789abc';
const image = '/api/v1/uploads/' + ID + '/content/?variant=thumbnail';
const audio = '/api/v1/narrations/' + ID + '/audio/';
const ok = (data, statusCode = 200) => ({ result: { statusCode, data: { data } } });
const buffer = (value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
function fixture(extra = {}) {
  const calls = [], init = [], storage = new Map(), files = new Map(), fds = new Map(), reads = [], unlinked = [];
  const wx = {
    cloud: { init: (options) => init.push(options), callFunction: (options) => { calls.push(options); }, callContainer: () => assert.fail('personal mode must not use a container') },
    request: () => assert.fail('no HTTP fallback'), uploadFile: () => assert.fail('no public uploads'), downloadFile: () => assert.fail('no public downloads'),
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
    env: { USER_DATA_PATH: '/private' },
    arrayBufferToBase64: (value) => Buffer.from(value).toString('base64'), base64ToArrayBuffer: (value) => buffer(Buffer.from(value, 'base64')),
    getFileSystemManager: () => ({
      stat: (o) => o.success({ stats: { size: files.get(o.path).length } }),
      open: (o) => { fds.set('fd', o.filePath); o.success({ fd: 'fd' }); },
      read: (o) => { reads.push([o.position, o.length]); const data = files.get(fds.get(o.fd)).subarray(o.position, o.position + o.length); new Uint8Array(o.arrayBuffer).set(data); o.success({ bytesRead: data.length, arrayBuffer: o.arrayBuffer }); },
      close: (o) => { fds.delete(o.fd); o.success({}); },
      writeFile: (o) => { files.set(o.filePath, Buffer.from(o.data)); o.success({}); },
      appendFile: (o) => { files.set(o.filePath, Buffer.concat([files.get(o.filePath), Buffer.from(o.data)])); o.success({}); },
      unlink: (o) => { unlinked.push(o.filePath); files.delete(o.filePath); o.success({}); },
    }),
  };
  const config = { transport: 'cloud-function', cloud: { env: 'test-env', function: 'hyhqApi' }, baseURL: 'https://legacy.example/api/v1', timeout: 1000, uploadTimeout: 1000, ...extra };
  const session = createSession(wx, 'cloud-function.test-env.hyhqApi');
  const client = createClient(wx, config, session);
  const login = (token = 'business-token-A') => session.save({ token, user: { id: token } });
  const handler = (fn, style = 'promise') => { wx.cloud.callFunction = (o) => { calls.push(o); const response = Promise.resolve().then(() => fn(o)); if (style === 'callback') { response.then(o.success, o.fail); return; } if (style === 'both') response.then(o.success, o.fail); return response; }; };
  return { wx, config, calls, init, session, client, login, handler, files, fds, reads, unlinked };
}

test('personal transport uses named native function and JSON bridge, with no client identity claims', async () => {
  const f = fixture(); f.login(); f.handler(() => ok({ version: 'personal' }));
  const result = await f.client.request('health/');
  assert.equal(result.data.version, 'personal');
  assert.deepEqual(f.init, [{ env: 'test-env', traceUser: false }]);
  assert.equal(f.calls[0].name, 'hyhqApi'); assert.deepEqual(f.calls[0].config, { env: 'test-env' });
  assert.deepEqual(f.calls[0].data, { method: 'GET', path: '/api/v1/health/', body: null, headers: { Authorization: 'Bearer business-token-A' } });
  assert.equal(f.calls[0].header, undefined); assert.equal(f.calls[0].url, undefined);
  assert.ok(!JSON.stringify(f.calls[0].data).includes('openid'));
});

test('native task reads can outlive the normal request deadline, remain cancellable, and never retry', async () => {
  const f = fixture({ timeout: 5 }); f.login();
  f.handler(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return ok({ status: 'succeeded' }); });
  for (const path of ['llm/turns/' + ID + '/', 'recognition-jobs/' + ID + '/', 'assessment-jobs/' + ID + '/', 'weather-data/overview/?location=beijing']) assert.equal((await f.client.request(path)).data.status, 'succeeded');
  assert.equal(f.calls.length, 4);
  await assert.rejects(f.client.request('llm/turns/' + ID + '/', { timeout: 5 }), { code: 'TIMEOUT' });
  const pending = f.client.request('recognition-jobs/' + ID + '/'); await tick(); const failed = assert.rejects(pending, { code: 'SESSION_CHANGED' }); f.login('new-session'); await failed;
  assert.equal(f.calls.length, 6);
});

test('GET filters preserve scope and pagination, while wx.login code stays in auth POST body', async () => {
  const f = fixture(); f.handler(() => ok([]));
  await f.client.request('llm/sessions/', { data: { scope: 'guide', page_size: 10, keyword: '天津 湿地' } });
  assert.equal(f.calls[0].data.path, '/api/v1/llm/sessions/?scope=guide&page_size=10&keyword=' + encodeURIComponent('天津 湿地'));
  await f.client.request('/api/v1/llm/sessions/?scope=guide&page=2');
  assert.equal(f.calls[1].data.path, '/api/v1/llm/sessions/?scope=guide&page=2');
  await f.client.request('auth/wechat/', { method: 'POST', data: { code: 'one-use-code' } });
  assert.deepEqual(f.calls[2].data.body, { code: 'one-use-code' });
  assert.deepEqual(f.calls[2].data.headers, {});
  assert.equal(f.calls[2].data.path, '/api/v1/auth/wechat/');
});

test('callback, promise and dual SDK responses unwrap exactly once including string result', async () => {
  for (const style of ['promise', 'callback', 'both']) {
    const f = fixture(); f.handler(() => ({ result: JSON.stringify(ok({ total: 3 }).result) }), style);
    assert.deepEqual((await f.client.request('health/')).data, { total: 3 });
  }
});

test('missing native function config or SDK fails explicitly without container or HTTP fallback', async () => {
  for (const cloud of [{ env: 'test-env' }, { function: 'hyhqApi' }, { env: 'test-env', function: '../hyhqApi' }]) {
    const f = fixture({ cloud }); await assert.rejects(f.client.request('health/'), { code: 'CLOUD_CONFIG_REQUIRED' }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); delete f.wx.cloud.callFunction;
  await assert.rejects(f.client.request('health/'), { code: 'CLOUD_UNAVAILABLE' }); assert.equal(f.calls.length, 0);
});

test('malformed function result and application failures retain stable error behavior', async () => {
  const f = fixture();
  for (const response of [{ statusCode: 200, data: { data: 'missing result' } }, { result: 'not json' }, { result: { statusCode: 200, data: '<html>' } }]) {
    f.handler(() => response); await assert.rejects(f.client.request('health/'), { code: 'INVALID_RESPONSE' });
  }
  f.handler(() => ({ result: { statusCode: 429, data: { error: { code: 'DAILY_LIMIT', message: '今日暂不可继续' }, request_id: 'native-req' } } }));
  await assert.rejects(f.client.request('llm/status/'), { code: 'DAILY_LIMIT', status: 429, requestId: 'native-req' });
  f.handler(() => ({ result: { statusCode: 204, data: '' } }));
  assert.deepEqual(await f.client.request('me/', { method: 'DELETE' }), { data: null });
});

test('old function callbacks cannot clear or populate a newly established session', async () => {
  const f = fixture(); f.login();
  const pending = f.client.request('me/'); await tick();
  const checked = assert.rejects(pending, { code: 'SESSION_CHANGED' }); f.login('business-token-B');
  f.calls[0].success({ result: { statusCode: 401, data: { error: { code: 'AUTH_REQUIRED' } } } });
  await checked; assert.equal(f.session.token(), 'business-token-B');
  f.handler(() => ({ result: { statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: '重新登录' } } } }));
  await assert.rejects(f.client.request('me/'), { code: 'AUTH_REQUIRED' }); assert.equal(f.session.token(), '');
});

test('function request timeout and cancellation suppress late work without automatic retries', async () => {
  const f = fixture({ timeout: 5 }); f.login();
  await assert.rejects(f.client.request('me/'), { code: 'TIMEOUT' });
  f.calls[0].success({ result: { statusCode: 401, data: {} } }); assert.equal(f.session.token(), 'business-token-A');
  const pending = f.client.request('me/'); await tick(); pending.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(f.calls.length, 2);
});

test('foreign URLs and noncanonical API paths never reach native function with business token', async () => {
  const f = fixture(); f.login();
  for (const path of ['https://other.example/api/v1/me/', '//other.example/api/v1/me/', '/admin/', '/api/v1/../me/', '/api/v1/%2e%2e/']) await assert.rejects(f.client.request(path), { code: 'UNSAFE_FILE_URL' });
  assert.equal(f.calls.length, 0);
});

test('native function upload reuses bounded chunks and fixed token, never public upload URLs', async () => {
  const f = fixture(); f.login(); const content = Buffer.alloc(CHUNK_BYTES + 23, 41); f.files.set('/tmp/image.jpg', content);
  f.handler((o) => {
    const { path, body } = o.data;
    if (path.endsWith('/complete/')) return ok({ id: ID, thumbnail_url: image });
    if (path.includes('/chunks/')) return ok({ offset: content.length });
    return ok({ id: ID, chunk_size: CHUNK_BYTES, total_size: body.size }, 201);
  });
  assert.equal((await f.client.upload('/tmp/image.jpg', 'avatar')).id, ID);
  assert.deepEqual(f.reads, [[0, CHUNK_BYTES], [CHUNK_BYTES, 23]]); assert.equal(f.fds.size, 0);
  const chunks = f.calls.filter((o) => o.data.method === 'PUT');
  assert.deepEqual(Buffer.concat(chunks.map((o) => Buffer.from(o.data.body.data_base64, 'base64'))), content);
  assert.ok(f.calls.every((o) => o.data.headers.Authorization === 'Bearer business-token-A'));
});

test('native image downloads preserve query variant and clean local files on logout', async () => {
  const f = fixture(); f.login(); const data = Buffer.from('jpeg-content');
  f.handler((o) => {
    assert.equal(o.data.path, '/api/v1/cloud-files/download/?path=' + encodeURIComponent(image) + '&offset=0');
    return ok({ data_base64: data.toString('base64'), offset: 0, next_offset: data.length, total_size: data.length, complete: true, content_type: 'image/jpeg', extension: 'jpg' });
  });
  const local = await f.client.download(image); assert.deepEqual(f.files.get(local), data);
  f.session.clear(); assert.equal(f.files.has(local), false);
});

test('public narration is downloaded through native function and released without a public URL', async () => {
  const f = fixture(); const data = Buffer.from('audio-content');
  f.handler((o) => { assert.deepEqual(o.data.headers, {}); return ok({ data_base64: data.toString('base64'), offset: 0, next_offset: data.length, total_size: data.length, complete: true, content_type: 'audio/mpeg', extension: 'mp3' }); });
  const local = await f.client.download(audio); assert.deepEqual(f.files.get(local), data);
  f.client.releaseFile(local); assert.equal(f.files.has(local), false);
});

test('personal environment/function, container and HTTP login stores remain isolated', () => {
  const f = fixture(); f.login();
  const http = createSession(f.wx), container = createSession(f.wx, 'cloud.test-env.hyhq-api'), otherFunction = createSession(f.wx, 'cloud-function.test-env.otherApi');
  assert.equal(http.token(), ''); assert.equal(container.token(), ''); assert.equal(otherFunction.token(), '');
  otherFunction.save({ token: 'other-token' }); f.session.clear();
  assert.equal(createSession(f.wx, 'cloud-function.test-env.otherApi').token(), 'other-token');
});

test('App startup selects actual function-specific storage and leaves HTTP/container scopes intact', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const storage = new Map();
  const wx = { getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) };
  function startup(config) {
    let application;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), { wx, App: (value) => { application = value; }, require: (name) => name === './config/index' ? config : name === './lib/session' ? { createSession } : { createClient: () => ({}) } });
    application.onLaunch(); return application;
  }
  const a = startup({ transport: 'cloud-function', cloud: { env: 'test-env', function: 'hyhqApi' } }); a.session.save({ token: 'fn-A' });
  const b = startup({ transport: 'cloud-function', cloud: { env: 'test-env', function: 'otherApi' } });
  const http = startup({ transport: 'http' }), container = startup({ transport: 'cloud', cloud: { env: 'test-env', service: 'hyhqApi' } });
  assert.equal(b.session.token(), ''); assert.equal(http.session.token(), ''); assert.equal(container.session.token(), '');
  assert.equal(startup({ transport: 'cloud-function', cloud: { env: 'test-env', function: 'hyhqApi' } }).session.token(), 'fn-A');
});

test('personal legal page enables existing cloud-only retention and cache explanation', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  for (const transport of ['http', 'cloud', 'cloud-function']) {
    let page;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/legal/index.js'), 'utf8'), { Page: (value) => { page = value; }, getApp: () => ({ config: { transport } }), wx: { setNavigationBarTitle() {} } });
    page.setData = (value) => Object.assign(page.data, value);
    page.onLoad({ kind: 'privacy' }); assert.equal(page.data.cloudMode, transport !== 'http'); assert.equal(page.data.privacy, true);
  }
});
