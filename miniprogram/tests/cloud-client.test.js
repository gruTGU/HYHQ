const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/client');
const { createSession } = require('../lib/session');
const { CHUNK_BYTES } = require('../lib/cloud-client');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const UPLOAD_ID = '12345678-1234-4567-8123-123456789abc';
const ASSET_ID = 'abcdefgh-1234-4567-8123-123456789abc'.replace('abcdefgh', 'abcdefab');
const image = '/api/v1/uploads/' + ASSET_ID + '/content/?variant=thumbnail';
const audio = '/api/v1/narrations/' + ASSET_ID + '/audio/';
const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const ok = (data, statusCode = 200) => ({ statusCode, data: { data } });
function fixture(overrides = {}) {
  const calls = [], init = [], storage = new Map(), files = new Map(), reads = [], deleted = [], closed = [], handles = new Map();
  const fsm = {
    readdirSync: () => Array.from(files.keys()).filter((name) => name.startsWith('/private/')).map((name) => name.slice(9)),
    unlinkSync: (file) => { deleted.push(file); files.delete(file); },
    stat: (o) => o.success({ stats: { size: (files.get(o.path) || Buffer.alloc(0)).length } }),
    open: (o) => { handles.set('fd', o.filePath); o.success({ fd: 'fd' }); },
    read: (o) => { reads.push(o); const source = files.get(handles.get(o.fd)).subarray(o.position, o.position + o.length); new Uint8Array(o.arrayBuffer).set(source); o.success({ bytesRead: source.length, arrayBuffer: o.arrayBuffer }); },
    close: (o) => { closed.push(o.fd); o.success({}); },
    writeFile: (o) => { files.set(o.filePath, Buffer.from(o.data)); o.success({}); },
    appendFile: (o) => { files.set(o.filePath, Buffer.concat([files.get(o.filePath), Buffer.from(o.data)])); o.success({}); },
    unlink: (o) => { deleted.push(o.filePath); files.delete(o.filePath); o.success({}); },
  };
  const wx = {
    cloud: { init: (o) => init.push(o), callContainer: (o) => { calls.push(o); } },
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
    env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => fsm,
    arrayBufferToBase64: (value) => Buffer.from(value).toString('base64'),
    base64ToArrayBuffer: (value) => arrayBuffer(Buffer.from(value, 'base64')),
    request: () => assert.fail('cloud transport must never fall back to wx.request'),
    uploadFile: () => assert.fail('cloud uploads must never use public URL uploads'),
    downloadFile: () => assert.fail('cloud downloads must never use public URL downloads'),
  };
  const config = { transport: 'cloud', baseURL: 'https://campus.example/api/v1', cloud: { env: 'prod-env', service: 'hyhq-api' }, timeout: 1000, uploadTimeout: 1000, ...overrides };
  const session = createSession(wx);
  const client = createClient(wx, config, session);
  function handler(fn, style = 'promise') {
    wx.cloud.callContainer = (o) => {
      calls.push(o);
      const result = Promise.resolve().then(() => fn(o));
      if (style === 'callback') { result.then(o.success, o.fail); return undefined; }
      if (style === 'both') result.then(o.success, o.fail);
      return result;
    };
  }
  function login(token = 'token-A') { session.save({ token, user: { id: token } }); }
  return { wx, config, session, client, calls, init, files, reads, deleted, closed, fsm, handler, login };
}
function uploadHandler(f, options = {}) {
  f.handler((o) => {
    if (o.method === 'DELETE') return ok(null, 204);
    if (o.path.endsWith('/complete/')) return ok({ id: ASSET_ID, thumbnail_url: image });
    if (o.path.includes('/chunks/')) { if (options.onChunk) return options.onChunk(o); return ok({ offset: 1 }); }
    return ok({ id: UPLOAD_ID, total_size: o.data.size, chunk_size: CHUNK_BYTES }, 201);
  });
}
function blocks(buffer, mime = 'image/jpeg', extension = 'jpg') {
  return (o) => {
    const offset = Number(o.path.match(/&offset=(\d+)/)[1]);
    const part = buffer.subarray(offset, offset + CHUNK_BYTES);
    return ok({ offset, next_offset: offset + part.length, total_size: buffer.length, complete: offset + part.length === buffer.length, data_base64: part.toString('base64'), content_type: mime, extension });
  };
}

test('cloud mode initializes once, uses private container routing and keeps pagination metadata', async () => {
  const f = fixture(); f.handler(() => ({ statusCode: 200, data: { data: [], meta: { next: '/api/v1/places/?page=2' } } }));
  const result = await f.client.request('places/', { data: { keyword: '湿地' } });
  await f.client.request('/api/v1/health/');
  assert.deepEqual(f.init, [{ env: 'prod-env', traceUser: false }]);
  assert.equal(f.calls[0].path, '/api/v1/places/?keyword=' + encodeURIComponent('湿地'));
  assert.equal(f.calls[0].data, undefined);
  assert.equal(f.calls[0].config.env, 'prod-env');
  assert.equal(f.calls[0].header['X-WX-SERVICE'], 'hyhq-api');
  assert.equal(f.calls[0].header.Authorization, undefined);
  assert.equal(f.calls[0].followRedirect, false);
  assert.equal(f.calls[0].url, undefined);
  assert.deepEqual(result.meta, { next: '/api/v1/places/?page=2' });
});

test('callbacks, promises and SDKs that invoke both resolve only once', async () => {
  for (const style of ['callback', 'promise', 'both']) {
    const f = fixture(); f.login(); f.handler(() => ok({ version: 'm5' }), style);
    assert.equal((await f.client.request('health/')).data.version, 'm5');
    assert.equal(f.calls[0].header.Authorization, 'Bearer token-A');
  }
});

test('missing cloud configuration or SDK produces explicit failure with no HTTP fallback', async () => {
  const missing = fixture({ cloud: {} });
  await assert.rejects(missing.client.request('health/'), { code: 'CLOUD_CONFIG_REQUIRED' });
  assert.equal(missing.calls.length, 0);
  const unsupported = fixture(); delete unsupported.wx.cloud;
  await assert.rejects(unsupported.client.request('health/'), { code: 'CLOUD_UNAVAILABLE' });
  assert.equal(unsupported.calls.length, 0);
  assert.throws(() => createClient({}, { transport: 'silent-fallback' }, {}), { code: 'TRANSPORT_UNSUPPORTED' });
});

test('failed cloud init can be explicitly retried without leaving an unhandled rejection', async () => {
  const f = fixture(); f.wx.cloud.init = () => Promise.reject(new Error('not associated'));
  await assert.rejects(f.client.request('health/'), { code: 'CLOUD_INIT_FAILED' });
  f.wx.cloud.init = () => {}; f.handler(() => ok(true));
  assert.equal((await f.client.request('health/')).data, true);
});

test('only configured legacy origin and canonical api/v1 paths can receive a token', async () => {
  const f = fixture(); f.login(); f.handler(() => ok(true));
  for (const path of ['https://foreign.example/api/v1/me/', 'https://campus.example.evil/api/v1/me/', 'https://campus.example@evil.example/api/v1/me/', '//evil.example/api/v1/', '/admin/', '/api/v1/../admin/', '/api/v1/%2e%2e/admin/', '/api/v1/a%2fb/', '/api/v1//me/', '/api/v1/a\\b', 'javascript:x', '/api/v1/me/#x']) await assert.rejects(f.client.request(path), { code: 'UNSAFE_FILE_URL' });
  assert.equal(f.calls.length, 0);
  await f.client.request('https://campus.example/api/v1/me/');
  assert.equal(f.calls[0].path, '/api/v1/me/');
  assert.equal(f.calls[0].header.Authorization, 'Bearer token-A');
});

test('401 clears only its active session and preserves server error metadata', async () => {
  const f = fixture(); f.login(); f.handler(() => ({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: '请登录' }, request_id: 'req-cloud' } }));
  await assert.rejects(f.client.request('me/'), { code: 'AUTH_REQUIRED', status: 401, requestId: 'req-cloud' });
  assert.equal(f.session.token(), '');
});

test('account switching cancels in-flight cloud calls; late success/401 cannot leak or clear new account', async () => {
  for (const response of [ok({ private: 'old-data' }), { statusCode: 401, data: { error: { message: 'old' } } }]) {
    const f = fixture(); f.login();
    const pending = f.client.request('me/'); await tick();
    const checked = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    f.login('token-B'); f.calls[0].success(response);
    await checked;
    assert.equal(f.session.token(), 'token-B');
  }
});

test('logging out then back into same token still invalidates old request generation', async () => {
  const f = fixture(); f.login(); const pending = f.client.request('me/'); await tick();
  const checked = assert.rejects(pending, { code: 'SESSION_CHANGED' });
  f.session.clear(); f.login(); f.calls[0].success(ok('old-result'));
  await checked;
  assert.equal(f.session.token(), 'token-A');
});

test('profile metadata refresh does not cancel operations or clear file cache', async () => {
  const f = fixture(); f.login(); const pending = f.client.request('me/'); await tick();
  f.session.updateUser({ id: 'token-A', nickname: 'New name' });
  f.calls[0].success(ok({ nickname: 'New name' }));
  assert.equal((await pending).data.nickname, 'New name');
});

test('timeout and explicit abort discard late callbacks and abort SDK task when supported', async () => {
  const f = fixture({ timeout: 5 }); f.login();
  await assert.rejects(f.client.request('me/'), { code: 'TIMEOUT' });
  f.calls[0].success({ statusCode: 401, data: {} }); assert.equal(f.session.token(), 'token-A');
  let aborts = 0;
  f.wx.cloud.callContainer = (o) => { f.calls.push(o); return { abort: () => { aborts += 1; } }; };
  const pending = f.client.request('me/'); await tick();
  pending.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
  f.calls[1].success(ok('too-late'));
  assert.equal(aborts, 1);
});

test('abort before initialization prevents any network dispatch', async () => {
  const f = fixture(); const pending = f.client.request('health/'); pending.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(f.calls.length, 0); assert.equal(f.init.length, 0);
});

test('network failure, malformed responses, redirects and 204 remain distinct', async () => {
  const f = fixture();
  f.handler(() => { throw { errMsg: 'callContainer:fail timeout' }; });
  await assert.rejects(f.client.request('health/'), { code: 'TIMEOUT' });
  for (const response of [undefined, { statusCode: 200, data: '<html>proxy</html>' }, { statusCode: '200', data: { data: [] } }]) {
    f.handler(() => response); await assert.rejects(f.client.request('health/'), { code: 'INVALID_RESPONSE' });
  }
  f.handler(() => ({ statusCode: 302, data: '', header: { location: 'https://evil.example' } }));
  await assert.rejects(f.client.request('health/'), { code: 'HTTP_ERROR', status: 302 });
  f.handler(() => ({ statusCode: 204, data: '' }));
  assert.deepEqual(await f.client.request('me/', { method: 'DELETE' }), { data: null });
});

test('cloud upload reads bounded chunks with positional file API and returns existing asset contract', async () => {
  const f = fixture(); f.login(); const source = Buffer.alloc(CHUNK_BYTES * 2 + 7, 23); f.files.set('/tmp/image.jpg', source); uploadHandler(f);
  const asset = await f.client.upload('/tmp/image.jpg');
  assert.equal(asset.id, ASSET_ID); assert.equal(asset.thumbnail_url, image);
  assert.deepEqual(f.reads.map((read) => [read.position, read.length]), [[0, CHUNK_BYTES], [CHUNK_BYTES, CHUNK_BYTES], [CHUNK_BYTES * 2, 7]]);
  assert.deepEqual(f.closed, ['fd']);
  const chunks = f.calls.filter((o) => o.method === 'PUT');
  assert.deepEqual(Buffer.concat(chunks.map((o) => Buffer.from(o.data.data_base64, 'base64'))), source);
  assert.equal(f.calls[0].data.purpose, 'recognition');
  assert.match(f.calls[0].data.request_id, /^[a-f0-9-]{36}$/);
  assert.ok(f.calls.every((o) => o.header.Authorization === 'Bearer token-A'));
  assert.equal(f.calls.filter((o) => o.method === 'DELETE').length, 0);
});

test('cloud upload validates authentication, purpose and 5MB limit before creating server staging', async () => {
  const f = fixture();
  await assert.rejects(f.client.upload('/tmp/a.jpg'), { code: 'AUTH_REQUIRED' });
  f.login(); await assert.rejects(f.client.upload('/tmp/a.jpg', 'private-secrets'), { code: 'INVALID_UPLOAD' });
  f.files.set('/tmp/a.jpg', Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(f.client.upload('/tmp/a.jpg', 'avatar'), { code: 'FILE_TOO_LARGE' });
  assert.equal(f.calls.length, 0);
});

test('failed upload chunk is not retried, closes descriptor and deletes staging with original token', async () => {
  const f = fixture(); f.login(); f.files.set('/tmp/a.jpg', Buffer.alloc(CHUNK_BYTES + 1));
  uploadHandler(f, { onChunk: () => { throw { errMsg: 'network unavailable' }; } });
  await assert.rejects(f.client.upload('/tmp/a.jpg'), { code: 'NETWORK_ERROR' }); await tick();
  assert.equal(f.calls.filter((o) => o.method === 'PUT').length, 1);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer token-A');
  assert.deepEqual(f.closed, ['fd']);
});

test('account switch during chunk upload cannot send next chunk or cleanup as the new account', async () => {
  const f = fixture(); f.login(); f.files.set('/tmp/a.jpg', Buffer.alloc(CHUNK_BYTES + 1));
  let release;
  uploadHandler(f, { onChunk: () => new Promise((resolve) => { release = resolve; }) });
  const pending = f.client.upload('/tmp/a.jpg'); await tick();
  const checked = assert.rejects(pending, { code: 'SESSION_CHANGED' });
  f.login('token-B'); release(ok({})); await checked; await tick();
  assert.equal(f.calls.filter((o) => o.method === 'PUT').length, 1);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.ok(f.calls.every((o) => o.header.Authorization === 'Bearer token-A'));
});

test('upload partial local read cleans staging and never submits incomplete data', async () => {
  const f = fixture(); f.login(); f.files.set('/tmp/a.jpg', Buffer.alloc(10)); uploadHandler(f);
  f.fsm.read = (o) => o.success({ bytesRead: 9, arrayBuffer: o.arrayBuffer });
  await assert.rejects(f.client.upload('/tmp/a.jpg'), { code: 'FILE_CHANGED' }); await tick();
  assert.equal(f.calls.filter((o) => o.method === 'PUT').length, 0);
  assert.equal(f.calls.at(-1).method, 'DELETE');
});

test('cloud download reconstructs private image chunks and removes cached file on logout', async () => {
  const f = fixture(); f.login(); const content = Buffer.alloc(CHUNK_BYTES + 3, 31); f.handler(blocks(content));
  const local = await f.client.download('https://campus.example' + image);
  assert.match(local, /^\/private\/hyhq-cloud-[a-f0-9-]+\.jpg$/);
  assert.deepEqual(f.files.get(local), content);
  assert.ok(f.calls.every((o) => o.header.Authorization === 'Bearer token-A'));
  assert.ok(f.calls[0].path.includes('path=' + encodeURIComponent(image)));
  assert.ok(!f.calls[0].path.includes('token-A'));
  f.session.clear(); assert.equal(f.files.has(local), false);
});

test('public narration downloads do not require login or an external download domain', async () => {
  const f = fixture(); f.handler(blocks(Buffer.from('audio-content'), 'audio/mpeg', 'mp3'));
  const local = await f.client.download(audio);
  assert.equal(f.files.get(local).toString(), 'audio-content');
  assert.equal(f.calls[0].header.Authorization, undefined);
});

test('cloud file endpoints reject unsupported paths and require auth for images', async () => {
  const f = fixture();
  await assert.rejects(f.client.download(image), { code: 'AUTH_REQUIRED' });
  f.login();
  for (const path of ['/api/v1/me/', '/api/v1/uploads/' + ASSET_ID + '/content/?variant=evil', '/api/v1/narrations/' + ASSET_ID + '/audio/?secret=x', '/api/v1/uploads/not-a-uuid/content/']) await assert.rejects(f.client.download(path), { code: 'UNSAFE_FILE_URL' });
  assert.equal(f.calls.length, 0);
});

test('invalid download boundaries, MIME, extension, base64 and changing identity are rejected', async () => {
  for (const change of [{ total_size: 9 * 1024 * 1024 }, { next_offset: 0 }, { offset: 1 }, { complete: false }, { content_type: 'text/html' }, { extension: '../js' }, { data_base64: '***=' }, { data_base64: 'YQ==' }]) {
    const f = fixture(); f.login(); f.handler((o) => { const result = blocks(Buffer.from('hello'))(o); Object.assign(result.data.data, change); return result; });
    await assert.rejects(f.client.download(image), { code: 'INVALID_RESPONSE' });
    assert.equal(f.files.size, 0);
  }
  const f = fixture(); f.login(); f.handler((o) => { const result = blocks(Buffer.alloc(CHUNK_BYTES + 1))(o); if (result.data.data.offset) { result.data.data.extension = 'png'; result.data.data.content_type = 'image/png'; } return result; });
  await assert.rejects(f.client.download(image), { code: 'INVALID_RESPONSE' });
  assert.equal(f.files.size, 0); assert.equal(f.deleted.length, 1);
});

test('download failure removes partial file and does not retry network work', async () => {
  const f = fixture(); f.login(); f.handler((o) => { if (o.path.endsWith('offset=0')) return blocks(Buffer.alloc(CHUNK_BYTES + 1))(o); throw { errMsg: 'timeout' }; });
  await assert.rejects(f.client.download(image), { code: 'TIMEOUT' });
  assert.equal(f.calls.length, 2); assert.equal(f.files.size, 0); assert.equal(f.deleted.length, 1);
});

test('account switch during filesystem write removes eventual file and never exposes it to new session', async () => {
  const f = fixture(); f.login(); f.handler(blocks(Buffer.from('private')));
  let finishWrite;
  f.fsm.writeFile = (o) => { finishWrite = () => { f.files.set(o.filePath, Buffer.from(o.data)); o.success({}); }; };
  const pending = f.client.download(image); await tick();
  const checked = assert.rejects(pending, { code: 'SESSION_CHANGED' });
  f.login('token-B'); await checked; finishWrite(); await tick();
  assert.equal(f.files.size, 0); assert.equal(f.deleted.length, 1);
});

test('first file operation deletes only cloud cache leftovers, preserving unrelated user files', async () => {
  const f = fixture(); f.files.set('/private/hyhq-cloud-' + ASSET_ID + '.jpg', Buffer.from('old')); f.files.set('/private/user-note.jpg', Buffer.from('keep'));
  f.handler(blocks(Buffer.from('audio'), 'audio/mpeg', 'mp3'));
  await f.client.download(audio);
  assert.equal(f.files.has('/private/hyhq-cloud-' + ASSET_ID + '.jpg'), false);
  assert.equal(f.files.get('/private/user-note.jpg').toString(), 'keep');
});

test('cloud initialization is bounded and a cancelled wait never dispatches after init resolves', async () => {
  const timed = fixture({ timeout: 5 }); timed.wx.cloud.init = () => new Promise(() => {});
  await assert.rejects(timed.client.request('health/'), { code: 'TIMEOUT' });
  assert.equal(timed.calls.length, 0);
  const f = fixture(); let ready;
  f.wx.cloud.init = () => new Promise((resolve) => { ready = resolve; });
  const pending = f.client.request('health/'); await tick(); pending.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); ready(); await tick();
  assert.equal(f.calls.length, 0);
});

test('query filters and LLM scope reach GET path safely and paginated relative links keep their query', async () => {
  const f = fixture(); f.handler(() => ok([]));
  await f.client.request('llm/sessions/', { data: { scope: 'guide', page_size: 20, keyword: '湖 & 湿地', omitted: undefined } });
  assert.equal(f.calls[0].path, '/api/v1/llm/sessions/?scope=guide&page_size=20&keyword=' + encodeURIComponent('湖 & 湿地'));
  assert.equal(f.calls[0].data, undefined);
  await f.client.request('/api/v1/llm/sessions/?scope=guide&page=2');
  assert.equal(f.calls[1].path, '/api/v1/llm/sessions/?scope=guide&page=2');
  await assert.rejects(f.client.request('places/', { data: { value: {} } }), { code: 'INVALID_REQUEST' });
  assert.equal(f.calls.length, 2);
});

test('WeChat login code is sent in POST body to existing authentication endpoint', async () => {
  const f = fixture(); f.handler(() => ok({ token: 'new', user: { id: 'wechat-user' } }));
  const result = await f.client.request('auth/wechat/', { method: 'POST', data: { code: 'one-use-login-code' } });
  assert.equal(result.data.token, 'new'); assert.equal(f.calls[0].path, '/api/v1/auth/wechat/');
  assert.deepEqual(f.calls[0].data, { code: 'one-use-login-code' }); assert.ok(!f.calls[0].path.includes('one-use-login-code'));
});

test('cloud environments and the original HTTP version keep separate stored login tokens', () => {
  const f = fixture(); f.login('http-token');
  const cloudA = createSession(f.wx, 'cloud.env-a.hyhq-api');
  const cloudB = createSession(f.wx, 'cloud.env-b.hyhq-api');
  assert.equal(cloudA.token(), ''); assert.equal(cloudB.token(), '');
  cloudA.save({ token: 'cloud-token' }); cloudB.save({ token: 'other-cloud-token' });
  assert.equal(createSession(f.wx).token(), 'http-token');
  assert.equal(createSession(f.wx, 'cloud.env-a.hyhq-api').token(), 'cloud-token');
  cloudA.clear();
  assert.equal(createSession(f.wx).token(), 'http-token');
  assert.equal(createSession(f.wx, 'cloud.env-b.hyhq-api').token(), 'other-cloud-token');
});

test('releaseFile removes only completed files owned by this client cache', async () => {
  const f = fixture(); f.handler(blocks(Buffer.from('audio'), 'audio/mpeg', 'mp3'));
  f.files.set('/private/other.jpg', Buffer.from('keep'));
  const local = await f.client.download(audio);
  f.client.releaseFile('/private/other.jpg'); assert.equal(f.files.get('/private/other.jpg').toString(), 'keep');
  f.client.releaseFile(local); assert.equal(f.files.has(local), false);
  f.client.releaseFile(local); assert.equal(f.deleted.filter((path) => path === local).length, 1);
});
