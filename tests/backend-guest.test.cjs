"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { SQLiteStore } = require('../backend/store.cjs');
const guest = require('../backend/guest.cjs');
const llm = require('../backend/vendor/lib/llm');
const recognition = require('../backend/vendor/lib/recognition');
const { uuid, sha256, ApiError } = require('../backend/vendor/lib/core');
const config = { sessionSecret: 'guest-test-stable-secret-12345678', inferenceEnabled: true,
  modelRoot: '/no-private-models-read-by-this-test', llmEnabled: true, llmGatewayEnabled: true,
  deepseekApiKey: 'fake-fixture-key-never-dispatched', llmGlobalAttemptLimit: 100,
  llmGlobalTokenLimit: 10000000, llmMaxConcurrency: 2, recognitionGlobalDailyLimit: 200 };
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyhq-guest-test-'));
  const filename = path.join(dir, 'db.sqlite3'), store = new SQLiteStore(filename);
  const h = { store, filename, now: '2026-10-09T07:00:00.000Z', config: { ...config } };
  t.after(async () => { await h.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return h;
}
function responseHeaders() { const headers = {}; return { headers, getHeader(k) { return headers[k]; }, setHeader(k, v) { headers[k] = v; } }; }
async function actor(h, { cookie, ip = '203.0.113.29', create = true, route = 'web/guest-session/', method = 'POST', body = {} } = {}) {
  const ctx = { store: h.store, config: h.config, now: h.now, path: route, method, body, query: new URLSearchParams(), user: null };
  const req = { headers: { cookie: cookie || '' }, socket: { remoteAddress: ip } }, res = responseHeaders();
  await guest.attach(ctx, req, res, { create });
  const set = res.headers['Set-Cookie'];
  return { ctx, req, res, cookie: set ? set.at(-1).split(';')[0] : cookie };
}
function call(a, route, method = 'GET', body = {}, adapters = {}) {
  return llm.handle({ ...a.ctx, path: route, method, body }, adapters);
}
async function session(a, scope = 'home', extras = {}) {
  return (await call(a, 'llm/sessions/', 'POST', { scope, ...extras })).data.data;
}
async function turn(a, sessionId, requestId = uuid(), question = '介绍花卉观察与水资源保护') {
  return (await call(a, `llm/sessions/${sessionId}/turns/`, 'POST', { request_id: requestId, question })).data.data;
}
async function finish(a, id, generate = async () => ({ text: '## 观察建议\n结合已发布资料。', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })) {
  return (await call(a, `llm/turns/${id}/`, 'GET', {}, { generateLlm: generate })).data.data;
}
async function asset(a) {
  const id = uuid(); await a.ctx.store.set('assets', id, { id, owner_id: a.ctx.user.id, purpose: 'recognition',
    original_expires_at: '2026-11-09T00:00:00.000Z', expires_at: '2026-11-09T00:00:00.000Z' }); return id;
}
async function imageJob(a, kind = 'recognition', id) {
  id ||= await asset(a);
  return (await recognition.handle({ ...a.ctx, path: kind + '-jobs/', method: 'POST', body: { asset_id: id } }, { verify: async () => true })).data.data;
}
async function imageResult(a, job, kind = 'recognition', success = true) {
  return (await recognition.handle({ ...a.ctx, path: `${kind}-jobs/${job.id}/`, method: 'GET', storage: { readAsset: async () => ({ bytes: Buffer.from('test-adapter-image') }) } },
    { infer: async () => { if (!success) throw new ApiError('MODEL_INFERENCE_FAILED', 'fixture failure', 503); return { candidates: [], decision: 'uncertain' }; } })).data.data;
}
test('guest cookie is opaque, HttpOnly, separated from login, with private owners and no raw IP records', async t => {
  const h = await setup(t), a = await actor(h), b = await actor(h);
  assert.notEqual(a.ctx.user.id, b.ctx.user.id);
  assert.notEqual(a.ctx.user.quota_key, b.ctx.user.quota_key);
  assert.equal(a.ctx.guest.bucket_key, b.ctx.guest.bucket_key);
  assert.match(a.res.headers['Set-Cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.match(a.cookie, /^hyhq_guest=[a-f0-9]{64}$/);
  const c = await actor(h, { cookie: a.cookie }); assert.equal(c.ctx.user.id, a.ctx.user.id);
  for (const row of h.store.db.prepare('SELECT value FROM documents').all()) {
    assert.equal(row.value.includes('203.0.113.29'), false);
    assert.equal(row.value.includes(a.cookie.split('=')[1]), false);
  }
  assert.equal((await guest.handle(c.ctx, c.req, c.res)).data.data.auth_kind, 'guest');
});
test('only the explicit private trial route whitelist receives a guest owner', async t => {
  const h = await setup(t), a = await actor(h);
  for (const route of ['me/', 'feedback/', 'favorites/', 'histories/', 'personal-admin/stats/', 'blog/mine/', 'blog/posts/', 'cloud-files/uploads/']) {
    const blocked = await actor(h, { cookie: a.cookie, route, method: 'POST' }); assert.equal(blocked.ctx.user, null, route);
  }
  await assert.rejects(actor(h, { cookie: a.cookie, route: 'web/uploads/', body: { purpose: 'avatar' } }), { code: 'NOT_AUTHENTICATED' });
  const empty = await actor(h, { create: false, method: 'GET' }); assert.equal(empty.ctx.user, null);
});
test('recognition plus assessment admits exactly five reservations under simultaneous requests from one IP', async t => {
  const h = await setup(t), actors = await Promise.all(Array.from({ length: 8 }, () => actor(h)));
  const outcomes = await Promise.allSettled(actors.map((a, i) => imageJob(a, i % 2 ? 'assessment' : 'recognition')));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 5);
  assert.ok(outcomes.filter(x => x.status === 'rejected').every(x => x.reason.code === 'GUEST_RECOGNITION_LIMIT'));
  const q = await guest.quotas(actors[0].ctx); assert.equal(q.recognition.reserved, 5); assert.equal(q.recognition.remaining, 0);
  assert.equal((await h.store.get('inference_daily', 'global:2026-10-09')).count, 5);
});
test('recognition retries and result reads charge once; failures release only guest allowance and preserve global attempts', async t => {
  const h = await setup(t), a = await actor(h), id = await asset(a), job = await imageJob(a, 'recognition', id);
  assert.equal((await imageJob(a, 'recognition', id)).id, job.id);
  const before = await guest.quotas(a.ctx); assert.equal(before.recognition.reserved, 1);
  assert.equal((await imageResult(a, job, 'recognition', false)).status, 'failed');
  await imageResult(a, job);
  const failed = await guest.quotas(a.ctx); assert.equal(failed.recognition.used, 0); assert.equal(failed.recognition.reserved, 0);
  const next = await imageJob(a, 'assessment'); await imageResult(a, next, 'assessment'); await imageResult(a, next, 'assessment');
  const after = await guest.quotas(a.ctx); assert.equal(after.recognition.used, 1); assert.equal(after.recognition.reserved, 0);
  assert.equal((await h.store.get('inference_daily', 'global:2026-10-09')).count, 2);
  await recognition.handle({ ...a.ctx, path: `assessment-jobs/${next.id}/`, method: 'DELETE', storage: { deleteAsset: async () => {} } });
  assert.equal((await guest.quotas(a.ctx)).recognition.used, 1);
});
test('same-IP guests cannot read each other recognition records, conversations, turns, or owners', async t => {
  const h = await setup(t), a = await actor(h), b = await actor(h), job = await imageJob(a);
  await assert.rejects(imageResult(b, job), { code: 'NOT_FOUND' });
  const s = await session(a), tr = await turn(a, s.id);
  await assert.rejects(call(b, `llm/sessions/${s.id}/`), { code: 'NOT_FOUND' });
  await assert.rejects(call(b, `llm/turns/${tr.id}/`), { code: 'NOT_FOUND' });
  assert.deepEqual((await call(b, 'llm/sessions/')).data.data, []);
  assert.deepEqual((await recognition.handle({ ...b.ctx, path: 'recognition-jobs/', method: 'GET' })).data.data, []);
});
test('AI per-scope five-request admission is atomic across cookies; retry request IDs remain isolated by private owner', async t => {
  const h = await setup(t), actors = await Promise.all(Array.from({ length: 7 }, () => actor(h)));
  const sessions = await Promise.all(actors.map(a => session(a, 'home'))), request = uuid();
  const outcomes = await Promise.allSettled(actors.map((a, i) => turn(a, sessions[i].id, request)));
  const accepted = outcomes.map((outcome, i) => ({ outcome, i })).filter(x => x.outcome.status === 'fulfilled');
  assert.equal(accepted.length, 5); assert.equal(new Set(accepted.map(x => x.outcome.value.id)).size, 5);
  assert.ok(outcomes.filter(x => x.status === 'rejected').every(x => x.reason.code === 'LLM_DAILY_LIMIT'));
  const first = accepted[0]; assert.equal((await turn(actors[first.i], sessions[first.i].id, request)).id, first.outcome.value.id);
  assert.equal((await h.store.get('llm_days', '2026-10-09')).attempts, 5);
  for (const { outcome, i } of accepted) { await finish(actors[i], outcome.value.id); await finish(actors[i], outcome.value.id); }
  const q = await guest.quotas(actors[0].ctx); assert.equal(q.ai.home.used, 5); assert.equal(q.ai.home.reserved, 0); assert.equal(q.ai.learn.remaining, 5);
  const other = await session(actors[0], 'learn'); await turn(actors[0], other.id);
});
test('failed AI calls release guest daily slots without erasing provider attempts, billed usage, or retry idempotency', async t => {
  const h = await setup(t), a = await actor(h), s = await session(a), request = uuid(), tr = await turn(a, s.id, request);
  const failed = await finish(a, tr.id, async () => { throw new (require('../backend/vendor/lib/providers').ProviderError)('LLM_TRANSPORT_ERROR', { ambiguous: false }); });
  assert.equal(failed.status, 'failed');
  assert.equal((await turn(a, s.id, request)).id, tr.id);
  const q = await guest.quotas(a.ctx); assert.equal(q.ai.home.used, 0); assert.equal(q.ai.home.reserved, 0);
  const day = await h.store.get('llm_days', '2026-10-09'); assert.equal(day.attempts, 1); assert.equal(day.reserved_tokens, 0);
  const success = await turn(a, s.id); await finish(a, success.id);
  assert.equal((await guest.quotas(a.ctx)).ai.home.used, 1);
  assert.equal((await h.store.get('llm_days', '2026-10-09')).accounted_tokens, 30);
});
test('IP bucket and owner survive restart; deleting cookies does not reset allowance; Beijing midnight does', async t => {
  const h = await setup(t); h.now = '2026-10-09T15:59:59.000Z';
  const a = await actor(h), job = await imageJob(a); await imageResult(a, job);
  await h.store.close(); h.store = new SQLiteStore(h.filename);
  const restored = await actor(h, { cookie: a.cookie }), fresh = await actor(h);
  assert.equal(restored.ctx.user.id, a.ctx.user.id); assert.equal((await guest.quotas(fresh.ctx)).recognition.used, 1);
  h.now = '2026-10-09T16:00:00.000Z'; const next = await actor(h, { cookie: a.cookie });
  const q = await guest.quotas(next.ctx); assert.equal(q.recognition.date, '2026-10-10'); assert.equal(q.recognition.remaining, 5);
  assert.equal(q.recognition.reset_at, '2026-10-10T16:00:00.000Z');
  const independent = await actor(h, { ip: '203.0.113.30' }); assert.notEqual(independent.ctx.guest.bucket_key, a.ctx.guest.bucket_key);
});
test('scope-only sessions work in all modules and recognition never fabricates an uploaded image', async t => {
  const h = await setup(t), a = await actor(h);
  for (const scope of ['home', 'explore', 'learn', 'recognition', 'recognize', 'water', 'data']) {
    const s = await session(a, scope); assert.equal(s.source_type, 'module'); assert.equal(s.source_id, null); assert.equal(s.image_available, false);
    const stored = await h.store.get('llm_sessions', s.id), facts = await llm.factsFor(a.ctx, stored, {}, '怎么观察花卉？');
    assert.equal(facts.context.image_supplied_this_turn, false); assert.equal(facts.context.current_page.selected_private_result, false);
  }
  await assert.rejects(session(a, 'recognition', { include_image: true }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(session(a, 'home', { source_type: 'module', source_id: 'forged' }), { code: 'LLM_SOURCE_INVALID' });
  await assert.rejects(session(a, 'home', { context: '客户端伪造事实' }), { code: 'VALIDATION_ERROR' });
});
test('home RAG includes current published posts but excludes pending, draft, rejected and private records', async t => {
  const h = await setup(t), a = await actor(h), published = uuid(), author = uuid();
  await h.store.set('users', author, { id: author, auth_kind: 'local', is_active: true });
  for (const status of ['published', 'pending', 'draft', 'rejected']) {
    const id = status === 'published' ? published : uuid();
    await h.store.set('blog_posts', id, { id, owner_id: author, status, title: status + ' 紫藤观察', body: status + ' 紫藤花卉观察的公开知识', summary: '紫藤', category: 'plants', author_name: '测试作者', published_at: h.now, updated_at: h.now });
  }
  await h.store.set('feedback', uuid(), { body: '秘密私人紫藤资料' });
  const s = await session(a), tr = await turn(a, s.id, uuid(), '紫藤观察'); let sent;
  const result = await finish(a, tr.id, async (_config, messages) => { sent = JSON.stringify(messages); return { text: '## 紫藤观察\n参考公开资料。', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }; });
  assert.match(sent, /published 紫藤/); assert.doesNotMatch(sent, /pending 紫藤|draft 紫藤|rejected 紫藤|秘密私人紫藤资料/);
  assert.ok(result.citations.some(x => x.kind === 'blog_post' && x.source_path === '/blog/' + published));
  await h.store.update('blog_posts', published, { status: 'draft' });
  const reread = await finish(a, tr.id); assert.ok(!reread.citations.some(x => x.id === published));
  await assert.rejects(session(a, 'learn', { source_type: 'blog_post', source_id: published }), { code: 'SOURCE_UNAVAILABLE' });
});
test('withdrawing a public source while AI is running rejects stale result and releases guest quota', async t => {
  const h = await setup(t), a = await actor(h), id = uuid(), author = uuid();
  await h.store.set('users', author, { id: author, auth_kind: 'local', is_active: true });
  await h.store.set('blog_posts', id, { id, owner_id: author, status: 'published', title: '紫藤观察', body: '紫藤观察公开资料', category: 'plants', published_at: h.now, updated_at: h.now });
  const s = await session(a, 'learn', { source_type: 'blog_post', source_id: id }), tr = await turn(a, s.id);
  const result = await finish(a, tr.id, async () => {
    await h.store.update('blog_posts', id, { status: 'draft' });
    return { text: '应被丢弃', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  assert.equal(result.status, 'failed'); assert.equal(result.answer, '');
  assert.equal((await guest.quotas(a.ctx)).ai.learn.remaining, 5);
  assert.equal((await h.store.get('llm_days', '2026-10-09')).accounted_tokens, 30);
});
test('session creation retries are atomic and cannot create duplicate or resurrect deleted private sessions', async t => {
  const h = await setup(t), a = await actor(h), request_id = uuid();
  const sessions = await Promise.all(Array.from({ length: 8 }, () => session(a, 'home', { request_id })));
  assert.equal(new Set(sessions.map(s => s.id)).size, 1);
  assert.equal(await h.store.count('llm_sessions', { owner_id: a.ctx.user.id }), 1);
  assert.equal(await h.store.count('llm_days'), 0);
  await assert.rejects(session(a, 'learn', { request_id }), { code: 'REQUEST_ID_CONFLICT' });
  await call(a, `llm/sessions/${sessions[0].id}/`, 'DELETE');
  await assert.rejects(session(a, 'home', { request_id }), { code: 'REQUEST_ALREADY_CONSUMED' });
});
test('private photo reads enforce random guest owner even when allowance bucket is shared', async t => {
  const h = await setup(t), a = await actor(h), b = await actor(h), id = await asset(a); let reads = 0;
  await h.store.update('assets', id, { original_file_id: 'local:opaque-original', thumbnail_file_id: 'local:opaque-thumbnail' });
  const cloud = { downloadFile: async () => { reads++; return { fileContent: Buffer.from('private-photo-bytes') }; } };
  const storage = require('../backend/vendor/lib/files').storageFor(b.ctx, cloud);
  await assert.rejects(storage.readAsset(b.ctx.user, id), { code: 'NOT_FOUND' }); assert.equal(reads, 0);
  assert.equal((await storage.readAsset(a.ctx.user, id)).bytes.toString(), 'private-photo-bytes');
});
test('expired guest cleanup removes private ownership and retains daily/provider accounting', async t => {
  const h = await setup(t), a = await actor(h), s = await session(a), tr = await turn(a, s.id);
  await finish(a, tr.id); const job = await imageJob(a); await imageResult(a, job);
  h.now = '2026-10-17T07:00:00.000Z';
  const ctx = { store: h.store, config: h.config, now: h.now };
  ctx.storage = require('../backend/vendor/lib/files').storageFor(ctx, { deleteFile: async ({ fileList }) => ({ fileList: fileList.map(fileID => ({ fileID, status: 0 })) }) });
  const result = await guest.cleanup(ctx); assert.equal(result.removed, 1);
  for (const kind of ['users', 'guest_sessions', 'assets', 'llm_sessions', 'llm_turns', 'recognition_jobs']) assert.equal(await h.store.count(kind), 0, kind);
  assert.equal((await h.store.get('llm_days', '2026-10-09')).attempts, 1);
  assert.equal((await h.store.get('llm_days', '2026-10-09')).accounted_tokens, 30);
  assert.equal((await h.store.list('guest_inference_days'))[0].succeeded, 1);
});
