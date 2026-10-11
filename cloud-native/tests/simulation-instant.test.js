'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const daily = require('../../cloudfunctions/hyhqApi/lib/weather-daily');
const policy = require('../../cloudfunctions/hyhqApi/lib/release-policy');
const NOW = '2026-10-11T08:00:00.000Z';
async function context() {
  const ctx = { store: new MemoryStore(), user: { id: 'instant-owner', is_active: true, nickname: '测试用户' }, wechatOpenId: 'trusted-fixture-openid', now: NOW, method: 'GET', path: 'weather-data/reminders/', query: new URLSearchParams(), body: {},
    config: policy.applyReleasePolicy({ weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } }),
    providers: { fetchWeather: () => assert.fail('instant simulation must not fetch weather'), sendWeatherReminder: async () => ({ errCode: 0 }) } };
  await ctx.store.set('users', ctx.user.id, ctx.user); return ctx;
}
async function call(ctx, path, body = {}) { return (await reminders.handle({ ...ctx, method: 'POST', path: 'weather-data/reminders/' + path, body })).data.data; }
const prepare = ctx => call(ctx, 'simulation-intents/');
const confirm = (ctx, row, decision = 'accept') => call(ctx, `simulation-intents/${row.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision });
test('prepare creates no message and accepts no caller-selected scenario, value, time or recipient', async () => {
  const ctx = await context();
  for (const b of [{ scenario: 'steady' }, { scheduled_for: NOW }, { turbidity: 999 }, { touser: 'other' }]) await assert.rejects(call(ctx, 'simulation-intents/', b), { code: 'VALIDATION_ERROR' });
  const rows = await Promise.all(Array.from({ length: 8 }, () => prepare(ctx)));
  assert.equal(new Set(rows.map(r => r.id)).size, 1); assert.equal(rows[0].mode, 'instant_simulation');
  assert.equal(rows[0].state, 'prepared'); assert.equal(rows[0].message_preview, '模拟异常：浊度偏高，请复核');
  assert.match(rows[0].notice, /不是当前曲线或真实水质/);
  assert.equal((await reminders.runDueReminders(ctx)).sent, 0);
  assert.equal(await ctx.store.count('weather_recipients'), 0); assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('one explicit accept immediately sends the fixed abnormal example, concurrent replay cannot send again or touch the daily pool', async () => {
  const ctx = await context(); let sent = [];
  ctx.providers.sendWeatherReminder = async message => { sent.push(message); return { errCode: 0 }; };
  const g = await call(ctx, 'grants/'); await call(ctx, `grants/${g.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  const row = await prepare(ctx); await Promise.all(Array.from({ length: 8 }, () => confirm(ctx, row)));
  assert.equal(sent.length, 1); assert.equal((await confirm(ctx, row)).state, 'sent');
  assert.equal(sent[0].touser, ctx.wechatOpenId); assert.equal(sent[0].page, 'pages/home/index');
  assert.equal(sent[0].data.thing2.value, '生态模拟异常提醒'); assert.equal(sent[0].data.thing4.value, '模拟异常：浊度偏高，请复核');
  for (const key of ['thing1', 'thing2', 'thing4']) assert.ok(Array.from(sent[0].data[key].value).length <= 20);
  const p = await ctx.store.get('weather_subscription_pools', ctx.user.id); assert.equal(p.remaining, 1); assert.equal(p.consumed, 0);
  await reminders.runDueReminders({ ...ctx, now: '2026-10-11T08:05:00.000Z' }); assert.equal(sent.length, 1);
  assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('reject, ban, expired, unauthenticated and foreign confirmations never dispatch', async () => {
  const ctx = await context(); ctx.providers.sendWeatherReminder = () => assert.fail('no valid accepted subscription');
  for (const decision of ['reject', 'ban']) { const row = await prepare(ctx); assert.equal((await confirm(ctx, row, decision)).state, 'cancelled'); assert.equal((await confirm(ctx, row, decision)).state, 'cancelled'); }
  const row = await prepare(ctx), other = { ...ctx, user: { id: 'stranger', is_active: true } }; await ctx.store.set('users', other.user.id, other.user);
  await assert.rejects(confirm(other, row), { code: 'NOT_FOUND' });
  await assert.rejects(prepare({ ...ctx, user: null }), { code: 'NOT_AUTHENTICATED' });
  await assert.rejects(confirm({ ...ctx, now: '2026-10-11T08:11:00.000Z' }, row), { code: 'REMINDER_CONSENT_EXPIRED' });
  await assert.rejects(call(ctx, `intents/${row.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' }), { code: 'VALIDATION_ERROR' });
});
test('ambiguous delivery is terminal and replay or timer never retries; provider timeout has the same outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const ctx = await context(); let calls = 0, signal; const started = new Promise(r => { signal = r; });
  ctx.providers.sendWeatherReminder = () => { calls++; signal(); return new Promise(() => {}); };
  const row = await prepare(ctx), running = confirm(ctx, row); await started; t.mock.timers.tick(10000);
  assert.equal((await running).state, 'unknown'); assert.equal((await confirm(ctx, row)).state, 'unknown');
  await reminders.runDueReminders({ ...ctx, now: '2026-10-11T08:05:00.000Z' }); assert.equal(calls, 1);
  assert.equal(await ctx.store.count('weather_subscription_pools'), 0);
});
test('confirmed platform refusal is replay-safe and cancelled intent cannot become accepted later', async () => {
  const ctx = await context(); let calls = 0; ctx.providers.sendWeatherReminder = async () => { calls++; return { errCode: 43101 }; };
  const row = await prepare(ctx); assert.equal((await confirm(ctx, row)).state, 'failed'); assert.equal((await confirm(ctx, row)).state, 'failed'); assert.equal(calls, 1);
  const cancelled = await prepare(ctx); await call(ctx, `${cancelled.id}/cancel/`);
  await assert.rejects(confirm(ctx, cancelled), { code: 'REMINDER_STATE_CHANGED' }); assert.equal(calls, 1);
});
test('accepted immediate trials are capped per Beijing day; replay at the cap does not add a new trial', async () => {
  const ctx = await context(); let last;
  for (let i = 0; i < 5; i++) { last = await prepare(ctx); await confirm(ctx, last); }
  assert.equal((await confirm(ctx, last)).state, 'sent'); await assert.rejects(prepare(ctx), { code: 'REMINDER_RATE_LIMITED' });
  assert.equal((await prepare({ ...ctx, now: '2026-10-11T16:00:00.000Z' })).state, 'prepared');
});
test('current release closes timed simulation creation and AI drafts, preserves only the immediate entry', async () => {
  const ctx = await context(); assert.equal(policy.applyReleasePolicy({ instantSimulationOnly: false }).instantSimulationOnly, true);
  await assert.rejects(call(ctx, 'intents/', { type: 'ecology_simulation', scenario: 'steady', scheduled_for: '2026-10-11T08:10:00Z' }), { code: 'SIMULATION_MOVED' });
  await assert.rejects(call(ctx, 'daily/', { type: 'ecology_simulation', scenario: 'heat', time: '18:00' }), { code: 'SIMULATION_MOVED' });
  const ai = require('../../cloudfunctions/hyhqApi/lib/weather-booking-ai');
  const out = ai.decode(JSON.stringify({ needs_clarification: false, type: 'ecology_simulation', scenario: 'rain', frequency: 'daily', local_time: '18:00', local_date: '2026-10-11' }), Date.parse(NOW), { instantOnly: true });
  assert.equal(out.needs_clarification, true); assert.equal(out.draft, null); assert.match(out.message, /首页/);
});
test('retiring legacy simulated plans cancels pending reservations and refunds pool credits, without changing history or committed sends', async () => {
  const ctx = await context(), previous = { ...ctx, config: { ...ctx.config, instantSimulationOnly: false } };
  const g = await call(previous, 'grants/'); await call(previous, `grants/${g.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  await call(previous, 'daily/', { type: 'ecology_simulation', scenario: 'steady', time: '16:10' });
  await daily.materialize({ ...previous, now: '2026-10-11T08:10:00.000Z' });
  const reserved = (await ctx.store.list('weather_reminders'))[0]; assert.equal((await ctx.store.get('weather_subscription_pools', ctx.user.id)).reserved, 1);
  for (const state of ['sent', 'unknown', 'sending']) await ctx.store.set('weather_reminders', 'history-' + state, { ...reserved, id: 'history-' + state, state, credit_state: 'consumed' });
  await reminders.retireLegacySimulation(ctx);
  assert.equal((await ctx.store.get('weather_reminders', reserved.id)).state, 'cancelled');
  assert.equal((await ctx.store.get('weather_reminders', reserved.id)).reason, 'simulation_changed_to_instant');
  const p = await ctx.store.get('weather_subscription_pools', ctx.user.id); assert.equal(p.remaining, 1); assert.equal(p.reserved, 0);
  for (const state of ['sent', 'unknown', 'sending']) assert.equal((await ctx.store.get('weather_reminders', 'history-' + state)).state, state);
  assert.equal((await ctx.store.list('weather_daily_plans'))[0].enabled, false);
});
test('retirement stays bounded, processes further pages later, and never cancels the new prepared instant experience', async () => {
  const ctx = await context(), row = await prepare(ctx), stored = await ctx.store.get('weather_reminders', row.id);
  for (let i = 0; i < 50; i++) await ctx.store.set('weather_reminders', 'legacy-' + i, { ...stored, id: 'legacy-' + i, instant_simulation: false, created_at: '2026-10-10T00:00:00Z' });
  assert.ok(await reminders.retireLegacySimulation(ctx, { limit: 10 }) <= 10);
  assert.equal(await ctx.store.count('weather_reminders', { state: 'cancelled' }), 10);
  for (let i = 0; i < 5; i++) await reminders.retireLegacySimulation(ctx, { limit: 10 });
  assert.equal(await ctx.store.count('weather_reminders', { state: 'cancelled' }), 50);
  assert.equal((await ctx.store.get('weather_reminders', row.id)).state, 'prepared');
});
test('deletion after dispatch does not recreate user records or pool state when the provider returns', async () => {
  const ctx = await context(); let finish, signal; const started = new Promise(r => { signal = r; });
  ctx.providers.sendWeatherReminder = () => { signal(); return new Promise(r => { finish = r; }); };
  const row = await prepare(ctx), running = confirm(ctx, row); await started;
  await ctx.store.update('users', ctx.user.id, { is_active: false }); await reminders.purgeOwnerReminders(ctx, ctx.user.id); finish({ errCode: 0 });
  await assert.rejects(running, { code: 'NOT_FOUND' });
  for (const kind of ['weather_reminders', 'weather_recipients', 'weather_simulation_trials', 'weather_subscription_pools']) assert.equal(await ctx.store.count(kind), 0);
});
test('public runtime enforces the new release policy with trusted SDK identity and no client toggle or weather request', async () => {
  const { createApp } = require('../../cloudfunctions/hyhqApi');
  const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
  const config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef' }, { env: 'unit-environment', weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } });
  const store = new MemoryStore(), sent = [];
  const app = createApp({ store, config, now: () => NOW, cloud: {}, providers: { sendWeatherReminder: async message => { sent.push(message); return { errCode: 0 }; }, fetchWeather: () => assert.fail('instant must not fetch weather') } });
  const identity = { APPID: config.appId, OPENID: 'verified-fixture-openid' };
  const req = (path, body, token = '') => app({ path: '/api/v1/' + path, method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body }, identity);
  const login = await req('auth/wechat/', { code: 'unit-code' }), token = login.data.data.token;
  const retired = await req('weather-data/reminders/daily/', { type: 'ecology_simulation', scenario: 'rain', time: '18:00' }, token);
  assert.equal(retired.statusCode, 409); assert.equal(retired.data.error.code, 'SIMULATION_MOVED');
  const prepared = await req('weather-data/reminders/simulation-intents/', {}, token); assert.equal(prepared.statusCode, 200);
  const result = await req(`weather-data/reminders/simulation-intents/${prepared.data.data.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' }, token);
  assert.equal(result.statusCode, 200); assert.equal(result.data.data.state, 'sent'); assert.equal(sent.length, 1); assert.equal(sent[0].touser, identity.OPENID);
  assert.doesNotMatch(JSON.stringify(result), /verified-fixture-openid|owner_id/); assert.equal(await store.count('weather_requests'), 0);
});
