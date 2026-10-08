"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { SQLiteStore } = require('../backend/store.cjs');
const { createServer } = require('../backend/server.cjs');
const { localCloud } = require('../backend/local-storage.cjs');
const sharp = require('../backend/node_modules/sharp');
const { uuid } = require('../backend/vendor/lib/core');
let store, server, dir, base, providerCalls = 0;
async function request(route, { cookie, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + '/api/v1/' + route, { method, headers: { Origin: base,
    ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const contentType = res.headers.get('content-type') || '';
  return { status: res.status, cookie: res.headers.getSetCookie().find(x => x.startsWith('hyhq_guest='))?.split(';')[0],
    headers: res.headers, ...(contentType.startsWith('application/json') ? { value: await res.json() } : { bytes: Buffer.from(await res.arrayBuffer()) }) };
}
async function start() { const r = await request('web/guest-session/', { method: 'POST', body: {} }); assert.equal(r.status, 200); return r; }
test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyhq-guest-http-')); store = new SQLiteStore(':memory:');
  server = createServer({ store, timers: false, cloud: localCloud(path.join(dir, 'uploads')), config: {
    sessionSecret: 'guest-http-fixture-secret-only', appId: 'web-test', modelRoot: path.join(dir, 'missing-models'),
    inferenceEnabled: false, llmEnabled: true, llmGatewayEnabled: true, deepseekApiKey: 'fixture-key-never-sent-to-provider',
    llmGlobalAttemptLimit: 30, llmGlobalTokenLimit: 60000, qweatherEnabled: false, qweatherMonthlyLimit: 0,
    management: { enabled: true, adminUserIds: [] }, community: { mode: 'official-editorial', enabled: false }, weatherReminders: { enabled: true },
  }, providers: { generateLlm: async (_config, messages) => { providerCalls++;
    assert.equal(typeof messages[0].content, 'string');
    return { text: '## 测试观察建议\n仅使用本地测试替身。', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
test('HTTP public config remains readable; guest start and resume use private secure cookie identity', async () => {
  const publicConfig = await request('web/config/'); assert.equal(publicConfig.status, 200); assert.equal(publicConfig.value.data.llm.enabled, true);
  const health = await request('health/'); assert.equal(health.status, 200); assert.equal(health.value.data.features.llm, true);
  assert.equal((await request('web/guest-session/')).status, 401);
  const a = await start(); assert.equal(a.value.data.auth_kind, 'guest');
  assert.match(a.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const resumed = await request('web/guest-session/', { cookie: a.cookie }); assert.equal(resumed.value.data.id, a.value.data.id);
  const wrongOrigin = await request('web/guest-session/', { method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' } }); assert.equal(wrongOrigin.status, 403);
});
test('HTTP guests ask in all four modules without selecting content; real route calls injected provider only', async () => {
  const a = await start(), before = providerCalls;
  for (const scope of ['home', 'explore', 'learn', 'recognition']) {
    const body = { scope, request_id: uuid() }, created = await request('llm/sessions/', { cookie: a.cookie, method: 'POST', body });
    assert.equal(created.status, 201); assert.equal(created.value.data.scope, scope); assert.equal(created.value.data.source_type, 'module');
    const replay = await request('llm/sessions/', { cookie: a.cookie, method: 'POST', body }); assert.equal(replay.status, 200); assert.equal(replay.value.data.id, created.value.data.id);
    const queued = await request(`llm/sessions/${created.value.data.id}/turns/`, { cookie: a.cookie, method: 'POST', body: { request_id: uuid(), question: '可以介绍一下花卉观察吗？' } });
    assert.equal(queued.status, 201); const done = await request(`llm/turns/${queued.value.data.id}/`, { cookie: a.cookie });
    assert.equal(done.status, 200); assert.equal(done.value.data.status, 'succeeded'); assert.match(done.value.data.answer, /^## /);
    await request(`llm/turns/${queued.value.data.id}/`, { cookie: a.cookie });
    const quota = await request(`llm/status/?scope=${scope}`, { cookie: a.cookie }); assert.equal(quota.value.data.quota.used, 1);
  }
  assert.equal(providerCalls - before, 4);
});
test('HTTP same-IP cookie owners share allowance but cannot read, delete or attach each other private data', async () => {
  const a = await start(), b = await start();
  assert.notEqual(a.value.data.id, b.value.data.id); assert.equal(a.value.data.quotas.ai.home.used, b.value.data.quotas.ai.home.used);
  const created = await request('llm/sessions/', { cookie: a.cookie, method: 'POST', body: { scope: 'home', request_id: uuid() } });
  for (const method of ['GET', 'DELETE']) assert.equal((await request(`llm/sessions/${created.value.data.id}/`, { cookie: b.cookie, method, ...(method === 'DELETE' ? { body: {} } : {}) })).status, 404);
  assert.deepEqual((await request('llm/sessions/', { cookie: b.cookie })).value.data, []);
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#557744' } }).png().toBuffer();
  const upload = await request('web/uploads/', { cookie: a.cookie, method: 'POST', body: { purpose: 'recognition', name: 'test.png', content_type: 'image/png', data: bytes.toString('base64') } });
  assert.equal(upload.status, 201); const asset = upload.value.data;
  assert.equal((await request(`uploads/${asset.id}/content/`, { cookie: a.cookie })).status, 200);
  assert.equal((await request(`uploads/${asset.id}/content/`, { cookie: b.cookie })).status, 404);
  assert.equal((await request('web/uploads/', { cookie: b.cookie, method: 'POST', body: { purpose: 'avatar', content_type: 'image/png', data: bytes.toString('base64') } })).status, 401);
  const job = uuid(); await store.set('recognition_jobs', job, { id: job, owner_id: a.value.data.id, status: 'succeeded', visible: true, expires_at: '2099-01-01T00:00:00Z', result: {}, asset_id: asset.id });
  assert.equal((await request(`recognition-jobs/${job}/`, { cookie: a.cookie })).status, 200);
  assert.equal((await request(`recognition-jobs/${job}/`, { cookie: b.cookie })).status, 404);
  assert.deepEqual((await request('recognition-jobs/', { cookie: b.cookie })).value.data, []);
});
test('HTTP guest cookie never authorizes account, feedback, activity, admin or direct cloud uploads routes', async () => {
  const a = await start();
  for (const route of ['me/', 'favorites/', 'histories/', 'feedback/', 'personal-admin/stats/'])
    assert.equal((await request(route, { cookie: a.cookie })).status, 401, route);
  for (const route of ['feedback/', 'cloud-files/uploads/'])
    assert.equal((await request(route, { cookie: a.cookie, method: 'POST', body: {} })).status, 401, route);
  assert.equal((await request('me/', { cookie: a.cookie, method: 'PATCH', body: { nickname: 'forged' } })).status, 401);
  assert.equal((await request('me/', { cookie: a.cookie, method: 'DELETE', body: {} })).status, 401);
  assert.equal((await store.get('users', a.value.data.id)).is_active, true);
  assert.equal((await request('llm/sessions/', { cookie: a.cookie, method: 'POST', body: { scope: 'home', owner_id: uuid(), OPENID: 'forged' } })).status, 400);
});
