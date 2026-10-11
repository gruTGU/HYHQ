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
function releaseConfig() {
  return { appId: 'wx0123456789abcdef', llmEnabled: true, llmGatewayEnabled: true,
    deepseekApiKey: 'unit-fixture-not-a-live-key', sessionSecret: 'unit-fixture-not-a-live-secret',
    qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'unit-weather-fixture', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 30,
    weatherReminders: { enabled: true, templateId: TEMPLATE_ID, state: 'trial' }, inferenceEnabled: false,
    maintenanceEnabled: true, deploymentEnv: 'unit-guide-environment' };
}
async function fixture(runtime = false, overrides = {}) {
  const store = new MemoryStore(), config = { ...releaseConfig(), ...overrides }, identity = { APPID: config.appId, OPENID: 'unit_verified_guide_openid' };
  let generated = 0;
  const providers = {
    getContext: async (_, kind, id) => ({ context: { id, title: '离线测试资料', body: '科普说明', source_path: '/api/v1/contents/' + id + '/' }, citations: [{ kind: 'content', id, source_path: '/api/v1/contents/' + id + '/', title: '离线测试资料' }] }),
    getPublicItem: async (_, kind, id) => ({ id, kind }),
    generateLlm: async () => { generated++; return { text: '离线测试回答', model: 'deepseek-flash', usage: USAGE }; },
    sendWeatherReminder: () => assert.fail('A reminder must not be sent merely by creating an intent'),
  };
  const app = (runtime ? createRuntime : createApp)({ store, config, cloud: {}, providers, now: () => NOW });
  const call = (path, method = 'GET', body = {}, token = '') => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {}, config: releaseConfig(), llmEnabled: true }, identity);
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

test('restored edition obeys explicit server switches and defaults to no provider access without configuration', () => {
  const env = { HYHQ_APP_ID: 'wx0123456789abcdef', HYHQ_LLM_ENABLED: 'true', DEEPSEEK_API_KEY: 'retained-unit-key', HYHQ_SESSION_SECRET: 'retained-unit-secret', HYHQ_INFERENCE_ENABLED: 'true', HYHQ_QWEATHER_ENABLED: 'true', HYHQ_WEATHER_REMINDERS_ENABLED: 'true' };
  const deployment = { llmEnabled: true, llmGatewayEnabled: true, weatherReminders: { enabled: true, templateId: TEMPLATE_ID } };
  const config = configFromEnvironment(env, deployment);
  assert.equal(config.llmEnabled, true); assert.equal(config.llmGatewayEnabled, true);
  assert.equal(config.deepseekApiKey, env.DEEPSEEK_API_KEY); assert.equal(config.sessionSecret, env.HYHQ_SESSION_SECRET);
  assert.equal(config.inferenceEnabled, true); assert.equal(config.qweatherEnabled, true); assert.equal(config.weatherReminders.enabled, true);
  const disabled = configFromEnvironment({ ...env, HYHQ_LLM_ENABLED: 'false' }, deployment);
  assert.equal(disabled.llmEnabled, false); assert.equal(disabled.llmGatewayEnabled, false);
  assert.equal(configFromEnvironment({ DEEPSEEK_API_KEY: 'key-alone-does-not-enable' }).llmEnabled, false);
  assert.equal(configFromEnvironment({}, deployment).llmEnabled, true);
  assert.equal(llm.configFor({ config: applyReleasePolicy(releaseConfig()) }).enabled, true);
});

test('both app and runtime restore only guide and learning conversations while preserving trusted identity and usage limits', async () => {
  for (const runtime of [false, true]) {
    const f = await fixture(runtime);
    const health = (await f.call('health/')).data.data;
    assert.equal(health.release, RELEASE_ID); assert.equal(health.features.llm, true); assert.equal(health.optional_services.llm, true);
    for (const scope of ['explore', 'learn']) {
      const status = await f.call('llm/status/?scope=' + scope, 'GET', {}, f.auth.token);
      assert.equal(status.statusCode, 200); assert.equal(status.data.data.enabled, true);
      const created = await f.call('llm/sessions/', 'POST', { scope, source_type: scope === 'learn' ? 'content' : 'region', source_id: SOURCE }, f.auth.token);
      assert.equal(created.statusCode, 201, JSON.stringify(created));
      const turn = await f.call('llm/sessions/' + created.data.data.id + '/turns/', 'POST', { question: '这份资料讲什么', request_id: randomUUID() }, f.auth.token);
      assert.equal(turn.statusCode, 201, JSON.stringify(turn));
      const result = await f.call('llm/turns/' + turn.data.data.id + '/', 'GET', {}, f.auth.token);
      assert.equal(result.data.data.status, 'succeeded');
      const stranger = await f.call('llm/turns/' + turn.data.data.id + '/');
      assert.equal(stranger.statusCode, 401);
    }
    assert.equal(f.generated(), 2); assert.equal(await f.store.count('llm_ledger'), 2);
    assert.equal((await f.store.get('llm_days', '2026-10-08')).accounted_tokens, 6);
  }
});

test('home and identification entry points cannot create sessions or append to legacy identification sessions', async () => {
  const f = await fixture();
  for (const scope of ['home', 'recognition']) {
    const rejected = await f.call('llm/sessions/', 'POST', { scope, assessment_job_id: SOURCE }, f.auth.token);
    assert.equal(rejected.statusCode, 403); assert.equal(rejected.data.error.code, 'LLM_SCOPE_DISABLED');
  }
  assert.equal(await f.store.count('llm_sessions'), 0);
  for (const kind of ['recognition', 'image']) {
    const session = await legacySession(f, kind);
    const rejected = await f.call('llm/sessions/' + session.id + '/turns/', 'POST', { question: '旧页面尝试继续', request_id: randomUUID() }, f.auth.token);
    assert.equal(rejected.statusCode, 403); assert.equal(rejected.data.error.code, 'LLM_SCOPE_DISABLED');
  }
  assert.equal(f.generated(), 0); assert.equal(await f.store.count('llm_ledger'), 0);
});

test('server-disabled generation cannot be reenabled by client-supplied flags or stale deployment flags', async () => {
  const f = await fixture(false, { llmEnabled: false, llmGatewayEnabled: false });
  const status = await f.call('llm/status/?scope=learn', 'GET', {}, f.auth.token);
  assert.equal(status.data.data.enabled, false);
  const out = await f.call('llm/sessions/', 'POST', { scope: 'learn', source_type: 'content', source_id: SOURCE }, f.auth.token);
  assert.equal(out.statusCode, 503); assert.equal(out.data.error.code, 'LLM_DISABLED');
  assert.equal(f.generated(), 0); assert.equal(await f.store.count('llm_ledger'), 0);
});

test('a replayed booking draft is readable through the restored endpoint but never executes an appointment', async () => {
  const f = await fixture(), key = randomUUID(), body = { text: '今天下午两点提醒看天津天气', location: 'tianjin', request_key: key };
  f.providers.generateLlm = async () => ({ text: JSON.stringify({ needs_clarification: false, location: 'tianjin', local_date: '2026-10-08', local_time: '14:00', frequency: 'once' }), usage: USAGE });
  const cached = await require('../../cloudfunctions/hyhqApi/lib/weather-booking-ai').handle({ ...f.ctx, method: 'POST', path: 'weather-data/reminders/interpret/', body });
  assert.equal(cached.data.data.draft.location, 'tianjin');
  const before = await f.store.get('llm_days', '2026-10-08');
  const out = await f.call('weather-data/reminders/interpret/', 'POST', body, f.auth.token);
  assert.equal(out.statusCode, 200); assert.deepEqual(out.data.data, cached.data.data);
  assert.deepEqual(await f.store.get('llm_days', '2026-10-08'), before);
  assert.equal(await f.store.count('weather_ai_drafts'), 1); assert.equal(await f.store.count('weather_reminders'), 0);
  assert.equal(await f.store.count('weather_recipients'), 0);
  const guest = await f.call('weather-data/reminders/interpret/', 'POST', body);
  assert.equal(guest.statusCode, 401);
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
