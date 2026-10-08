'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { MemoryStore } = require('./memory-store');
const { createApp, createRuntime } = require('../../cloudfunctions/hyhqApi');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const { RELEASE_ID, applyReleasePolicy } = require('../../cloudfunctions/hyhqApi/lib/release-policy');
const llm = require('../../cloudfunctions/hyhqApi/lib/llm');
const { TEMPLATE_ID } = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const NOW = '2026-10-08T04:00:00.000Z', SOURCE = '10000000-0000-4000-8000-000000000001';
const USAGE = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
function legacyConfig() {
  return { appId: 'wx0123456789abcdef', llmEnabled: true, llmGatewayEnabled: true,
    deepseekApiKey: 'unit-fixture-not-a-live-key', sessionSecret: 'unit-fixture-not-a-live-secret',
    qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'unit-weather-fixture', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 30,
    weatherReminders: { enabled: true, templateId: TEMPLATE_ID, state: 'trial' }, inferenceEnabled: false,
    maintenanceEnabled: true, deploymentEnv: 'unit-no-qa-environment' };
}
async function fixture(runtime = false) {
  const store = new MemoryStore(), config = legacyConfig(), identity = { APPID: config.appId, OPENID: 'unit_verified_no_qa_openid' };
  let generated = 0;
  const providers = {
    getContext: async (_, kind, id) => ({ context: { id, title: '离线测试资料', body: '科普说明', source_path: '/api/v1/contents/' + id + '/' }, citations: [{ kind: 'content', id, source_path: '/api/v1/contents/' + id + '/', title: '离线测试资料' }] }),
    getPublicItem: async (_, kind, id) => ({ id, kind }),
    generateLlm: async () => { generated++; return { text: '离线测试回答', model: 'deepseek-flash', usage: USAGE }; },
    sendWeatherReminder: () => assert.fail('A reminder must not be sent merely by creating an intent'),
  };
  const app = (runtime ? createRuntime : createApp)({ store, config, cloud: {}, providers, now: () => NOW });
  const call = (path, method = 'GET', body = {}, token = '') => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {}, config: legacyConfig(), llmEnabled: true }, identity);
  const auth = (await call('auth/wechat/', 'POST', { code: 'unit-sdk-code' })).data.data;
  const user = await store.get('users', auth.user.id);
  const ctx = { store, config, providers, user, now: NOW, query: new URLSearchParams(),
    storage: { readAsset: async () => ({ bytes: Buffer.from([255, 216, 1, 2, 255, 217]), mime_type: 'image/jpeg', original_expires_at: '2026-10-09T04:00:00Z', asset: { purpose: 'recognition' } }) } };
  const generic = (method, path, body = {}) => llm.handle({ ...ctx, method, path, body }, providers);
  return { store, config, call, auth, ctx, generic, providers, generated: () => generated };
}
async function legacySession(f, kind = 'learn') {
  let body;
  if (kind === 'learn' || kind === 'explore') body = { scope: kind, source_type: kind === 'learn' ? 'content' : 'region', source_id: SOURCE };
  else {
    const type = kind === 'recognition' ? kind : 'assessment';
    await f.store.set(type + '_jobs', SOURCE, { id: SOURCE, owner_id: f.ctx.user.id, asset_id: randomUUID(), status: 'succeeded', expires_at: '2026-10-09T04:00:00Z', result: { decision: 'uncertain', candidates: [] } });
    body = { scope: 'recognition', [type + '_job_id']: SOURCE, ...(kind === 'image' ? { interpretation_mode: 'image', include_image: true } : {}) };
  }
  return (await f.generic('POST', 'llm/sessions/', body)).data.data;
}
async function queued(f, session) { return (await f.generic('POST', 'llm/sessions/' + session.id + '/turns/', { question: '原有排队问题', request_id: randomUUID() })).data.data; }

test('production environment and deployment overrides cannot enable generation, but credentials and other capabilities remain', () => {
  const env = { HYHQ_APP_ID: 'wx0123456789abcdef', HYHQ_LLM_ENABLED: 'true', DEEPSEEK_API_KEY: 'retained-unit-key', HYHQ_SESSION_SECRET: 'retained-unit-secret', HYHQ_INFERENCE_ENABLED: 'true', HYHQ_QWEATHER_ENABLED: 'true', HYHQ_WEATHER_REMINDERS_ENABLED: 'true' };
  const config = configFromEnvironment(env, { llmEnabled: true, llmGatewayEnabled: true, weatherReminders: { enabled: true, templateId: TEMPLATE_ID } });
  assert.equal(config.llmEnabled, false); assert.equal(config.llmGatewayEnabled, false);
  assert.throws(() => { config.llmEnabled = true; }, TypeError);
  assert.equal(config.deepseekApiKey, env.DEEPSEEK_API_KEY); assert.equal(config.sessionSecret, env.HYHQ_SESSION_SECRET);
  assert.equal(config.inferenceEnabled, true); assert.equal(config.qweatherEnabled, true); assert.equal(config.weatherReminders.enabled, true);
  const wrapped = applyReleasePolicy(legacyConfig()); assert.equal(llm.configFor({ config: wrapped }).enabled, false);
});

test('both production app and runtime report closed capabilities even with stale true flags and client overrides', async () => {
  for (const runtime of [false, true]) {
    const f = await fixture(runtime);
    // Mutating the caller's legacy settings after assembly cannot reopen its copy.
    f.config.llmEnabled = true; f.config.llmGatewayEnabled = true;
    const health = (await f.call('health/')).data.data;
    assert.equal(health.release, RELEASE_ID); assert.equal(health.features.llm, false); assert.equal(health.optional_services.llm, false);
    for (const scope of ['recognition', 'explore', 'learn']) {
      const status = await f.call('llm/status/?scope=' + scope, 'GET', {}, f.auth.token);
      assert.equal(status.statusCode, 200); assert.equal(status.data.data.enabled, false);
    }
    for (const [path, body] of [
      ['llm/sessions/', { scope: 'learn', source_type: 'content', source_id: SOURCE }],
      ['llm/sessions/', { scope: 'recognition', assessment_job_id: SOURCE, interpretation_mode: 'image', include_image: true }],
      ['llm/sessions/' + SOURCE + '/turns/', { question: '旧客户端继续发送', request_id: randomUUID() }],
      ['weather-data/reminders/interpret/', { text: '明天下午两点提醒看天气', location: 'tianjin', request_key: randomUUID() }],
    ]) {
      const out = await f.call(path, 'POST', body, f.auth.token);
      assert.equal(out.statusCode, 503, JSON.stringify(out)); assert.equal(out.data.error.code, 'LLM_DISABLED');
    }
    assert.equal(f.generated(), 0); assert.equal(await f.store.count('llm_sessions'), 0); assert.equal(await f.store.count('llm_ledger'), 0);
  }
});

test('old queued learn, explore, recognition and image turns settle without provider calls or extra attempts', async () => {
  for (const kind of ['learn', 'explore', 'recognition', 'image']) {
    const f = await fixture(), session = await legacySession(f, kind), turn = await queued(f, session);
    const before = await f.store.get('llm_days', '2026-10-08'); assert.ok(before.reserved_tokens > 0);
    const out = await f.call('llm/turns/' + turn.id + '/', 'GET', {}, f.auth.token);
    assert.equal(out.statusCode, 200, JSON.stringify(out)); assert.equal(out.data.data.status, 'failed'); assert.equal(out.data.data.error_code, 'LLM_DISABLED');
    const after = await f.store.get('llm_days', '2026-10-08');
    assert.equal(after.attempts, before.attempts); assert.equal(after.accounted_tokens, before.accounted_tokens); assert.equal(after.reserved_tokens, 0);
    assert.equal(await f.store.count('llm_ledger'), 1); assert.equal(f.generated(), 0);
    await f.call('llm/turns/' + turn.id + '/', 'GET', {}, f.auth.token); assert.equal(f.generated(), 0);
    assert.deepEqual(await f.store.get('llm_days', '2026-10-08'), after);
  }
});

test('an old successful booking draft cannot bypass the closed production interpretation endpoint', async () => {
  const f = await fixture(), key = randomUUID(), body = { text: '今天下午两点提醒看天津天气', location: 'tianjin', request_key: key };
  f.providers.generateLlm = async () => ({ text: JSON.stringify({ needs_clarification: false, location: 'tianjin', local_date: '2026-10-08', local_time: '14:00', frequency: 'once' }), usage: USAGE });
  const cached = await require('../../cloudfunctions/hyhqApi/lib/weather-booking-ai').handle({ ...f.ctx, method: 'POST', path: 'weather-data/reminders/interpret/', body });
  assert.equal(cached.data.data.draft.location, 'tianjin');
  const before = await f.store.get('llm_days', '2026-10-08');
  const out = await f.call('weather-data/reminders/interpret/', 'POST', body, f.auth.token);
  assert.equal(out.statusCode, 503); assert.equal(out.data.error.code, 'LLM_DISABLED');
  assert.deepEqual(await f.store.get('llm_days', '2026-10-08'), before);
  assert.equal(await f.store.count('weather_ai_drafts'), 1); assert.equal(await f.store.count('weather_reminders'), 0);
});

test('manual reminder confirmation stays available and does not consume the LLM budget', async () => {
  const f = await fixture(true);
  const capabilities = (await f.call('weather-data/reminders/', 'GET', {}, f.auth.token)).data.data;
  assert.equal(capabilities.enabled, true);
  const intent = await f.call('weather-data/reminders/intents/', 'POST', { location: 'tianjin', scheduled_for: '2026-10-08T04:10:00Z' }, f.auth.token);
  assert.equal(intent.statusCode, 201);
  const confirmed = await f.call('weather-data/reminders/intents/' + intent.data.data.id + '/confirm/', 'POST', { template_id: TEMPLATE_ID, decision: 'accept' }, f.auth.token);
  assert.equal(confirmed.statusCode, 200); assert.equal(confirmed.data.data.state, 'pending');
  assert.equal(await f.store.count('llm_days'), 0); assert.equal(f.generated(), 0);
});

test('existing answers remain readable and deletable; account purge anonymizes retained accounting', async () => {
  const f = await fixture(), session = await legacySession(f), turn = await queued(f, session);
  const completed = (await f.generic('GET', 'llm/turns/' + turn.id + '/')).data.data;
  assert.equal(completed.status, 'succeeded'); assert.equal(f.generated(), 1);
  const before = await f.store.get('llm_days', '2026-10-08'); assert.equal(before.accounted_tokens, 3);
  const readable = await f.call('llm/turns/' + turn.id + '/', 'GET', {}, f.auth.token);
  assert.equal(readable.data.data.answer, completed.answer); assert.equal(f.generated(), 1);
  assert.equal((await f.call('llm/sessions/' + session.id + '/', 'DELETE', {}, f.auth.token)).statusCode, 204);
  assert.equal(await f.store.get('llm_turns', turn.id), null);
  assert.equal((await f.call('me/', 'DELETE', {}, f.auth.token)).statusCode, 204);
  assert.equal(await f.store.get('users', f.auth.user.id), null);
  assert.deepEqual(await f.store.get('llm_days', '2026-10-08'), before);
  const ledger = (await f.store.list('llm_ledger'))[0]; assert.equal(ledger.owner_id, null); assert.equal(ledger.accounted_tokens, 3);
});
