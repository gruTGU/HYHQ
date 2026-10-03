'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const { createApp } = require('../../cloudfunctions/hyhqApi');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const { uuid } = require('../../cloudfunctions/hyhqApi/lib/core');
const sharp = require('../../cloudfunctions/hyhqApi/node_modules/sharp');
function setup() {
  const store = new MemoryStore(), objects = new Map(); let clock = '2026-10-03T12:00:00.000Z', uploads = 0;
  const cloud = { uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://test/' + cloudPath; objects.set(fileID, fileContent); uploads++; return { fileID }; }, downloadFile: async ({ fileID }) => ({ fileContent: objects.get(fileID) }), deleteFile: async ({ fileList }) => { for (const id of fileList) objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; } };
  const config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const app = createApp({ store, cloud, config, now: () => clock });
  const identity = name => ({ APPID: config.appId, OPENID: 'openid-test-' + name });
  const call = (path, method = 'GET', body = null, token, name = 'alice') => app({ path: '/api/v1/' + path, method, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }, identity(name));
  const login = async (name = 'alice') => { const result = await call('auth/wechat/', 'POST', { code: 'wx-sdk-login-code' }, null, name); assert.equal(result.statusCode, 200, JSON.stringify(result)); return result.data.data; };
  return { store, objects, app, call, login, identity, config, setClock: value => { clock = value; }, uploads: () => uploads };
}
async function upload(f, token, purpose = 'recognition', image, name = 'alice') {
  const bytes = image || await sharp({ create: { width: 80, height: 60, channels: 3, background: '#3a7d5c' } }).png().toBuffer();
  const started = await f.call('cloud-files/uploads/', 'POST', { purpose, size: bytes.length, request_id: uuid() }, token, name);
  assert.equal(started.statusCode, 201, JSON.stringify(started)); const id = started.data.data.id;
  const sent = await f.call('cloud-files/uploads/' + id + '/chunks/0/', 'PUT', { data_base64: bytes.toString('base64') }, token, name);
  assert.equal(sent.statusCode, 200, JSON.stringify(sent));
  const result = await f.call('cloud-files/uploads/' + id + '/complete/', 'POST', {}, token, name);
  return { id, result, bytes };
}
test('entry rejects forged identity, path traversal and oversized events', async () => {
  const f = setup();
  assert.equal((await f.app({ method: 'GET', path: '/api/v1/health/', OPENID: 'forged', APPID: f.config.appId }, {})).statusCode, 403);
  assert.equal((await f.app({ method: 'GET', path: '/api/v1/health/' }, { ...f.identity('alice'), APPID: 'wxwrong' })).statusCode, 403);
  for (const path of ['/api/v1/../me/', '/api/v1//me/', '/api/v1/%2e%2e/me/', 'https://evil/api/v1/me/']) assert.equal((await f.app({ method: 'GET', path }, f.identity('alice'))).statusCode, 400);
  assert.equal((await f.call('me/', 'POST', { data: 'x'.repeat(400001) })).statusCode, 400);
});
test('native login uses trusted SDK identity, token is hashed and bound to caller', async () => {
  const f = setup(), alice = await f.login(), bob = await f.login('bob');
  assert.notEqual(alice.user.id, bob.user.id);
  assert.equal((await f.call('me/', 'GET', null, alice.token)).data.data.id, alice.user.id);
  assert.equal((await f.call('me/', 'GET', null, alice.token, 'bob')).statusCode, 401);
  assert.equal((await f.call('me/')).statusCode, 401);
  assert.equal((await f.call('auth/dev/', 'POST', { device_id: 'a'.repeat(30) })).statusCode, 404);
  assert.equal(JSON.stringify([...f.store.data.values()]).includes(alice.token), false);
  assert.equal(JSON.stringify(alice.user).includes('quota_key'), false);
  await f.call('auth/logout/', 'POST', {}, alice.token);
  assert.equal((await f.call('me/', 'GET', null, alice.token)).statusCode, 401);
});
test('cloud entry serves published catalog and rejects unimplemented routes', async () => {
  const f = setup();
  for (const path of ['health/', 'regions/', 'contents/', 'routes/']) assert.equal((await f.call(path)).statusCode, 200, path);
  assert.equal((await f.call('unavailable/')).statusCode, 404);
});
test('image upload normalizes privately; cross-user access and arbitrary downloads fail', async () => {
  const f = setup(), alice = await f.login(), bob = await f.login('bob');
  const { result, id } = await upload(f, alice.token); assert.equal(result.statusCode, 201, JSON.stringify(result));
  const asset = result.data.data;
  assert.equal(asset.width, 80); assert.equal(asset.height, 60); assert.equal(JSON.stringify(asset).includes('cloud://'), false);
  const path = 'cloud-files/download/?path=' + encodeURIComponent(asset.thumbnail_url);
  const own = await f.call(path, 'GET', null, alice.token); assert.equal(own.statusCode, 200); assert.equal(own.data.data.content_type, 'image/jpeg');
  assert.equal((await f.call(path, 'GET', null, bob.token, 'bob')).statusCode, 404);
  assert.equal((await f.call(path)).statusCode, 401);
  assert.equal((await f.call('cloud-files/download/?path=' + encodeURIComponent('https://evil/file'), 'GET', null, alice.token)).statusCode, 400);
  assert.equal((await f.call(path + '&offset=1', 'GET', null, alice.token)).statusCode, 416);
  assert.equal((await f.call('cloud-files/uploads/' + id + '/complete/', 'POST', {}, alice.token)).statusCode, 200);
  assert.equal(f.uploads(), 2);
});
test('invalid images cannot persist in cloud storage; declared size and duplicate chunks are checked', async () => {
  const f = setup(), alice = await f.login();
  assert.equal((await upload(f, alice.token, 'recognition', Buffer.from('not an image'))).result.statusCode, 400);
  assert.equal(f.objects.size, 0);
  const body = { purpose: 'recognition', size: 3, request_id: uuid() };
  const first = await f.call('cloud-files/uploads/', 'POST', body, alice.token), id = first.data.data.id;
  assert.equal((await f.call('cloud-files/uploads/', 'POST', body, alice.token)).data.data.id, id);
  assert.equal((await f.call('cloud-files/uploads/', 'POST', { ...body, size: 4 }, alice.token)).statusCode, 409);
  assert.equal((await f.call('cloud-files/uploads/' + id + '/chunks/0/', 'PUT', { data_base64: 'YWI=' }, alice.token)).statusCode, 400);
  assert.equal((await f.call('cloud-files/uploads/' + id + '/chunks/0/', 'PUT', { data_base64: 'YWJj' }, alice.token)).statusCode, 200);
  assert.equal((await f.call('cloud-files/uploads/' + id + '/chunks/0/', 'PUT', { data_base64: 'YWJk' }, alice.token)).statusCode, 409);
});
test('avatar ownership and purpose are enforced; replacing removes the previous files', async () => {
  const f = setup(), alice = await f.login(), bob = await f.login('bob');
  const avatar = (await upload(f, alice.token, 'avatar')).result.data.data;
  assert.equal((await f.call('me/', 'PATCH', { avatar_asset_id: avatar.id }, bob.token, 'bob')).statusCode, 400);
  const changed = await f.call('me/', 'PATCH', { avatar_asset_id: avatar.id, nickname: '海晏', record_history: false }, alice.token);
  assert.equal(changed.statusCode, 200); assert.equal(changed.data.data.record_history, false);
  assert.equal((await f.store.get('assets', avatar.id)).expires_at, null);
  await f.call('me/', 'PATCH', { avatar_asset_id: null }, alice.token);
  assert.equal(f.objects.size, 0);
  assert.equal((await f.call('me/', 'PATCH', { is_admin: true }, alice.token)).statusCode, 400);
});
test('original expires independently from thumbnail and account deletion purges files/sessions', async () => {
  const f = setup(), alice = await f.login();
  const before = await f.store.get('users', alice.user.id), { result } = await upload(f, alice.token), asset = result.data.data;
  f.setClock('2026-10-05T12:00:00.000Z');
  const path = 'cloud-files/download/?path=' + encodeURIComponent(asset.thumbnail_url);
  assert.equal((await f.call(path, 'GET', null, alice.token)).statusCode, 200);
  assert.equal((await f.call(path.replace('thumbnail', 'original'), 'GET', null, alice.token)).statusCode, 410);
  assert.equal((await f.call('me/', 'DELETE', {}, alice.token)).statusCode, 204);
  assert.equal(f.objects.size, 0); assert.equal(await f.store.get('users', alice.user.id), null);
  assert.equal((await f.call('me/', 'GET', null, alice.token)).statusCode, 401);
  const again = await f.login(); assert.notEqual(again.user.id, alice.user.id);
  assert.equal((await f.store.get('users', again.user.id)).quota_key, before.quota_key);
  assert.equal((await f.store.list('upload_budget')).length, 2);
});
test('configuration never enables paid APIs by default and caps user limits', () => {
  const config = configFromEnvironment({}); assert.equal(config.llmEnabled, false); assert.equal(config.qweatherMonthlyLimit, 0); assert.equal(config.inferenceEnabled, false);
  assert.equal(configFromEnvironment({ HYHQ_LLM_DAILY_LIMIT: '50' }).llmDailyLimit, 5);
});
