'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sdk = require('../../cloudfunctions/hyhqApi/node_modules/wx-server-sdk');
const { EJSON } = require('../../cloudfunctions/hyhqApi/node_modules/bson');
const { CloudStore } = require('../../cloudfunctions/hyhqApi/lib/store');
const { createApp } = require('../../cloudfunctions/hyhqApi');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const clone = value => structuredClone(value);
function setup(t, options = {}) {
  sdk.init({ env: 'hyhq-offline-sdk-contract' });
  const db = sdk.database(options), Db = db._db.constructor, oldRequest = Db.reqClass;
  let records = new Map(), sequence = 0, failure = null, conflict = false, loseCommitKind = null, rejectCommitKind = null;
  const transactions = new Map(), calls = [], transactionOperations = new Map();
  const parse = value => typeof value === 'string' ? EJSON.parse(value) : value;
  // This is the only replacement: the installed SDK still wraps real document,
  // transaction, query and EJSON serializers. No credentials or network are used.
  Db.reqClass = class OfflineTransport {
    async send(action, params = {}) {
      calls.push({ action, params: clone(params) });
      if (failure) return { ...failure };
      if (action === 'database.startTransaction') { const id = 'tx-' + ++sequence; transactions.set(id, new Map([...records].map(([key, value]) => [key, clone(value)]))); transactionOperations.set(id, 0); return { transactionId: id }; }
      if (action === 'database.abortTransaction') { transactions.delete(params.transactionId); return {}; }
      if (action === 'database.commitTransaction') {
        if (conflict) { conflict = false; return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'fixture conflict' }; }
        const pending = transactions.get(params.transactionId);
        if (rejectCommitKind && [...pending.values()].some(row => row._kind === rejectCommitKind)) { rejectCommitKind = null; throw new Error('commit transport failure before durable result'); }
        records = pending; transactions.delete(params.transactionId);
        if (loseCommitKind && [...records.values()].some(row => row._kind === loseCommitKind)) { loseCommitKind = null; throw new Error('commit applied but acknowledgment lost'); }
        return {};
      }
      assert.equal(params.collectionName, 'hyhq_data');
      const target = params.transactionId ? transactions.get(params.transactionId) : records;
      assert.ok(target, 'transaction exists');
      if (params.transactionId) { const count = transactionOperations.get(params.transactionId) + 1; transactionOperations.set(params.transactionId, count); assert.ok(count <= 100, 'CloudBase transaction cannot exceed 100 operations'); }
      const filter = parse(params.query) || {}, selected = [...target.values()].filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
      if (action === 'database.getDocument') {
        if (params.transactionId) assert.ok(filter._id, 'transaction store must not issue queries');
        const order = parse(params.order) || {};
        for (const [field, direction] of Object.entries(order).reverse()) selected.sort((a, b) => (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1) * direction);
        const rows = selected.slice(params.offset || 0, (params.offset || 0) + (params.limit || selected.length));
        return { data: { list: rows.map(value => EJSON.stringify(value)) } };
      }
      if (action === 'database.calculateDocument') return { data: { total: selected.length } };
      if (action === 'database.modifyDocument') {
        assert.equal(params.merge, false, 'store patch must replace object maps, never SDK recursive merge');
        const previous = target.get(filter._id), value = { ...parse(params.data), _id: filter._id };
        assert.equal(Object.hasOwn(parse(params.data), '_id'), false, 'document.set may not include _id');
        target.set(filter._id, value); return { data: { updated: previous ? 1 : 0, upsert_id: previous ? undefined : filter._id } };
      }
      if (action === 'database.insertDocument') {
        const values = params.data.map(parse);
        if (values.some(value => target.has(value._id))) return { code: 'DATABASE_REQUEST_FAILED', message: 'E11000 duplicate key fixture' };
        for (const value of values) target.set(value._id, value);
        return { data: { insertedIds: values.map(value => value._id) } };
      }
      if (action === 'database.removeDocument') { const deleted = target.delete(filter._id); return { data: { deleted: deleted ? 1 : 0 } }; }
      assert.fail('Unexpected SDK network action: ' + action);
    }
  };
  t.after(() => { Db.reqClass = oldRequest; });
  return { db, store: new CloudStore(db), calls, transactionOperations, records: () => records, fail: value => { failure = value; }, conflict: () => { conflict = true; }, loseCommitResponseFor: kind => { loseCommitKind = kind; }, rejectCommitFor: kind => { rejectCommitKind = kind; } };
}
test('installed SDK absent document returns null with default throwing and explicit nonthrowing modes', async t => {
  const f = setup(t); assert.equal(await f.store.get('users', 'absent'), null);
  assert.equal(await f.store.transaction(tx => tx.get('users', 'absent')), null);
  f.db.config.throwOnNotFound = false; assert.equal(await f.store.get('users', 'absent'), null);
});
test('missing collection, authorization, transport and malformed key never become an empty budget', async t => {
  const f = setup(t);
  for (const error of [{ code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'collection does not exist' }, { code: 'DATABASE_PERMISSION_DENIED', message: 'permission denied' }, { code: 'SERVER_TIMEOUT', message: 'timeout' }]) { f.fail(error); await assert.rejects(f.store.get('llm_days', '2026-10-03')); }
  f.fail(null); await assert.rejects(f.store.get('users', '../escape')); await assert.rejects(f.store.get('users.$', 'id'));
});
test('real SDK doc get object/list contracts preserve logical IDs and strip physical metadata', async t => {
  const f = setup(t); await f.store.set('inference_daily', 'global_2026-10-03', { day: '2026-10-03', count: 1, _openid: 'must-be-stripped' });
  const value = await f.store.get('inference_daily', 'global_2026-10-03'); assert.deepEqual(value, { id: 'global_2026-10-03', day: '2026-10-03', count: 1 });
  assert.deepEqual(await f.store.transaction(tx => tx.get('inference_daily', 'global_2026-10-03')), value);
  assert.equal(f.records().get('inference_daily:global_2026-10-03')._kind, 'inference_daily');
  assert.equal(Object.hasOwn(f.records().get('inference_daily:global_2026-10-03'), '_openid'), false);
});
test('shallow patch atomically replaces nested maps instead of retaining deleted reservations', async t => {
  const f = setup(t); await f.store.set('upload_gate', 'global', { active: { expired: { size: 100 }, keep: { size: 200 } }, preserved: 1 });
  await f.store.update('upload_gate', 'global', { active: { keep: { size: 200 } } });
  assert.deepEqual((await f.store.get('upload_gate', 'global')).active, { keep: { size: 200 } });
  await f.store.transaction(async tx => { const value = await tx.update('upload_gate', 'global', { active: {} }); assert.deepEqual(value.active, {}); assert.equal(value.preserved, 1); });
  assert.deepEqual((await f.store.get('upload_gate', 'global')).active, {});
  assert.ok(f.calls.some(row => row.action === 'database.startTransaction'));
  await assert.rejects(f.store.update('users', 'missing', { nickname: 'x' }), e => e.code === 'DOCUMENT_NOT_FOUND');
});
test('transaction create uses unique physical ID and duplicate insertion rolls back prior mutations', async t => {
  const f = setup(t); await f.store.create('asset_usage', 'asset', { job_id: 'job' });
  await assert.rejects(f.store.transaction(async tx => { await tx.set('llm_days', '2026-10-03', { attempts: 1 }); await tx.create('asset_usage', 'asset', { job_id: 'other' }); }));
  assert.equal(await f.store.get('llm_days', '2026-10-03'), null); assert.equal((await f.store.get('asset_usage', 'asset')).job_id, 'job');
  assert.ok(f.calls.some(row => row.action === 'database.insertDocument' && row.params.transactionId));
});
test('SDK transaction retries conflict without double increment and application failure rolls back', async t => {
  const f = setup(t); await f.store.set('llm_days', 'day', { attempts: 0 }); let attempts = 0; f.conflict();
  await f.store.transaction(async tx => { attempts++; const previous = await tx.get('llm_days', 'day'); await tx.update('llm_days', 'day', { attempts: previous.attempts + 1 }); });
  assert.equal(attempts, 2); assert.equal((await f.store.get('llm_days', 'day')).attempts, 1);
  await assert.rejects(f.store.transaction(async tx => { await tx.update('llm_days', 'day', { attempts: 2 }); throw new Error('intentional rollback'); }));
  assert.equal((await f.store.get('llm_days', 'day')).attempts, 1);
});
test('query namespacing, scalar equality, paging and transaction restrictions use real SDK shapes', async t => {
  const f = setup(t); for (let i = 0; i < 4; i++) await f.store.set('sessions', String(i), { owner_id: i === 3 ? 'other' : 'self' });
  await f.store.set('users', 'private', { owner_id: 'self' });
  assert.equal(await f.store.count('sessions', { owner_id: 'self' }), 3);
  assert.deepEqual((await f.store.list('sessions', { where: { owner_id: 'self' }, orderBy: [{ field: 'id', direction: 'desc' }], offset: 1, limit: 1 })).map(x => x.id), ['1']);
  for (const where of [{ _kind: 'users' }, { owner_id: { $ne: '' } }, { 'owner.id': 'self' }]) await assert.rejects(f.store.list('sessions', { where }));
  await assert.rejects(f.store.transaction(tx => tx.list('users'))); await assert.rejects(f.store.transaction(tx => tx.count('users')));
  await assert.rejects(f.store.list('users', { limit: 101 }));
});
test('cloud entry with installed SDK can first-login, delete, re-register and retain stable daily budgets', async t => {
  const f = setup(t), config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const identity = { APPID: config.appId, OPENID: 'offline_sdk_openid_alice' }, app = createApp({ store: f.store, cloud: {}, config, now: () => '2026-10-03T04:00:00.000Z' });
  const call = (method, path, body = {}, token) => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }, identity);
  const first = await call('POST', 'auth/wechat/', { code: 'sdk-code' }); assert.equal(first.statusCode, 200, JSON.stringify(first));
  const auth = first.data.data, owner = await f.store.get('users', auth.user.id);
  await f.store.set('upload_budget', owner.quota_key + '_2026-10-03', { day: '2026-10-03', bytes: 999 });
  assert.equal((await call('DELETE', 'me/', {}, auth.token)).statusCode, 204);
  assert.equal(await f.store.get('users', auth.user.id), null);
  const second = await call('POST', 'auth/wechat/', { code: 'new-code' }); assert.equal(second.statusCode, 200);
  assert.notEqual(second.data.data.user.id, auth.user.id); assert.equal((await f.store.get('users', second.data.data.user.id)).quota_key, owner.quota_key);
  assert.equal((await f.store.get('upload_budget', owner.quota_key + '_2026-10-03')).bytes, 999);
  assert.equal((await call('GET', 'me/', {}, auth.token)).statusCode, 401);
});
test('malformed session expiry and incomplete identity records fail authentication closed', async t => {
  const f = setup(t), config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const identity = { APPID: config.appId, OPENID: 'offline_sdk_openid_bob' }, app = createApp({ store: f.store, cloud: {}, config, now: () => '2026-10-03T04:00:00.000Z' });
  const login = await app({ method: 'POST', path: '/api/v1/auth/wechat/', body: { code: 'code' } }, identity), token = login.data.data.token;
  const record = (await f.store.list('sessions'))[0]; await f.store.update('sessions', record.id, { expires_at: 'invalid' });
  const request = { method: 'GET', path: '/api/v1/me/', headers: { Authorization: 'Bearer ' + token } };
  assert.equal((await app(request, identity)).statusCode, 401);
  await f.store.update('sessions', record.id, { expires_at: '2026-10-09T04:00:00Z' }); await f.store.update('users', login.data.data.user.id, { is_active: null });
  assert.equal((await app(request, identity)).statusCode, 401); assert.equal((await app(request, null)).statusCode, 403);
});
test('two-phase image publication and cancellation clear nested reservations through the installed SDK', async t => {
  const f = setup(t), objects = new Map(), config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const cloud = { uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://offline/' + cloudPath; objects.set(fileID, fileContent); return { fileID }; }, downloadFile: async ({ fileID }) => ({ fileContent: objects.get(fileID) }), deleteFile: async ({ fileList }) => { for (const id of fileList) objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; } };
  const identity = { APPID: config.appId, OPENID: 'offline_sdk_openid_photos' }, app = createApp({ store: f.store, cloud, config, now: () => '2026-10-03T04:00:00.000Z' });
  const request = (method, path, body = {}, token) => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }, identity);
  const login = await request('POST', 'auth/wechat/', { code: 'code' }), token = login.data.data.token;
  const bytes = await require('../../cloudfunctions/hyhqApi/node_modules/sharp')({ create: { width: 50, height: 50, channels: 3, background: '#3a7d5c' } }).png().toBuffer();
  const start = await request('POST', 'cloud-files/uploads/', { purpose: 'recognition', size: bytes.length, request_id: '00000000-0000-4000-8000-000000000001' }, token), id = start.data.data.id;
  assert.equal((await request('PUT', 'cloud-files/uploads/' + id + '/chunks/0/', { data_base64: bytes.toString('base64') }, token)).statusCode, 200);
  const done = await request('POST', 'cloud-files/uploads/' + id + '/complete/', {}, token); assert.equal(done.statusCode, 201, JSON.stringify(done));
  assert.deepEqual((await f.store.get('upload_gate', 'global')).active, {}); assert.deepEqual((await f.store.get('uploads', id)).pending_file_ids, []);
  assert.equal(await f.store.count('upload_chunks'), 0); assert.equal(objects.size, 2);
  // Removing the completed upload receipt must not remove the published asset.
  assert.equal((await request('DELETE', 'cloud-files/uploads/' + id + '/', {}, token)).statusCode, 204); assert.equal(objects.size, 2);
  assert.equal((await request('DELETE', 'me/', {}, token)).statusCode, 204); assert.equal(objects.size, 0); assert.equal(await f.store.count('storage_cleanup'), 0); assert.equal(await f.store.count('upload_budget'), 2);
});
test('LLM admission and retry accounting survive actual SDK serialization without external calls', async t => {
  const f = setup(t), config = { ...configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' }), llmEnabled: true, llmGatewayEnabled: true, deepseekApiKey: 'offline-fake-only', sessionSecret: 'offline-test-session-secret-32-bytes' };
  let external = 0;
  const providers = { getContext: async () => ({ context: { body: '模拟教学资料' }, revision: 'published-v1', citations: [] }), generateLlm: async () => { external++; return { text: '这是模拟资料。', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }; } };
  const identity = { APPID: config.appId, OPENID: 'offline_sdk_openid_llm' }, app = createApp({ store: f.store, cloud: {}, config, providers, now: () => '2026-10-03T04:00:00.000Z' });
  const auth = (await app({ method: 'POST', path: '/api/v1/auth/wechat/', body: { code: 'code' } }, identity)).data.data;
  // Exercise the reusable accounting library against real SDK serialization.
  // The special-release production entry remains closed and has no test bypass.
  const user = await f.store.get('users', auth.user.id);
  const request = (method, path, body = {}) => require('../../cloudfunctions/hyhqApi/lib/llm').handle({ method, path, body, query: new URLSearchParams(), store: f.store, user, config, now: '2026-10-03T04:00:00.000Z' }, providers);
  const s = await request('POST', 'llm/sessions/', { scope: 'learn', source_type: 'content', source_id: '00000000-0000-4000-8000-000000000001' }, auth.token); assert.equal(s.statusCode, 201, JSON.stringify(s));
  const body = { request_id: '00000000-0000-4000-8000-000000000002', question: '资料如何理解？' }, path = 'llm/sessions/' + s.data.data.id + '/turns/';
  const first = await request('POST', path, body, auth.token); assert.equal(first.statusCode, 201, JSON.stringify(first)); assert.equal(external, 0);
  assert.equal((await request('POST', path, body, auth.token)).data.data.id, first.data.data.id);
  const done = await request('GET', 'llm/turns/' + first.data.data.id + '/', {}, auth.token); assert.equal(done.data.data.status, 'succeeded', JSON.stringify(done));
  await request('GET', 'llm/turns/' + first.data.data.id + '/', {}, auth.token); assert.equal(external, 1);
  assert.equal((await f.store.get('llm_days', '2026-10-03')).attempts, 1); assert.equal((await f.store.get('llm_days', '2026-10-03')).accounted_tokens, 3); assert.equal((await f.store.get('llm_days', '2026-10-03')).reserved_tokens, 0);
});
test('SDK commit acknowledgment loss preserves already published cloud image objects', async t => {
  const f = setup(t), objects = new Map(), config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const cloud = { uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://offline/' + cloudPath; objects.set(fileID, fileContent); return { fileID }; }, deleteFile: async ({ fileList }) => { for (const id of fileList) objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; } };
  const identity = { APPID: config.appId, OPENID: 'offline_commit_loss_user' }, app = createApp({ store: f.store, cloud, config, now: () => '2026-10-03T04:00:00.000Z' });
  const request = (method, path, body = {}, token) => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }, identity);
  const token = (await request('POST', 'auth/wechat/', { code: 'code' })).data.data.token;
  const bytes = await require('../../cloudfunctions/hyhqApi/node_modules/sharp')({ create: { width: 50, height: 50, channels: 3, background: '#3a7d5c' } }).png().toBuffer();
  const started = await request('POST', 'cloud-files/uploads/', { purpose: 'recognition', size: bytes.length, request_id: '00000000-0000-4000-8000-000000000007' }, token), id = started.data.data.id;
  await request('PUT', 'cloud-files/uploads/' + id + '/chunks/0/', { data_base64: bytes.toString('base64') }, token);
  f.loseCommitResponseFor('assets');
  const complete = await request('POST', 'cloud-files/uploads/' + id + '/complete/', {}, token); assert.equal(complete.statusCode, 201, JSON.stringify(complete));
  assert.equal(objects.size, 2); assert.equal(await f.store.count('assets'), 1); assert.deepEqual((await f.store.get('uploads', id)).pending_file_ids, []); assert.equal(await f.store.count('storage_cleanup'), 0);
  assert.equal((await request('POST', 'cloud-files/uploads/' + id + '/complete/', {}, token)).statusCode, 200);
});
test('unknown publication outcome keeps pending files until safe later cancellation', async t => {
  const f = setup(t), objects = new Map(), config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' });
  const cloud = { uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://offline/' + cloudPath; objects.set(fileID, fileContent); return { fileID }; }, deleteFile: async ({ fileList }) => { for (const id of fileList) objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; } };
  const identity = { APPID: config.appId, OPENID: 'offline_commit_unknown_user' }, app = createApp({ store: f.store, cloud, config, now: () => '2026-10-03T04:00:00.000Z' });
  const request = (method, path, body = {}, token) => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {} }, identity);
  const token = (await request('POST', 'auth/wechat/', { code: 'code' })).data.data.token;
  const bytes = await require('../../cloudfunctions/hyhqApi/node_modules/sharp')({ create: { width: 50, height: 50, channels: 3, background: '#3a7d5c' } }).png().toBuffer();
  const started = await request('POST', 'cloud-files/uploads/', { purpose: 'recognition', size: bytes.length, request_id: '00000000-0000-4000-8000-000000000008' }, token), id = started.data.data.id;
  await request('PUT', 'cloud-files/uploads/' + id + '/chunks/0/', { data_base64: bytes.toString('base64') }, token); f.rejectCommitFor('assets');
  const complete = await request('POST', 'cloud-files/uploads/' + id + '/complete/', {}, token); assert.equal(complete.statusCode, 503); assert.equal(complete.data.error.code, 'UPLOAD_CONFIRMATION_PENDING');
  assert.equal(objects.size, 2); assert.equal(await f.store.count('assets'), 0); assert.equal((await f.store.get('uploads', id)).pending_file_ids.length, 2);
  assert.equal((await request('DELETE', 'cloud-files/uploads/' + id + '/', {}, token)).statusCode, 204); assert.equal(objects.size, 0);
});
test('twenty abandoned LLM tasks recover in bounded SDK transactions without quota refunds or duplicate billing', async t => {
  const f = setup(t), now = '2026-10-03T04:00:00.000Z', day = '2026-10-03';
  const active = [];
  for (let i = 0; i < 20; i++) {
    const running = i % 2 === 0, id = 'ledger' + i, quotaId = 'quota' + i, turnId = 'turn' + i, ownerId = 'owner' + i;
    active.push({ id, owner_id: ownerId, status: running ? 'running' : 'queued', deadline: '2026-10-03T00:00:00Z' });
    await f.store.set('llm_ledger', id, { owner_id: ownerId, status: running ? 'running' : 'queued', dispatched: running, reserved_tokens: 100, quota_id: quotaId, turn_id: turnId, day });
    await f.store.set('llm_quotas', quotaId, { attempts: 1, succeeded: 0, reserved: 1 }); await f.store.set('llm_turns', turnId, { status: running ? 'running' : 'queued' });
  }
  await f.store.set('llm_days', day, { attempts: 20, accounted_tokens: 0, reserved_tokens: 2000 }); await f.store.set('llm_gate', 'runtime', { active });
  const llm = require('../../cloudfunctions/hyhqApi/lib/llm'), ctx = { store: f.store, now, user: { id: 'owner19' } };
  for (let i = 0; i < 5; i++) assert.equal(await llm.recoverExpired(ctx), 4);
  assert.deepEqual((await f.store.get('llm_gate', 'runtime')).active, []);
  const usage = await f.store.get('llm_days', day); assert.equal(usage.attempts, 20); assert.equal(usage.accounted_tokens, 1000); assert.equal(usage.reserved_tokens, 0);
  assert.equal(await llm.recoverExpired(ctx), 0); assert.ok(Math.max(...f.transactionOperations.values()) < 100);
});
