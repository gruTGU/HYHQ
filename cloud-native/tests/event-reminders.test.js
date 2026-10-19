'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const events = require('../../cloudfunctions/hyhqApi/lib/events');
const eventReminders = require('../../cloudfunctions/hyhqApi/lib/event-reminders');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const daily = require('../../cloudfunctions/hyhqApi/lib/weather-daily');
const { createApp, createRuntime } = require('../../cloudfunctions/hyhqApi');
const { createWeatherReminderSender } = require('../../cloudfunctions/hyhqApi/lib/subscription-transport');
const { purgeAccount } = require('../../cloudfunctions/hyhqApi/lib/accounts');
const START = '2026-10-23T10:00:00.000Z', DUE = '2026-10-23T12:00:00.000Z';
async function fixture(now = START) {
  const ctx = { method: 'GET', path: 'events/', body: {}, query: new URLSearchParams(), now, store: new MemoryStore(),
    user: { id: 'event-owner', is_active: true, nickname: '自然观察者', quota_key: 'a'.repeat(64) }, wechatOpenId: 'verified-event-test-openid',
    config: { weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID, state: 'developer' } },
    providers: { fetchWeather: async () => assert.fail('event must not fetch weather'), sendWeatherReminder: async () => ({ errCode: 0 }) } };
  await ctx.store.set('users', ctx.user.id, ctx.user);
  // Mirror the native store's strict transaction contract: direct documents only,
  // valid keys, and a bounded number of operations. MemoryStore alone allows more.
  const transact = ctx.store.transaction.bind(ctx.store);
  ctx.store.transaction = callback => transact(async tx => {
    let count = 0;
    for (const method of ['get', 'set', 'remove', 'update']) {
      const original = tx[method].bind(tx);
      tx[method] = (kind, id, ...args) => { assert.equal(typeof id, 'string', 'native document id'); assert.ok(++count <= 100); return original(kind, id, ...args); };
    }
    tx.list = tx.count = () => assert.fail('no query inside native transactions'); return callback(tx);
  });
  return ctx;
}
async function weatherCall(ctx, path, body = {}) { return (await reminders.handle({ ...ctx, method: 'POST', path: 'weather-data/reminders/' + path, body })).data.data; }
async function grant(ctx, decision = 'accept') { const g = await weatherCall(ctx, 'grants/'); return weatherCall(ctx, 'grants/' + g.id + '/confirm/', { template_id: reminders.TEMPLATE_ID, decision }); }
async function subscribe(ctx, event = events.catalogue(ctx.now).find(row => row.id.startsWith('river-weekend'))) { return (await events.handle({ ...ctx, path: 'event-subscriptions/', method: 'POST', body: { event_id: event.id } })).data.data; }
async function cancel(ctx, eventId) { return events.handle({ ...ctx, path: 'event-subscriptions/' + eventId + '/', method: 'DELETE', body: {} }); }
async function status(ctx) { return (await events.handle({ ...ctx, path: 'event-subscriptions/' })).data.data; }
const pool = ctx => ctx.store.get('weather_subscription_pools', ctx.user.id);
const job = (ctx, row) => ctx.store.get('weather_reminders', row.reminder.id);

test('activity reminders use the previous evening at 20:00 Shanghai time, including year/leap boundaries and late booking', () => {
  const event = events.catalogue(START).find(row => row.id === 'river-weekend-2026-10-24');
  assert.equal(eventReminders.scheduled(event, START), DUE);
  assert.equal(eventReminders.scheduled(event, '2026-10-24T02:00:00Z'), '2026-10-24T02:00:00.000Z');
  const january = events.catalogue('2026-12-30T00:00:00Z').find(row => row.id === 'flower-month-1-2027-01-01');
  assert.equal(eventReminders.scheduled(january, '2026-12-30T00:00:00Z'), '2026-12-31T12:00:00.000Z');
  const march = events.catalogue('2028-02-20T00:00:00Z').find(row => row.id === 'flower-month-3-2028-03-01');
  assert.equal(eventReminders.scheduled(march, '2028-02-20T00:00:00Z'), '2028-02-29T12:00:00.000Z');
  for (const bad of [{ ...event, ends_at: START }, { ...event, starts_at: 'not-a-date' }]) assert.throws(() => eventReminders.scheduled(bad, START), { code: 'EVENT_UNAVAILABLE' });
});

test('subscription requires a shared explicit acceptance and trusted identity; clients cannot provide quota or notification content', async () => {
  const ctx = await fixture();
  assert.equal((await status(ctx)).reminder.enabled, true); assert.equal((await status(ctx)).reminder.wechat_login, true);
  await assert.rejects(subscribe(ctx), { code: 'SUBSCRIPTION_CREDIT_REQUIRED' });
  await grant(ctx, 'reject'); await assert.rejects(subscribe(ctx), { code: 'SUBSCRIPTION_CREDIT_REQUIRED' });
  await assert.rejects(subscribe({ ...ctx, wechatOpenId: undefined }), { code: 'WECHAT_IDENTITY_REQUIRED' });
  await assert.rejects(subscribe({ ...ctx, config: { weatherReminders: { enabled: false } } }), { code: 'SUBSCRIPTIONS_DISABLED' });
  const event = events.catalogue(START)[0];
  for (const extra of [{ count: 9 }, { openid: 'forged' }, { scheduled_for: START }, { message: 'not simulated' }, { title: 'forged title' }])
    await assert.rejects(events.handle({ ...ctx, path: 'event-subscriptions/', method: 'POST', body: { event_id: event.id, ...extra } }), { code: 'VALIDATION_ERROR' });
  assert.equal(await ctx.store.count('event_subscriptions'), 0); assert.equal(await ctx.store.count('weather_reminders'), 0);
  assert.doesNotMatch(JSON.stringify(await status(ctx)), /verified-event-test-openid|owner_id|total_grants/);
});

test('concurrent same-event subscriptions reserve exactly one shared credit and remain idempotent without immediate delivery', async () => {
  const ctx = await fixture(); ctx.providers.sendWeatherReminder = () => assert.fail('signup never sends'); await grant(ctx);
  const results = await Promise.all(Array.from({ length: 10 }, () => subscribe(ctx)));
  assert.equal(new Set(results.map(row => row.reminder.id)).size, 1);
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).reserved, 1);
  assert.equal(await ctx.store.count('weather_reminders'), 1); assert.equal(await ctx.store.count('event_subscriptions'), 1);
  await assert.rejects(subscribe(ctx, events.catalogue(START).find(row => row.id.startsWith('beijing-weekend'))), { code: 'SUBSCRIPTION_CREDIT_REQUIRED' });
  const other = { ...ctx, user: { id: 'other-owner', is_active: true } }; await ctx.store.set('users', other.user.id, other.user);
  await cancel(other, results[0].event_id); assert.equal((await status(other)).items.length, 0); assert.equal((await pool(ctx)).reserved, 1);
});

test('daily reminders and an activity compete atomically for the same single template credit', async () => {
  const ctx = await fixture(); await grant(ctx);
  await weatherCall(ctx, 'daily/', { type: 'ecology_simulation', scenario: 'rain', time: '20:00' });
  const due = { ...ctx, now: DUE };
  await Promise.allSettled([daily.materialize(due), subscribe(due)]);
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).reserved, 1);
  assert.equal(await ctx.store.count('weather_reminders'), 1);
  assert.equal((await reminders.runDueReminders(due)).sent, 1);
  assert.equal((await pool(ctx)).consumed, 1); assert.equal((await pool(ctx)).reserved, 0);
});

test('cancellation refunds the shared reservation and a stale preparation cannot dispatch after cancel and re-subscribe', async () => {
  const ctx = await fixture(); await grant(ctx); const first = await subscribe(ctx);
  let pause, ready; const started = new Promise(resolve => { ready = resolve; }); let blocked = false, sent = 0;
  const original = ctx.store.transaction.bind(ctx.store);
  ctx.store.transaction = async callback => { const result = await original(callback); if (!blocked && result && result.type === 'event' && result.state === 'preparing') { blocked = true; ready(); await new Promise(resolve => { pause = resolve; }); } return result; };
  ctx.providers.sendWeatherReminder = async () => { sent++; return { errCode: 0 }; };
  const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started;
  await cancel(ctx, first.event_id); assert.equal((await pool(ctx)).remaining, 1); assert.equal((await pool(ctx)).reserved, 0);
  const second = await subscribe(ctx); assert.equal(second.reminder.id, first.reminder.id); assert.equal((await job(ctx, second)).event_subscription_generation, 2);
  pause(); await running; assert.equal(sent, 0);
  await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal(sent, 1); assert.equal((await pool(ctx)).consumed, 1);
});

test('the existing worker sends one fixed simulated template with real activity dates and an allowlisted page', async () => {
  const ctx = await fixture(); const sent = [];
  ctx.providers.sendWeatherReminder = createWeatherReminderSender({ openapi: { subscribeMessage: { send: async payload => { sent.push(payload); return { errCode: 0 }; } } } }, ctx.config);
  await grant(ctx); const row = await subscribe(ctx);
  await reminders.runDueReminders(ctx); assert.equal(sent.length, 0);
  await Promise.all(Array.from({ length: 8 }, () => reminders.runDueReminders({ ...ctx, now: DUE })));
  assert.equal(sent.length, 1); const message = sent[0];
  assert.equal(message.templateId, reminders.TEMPLATE_ID); assert.equal(message.page, 'pages/events/index'); assert.equal(message.touser, ctx.wechatOpenId);
  assert.equal(message.miniprogramState, 'developer');
  for (const field of ['thing1', 'thing2', 'thing4']) assert.ok(Array.from(message.data[field].value).length <= 20);
  assert.match(message.data.thing2.value, /^模拟活动：/); assert.match(message.data.thing4.value, /^模拟地点：/);
  assert.equal(message.data.time26.value, '2026-10-24 09:00'); assert.equal(message.data.time9.value, '2026-10-24 11:00');
  assert.equal((await job(ctx, row)).state, 'sent'); assert.equal(await ctx.store.count('event_delivery_receipts'), 1);
  await cancel(ctx, row.event_id); assert.equal((await subscribe(ctx)).reminder.state, 'sent');
  await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal(sent.length, 1); assert.equal((await pool(ctx)).remaining, 0);
});

test('a send already submitted cannot be cancelled and an uncertain result is held without retries or refund', async () => {
  const ctx = await fixture(); await grant(ctx); const row = await subscribe(ctx); let finish, signal, calls = 0;
  const started = new Promise(resolve => { signal = resolve; });
  ctx.providers.sendWeatherReminder = () => { calls++; signal(); return new Promise(resolve => { finish = resolve; }); };
  const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started;
  await assert.rejects(cancel(ctx, row.event_id), { code: 'REMINDER_DISPATCHED' }); assert.equal((await status(ctx)).items.length, 1);
  finish({}); await running;
  assert.equal((await job(ctx, row)).state, 'unknown'); assert.equal((await pool(ctx)).held, 1); assert.equal((await pool(ctx)).remaining, 0);
  await grant(ctx); await cancel(ctx, row.event_id); assert.equal((await subscribe(ctx)).reminder.state, 'unknown');
  await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal(calls, 1); assert.equal((await pool(ctx)).remaining, 1);
});

test('platform refusal invalidates old shared reservations while preserving consent accepted during dispatch', async () => {
  const ctx = await fixture(); await grant(ctx); await grant(ctx);
  const first = await subscribe(ctx), secondEvent = events.catalogue(START).find(row => row.id.startsWith('beijing-weekend'));
  const second = await subscribe(ctx, secondEvent); let finish, signal;
  const started = new Promise(resolve => { signal = resolve; }); ctx.providers.sendWeatherReminder = () => { signal(); return new Promise(resolve => { finish = resolve; }); };
  const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started; await grant(ctx); finish({ errCode: 43101 }); await running;
  assert.equal((await job(ctx, first)).state, 'failed'); assert.equal((await pool(ctx)).remaining, 1); assert.equal((await pool(ctx)).generation, 1);
  ctx.providers.sendWeatherReminder = async () => ({ errCode: 0 });
  await subscribe(ctx, secondEvent); assert.equal((await job(ctx, second)).credit_generation, 1); assert.equal((await pool(ctx)).reserved, 1);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: '2026-10-24T12:00:00Z' })).sent, 1);
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).consumed, 1);
});

test('an explicit transient refusal retries only the same reservation once, while an unsent expiry returns it', async () => {
  const ctx = await fixture(); await grant(ctx); const row = await subscribe(ctx); let calls = 0;
  ctx.providers.sendWeatherReminder = async () => ({ errCode: ++calls === 1 ? -1 : 0 });
  await reminders.runDueReminders({ ...ctx, now: DUE }); assert.equal((await job(ctx, row)).state, 'retry');
  assert.equal((await subscribe(ctx)).reminder.id, row.reminder.id); assert.equal((await pool(ctx)).reserved, 1);
  await reminders.runDueReminders({ ...ctx, now: '2026-10-23T12:06:00Z' }); assert.equal(calls, 2); assert.equal((await pool(ctx)).consumed, 1);
  const expired = await fixture(); await grant(expired); const pending = await subscribe(expired);
  await reminders.cleanupReminders({ ...expired, now: '2026-10-24T03:00:01Z' });
  assert.equal((await job(expired, pending)).state, 'expired'); assert.equal((await pool(expired)).remaining, 1);
  await assert.rejects(subscribe({ ...expired, now: '2026-10-24T03:00:01Z' }, { id: pending.event_id }), { code: 'EVENT_UNAVAILABLE' });
});

test('a new grant already reserved during an older 43101 response is conservatively invalidated without refund or duplicate send', async () => {
  const ctx = await fixture(); await grant(ctx); await subscribe(ctx); let finish, signal, calls = 0;
  const started = new Promise(resolve => { signal = resolve; });
  ctx.providers.sendWeatherReminder = () => { calls++; signal(); return new Promise(resolve => { finish = resolve; }); };
  const running = reminders.runDueReminders({ ...ctx, now: DUE }); await started;
  await grant(ctx); const secondEvent = events.catalogue(START).find(row => row.id.startsWith('beijing-weekend'));
  const second = await subscribe(ctx, secondEvent); assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).reserved, 2);
  finish({ errCode: 43101 }); await running;
  const after = { ...ctx, now: '2026-10-24T12:00:00Z' };
  ctx.providers.sendWeatherReminder = async () => { calls++; return { errCode: 0 }; };
  await reminders.runDueReminders(after);
  assert.equal(calls, 1); assert.equal((await job(ctx, second)).state, 'cancelled'); assert.equal((await job(ctx, second)).credit_state, 'invalid');
  assert.equal((await pool(ctx)).remaining, 0); assert.equal((await pool(ctx)).reserved, 0); assert.equal((await pool(ctx)).needs_resubscribe, true);
  // The estimate can undercount this race. Never fabricate a refund that might
  // duplicate an authorization consumed by an already submitted platform call.
  await assert.rejects(subscribe(after, secondEvent), { code: 'SUBSCRIPTION_CREDIT_REQUIRED' });
  await grant(after); await subscribe(after, secondEvent); await reminders.runDueReminders(after);
  assert.equal(calls, 2); assert.equal((await pool(ctx)).consumed, 1); assert.equal((await pool(ctx)).remaining, 0);
});

test('long events keep a duplicate barrier after normal job cleanup; retained receipts do not block other history cleanup', async () => {
  const ctx = await fixture('2027-01-01T00:00:00Z'), event = events.catalogue(ctx.now).find(row => row.id === 'flower-month-1-2027-01-01');
  await grant(ctx); const row = await subscribe(ctx, event); await reminders.runDueReminders(ctx); await cancel(ctx, row.event_id);
  const later = { ...ctx, now: '2027-01-31T01:00:00Z' };
  const cleanup = await reminders.cleanupReminders(later); assert.equal(cleanup.reminders_removed, 1);
  assert.equal(await job(ctx, row), null); assert.equal(await ctx.store.count('event_delivery_receipts'), 1);
  const renewed = await subscribe(later, event); assert.equal(renewed.reminder.state, 'sent'); assert.equal(await ctx.store.count('weather_reminders'), 0);
  assert.equal((await pool(ctx)).consumed, 1); assert.equal((await pool(ctx)).remaining, 0);
  assert.equal((await reminders.cleanupReminders({ ...ctx, now: '2027-05-02T00:00:00Z' })).event_receipts_removed, 1);
});

test('many activity rows neither hide legacy weather history nor block event delivery when weather is unavailable', async () => {
  const ctx = await fixture(); await grant(ctx); const row = await subscribe(ctx);
  for (let i = 0; i < 140; i++) await ctx.store.set('weather_reminders', 'event-history-' + i, { ...(await job(ctx, row)), id: 'event-history-' + i, state: 'sent', created_at: DUE });
  await ctx.store.set('weather_reminders', 'legacy-weather', { id: 'legacy-weather', owner_id: ctx.user.id, state: 'sent', location: 'tianjin', scheduled_for: START, created_at: START, updated_at: START, expires_at: DUE });
  const weatherStatus = (await reminders.handle({ ...ctx, path: 'weather-data/reminders/' })).data.data;
  assert.deepEqual(weatherStatus.items.map(item => item.id), ['legacy-weather']);
  for (let i = 0; i < 10; i++) await ctx.store.set('weather_reminders', 'disabled-weather-' + i, { id: 'disabled-weather-' + i, type: 'weather', state: 'pending', scheduled_for: START });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: DUE })).sent, 1);
});

test('weather appointment confirmation and cancellation cannot operate on an event reservation', async () => {
  const ctx = await fixture(); await grant(ctx); const row = await subscribe(ctx);
  await assert.rejects(weatherCall(ctx, 'intents/' + row.reminder.id + '/confirm/', { template_id: reminders.TEMPLATE_ID, decision: 'accept' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(weatherCall(ctx, row.reminder.id + '/cancel/'), { code: 'VALIDATION_ERROR' });
  assert.equal((await pool(ctx)).reserved, 1); assert.equal((await job(ctx, row)).state, 'pending');
});

test('inactive accounts cannot subscribe or dispatch, and account purge removes shared jobs, pool and delivery receipts', async () => {
  const ctx = await fixture(); await grant(ctx); await subscribe(ctx); await reminders.runDueReminders({ ...ctx, now: DUE });
  await ctx.store.update('users', ctx.user.id, { is_active: false });
  await assert.rejects(subscribe(ctx), { code: 'AUTH_REQUIRED' });
  await purgeAccount({ ...ctx, storage: {} }, ctx.user);
  for (const kind of ['weather_reminders', 'weather_subscription_pools', 'weather_subscription_grants', 'event_subscriptions', 'event_delivery_receipts']) assert.equal(await ctx.store.count(kind), 0, kind);
});

test('the real native API queues activities but only trusted server timer context reaches the sender', async () => {
  const store = new MemoryStore(), sent = [], config = { appId: 'wx0123456789abcdef', deploymentEnv: 'event-test-env', weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID, state: 'developer' } };
  let now = START; const providers = { sendWeatherReminder: async request => { sent.push(request); return { errCode: 0 }; } };
  const deps = { store, config, providers, now: () => now }, api = createApp(deps), runtime = createRuntime(deps), identity = { APPID: config.appId, OPENID: 'verified-event-api-openid' };
  const login = await api({ method: 'POST', path: '/api/v1/auth/wechat/', body: { code: 'native-fixture' } }, identity);
  const headers = { Authorization: 'Bearer ' + login.data.data.token };
  const call = (path, body) => api({ path: '/api/v1/' + path, method: 'POST', body, headers }, identity);
  const g = (await call('weather-data/reminders/grants/', {})).data.data;
  await call('weather-data/reminders/grants/' + g.id + '/confirm/', { template_id: reminders.TEMPLATE_ID, decision: 'accept' });
  const event = events.catalogue(now).find(row => row.id.startsWith('river-weekend'));
  assert.equal((await call('event-subscriptions/', { event_id: event.id })).statusCode, 200); assert.equal(sent.length, 0);
  now = DUE; const timer = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders' };
  assert.equal((await runtime(timer, identity, { source: 'wx_client', env: config.deploymentEnv })).statusCode, 400); assert.equal(sent.length, 0);
  assert.equal((await runtime(timer, {}, { source: 'wx_trigger', env: config.deploymentEnv })).data.data.sent, 1);
  await runtime(timer, {}, { source: 'wx_trigger', env: config.deploymentEnv }); assert.equal(sent.length, 1);
});
