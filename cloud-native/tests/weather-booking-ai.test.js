'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { MemoryStore } = require('./memory-store');
const ai = require('../../cloudfunctions/hyhqApi/lib/weather-booking-ai');
const llm = require('../../cloudfunctions/hyhqApi/lib/llm');
const provider = require('../../cloudfunctions/hyhqApi/lib/providers');
const NOW = '2026-10-07T04:00:00.000Z', USAGE = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const payload = { needs_clarification: false, location: 'tianjin', local_date: '2026-10-08', local_time: '08:00', frequency: 'once' };
async function setup() {
  const ctx = { now: NOW, store: new MemoryStore(), path: 'weather-data/reminders/interpret/', method: 'POST', query: new URLSearchParams(), user: { id: 'owner', quota_key: 'stable-owner', is_active: true }, body: { text: '明天早上八点提醒我看天津天气', location: 'tianjin', request_key: randomUUID() }, config: { weatherReminders: { enabled: true, templateId: require('../../cloudfunctions/hyhqApi/lib/weather-reminders').TEMPLATE_ID }, qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'fixture-weather-key', qweatherApiHost: 'fixture.re.qweatherapi.com', qweatherMonthlyLimit: 25000, llmEnabled: true, llmGatewayEnabled: true, deepseekApiKey: 'fake-test-only-key', sessionSecret: 'fake-unit-session-secret-not-for-deployment' }, providers: { sendWeatherReminder: () => assert.fail("draft cannot send"), generateLlm: async () => ({ text: JSON.stringify(payload), usage: USAGE }) } };
  await ctx.store.set('users', ctx.user.id, ctx.user); return ctx;
}
const call = async ctx => (await ai.handle(ctx)).data.data;
test('draft uses fixed Beijing clock, server whitelist and no execution', async () => {
  const ctx = await setup(); let messages;
  ctx.providers.generateLlm = async (_, input) => { messages = input; return { text: JSON.stringify(payload), usage: USAGE }; };
  const out = await call(ctx); assert.equal(out.draft.scheduled_for, '2026-10-08T00:00:00.000Z'); assert.match(out.message, /待确认/); assert.equal(out.model, 'deepseek-flash');
  assert.match(messages[0].content, /2026-10-07T12:00:00/); assert.doesNotMatch(JSON.stringify(messages), /stable-owner|fake-test|OPENID/);
  for (const kind of ['weather_reminders', 'weather_recipients', 'weather_requests']) assert.equal(await ctx.store.count(kind), 0);
  assert.equal((await ctx.store.get('llm_days', '2026-10-07')).accounted_tokens, 30);
});
test('same request replay does not dispatch or debit twice; conflict rejects', async () => {
  const ctx = await setup(); let calls = 0; ctx.providers.generateLlm = async () => { calls++; return { text: JSON.stringify(payload), usage: USAGE }; };
  assert.deepEqual(await call(ctx), await call(ctx)); assert.equal(calls, 1);
  ctx.body.text = '另一问题'; await assert.rejects(call(ctx), e => e.code === 'REQUEST_ID_CONFLICT');
});
test('concurrent replay dispatches exactly once and has recoverable busy response', async () => {
  const ctx = await setup(); let calls = 0; ctx.providers.generateLlm = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { text: JSON.stringify(payload), usage: USAGE }; };
  const out = await Promise.allSettled([call(ctx), call(ctx), call(ctx)]); assert.equal(calls, 1); assert.equal(out.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(out.filter(x => x.status === 'rejected').every(x => x.reason.code === 'LLM_USER_BUSY'));
});
test('natural-language and explore chat share daily successes, attempts and stable identity', async () => {
  const ctx = await setup(); const qid = llm.quotaId('stable-owner', 'explore', '2026-10-07');
  await ctx.store.set('llm_quotas', qid, { id: qid, owner_id: 'old-account', succeeded: 4, reserved: 0, attempts: 4 });
  await call(ctx); ctx.body.request_key = randomUUID(); await assert.rejects(call(ctx), e => e.code === 'LLM_DAILY_LIMIT');
  assert.equal((await ctx.store.get('llm_quotas', qid)).succeeded, 5);
});
test('global reservation and active chat block dispatch without taking another attempt', async () => {
  for (const mode of ['tokens', 'busy', 'attempt']) {
    const ctx = await setup(); ctx.providers.generateLlm = () => assert.fail('no dispatch');
    if (mode === 'tokens') ctx.config.llmGlobalTokenLimit = 1024;
    if (mode === 'attempt') ctx.config.llmGlobalAttemptLimit = 1;
    if (mode === 'attempt') await ctx.store.set('llm_days', '2026-10-07', { attempts: 1, reserved_tokens: 0, accounted_tokens: 0 });
    if (mode === 'busy') await ctx.store.set('llm_gate', 'runtime', { active: [{ id: 'other', owner_id: 'someone', status: 'running', deadline: '2026-10-08T00:00:00Z' }] });
    await assert.rejects(call(ctx), e => ['LLM_BUDGET_LIMIT', 'LLM_GLOBAL_LIMIT', 'LLM_BUSY'].includes(e.code)); assert.equal(await ctx.store.count('llm_ledger'), 0);
  }
});
test('malformed model output charges known usage and cannot create a booking', async () => {
  for (const text of ['not json', JSON.stringify({ ...payload, execute: true })]) {
    const ctx = await setup(); ctx.providers.generateLlm = async () => ({ text, usage: USAGE });
    await assert.rejects(call(ctx), e => e.code === 'WEATHER_AI_UNAVAILABLE'); assert.equal((await ctx.store.get('llm_days', '2026-10-07')).accounted_tokens, 30);
    assert.equal(await ctx.store.count('weather_ai_drafts'), 0); assert.equal(await ctx.store.count('weather_reminders'), 0);
  }
});
test('unsupported schedules, cities, calendar rollover and missing details need clarification', () => {
  for (const patch of [{ frequency: 'daily' }, { location: 'https://bad' }, { local_date: '2026-02-30' }, { local_time: '25:10' }, { local_date: '2026-10-07', local_time: '12:01' }, { local_date: '2026-10-10' }, { needs_clarification: true }]) assert.equal(ai.decode(JSON.stringify({ ...payload, ...patch }), Date.parse(NOW)).needs_clarification, true);
  assert.equal(ai.decode('```json\n'+JSON.stringify(payload)+'\n```', Date.parse(NOW)).draft.location, 'tianjin');
});
test('upstream timeout charges reserved tokens conservatively and replay never redispatches', async () => {
  const ctx = await setup(); let calls = 0; ctx.providers.generateLlm = async () => { calls++; throw new provider.ProviderError('LLM_TIMEOUT', { ambiguous: true }); };
  await assert.rejects(call(ctx)); await assert.rejects(call(ctx), e => e.code === 'REQUEST_ALREADY_CONSUMED'); assert.equal(calls, 1);
  const day = await ctx.store.get('llm_days', '2026-10-07'); assert.equal(day.accounted_tokens, 33368); assert.equal(day.reserved_tokens, 0);
});
test('account deletion racing a provider reply cannot resurrect a draft or raw prompt', async () => {
  const ctx = await setup(); ctx.providers.generateLlm = async () => { await ctx.store.update('users', 'owner', { is_active: false }); await llm.anonymizeOwner(ctx); return { text: JSON.stringify(payload), usage: USAGE }; };
  await assert.rejects(call(ctx), e => e.code === 'AUTH_REQUIRED'); assert.equal(await ctx.store.count('weather_ai_drafts'), 0);
  assert.doesNotMatch(JSON.stringify(await ctx.store.list('llm_ledger')), /明天早上|stable-owner|"owner_id":"owner"/);
});
test('clients cannot supply identity, prompt, arbitrary city or overlong query', async () => {
  for (const patch of [{ OPENID: 'attacker' }, { system_prompt: 'bypass' }, { text: '文'.repeat(501) }, { location: 'arbitrary' }, { request_key: 'x' }]) { const ctx = await setup(); Object.assign(ctx.body, patch); await assert.rejects(call(ctx), e => e.code === 'VALIDATION_ERROR'); assert.equal(await ctx.store.count('llm_ledger'), 0); }
});
test('disabled feature, guest and inactive user cannot consume LLM budget', async () => {
  for (const mode of ['disabled', 'guest', 'inactive']) { const ctx = await setup(); if (mode === 'disabled') ctx.config.weatherReminders.enabled = false; if (mode === 'guest') ctx.user = null; if (mode === 'inactive') await ctx.store.update('users', 'owner', { is_active: false }); await assert.rejects(call(ctx)); assert.equal(await ctx.store.count('llm_ledger'), 0); }
});
test('a replay later than appointment returns clarification, without a second call', async () => {
  const ctx = await setup(); await call(ctx); ctx.now = '2026-10-08T01:00:00.000Z'; ctx.providers.generateLlm = () => assert.fail(); assert.equal((await call(ctx)).needs_clarification, true);
});

test("structured prompt satisfies actual provider validation", () => { assert.doesNotThrow(() => provider.validMessages(ai.messages("明早八点天津天气", "tianjin", Date.parse(NOW)))); });
