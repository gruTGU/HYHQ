'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const maintenance = require('../../cloudfunctions/hyhqApi/lib/maintenance');
const files = require('../../cloudfunctions/hyhqApi/lib/files');
const accounts = require('../../cloudfunctions/hyhqApi/lib/accounts');
const llm = require('../../cloudfunctions/hyhqApi/lib/llm');
const NOW = '2026-10-03T04:00:00.000Z', OLD = '2026-01-01T00:00:00.000Z', FUTURE = '2026-11-03T00:00:00.000Z';
const A = '00000000-0000-4000-8000-000000000001';
async function setup() {
  const store = new MemoryStore(), objects = new Map();
  const user = { id: 'admin', is_active: true, avatar_id: null };
  await store.set('users', user.id, user);
  const cloud = { deleteFile: async ({ fileList }) => { for (const id of fileList) objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; }, downloadFile: async ({ fileID }) => ({ fileContent: objects.get(fileID) }) };
  const ctx = { method: 'POST', path: 'management/maintenance/', query: new URLSearchParams(), body: {}, now: NOW, user, store, config: { management: { enabled: true, adminUserIds: [user.id] } } };
  ctx.storage = files.storageFor(ctx, cloud);
  return { ctx, cloud, objects };
}
async function asset(f, overrides = {}) {
  const row = { id: A, owner_id: f.ctx.user.id, purpose: 'recognition', created_at: '2026-10-01T00:00:00.000Z', original_file_id: 'cloud://private/original', thumbnail_file_id: 'cloud://private/thumb', original_expires_at: '2026-10-02T00:00:00.000Z', expires_at: FUTURE, ...overrides };
  for (const file of [row.original_file_id, row.thumbnail_file_id].filter(Boolean)) f.objects.set(file, Buffer.from([255, 216, 1, 255, 217]));
  await f.ctx.store.set('assets', row.id, row); return row;
}
const run = (f, kind, limit) => maintenance.runMaintenance(f.ctx, { kind, ...(limit ? { limit } : {}) });
test('weather AI interpretation drafts expire independently without erasing billing evidence', async () => {
  const f = await setup();
  await f.ctx.store.set('weather_ai_drafts', 'expired', { id: 'expired', owner_id: 'admin', expires_at: OLD, proposal: { private: 'old' } });
  await f.ctx.store.set('weather_ai_drafts', 'valid', { id: 'valid', owner_id: 'admin', expires_at: '2099-01-01T00:00:00Z' });
  await f.ctx.store.set('llm_days', '2026-10-07', { id: '2026-10-07', reserved_tokens: 0, billed_tokens: 123 });
  const result = await run(f, 'weather_ai_drafts');
  assert.equal(result.removed, 1); assert.equal(await f.ctx.store.get('weather_ai_drafts', 'expired'), null);
  assert.ok(await f.ctx.store.get('weather_ai_drafts', 'valid')); assert.equal((await f.ctx.store.get('llm_days', '2026-10-07')).billed_tokens, 123);
  assert.doesNotMatch(JSON.stringify(result), /proposal|private/);
});
test('maintenance requires fresh configured administrator; forged cron fields confer no authority', async () => {
  const f = await setup();
  for (const config of [{}, { management: { enabled: false, adminUserIds: ['admin'] } }, { management: { enabled: true, adminUserIds: [] } }]) await assert.rejects(maintenance.handle({ ...f.ctx, config, type: 'Timer', trigger: 'trusted' }), e => e.status === 403);
  await assert.rejects(maintenance.handle({ ...f.ctx, user: null, type: 'Timer' }), e => e.status === 401);
  await f.ctx.store.update('users', 'admin', { is_active: false });
  await assert.rejects(maintenance.handle(f.ctx), e => e.status === 401);
  assert.equal(await maintenance.handle({ ...f.ctx, path: 'unrelated/' }), undefined);
});
test('status contains policy and aggregate results only; destructive options and oversized batches are rejected', async () => {
  const f = await setup(), status = (await maintenance.handle({ ...f.ctx, method: 'GET' })).data.data;
  assert.equal(status.policy.accounting_days, 90); assert.equal(status.policy.automatic_schedule_enabled, false);
  for (const options of [{ limit: 21 }, { kind: 'users' }, { force: true }, { limit: 0 }]) await assert.rejects(maintenance.runMaintenance(f.ctx, options), e => e.code === 'VALIDATION_ERROR');
});
test('expired originals are actually removed while thumbnails remain readable', async () => {
  const f = await setup(), row = await asset(f); const out = await run(f, 'assets');
  assert.equal(out.scanned, 1); assert.equal(out.removed, 0); assert.equal(f.objects.has(row.original_file_id), false); assert.equal(f.objects.has(row.thumbnail_file_id), true);
  const current = await f.ctx.store.get('assets', A); assert.equal(current.original_file_id, null); assert.equal(current.original_deleted_at, NOW);
  await assert.rejects(f.ctx.storage.readAsset(f.ctx.user, A), e => e.status === 410);
  assert.ok((await f.ctx.storage.readAsset(f.ctx.user, A, { variant: 'thumbnail' })).bytes.length);
});
test('thumbnail expiry removes both stored objects and their document', async () => {
  const f = await setup(); await asset(f, { expires_at: OLD }); assert.equal((await run(f, 'assets')).removed, 1);
  assert.equal(f.objects.size, 0); assert.equal(await f.ctx.store.get('assets', A), null);
});
test('active selected avatar survives TTL; unselected old avatar and deleted owner do not', async () => {
  const f = await setup(); await asset(f, { purpose: 'avatar', original_expires_at: null, expires_at: null }); await f.ctx.store.update('users', 'admin', { avatar_id: A });
  assert.equal((await run(f, 'assets')).removed, 0); assert.equal(f.objects.size, 2);
  await f.ctx.store.update('users', 'admin', { avatar_id: null }); assert.equal((await run(f, 'assets')).removed, 1); assert.equal(f.objects.size, 0);
  await asset(f, { expires_at: FUTURE, original_expires_at: FUTURE }); await f.ctx.store.remove('users', 'admin'); assert.equal((await run(f, 'assets')).removed, 1);
});
test('partial cloud deletion persists retry markers and later maintenance completes', async () => {
  const f = await setup(); const row = await asset(f, { expires_at: OLD }); let fail = true;
  f.cloud.deleteFile = async ({ fileList }) => { if (fail) { f.objects.delete(fileList[0]); return { fileList: [{ fileID: fileList[0], status: 0 }, { fileID: fileList[1], status: -1, errMsg: 'temporary failure' }] }; } for (const id of fileList) f.objects.delete(id); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; };
  assert.equal((await run(f, 'assets')).failed, 1); const pending = await f.ctx.store.get('assets', A); assert.equal(pending.deleting, true); assert.equal(pending.thumbnail_file_id, row.thumbnail_file_id);
  await assert.rejects(f.ctx.storage.readAsset(f.ctx.user, A, { variant: 'thumbnail' }), e => e.status === 404);
  fail = false; assert.equal((await run(f, 'assets')).removed, 1); assert.equal(f.objects.size, 0);
});
test('missing delete receipts fail closed, while explicit object-not-found is retry success', async () => {
  const f = await setup(); await asset(f, { expires_at: OLD }); f.cloud.deleteFile = async () => ({ fileList: [] });
  assert.equal((await run(f, 'assets')).failed, 1); assert.ok(await f.ctx.store.get('assets', A));
  f.cloud.deleteFile = async ({ fileList }) => ({ fileList: fileList.map(fileID => ({ fileID, status: -1, errMsg: 'file not found' })) });
  assert.equal((await run(f, 'assets')).removed, 1);
});
test('download rechecks deletion and identity after object storage I/O', async () => {
  const f = await setup(); await asset(f, { original_expires_at: FUTURE });
  f.cloud.downloadFile = async () => { await f.ctx.store.update('assets', A, { original_deleting: true }); return { fileContent: Buffer.from('jpeg') }; };
  await assert.rejects(f.ctx.storage.readAsset(f.ctx.user, A), e => e.status === 410);
  await f.ctx.store.update('assets', A, { original_deleting: false });
  f.cloud.downloadFile = async () => { await f.ctx.store.update('users', 'admin', { is_active: false }); return { fileContent: Buffer.from('jpeg') }; };
  await assert.rejects(f.ctx.storage.readAsset(f.ctx.user, A), e => e.status === 401);
});
test('avatar pin cannot race a claimed cleanup; old-avatar deletion preserves concurrent reselection', async () => {
  const f = await setup(); await asset(f, { purpose: 'avatar', original_expires_at: FUTURE, original_deleting: true });
  await assert.rejects(accounts.handle({ ...f.ctx, method: 'PATCH', path: 'me/', body: { avatar_asset_id: A } }), e => e.code === 'VALIDATION_ERROR');
  await f.ctx.store.update('assets', A, { original_deleting: false }); await f.ctx.store.update('users', 'admin', { avatar_id: A });
  await f.ctx.storage.deleteAsset(f.ctx.user, A); assert.equal(f.objects.size, 2); assert.ok(await f.ctx.store.get('assets', A));
});
test('expired upload cancels first, removes all chunks and releases reservation without refunding budget', async () => {
  const f = await setup(); await f.ctx.store.set('uploads', A, { id: A, owner_id: 'admin', status: 'processing', expires_at: OLD, total_size: 400000 });
  await f.ctx.store.set('upload_gate', 'global', { id: 'global', active: { [A]: { owner_id: 'admin', size: 400000, expires_at: OLD } } });
  await f.ctx.store.set('upload_budget', 'quota', { id: 'quota', day: '2026-10-03', bytes: 400000 });
  for (let i = 0; i < 3; i++) await f.ctx.store.set('upload_chunks', A + '_' + i, { id: A + '_' + i, data_base64: 'private' });
  assert.equal((await run(f, 'uploads')).removed, 1); assert.equal(await f.ctx.store.count('upload_chunks'), 0); assert.deepEqual((await f.ctx.store.get('upload_gate', 'global')).active, {}); assert.equal((await f.ctx.store.get('upload_budget', 'quota')).bytes, 400000);
});
test('orphan chunks are removed but live uploads and chunks remain', async () => {
  const f = await setup(), B = A.replace(/1$/, '2');
  await f.ctx.store.set('uploads', A, { id: A, total_size: 1, status: 'uploading', expires_at: FUTURE });
  for (const id of [A, B]) await f.ctx.store.set('upload_chunks', id + '_0', { id: id + '_0', data_base64: 'eA==' });
  assert.equal((await run(f, 'uploads')).removed, 0); assert.equal((await run(f, 'upload_chunks')).removed, 1); assert.ok(await f.ctx.store.get('upload_chunks', A + '_0'));
});
test('bounded cursor advances across live records without skipping deletions, then wraps', async () => {
  const f = await setup();
  for (let i = 0; i < 7; i++) await f.ctx.store.set('sessions', String(i), { id: String(i), expires_at: i % 2 ? FUTURE : OLD });
  for (let i = 0; i < 6; i++) { const out = await run(f, 'sessions', 2); assert.ok(out.scanned <= 2); }
  assert.deepEqual((await f.ctx.store.list('sessions')).map(r => r.id).sort(), ['1', '3', '5']);
  const state = await f.ctx.store.get('maintenance_state', 'global'); assert.ok(state.recent.length <= 20); assert.doesNotMatch(JSON.stringify(state), /private|cloud:\/\//);
});
test('maintenance lease serializes concurrent sweeps and abandoned leases are recoverable', async () => {
  const f = await setup(); let proceed, started; const entered = new Promise(resolve => { started = resolve; });
  await asset(f); f.cloud.deleteFile = async ({ fileList }) => { started(); await new Promise(resolve => { proceed = resolve; }); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; };
  const first = run(f, 'assets'); await entered; await assert.rejects(run(f, 'assets'), e => e.code === 'MAINTENANCE_BUSY'); proceed(); await first;
  await f.ctx.store.update('maintenance_state', 'global', { lease_token: 'dead', lease_until: OLD }); assert.equal((await run(f, 'sessions')).scanned, 0);
});
test('accounting retains full active windows and removes only completed old records', async () => {
  const f = await setup();
  for (const kind of ['llm_quotas', 'upload_budget', 'inference_daily']) for (const [id, day] of [['old', '2026-01-01'], ['recent', '2026-10-03']]) await f.ctx.store.set(kind, id, { id, day, reserved: 0 });
  await f.ctx.store.set('llm_quotas', 'reserved', { id: 'reserved', day: '2026-01-01', reserved: 1 });
  for (const kind of ['llm_quotas', 'upload_budget', 'inference_daily']) { assert.equal((await run(f, kind)).removed, 1); assert.ok(await f.ctx.store.get(kind, 'recent')); }
  assert.ok(await f.ctx.store.get('llm_quotas', 'reserved'));
  await f.ctx.store.set('llm_ledger', 'finished', { id: 'finished', status: 'failed', day: '2026-01-01', finished_at: OLD });
  await f.ctx.store.set('llm_ledger', 'active', { id: 'active', status: 'running', day: '2026-01-01', finished_at: OLD });
  assert.equal((await run(f, 'llm_ledger')).removed, 1); assert.ok(await f.ctx.store.get('llm_ledger', 'active'));
  await f.ctx.store.set('weather_gate', 'budget', { id: 'budget', days: { '2026-10-01': 99 } });
  await f.ctx.store.set('weather_requests', 'old', { id: 'old', reserved_at: OLD }); await f.ctx.store.set('weather_requests', 'new', { id: 'new', reserved_at: NOW });
  assert.equal((await run(f, 'weather_requests')).removed, 1); assert.equal((await f.ctx.store.get('weather_gate', 'budget')).days['2026-10-01'], 99);
});
test('expired sessions remove private turns later and cancel active LLM without refunding attempts', async () => {
  const f = await setup();
  await f.ctx.store.set('llm_sessions', 'session', { id: 'session', owner_id: 'admin', expires_at: OLD });
  await f.ctx.store.set('llm_turns', 'turn', { id: 'turn', session_id: 'session', status: 'running', question: 'private' });
  await f.ctx.store.set('llm_owners', 'admin', { id: 'admin', owner_id: 'admin', sessions: [{ id: 'session', expires_at: OLD }] });
  await f.ctx.store.set('llm_ledger', 'ledger', { id: 'ledger', session_id: 'session', turn_id: 'turn', status: 'running', dispatched: true, day: '2026-10-03', quota_id: 'quota', reserved_tokens: 100 });
  await f.ctx.store.set('llm_days', '2026-10-03', { id: '2026-10-03', attempts: 1, reserved_tokens: 100, accounted_tokens: 0 });
  await f.ctx.store.set('llm_quotas', 'quota', { id: 'quota', attempts: 1, succeeded: 0, reserved: 1 });
  await f.ctx.store.set('llm_gate', 'runtime', { id: 'runtime', active: [{ id: 'ledger', status: 'running', deadline: FUTURE }] });
  assert.equal((await run(f, 'llm_sessions')).removed, 1); assert.equal((await f.ctx.store.get('llm_days', '2026-10-03')).accounted_tokens, 100); assert.equal((await f.ctx.store.get('llm_days', '2026-10-03')).attempts, 1);
  assert.equal((await run(f, 'llm_turns')).removed, 1); assert.equal(await f.ctx.store.get('llm_turns', 'turn'), null);
});
test('expired inference jobs respect active CPU lease and clean asset usage afterward', async () => {
  const f = await setup(); await f.ctx.store.set('recognition_jobs', 'job', { id: 'job', asset_id: A, expires_at: OLD }); await f.ctx.store.set('asset_usage', A, { id: A, job_id: 'job', kind: 'recognition' });
  await f.ctx.store.set('inference_gate', 'cpu', { id: 'cpu', job_id: 'job', expires_at: FUTURE }); assert.equal((await run(f, 'recognition_jobs')).removed, 0);
  await f.ctx.store.update('inference_gate', 'cpu', { expires_at: OLD }); assert.equal((await run(f, 'recognition_jobs')).removed, 1); assert.equal(await f.ctx.store.get('asset_usage', A), null);
});
test('invalid explicit LLM budget cannot silently revert to a larger default', () => {
  for (const llmGlobalTokenLimit of [0, -1, '1000000', 100000001]) assert.throws(() => llm.configFor({ config: { llmGlobalTokenLimit } }), e => e.code === 'LLM_CONFIG_INVALID');
  assert.equal(llm.configFor({ config: {} }).globalTokens, 1000000);
});
test('interrupted upload retains cloud file cleanup until storage acknowledges deletion', async () => {
  const f = await setup(), id = 'cloud://private/interrupted'; f.objects.set(id, Buffer.from('jpeg'));
  await f.ctx.store.set('uploads', A, { id: A, owner_id: 'admin', total_size: 1, status: 'processing', expires_at: OLD, pending_file_ids: [id] });
  f.cloud.deleteFile = async () => { throw new Error('transport failure'); };
  assert.equal((await run(f, 'uploads')).failed, 1); assert.equal((await f.ctx.store.get('uploads', A)).status, 'cancelled'); assert.equal(await f.ctx.store.count('storage_cleanup'), 1);
  f.cloud.deleteFile = async ({ fileList }) => { for (const value of fileList) f.objects.delete(value); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; };
  assert.equal((await run(f, 'storage_cleanup')).removed, 1); assert.equal(f.objects.size, 0); assert.equal((await run(f, 'uploads')).removed, 1);
});
test('expired job maintenance releases stored-record capacity but never daily inference budget', async () => {
  const f = await setup(); await f.ctx.store.update('users', 'admin', { inference_counts: { recognition: 200 }, record_revision: 3 });
  await f.ctx.store.set('recognition_jobs', 'job', { id: 'job', owner_id: 'admin', asset_id: A, status: 'succeeded', expires_at: OLD });
  await f.ctx.store.set('inference_daily', 'today', { id: 'today', day: '2026-10-03', count: 20 });
  assert.equal((await run(f, 'recognition_jobs')).removed, 1); assert.equal((await f.ctx.store.get('users', 'admin')).inference_counts.recognition, 199); assert.equal((await f.ctx.store.get('inference_daily', 'today')).count, 20);
});
