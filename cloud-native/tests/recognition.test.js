'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const { handle, status } = require('../../cloudfunctions/hyhqApi/lib/recognition');
const inference = require('../../cloudfunctions/hyhqApi/lib/inference');
const { ApiError, uuid } = require('../../cloudfunctions/hyhqApi/lib/core');
const DAY = '2026-10-03T02:00:00.000Z';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function flower() { return { decision: 'recognized', candidates: [{ label: 'daisy', name: '雏菊类花卉', score: 0.8, content_id: null }], threshold: 0, model: inference.snapshot('recognition'), scope: '五类', disclaimer: '仅候选' }; }
async function fixture(config = {}) {
  const store = new MemoryStore(), user = { id: uuid(), is_active: true, record_revision: 0, quota_key: 'a'.repeat(64) };
  await store.set('users', user.id, user);
  let calls = 0, deleted = [];
  const ctx = { store, user, now: DAY, config: { inferenceEnabled: true, recognitionDailyLimit: 20, recognitionGlobalDailyLimit: 200, inferenceTimeoutSeconds: 35, catalogSeed: { schema_version: 1, collections: {} }, ...config }, query: new URLSearchParams(), body: {}, method: 'POST', path: 'recognition-jobs/', storage: {
    async readAsset(u, id) { const asset = await store.get('assets', id); if (!asset || asset.owner_id !== u.id || asset.deleting) throw new ApiError('ASSET_EXPIRED', '图片不存在', 404); return { bytes: Buffer.from('test-image'), asset }; },
    async deleteAsset(u, id) { deleted.push(id); await store.remove('assets', id); },
  } };
  const adapters = { verify: async () => Buffer.alloc(0), infer: async (kind) => { calls++; return kind === 'recognition' ? flower() : inference.assessmentResult([], 100, 100); } };
  const asset = async (extra = {}) => { const row = { id: uuid(), owner_id: user.id, purpose: 'recognition', original_expires_at: '2026-10-04T02:00:00.000Z', expires_at: '2026-11-02T02:00:00.000Z', ...extra }; await store.set('assets', row.id, row); return row; };
  const request = (method, route, body = {}, overrides = {}, adapter = adapters) => handle({ ...ctx, method, path: route, body, ...overrides }, adapter);
  const create = async (kind = 'recognition', row) => request('POST', kind + '-jobs/', { asset_id: (row || await asset()).id });
  return { ctx, store, user, adapters, asset, request, create, calls: () => calls, deleted };
}

test('disabled model reports honest capabilities and cannot reserve task quota', async () => {
  const f = await fixture({ inferenceEnabled: false }), capabilities = await status(f.ctx, f.adapters);
  assert.equal(capabilities.recognition.enabled, false); assert.equal(capabilities.assessment.enabled, false);
  await assert.rejects(f.create(), { code: 'MODEL_NOT_CONFIGURED' }); assert.equal(await f.store.count('inference_daily'), 0);
  f.ctx.config.inferenceEnabled = true;
  const enabled = await status(f.ctx, f.adapters); assert.equal(enabled.recognition.threshold, 0); assert.deepEqual(enabled.assessment.labels.map(label => label.id), [9]);
  const missing = await status(f.ctx, { verify: async () => { throw new Error('missing'); } }); assert.equal(missing.recognition.enabled, false);
});

test('POST creates queued job, repeated asset is idempotent and cross-kind use fails', async () => {
  const f = await fixture(), asset = await f.asset();
  const [a, b] = await Promise.all([f.create('recognition', asset), f.create('recognition', asset)]);
  assert.equal(a.data.data.id, b.data.data.id); assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201]);
  assert.equal(a.data.data.status, 'queued'); assert.equal(f.calls(), 0);
  assert.equal((await f.store.get('inference_daily', 'a'.repeat(64) + ':2026-10-03')).count, 1);
  await assert.rejects(f.create('assessment', asset), { code: 'ASSET_IN_USE' });
});

test('daily quota is atomic across users sharing the same identity after re-registration', async () => {
  const f = await fixture({ recognitionDailyLimit: 1 });
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'RECOGNITION_LIMIT');
  const replacement = { ...f.user, id: uuid() }; await f.store.set('users', replacement.id, replacement);
  const asset = await f.asset({ owner_id: replacement.id });
  await assert.rejects(f.request('POST', 'recognition-jobs/', { asset_id: asset.id }, { user: replacement }), { code: 'RECOGNITION_LIMIT' });
});

test('global quota covers both model kinds and remains after deletions', async () => {
  const f = await fixture({ recognitionGlobalDailyLimit: 1 }); const created = (await f.create()).data.data;
  await f.request('DELETE', 'recognition-jobs/' + created.id + '/');
  await assert.rejects(f.create('assessment'), { code: 'RECOGNITION_LIMIT' });
  assert.equal((await f.store.get('inference_daily', 'global:2026-10-03')).count, 1);
});

test('invalid, foreign, avatar, deleting and expired assets never create jobs', async () => {
  const f = await fixture();
  for (const changes of [{ owner_id: uuid() }, { purpose: 'avatar' }, { deleting: true }, { expires_at: DAY }, { original_expires_at: DAY }]) await assert.rejects(f.create('recognition', await f.asset(changes)), { code: 'ASSET_EXPIRED' });
  await assert.rejects(f.request('POST', 'recognition-jobs/', { asset_id: '../private' }), { code: 'VALIDATION_ERROR' });
  assert.equal(await f.store.count('recognition_jobs'), 0);
});

test('record capacity is enforced inside user transaction before reserving budget', async () => {
  const f = await fixture(); await f.store.update('users', f.user.id, { inference_counts: { recognition: 500 } });
  await assert.rejects(f.create(), { code: 'STORAGE_QUOTA' }); assert.equal(await f.store.count('inference_daily'), 0);
});

test('two concurrent GET requests execute a queued job once and expose compatible final JSON', async () => {
  const f = await fixture(), job = (await f.create()).data.data, pending = defer(); let runs = 0;
  const adapters = { ...f.adapters, infer: async () => { runs++; return pending.promise; } };
  const first = f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, adapters); await tick();
  const second = await f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, adapters);
  assert.equal(second.data.data.status, 'running'); assert.equal(runs, 1);
  pending.resolve(flower()); const completed = (await first).data.data;
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.threshold, 0); assert.equal(completed.result.candidates[0].content_id, null);
  assert.equal((await f.request('GET', 'recognition-jobs/' + job.id + '/')).data.data.status, 'succeeded');
  assert.equal(await f.store.get('inference_gate', 'cpu'), null);
});

test('global CPU gate covers both kinds and permits next claim after first completes', async () => {
  const f = await fixture(), a = (await f.create()).data.data, b = (await f.create('assessment')).data.data, pending = defer();
  const first = f.request('GET', 'recognition-jobs/' + a.id + '/', {}, {}, { ...f.adapters, infer: async () => pending.promise }); await tick();
  assert.equal((await f.request('GET', 'assessment-jobs/' + b.id + '/')).data.data.status, 'queued'); assert.equal(f.calls(), 0);
  pending.resolve(flower()); await first;
  const result = (await f.request('GET', 'assessment-jobs/' + b.id + '/')).data.data;
  assert.equal(result.status, 'succeeded'); assert.equal(result.score, null); assert.equal(result.observation_summary.reason, 'NO_SUPPORTED_DETECTIONS');
});

test('expired running claim becomes failed, never re-executes or overwrites a newer gate', async () => {
  const f = await fixture(), job = (await f.create()).data.data;
  await f.store.update('recognition_jobs', job.id, { status: 'running', claim_id: 'old', claim_expires_at: DAY });
  await f.store.set('inference_gate', 'cpu', { claim_id: 'newer', expires_at: '2026-10-03T02:01:00Z' });
  const result = (await f.request('GET', 'recognition-jobs/' + job.id + '/')).data.data;
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'WORKER_TIMEOUT'); assert.equal(f.calls(), 0);
  assert.equal((await f.store.get('inference_gate', 'cpu')).claim_id, 'newer');
});

test('deleting a running job prevents completion resurrection and deletes original asset', async () => {
  const f = await fixture(), job = (await f.create()).data.data, pending = defer();
  const running = f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, { ...f.adapters, infer: async () => pending.promise }); await tick();
  assert.equal((await f.request('DELETE', 'recognition-jobs/' + job.id + '/')).statusCode, 204);
  assert.notEqual(await f.store.get('inference_gate', 'cpu'), null);
  pending.resolve(flower()); await assert.rejects(running, { code: 'NOT_FOUND' });
  assert.equal((await f.store.get('recognition_jobs', job.id)).status, 'deleted'); assert.equal(await f.store.get('assets', job.asset_id), null);
  const list = await f.request('GET', 'recognition-jobs/'); assert.equal(list.data.data.length, 0);
  assert.equal((await f.request('DELETE', 'recognition-jobs/' + job.id + '/')).statusCode, 204);
});

test('account deletion racing completion cannot recreate personal data', async () => {
  const f = await fixture(), job = (await f.create()).data.data, pending = defer();
  const running = f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, { ...f.adapters, infer: async () => pending.promise }); await tick();
  await f.store.update('users', f.user.id, { is_active: false }); await f.store.remove('recognition_jobs', job.id);
  pending.resolve(flower()); await assert.rejects(running, { code: 'NOT_FOUND' });
  assert.equal(await f.store.get('recognition_jobs', job.id), null); assert.equal(await f.store.get('inference_gate', 'cpu'), null);
});

test('asset deletion during inference yields failure and no candidates', async () => {
  const f = await fixture(), job = (await f.create()).data.data, pending = defer();
  const running = f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, { ...f.adapters, infer: async () => pending.promise }); await tick();
  await f.store.update('assets', job.asset_id, { deleting: true }); pending.resolve(flower());
  const result = (await running).data.data; assert.equal(result.error_code, 'ASSET_EXPIRED'); assert.deepEqual(result.result, {});
});

test('other users cannot read, execute or delete a job; pagination stays API-relative', async () => {
  const f = await fixture(), job = (await f.create()).data.data, other = { ...f.user, id: uuid() }; await f.store.set('users', other.id, other);
  for (const method of ['GET', 'DELETE']) await assert.rejects(f.request(method, 'recognition-jobs/' + job.id + '/', {}, { user: other }), { code: 'NOT_FOUND' });
  assert.equal(f.calls(), 0); await f.create();
  const list = await f.request('GET', 'recognition-jobs/', {}, { query: new URLSearchParams('page_size=1') });
  assert.equal(list.data.data.length, 1); assert.equal(list.data.meta.count, 2); assert.match(list.data.meta.next, /^\/api\/v1\/recognition-jobs\//);
});

test('coordinate bounds and selected water metadata are validated before queuing', async () => {
  const f = await fixture(), asset = await f.asset();
  for (const extra of [{ latitude: 12 }, { latitude: NaN, longitude: 120, coordinate_system: 'GCJ02' }, { latitude: 12, longitude: 120 }, { coordinate_system: 'GCJ02' }, { latitude: 90.1, longitude: 100, coordinate_system: 'WGS84' }, { water_body_id: uuid() }]) await assert.rejects(f.request('POST', 'assessment-jobs/', { asset_id: asset.id, ...extra }), { code: 'VALIDATION_ERROR' });
  const result = (await f.request('POST', 'assessment-jobs/', { asset_id: asset.id, latitude: 39.1, longitude: 117.1, coordinate_system: 'GCJ02' })).data.data;
  assert.equal(result.latitude, 39.1); assert.equal(result.coordinate_system, 'GCJ02'); assert.equal(result.water_body, null);
});

test('model errors persist safe failure without retrying execution on later reads', async () => {
  const f = await fixture(), job = (await f.create()).data.data; let runs = 0;
  const adapter = { ...f.adapters, infer: async () => { runs++; throw new ApiError('MODEL_CHECKSUM_MISMATCH', '/private/path', 503); } };
  const result = (await f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, adapter)).data.data;
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'MODEL_CHECKSUM_MISMATCH'); assert.ok(!result.message.includes('/private'));
  await f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, adapter); assert.equal(runs, 1);
});

test('whole operation timeout includes storage and late storage never starts inference', async () => {
  const f = await fixture({ inferenceTimeoutSeconds: 1 }), job = (await f.create()).data.data, pending = defer();
  f.ctx.storage.readAsset = async () => pending.promise;
  const result = (await f.request('GET', 'recognition-jobs/' + job.id + '/')).data.data;
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'INFERENCE_TIMEOUT');
  assert.notEqual(await f.store.get('inference_gate', 'cpu'), null);
  pending.resolve({ bytes: Buffer.from('late') }); await tick();
  assert.equal(f.calls(), 0);
  assert.equal((await f.store.get('recognition_jobs', job.id)).status, 'failed');
});

test('late model resolution cannot overwrite a timed-out job or release its CPU lease early', async () => {
  const f = await fixture({ inferenceTimeoutSeconds: 1 }), job = (await f.create()).data.data, pending = defer();
  const result = (await f.request('GET', 'recognition-jobs/' + job.id + '/', {}, {}, { ...f.adapters, infer: async () => pending.promise })).data.data;
  assert.equal(result.error_code, 'INFERENCE_TIMEOUT');
  const lease = await f.store.get('inference_gate', 'cpu');
  pending.resolve(flower()); await tick();
  assert.equal((await f.store.get('recognition_jobs', job.id)).status, 'failed');
  assert.deepEqual((await f.store.get('recognition_jobs', job.id)).result, {});
  assert.deepEqual(await f.store.get('inference_gate', 'cpu'), lease);
  assert.equal((await f.request('GET', 'recognition-jobs/' + job.id + '/')).data.data.status, 'failed');
});

test('public health preserves legacy mini-program capability schema without claiming unconfigured services', async () => {
  const { createApp } = require('../../cloudfunctions/hyhqApi');
  const f = await fixture({ inferenceEnabled: false, appId: 'wx0123456789abcdef', llmEnabled: true, llmGatewayEnabled: true, deepseekApiKey: '', qweatherEnabled: true });
  const app = createApp({ store: f.store, cloud: {}, config: f.ctx.config });
  const response = await app({ method: 'GET', path: '/api/v1/health/' }, { APPID: f.ctx.config.appId, OPENID: 'health-test-openid' });
  assert.equal(response.statusCode, 200);
  const data = response.data.data;
  assert.equal(data.dev_auth_enabled, false); assert.equal(data.version, 'm5');
  assert.deepEqual(data.features, { recognition: false, assessment: false, llm: false });
  assert.deepEqual(data.optional_services, { inference: false, llm: false, weather: false });
  assert.equal(data.recognition.enabled, false); assert.equal(data.assessment.enabled, false);
});
