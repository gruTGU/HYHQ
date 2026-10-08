'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThemeAssetsHandler } = require('../../cloudfunctions/hyhqApi/lib/theme-assets');
const { createApp } = require('../../cloudfunctions/hyhqApi');
const { MemoryStore } = require('./memory-store');

const shared = 'cloud://fixture-env.bucket/themes/shared/river.jpg';
const river = 'cloud://fixture-env.bucket/themes/design-2/river.png';
const flower = 'cloud://fixture-env.bucket/themes/design-2/flower.png';
const paper = 'cloud://fixture-env.bucket/themes/design-3/paper.png';
const manifest = { version: 'test-1', shared: { riverExample: shared }, themes: {
  forest: {}, 'design-2': { weatherRiver: river, entryFlower: flower }, 'design-3': { paperTile: paper },
} };
function context(query = 'theme=design-2', extra = {}) { return { method: 'GET', path: 'theme-assets/', query: new URLSearchParams(query), body: {}, ...extra }; }
function signed(fileID, suffix = '') { return { fileID, status: 0, maxAge: 3600, tempFileURL: 'https://assets.example.test/' + encodeURIComponent(fileID.split('/').pop()) + '?signature=fixture' + suffix }; }
function unwrap(result) { assert.equal(result.statusCode, 200); return result.data.data; }

test('only whitelisted deployment assets can be signed; private/unrecognized fields never leave the server', async () => {
  const calls = [], handler = createThemeAssetsHandler({ getTempFileURL: async request => { calls.push(request); return { fileList: request.fileList.map(item => signed(item.fileID)) }; } }, {
    manifest: { ...manifest, shared: { ...manifest.shared, avatar: 'cloud://private/avatars/user.jpg' }, themes: {
      ...manifest.themes, 'design-2': { ...manifest.themes['design-2'], ownerImage: 'cloud://private/user.jpg', entryLearn: 'https://not-a-cloud-id.invalid/pic.png' },
    } }, clock: () => 0,
  });
  const reply = unwrap(await handler(context()));
  assert.deepEqual(Object.keys(reply.assets).sort(), ['entryFlower', 'riverExample', 'weatherRiver']);
  assert.deepEqual(calls, [{ fileList: [shared, river, flower].map(fileID => ({ fileID, maxAge: 300 })) }]);
  assert.equal(reply.version, 'test-1'); assert.equal(reply.theme, 'design-2');
  assert.equal(reply.expires_at, '1970-01-01T00:04:00.000Z');
  assert.equal(JSON.stringify(reply).includes('cloud://'), false);
});

test('invalid themes, extra file IDs, duplicate parameters and request bodies never invoke the SDK', async () => {
  let calls = 0;
  const handler = createThemeAssetsHandler({ getTempFileURL: async () => { calls++; throw new Error('should not call'); } }, { manifest });
  for (const query of ['', 'theme=unknown', 'theme=__proto__', 'theme=design-2&theme=forest', 'theme=forest&fileID=cloud%3A%2F%2Fprivate%2Fphoto', 'theme=forest&url=https%3A%2F%2Fevil.invalid']) {
    await assert.rejects(handler(context(query)), error => error.code === 'VALIDATION_ERROR');
  }
  await assert.rejects(handler(context('theme=forest', { body: { fileID: 'cloud://private/photo' } })), error => error.code === 'VALIDATION_ERROR');
  await assert.rejects(handler(context('theme=forest', { method: 'POST' })), error => error.status === 405);
  assert.equal(await handler(context('theme=forest', { path: 'another-route/' })), undefined);
  assert.equal(calls, 0);
});

test('same concurrent requests merge and shared files reuse signatures across themes', async () => {
  const calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createThemeAssetsHandler({ getTempFileURL: async request => { calls.push(request); await gate; return { fileList: request.fileList.map(item => signed(item.fileID)) }; } }, { manifest, clock: () => 0 });
  const first = handler(context()), second = handler(context()), forest = handler(context('theme=forest'));
  assert.equal(calls.length, 1);
  release();
  const [a, b, c] = await Promise.all([first, second, forest]);
  assert.deepEqual(a, b); assert.deepEqual(Object.keys(unwrap(c).assets), ['riverExample']);
  await handler(context()); assert.equal(calls.length, 1);
  const other = unwrap(await handler(context('theme=design-3')));
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].fileList, [{ fileID: paper, maxAge: 300 }]);
  assert.equal(other.assets.riverExample, unwrap(c).assets.riverExample);
});

test('expiry honors provider maxAge and refreshes signatures before they expire', async () => {
  let timestamp = 0, calls = 0;
  const handler = createThemeAssetsHandler({ getTempFileURL: async request => {
    calls++; return { fileList: request.fileList.map(item => ({ ...signed(item.fileID, calls), maxAge: 120 })) };
  } }, { manifest, clock: () => timestamp });
  const first = unwrap(await handler(context('theme=forest')));
  assert.equal(first.expires_at, '1970-01-01T00:01:00.000Z');
  timestamp = 59000; await handler(context('theme=forest')); assert.equal(calls, 1);
  timestamp = 60000;
  const next = unwrap(await handler(context('theme=forest'))); assert.equal(calls, 2);
  assert.notEqual(next.assets.riverExample, first.assets.riverExample);
});

test('SDK results without maxAge use the short conservative lifetime and refresh at four minutes', async () => {
  let timestamp = 0, calls = 0;
  const handler = createThemeAssetsHandler({ getTempFileURL: async request => {
    calls++;
    assert.deepEqual(request.fileList, [{ fileID: shared, maxAge: 300 }]);
    return { fileList: request.fileList.map(({ fileID }) => {
      const result = signed(fileID, calls); delete result.maxAge; return result;
    }) };
  } }, { manifest, clock: () => timestamp });
  const first = unwrap(await handler(context('theme=forest')));
  assert.equal(first.expires_at, '1970-01-01T00:04:00.000Z');
  timestamp = 239000; await handler(context('theme=forest')); assert.equal(calls, 1);
  timestamp = 240000;
  const next = unwrap(await handler(context('theme=forest')));
  assert.equal(calls, 2); assert.notEqual(next.assets.riverExample, first.assets.riverExample);
});

test('a missing or failed asset leaves successful illustrations available and retries only failed files', async () => {
  const calls = [];
  const handler = createThemeAssetsHandler({ getTempFileURL: async request => {
    calls.push(request);
    return { fileList: request.fileList.map(item => item.fileID === flower && calls.length === 1
      ? { fileID: flower, status: -1, errMsg: 'missing', tempFileURL: '' } : signed(item.fileID)) };
  } }, { manifest, clock: () => 0 });
  const first = unwrap(await handler(context()));
  assert.deepEqual(Object.keys(first.assets), ['riverExample', 'weatherRiver']);
  assert.equal(first.expires_at, '1970-01-01T00:00:30.000Z');
  const retry = unwrap(await handler(context()));
  assert.ok(retry.assets.entryFlower); assert.deepEqual(calls[1].fileList, [{ fileID: flower, maxAge: 300 }]);
});

test('provider failure, unsafe URLs and unrequested results are omitted without caching failure', async () => {
  let calls = 0;
  const handler = createThemeAssetsHandler({ getTempFileURL: async () => {
    calls++;
    if (calls === 1) throw new Error('provider outage containing sensitive details');
    if (calls === 2) return { fileList: [{ ...signed(shared), tempFileURL: 'http://assets.example.test/insecure.jpg' }, signed('cloud://private/unrequested.jpg')] };
    return { fileList: [signed(shared)] };
  } }, { manifest, clock: () => 0 });
  assert.deepEqual(unwrap(await handler(context('theme=forest'))).assets, {});
  assert.deepEqual(unwrap(await handler(context('theme=forest'))).assets, {});
  assert.deepEqual(Object.keys(unwrap(await handler(context('theme=forest'))).assets), ['riverExample']);
  assert.equal(calls, 3);
});

test('an unconfigured manifest returns a small empty fallback without calling storage', async () => {
  const handler = createThemeAssetsHandler({ getTempFileURL: () => { throw new Error('must not call'); } }, { manifest: { version: 'empty', shared: {}, themes: {} }, clock: () => 0 });
  assert.deepEqual(unwrap(await handler(context())), { version: 'empty', theme: 'design-2', assets: {}, expires_at: '1970-01-01T00:00:30.000Z' });
});

test('route is accessible without account login but still requires trusted mini-program identity', async () => {
  const store = new MemoryStore(), config = { appId: 'wx1234567890123456' };
  const app = createApp({ store, cloud: {}, config });
  const event = { method: 'GET', path: '/api/v1/theme-assets/?theme=forest', headers: {}, body: null };
  const identity = { APPID: config.appId, OPENID: 'valid-public-theme-user' };
  const publicReply = await app(event, identity);
  assert.equal(publicReply.statusCode, 200); assert.equal(publicReply.data.data.theme, 'forest');
  assert.equal((await app(event, {})).statusCode, 403);
  assert.equal((await app({ ...event, path: event.path + '&fileID=cloud%3A%2F%2Fprivate%2Fphoto' }, identity)).statusCode, 400);
});
