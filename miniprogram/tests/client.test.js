const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/client');
const { createSession } = require('../lib/session');

function fixture() {
  const storage = new Map();
  const calls = [];
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request: (options) => calls.push({ type: 'request', options }),
    uploadFile: (options) => calls.push({ type: 'upload', options }),
    downloadFile: (options) => calls.push({ type: 'download', options }),
  };
  const session = createSession(wx);
  const client = createClient(wx, { baseURL: 'https://campus.example/api/v1/', timeout: 15000, uploadTimeout: 30000 }, session);
  return { wx, calls, session, client };
}

test('public request has no token; list response preserves pagination metadata', async () => {
  const { client, calls } = fixture();
  const promise = client.request('places/', { data: { region: 'demo-campus' } });
  assert.equal(calls[0].options.url, 'https://campus.example/api/v1/places/');
  assert.equal(calls[0].options.header.Authorization, undefined);
  calls[0].options.success({ statusCode: 200, data: { data: [{ id: 'p1' }], meta: { next: null, count: 1 } } });
  assert.deepEqual((await promise).meta, { next: null, count: 1 });
});

test('private file download sends bearer only in headers', async () => {
  const { client, calls, session } = fixture();
  session.save({ token: 'test-token', user: { id: 1 } });
  const promise = client.download('/api/v1/uploads/asset/content/?variant=thumbnail');
  assert.equal(calls[0].options.header.Authorization, 'Bearer test-token');
  assert.ok(!calls[0].options.url.includes('test-token'));
  calls[0].options.success({ statusCode: 200, tempFilePath: '/tmp/mock-thumbnail' });
  assert.equal(await promise, '/tmp/mock-thumbnail');
});

test('foreign URLs, scheme-relative URLs and backslashes never receive authentication', async () => {
  const { client, calls, session } = fixture();
  session.save({ token: 'test-token' });
  for (const url of ['https://evil.example/x', 'https://campus.example.evil.example/x', '//evil.example/x', 'https://campus.example/\\evil.example', 'javascript:alert(1)']) {
    await assert.rejects(client.download(url), { code: 'UNSAFE_FILE_URL' });
  }
  assert.equal(calls.length, 0);
});

test('upload parses wx string responses and does not set multipart content-type manually', async () => {
  const { client, calls, session } = fixture();
  session.save({ token: 'test-token' });
  const promise = client.upload('/tmp/mock.jpg', 'avatar');
  const options = calls[0].options;
  assert.equal(options.name, 'file');
  assert.deepEqual(options.formData, { purpose: 'avatar' });
  assert.equal(options.header['content-type'], undefined);
  options.success({ statusCode: 201, data: JSON.stringify({ data: { id: 'asset' } }) });
  assert.deepEqual(await promise, { id: 'asset' });
});

test('401 revokes the active local session and preserves stable error metadata', async () => {
  const { client, calls, session } = fixture();
  session.save({ token: 'test-token' });
  const promise = client.request('me/');
  calls[0].options.success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: '请重新登录' }, request_id: 'req-1' } });
  await assert.rejects(promise, { code: 'AUTH_REQUIRED', requestId: 'req-1' });
  assert.equal(session.token(), '');
  assert.equal(session.invalidation().reason, 'expired');
});

test('an old in-flight 401 cannot clear a newly established session', async () => {
  const { client, calls, session } = fixture();
  session.save({ token: 'old-token' });
  const promise = client.request('me/');
  session.save({ token: 'new-token' });
  calls[0].options.success({ statusCode: 401, data: { error: { message: 'Expired' } } });
  await assert.rejects(promise);
  assert.equal(session.token(), 'new-token');
});

test('upload and private download 401 clear the session consistently', async () => {
  for (const type of ['upload', 'download']) {
    const { client, calls, session } = fixture();
    session.save({ token: 'test-token' });
    const promise = type === 'upload' ? client.upload('/tmp/a.jpg') : client.download('/api/v1/uploads/a/content/');
    calls[0].options.success({ statusCode: 401, data: '{"error":{"message":"expired"}}' });
    await assert.rejects(promise);
    assert.equal(session.token(), '');
  }
});

test('network timeout, invalid response and 204 are handled distinctly', async () => {
  const { client, calls } = fixture();
  const timeout = client.request('health/');
  calls[0].options.fail({ errMsg: 'request:fail timeout' });
  await assert.rejects(timeout, { code: 'TIMEOUT' });
  const invalid = client.request('health/');
  calls[1].options.success({ statusCode: 200, data: '<html>proxy page</html>' });
  await assert.rejects(invalid, { code: 'INVALID_RESPONSE' });
  const deleted = client.request('me/', { method: 'DELETE' });
  calls[2].options.success({ statusCode: 204, data: '' });
  assert.deepEqual(await deleted, { data: null });
});

test('session expires, survives instance reload and keeps dev identifier stable', () => {
  const { wx, session } = fixture();
  const id = session.deviceId();
  assert.equal(session.deviceId(), id);
  session.save({ token: 'test-token', expires_at: '2099-01-01T00:00:00Z' });
  assert.equal(createSession(wx).token(), 'test-token');
  session.save({ token: 'test-token', expires_at: '2000-01-01T00:00:00Z' });
  assert.equal(session.token(), '');
  assert.equal(createSession(wx).token(), '');
});
