'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const daily = require('../../cloudfunctions/hyhqApi/lib/weather-daily');
const START = '2026-12-31T23:00:00.000Z', DUE = '2027-01-01T00:00:00.000Z';
async function fixture(extra = {}) {
  const ctx = { method: 'GET', path: 'weather-data/reminders/', body: {}, query: new URLSearchParams(), now: START, store: new MemoryStore(),
    user: { id: 'daily-owner', nickname: '自然观察者', is_active: true }, wechatOpenId: 'trusted-fixture-openid',
    config: { weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } }, providers: { fetchWeather: async () => { throw new Error('simulation must not fetch weather'); }, sendWeatherReminder: async () => ({ errCode: 0 }) }, ...extra };
  await ctx.store.set('users', ctx.user.id, ctx.user); return ctx;
}
async function call(ctx, path, body = {}) { return (await reminders.handle({ ...ctx, method: 'POST', path: 'weather-data/reminders/' + path, body })).data.data; }
async function grant(ctx, decision = 'accept') { const g = await call(ctx, 'grants/'); return call(ctx, `grants/${g.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision }); }
async function plan(ctx, body = {}) { return call(ctx, 'daily/', { type: 'ecology_simulation', scenario: 'rain', time: '08:00', ...body }); }
async function status(ctx) { return (await reminders.handle(ctx)).data.data; }
const pool = ctx => ctx.store.get('weather_subscription_pools', ctx.user.id);

test('each separately prepared explicit acceptance adds one, concurrent callbacks and retries never add twice', async () => {
  const ctx = await fixture(), drafts = await Promise.all(Array.from({ length: 8 }, () => call(ctx, 'grants/')));
  assert.equal(new Set(drafts.map(r => r.id)).size, 1);
  const body = { template_id: reminders.TEMPLATE_ID, decision: 'accept' };
  const confirmations = await Promise.all(Array.from({ length: 12 }, () => call(ctx, `grants/${drafts[0].id}/confirm/`, body)));
  assert.ok(confirmations.every(r => r.state === 'accepted')); assert.equal((await pool(ctx)).remaining, 1);
  await grant(ctx); await grant(ctx); assert.equal((await pool(ctx)).remaining, 3);
  const publicState = await status(ctx); assert.equal(publicState.subscription_pool.remaining, 3);
  for (const secret of ['owner_id', ctx.wechatOpenId, 'total_grants']) assert.ok(!JSON.stringify(publicState).includes(secret));
  assert.equal(await ctx.store.count('weather_reminders'), 0);
});
test('refused, banned, expired, forged and foreign confirmations add no credits', async () => {
  const ctx = await fixture(); await grant(ctx, 'reject'); await grant(ctx, 'ban'); assert.equal((await pool(ctx)).remaining, 0);
  const draft = await call(ctx, 'grants/'), body = { template_id: reminders.TEMPLATE_ID, decision: 'accept' };
  await assert.rejects(call(ctx, `grants/${draft.id}/confirm/`, { ...body, count: 100 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(call(ctx, `grants/${draft.id}/confirm/`, { ...body, template_id: 'foreign' }), { code: 'VALIDATION_ERROR' });
  const other = { ...ctx, user: { id: 'other', is_active: true } }; await ctx.store.set('users', 'other', other.user);
  await assert.rejects(call(other, `grants/${draft.id}/confirm/`, body), { code: 'NOT_FOUND' });
  await assert.rejects(call({ ...ctx, now: '2026-12-31T23:11:00.000Z' }, `grants/${draft.id}/confirm/`, body), { code: 'REMINDER_CONSENT_EXPIRED' });
  assert.equal((await pool(ctx)).remaining, 0);
  await ctx.store.update('users', ctx.user.id, { is_active: false });
  await assert.rejects(call(ctx, 'grants/'), { code: 'NOT_AUTHENTICATED' });
});
test('daily plans and model values are server-allowlisted, identity cannot be supplied by clients', async () => {
  const ctx = await fixture();
  for (const patch of [{ time: '8:00' }, { time: '24:00' }, { scenario: ['rain'] }, { scenario: '__proto__' }, { threshold: 1 }, { temperature: 1000 }, { type: 'realwater' }, { openid: 'forged' }, { enabled: false }]) await assert.rejects(plan(ctx, patch), { code: 'VALIDATION_ERROR' });
  await assert.rejects(plan({ ...ctx, wechatOpenId: undefined }), { code: 'WECHAT_IDENTITY_REQUIRED' });
  assert.equal(await ctx.store.count('weather_daily_plans'), 0);
});
test('concurrent daily workers reserve a single shared credit and consume it only after one success', async () => {
  let calls = 0, sent;
  const ctx = await fixture(); ctx.providers.sendWeatherReminder = async req => { calls++; sent = req; return { errCode: 0 }; };
  await grant(ctx); await plan(ctx);
  const out = await Promise.all(Array.from({ length: 8 }, () => reminders.runDueReminders({ ...ctx, now: DUE })));
  assert.equal(out.reduce((n, r) => n + r.sent, 0), 1); assert.equal(calls, 1);
  const p = await pool(ctx); assert.equal(p.remaining, 0); assert.equal(p.reserved, 0); assert.equal(p.consumed, 1); assert.equal(p.held, 0);
  assert.equal(sent.data.thing2.value, '生态模拟提醒'); assert.match(sent.data.thing4.value, /^模拟/);
  assert.equal(sent.data.time26.value, '2027-01-01 08:00');
  for (const key of ['thing1', 'thing2', 'thing4']) assert.ok(Array.from(sent.data[key].value).length <= 20);
  await reminders.runDueReminders({ ...ctx, now: '2027-01-02T00:00:00.000Z' });
  assert.equal(calls, 1); assert.equal((await status(ctx)).daily_plans[0].last_state, 'no_credit');
  assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('cancel and change before dispatch release reservation, never double-send after re-enable on the same Beijing day', async () => {
  const ctx = await fixture(); await grant(ctx); await grant(ctx); await plan(ctx);
  await daily.materialize({ ...ctx, now: DUE }); assert.equal((await pool(ctx)).reserved, 1);
  await call({ ...ctx, now: DUE }, 'daily/ecology_simulation/cancel/');
  assert.equal((await pool(ctx)).remaining, 2); assert.equal((await pool(ctx)).reserved, 0);
  const again = await plan({ ...ctx, now: DUE }, { scenario: 'check', time: '08:10' });
  assert.equal(again.next_scheduled_for, '2027-01-02T00:10:00.000Z');
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-01T00:10:00.000Z' })).sent, 0);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-02T00:10:00.000Z' })).sent, 1);
  await plan({ ...ctx, now: '2027-01-02T00:11:00.000Z' }, { scenario: 'heat', time: '09:00' });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-02T01:00:00.000Z' })).sent, 0);
  assert.equal((await pool(ctx)).consumed, 1);
});
test('a missed day is never replayed and inactive or purged users never recreate grants, jobs or recipients', async () => {
  const ctx = await fixture(); await grant(ctx); await grant(ctx); await plan(ctx);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-04T02:00:00.000Z' })).sent, 0);
  assert.equal((await pool(ctx)).remaining, 2);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-05T00:00:00.000Z' })).sent, 1);
  await ctx.store.update('users', ctx.user.id, { is_active: false });
  await reminders.purgeOwnerReminders(ctx, ctx.user.id);
  await reminders.runDueReminders({ ...ctx, now: '2027-01-06T00:00:00.000Z' });
  for (const kind of ['weather_daily_plans', 'weather_subscription_pools', 'weather_subscription_grants', 'weather_reminders', 'weather_recipients']) assert.equal(await ctx.store.count(kind), 0);
});
test('ambiguous delivery holds one credit permanently; late worker recovery and the following day never reuse it', async () => {
  const ctx = await fixture(); let calls = 0;
  ctx.providers.sendWeatherReminder = async () => { calls++; throw Object.assign(new Error('connection lost after write'), { ambiguous: true }); };
  await grant(ctx); await plan(ctx); assert.equal((await reminders.runDueReminders({ ...ctx, now: DUE })).unknown, 1);
  let p = await pool(ctx); assert.equal(p.remaining, 0); assert.equal(p.held, 1); assert.equal(p.reserved, 0); assert.equal(p.consumed, 0);
  await reminders.runDueReminders({ ...ctx, now: '2027-01-01T00:10:00.000Z' }); await reminders.runDueReminders({ ...ctx, now: '2027-01-02T00:00:00.000Z' });
  assert.equal(calls, 1); p = await pool(ctx); assert.equal(p.held, 1);
});
test('a provider deadline is unknown rather than refunded or retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = await fixture(); let signal; const started = new Promise(resolve => { signal = resolve; });
  ctx.providers.sendWeatherReminder = () => { signal(); return new Promise(() => {}); };
  await grant(ctx); await plan(ctx); const running = reminders.runDueReminders({ ...ctx, now: DUE });
  await started; t.mock.timers.tick(10000);
  assert.equal((await running).unknown, 1); assert.equal((await pool(ctx)).held, 1); assert.equal((await pool(ctx)).remaining, 0);
});
test('known permanent refusal refunds only its reservation; platform 43101 invalidates the estimated pool until new explicit consent', async () => {
  for (const code of [40003, 43101]) {
    const ctx = await fixture(); let calls = 0;
    ctx.providers.sendWeatherReminder = async () => { calls++; return { errCode: code }; };
    await grant(ctx); await grant(ctx); await plan(ctx);
    assert.equal((await reminders.runDueReminders({ ...ctx, now: DUE })).failed, 1);
    const p = await pool(ctx); assert.equal(p.reserved, 0); assert.equal(p.remaining, code === 43101 ? 0 : 2); assert.equal(p.needs_resubscribe, code === 43101);
    if (code === 43101) {
      await reminders.runDueReminders({ ...ctx, now: '2027-01-02T00:00:00.000Z' }); assert.equal(calls, 1);
      await grant({ ...ctx, now: '2027-01-02T01:00:00.000Z' }); assert.equal((await pool(ctx)).remaining, 1); assert.equal((await pool(ctx)).needs_resubscribe, false);
    }
  }
});
test('late 43101 does not erase a freshly accepted grant received while the old send was in flight', async () => {
  const ctx = await fixture(); let release, signal; const started = new Promise(r => { signal = r; });
  ctx.providers.sendWeatherReminder = () => { signal(); return new Promise(r => { release = r; }); };
  await grant(ctx); await plan(ctx); const running = reminders.runDueReminders({ ...ctx, now: DUE });
  await started; await grant({ ...ctx, now: DUE }); release({ errCode: 43101 }); await running;
  const p = await pool(ctx); assert.equal(p.remaining, 1); assert.equal(p.needs_resubscribe, false); assert.equal(p.reserved, 0);
});
test('a crashed sending lease becomes unknown and holds its credit instead of resending', async () => {
  const ctx = await fixture(); await grant(ctx); await plan(ctx); await daily.materialize({ ...ctx, now: DUE });
  const row = (await ctx.store.list('weather_reminders'))[0];
  await ctx.store.update('weather_reminders', row.id, { state: 'sending', lease_token: 'crashed', lease_until: '2027-01-01T00:01:00.000Z' });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-01T00:05:00.000Z' })).sent, 0);
  assert.equal((await ctx.store.get('weather_reminders', row.id)).state, 'unknown'); assert.equal((await pool(ctx)).held, 1);
});
test('manual single appointments neither add to nor consume the daily pool and owner plans stay private', async () => {
  const ctx = await fixture(); await grant(ctx); await plan(ctx);
  const manual = await call(ctx, 'intents/', { type: 'ecology_simulation', scenario: 'heat', scheduled_for: DUE });
  await call(ctx, `intents/${manual.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  assert.equal((await pool(ctx)).remaining, 1);
  const other = { ...ctx, user: { id: 'stranger', is_active: true } }; await ctx.store.set('users', 'stranger', other.user);
  assert.equal((await status(other)).daily_plans.length, 0); assert.equal((await status(other)).subscription_pool.remaining, 0);
  await call(other, 'daily/ecology_simulation/cancel/'); assert.equal((await status(ctx)).daily_plans[0].enabled, true);
  const result = await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal(result.sent, 2);
  assert.equal((await pool(ctx)).consumed, 1);
});
function enableWeather(ctx) {
  Object.assign(ctx.config, { qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'test-only', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 30 });
  ctx.providers.fetchWeather = async () => ({ data: { schema_version: 2, days: [{ date: '2027-01-01', starts_at: '2026-12-31T16:00:00.000Z', ends_at: '2027-01-01T16:00:00.000Z', temperature_min: -2, temperature_max: 9, temperature_unit: '°C', daytime: { condition: '晴' }, nighttime: { condition: '多云' } }] }, attributions: [], refer: { sources: ['QWeather'] }, observed_at: null });
}
test('weather and ecology plans compete atomically for the same template pool, never a negative balance or two messages for one grant', async () => {
  const ctx = await fixture(); enableWeather(ctx); let calls = 0; ctx.providers.sendWeatherReminder = async () => { calls++; return { errCode: 0 }; };
  await grant(ctx); await plan(ctx); await plan(ctx, { type: 'weather', scenario: '', location: 'tianjin' });
  await Promise.all(Array.from({ length: 6 }, () => reminders.runDueReminders({ ...ctx, now: DUE })));
  assert.equal(calls, 1); const p = await pool(ctx); assert.equal(p.remaining, 0); assert.equal(p.reserved, 0); assert.equal(p.consumed, 1);
  assert.equal((await status(ctx)).daily_plans.length, 2);
});
test('plan cancellation during forecast refresh refunds the held credit and prevents provider dispatch', async () => {
  const ctx = await fixture(); enableWeather(ctx); const original = ctx.providers.fetchWeather; let resume, signal; const started = new Promise(r => { signal = r; });
  ctx.providers.fetchWeather = async () => { signal(); await new Promise(r => { resume = r; }); return original(); };
  ctx.providers.sendWeatherReminder = () => assert.fail('cancelled plan must not dispatch');
  await grant(ctx); await plan(ctx, { type: 'weather', scenario: '', location: 'tianjin' });
  const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started;
  await call({ ...ctx, now: DUE }, 'daily/weather/cancel/'); resume(); await running;
  assert.equal((await pool(ctx)).remaining, 1); assert.equal((await pool(ctx)).reserved, 0);
});
test('stopping after dispatch cannot retract a platform message and consumes exactly the reserved credit', async () => {
  const ctx = await fixture(); let finish, signal; const started = new Promise(r => { signal = r; });
  ctx.providers.sendWeatherReminder = () => { signal(); return new Promise(r => { finish = r; }); };
  await grant(ctx); await plan(ctx); const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started;
  await call({ ...ctx, now: DUE }, 'daily/ecology_simulation/cancel/');
  assert.equal((await pool(ctx)).reserved, 1); finish({ errCode: 0 }); await running;
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).consumed, 1); assert.equal((await status(ctx)).daily_plans[0].enabled, false);
});
test('confirmed transient platform refusal retries the same reservation once without debiting another grant', async () => {
  const ctx = await fixture(); let calls = 0; ctx.providers.sendWeatherReminder = async () => ({ errCode: ++calls === 1 ? -1 : 0 });
  await grant(ctx); await plan(ctx); await reminders.runDueReminders({ ...ctx, now: DUE });
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).reserved, 1);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2027-01-01T00:06:00.000Z' })).sent, 1);
  assert.equal(calls, 2); assert.equal((await pool(ctx)).consumed, 1); assert.equal((await pool(ctx)).reserved, 0);
});
test('manual platform no-permission response also invalidates the shared template estimate', async () => {
  const ctx = await fixture(); ctx.providers.sendWeatherReminder = async () => ({ errCode: 43101 }); await grant(ctx); await grant(ctx);
  const manual = await call(ctx, 'intents/', { type: 'ecology_simulation', scenario: 'heat', scheduled_for: DUE });
  await call(ctx, `intents/${manual.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).needs_resubscribe, true);
});
test('thirty-day receipt cleanup retains pooled credits and deleted receipt callbacks cannot mint another credit', async () => {
  const ctx = await fixture(), g = await grant(ctx);
  const out = await reminders.cleanupReminders({ ...ctx, now: '2027-02-01T00:00:00.000Z' });
  assert.equal(out.grants_removed, 1); assert.equal((await pool(ctx)).remaining, 1);
  await assert.rejects(call(ctx, `grants/${g.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' }), { code: 'NOT_FOUND' });
});
test('inactive weather-provider plans cannot occupy the simulation worker query window', async () => {
  const ctx = await fixture(); await grant(ctx); await plan(ctx);
  for (let i = 0; i < 25; i++) await ctx.store.set('weather_daily_plans', 'weather-block-' + i, { id: 'weather-block-' + i, owner_id: ctx.user.id, enabled: true, type: 'weather', location: 'tianjin', time: '07:00', next_scheduled_for: START, generation: 1 });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: DUE })).sent, 1);
  assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('daily grant preparation is bounded and resets at Beijing midnight without blocking a prepared token replay', async () => {
  const ctx = await fixture();
  for (let i = 0; i < 99; i++) await grant(ctx, 'reject');
  const last = await call(ctx, 'grants/'); assert.equal((await call(ctx, 'grants/')).id, last.id);
  await call(ctx, `grants/${last.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  await assert.rejects(call(ctx, 'grants/'), { code: 'REMINDER_RATE_LIMITED' });
  await grant({ ...ctx, now: '2027-01-01T16:00:00.000Z' }); assert.equal((await pool(ctx)).remaining, 2);
});
