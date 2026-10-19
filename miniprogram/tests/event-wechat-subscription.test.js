const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { scheduleLabel, poolView } = require('../lib/event-subscriptions');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const NOW = '2030-10-19T00:00:00.000Z';
const EVENT = { id: 'demo-2030-10-20', title: '公园秋日观察 · 模拟', location_name: '公园', starts_at: '2030-10-20T01:00:00Z', ends_at: '2030-10-20T04:00:00Z', map_reference_id: 'reference-park-079' };
const GRANT = { id: 'one-grant', state: 'prepared', template_id: 'shared-template', expires_at: '2030-10-19T00:10:00Z' };
const REMINDER = { id: 'one-reminder', state: 'pending', scheduled_for: '2030-10-19T12:00:00Z' };
const click = id => ({ currentTarget: { dataset: { id } } });
function fixture({ remaining = 0, items = [], handler, guest = false, enabled = true, wechat = true } = {}) {
  const store = new Map(), calls = [], natives = [];
  const session = createSession({ getStorageSync: k => store.get(k), setStorageSync: (k, v) => store.set(k, v), removeStorageSync: k => store.delete(k) });
  if (!guest) session.save({ token: 'account-a', user: { id: 'a' } });
  const application = { session, globalData: {}, api: { async request(path, options) {
    calls.push({ path, options });
    if (handler) { const result = await handler(path, options); if (result !== undefined) return result; }
    if (path === 'events/') return { data: { items: [EVENT], server_time: NOW } };
    if (path === 'event-notifications/') return { data: { enabled: false } };
    if (path === 'event-subscriptions/' && !(options && options.method === 'POST')) return { data: { items, reminder: { enabled, wechat_login: wechat, template_id: GRANT.template_id }, subscription_pool: { remaining } } };
    if (path === 'event-subscriptions/') return { data: { event_id: EVENT.id, reminder: REMINDER, subscription_pool: { remaining: 0, reserved: 1 } } };
    if (path === 'weather-data/reminders/grants/') return { data: GRANT };
    if (path.endsWith('/confirm/')) return { data: { state: 'accepted', subscription_pool: { remaining: 1 } } };
    return { data: {} };
  } } };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, requestSubscribeMessage(options) { natives.push(options); }, switchTab() {} };
  let definition; global.Page = value => { definition = value; };
  const file = require.resolve('../pages/events/index'); delete require.cache[file]; require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad({});
  return { page, calls, natives, application, posts: path => calls.filter(c => c.path === path && c.options && c.options.method === 'POST') };
}
async function open(f) { await f.page.onShow(); await f.page.subscribe(click(EVENT.id)); }

test('activity schedule uses previous China day at 20:00, including month boundary and late subscription', () => {
  assert.match(scheduleLabel(EVENT, null, Date.parse(NOW)), /2030-10-19 20:00 北京时间/);
  assert.match(scheduleLabel({ ...EVENT, starts_at: '2030-10-31T16:30:00Z', ends_at: '2030-11-01T04:00:00Z' }, null, Date.parse(NOW)), /2030-10-31 20:00/);
  assert.equal(scheduleLabel(EVENT, null, Date.parse('2030-10-19T12:01:00Z')), '尽快发送一次（预计5分钟内）');
  assert.equal(scheduleLabel(EVENT, null, Date.parse(EVENT.ends_at)), '活动已结束');
  assert.deepEqual(poolView({ remaining: -2, reserved: '5', held: 1 }), { remaining: 0, reserved: 0, held: 1, needs_resubscribe: false });
});

test('opening a legacy subscription does not auto-upgrade or invoke native permission; explicit confirm reserves once', async () => {
  const f = fixture({ remaining: 2, items: [{ event_id: EVENT.id, event: EVENT, reminder: null }] });
  await open(f); assert.equal(f.page.data.items[0].subscribed, true); assert.equal(f.page.data.dialogOpen, true);
  assert.equal(f.natives.length, 0); assert.equal(f.posts('event-subscriptions/').length, 0);
  await Promise.all([f.page.confirmBooking(), f.page.confirmBooking()]);
  assert.equal(f.posts('event-subscriptions/').length, 1); assert.equal(f.page.data.dialogFinished, true); assert.equal(f.page.data.items[0].reminder.id, REMINDER.id);
  await f.page.confirmBooking(); assert.equal(f.posts('event-subscriptions/').length, 1);
});

test('+1 is prepared before permission and only the button tap synchronously requests native consent', async () => {
  const f = fixture(); await open(f);
  assert.equal(f.natives.length, 0); assert.equal(f.posts('weather-data/reminders/grants/').length, 1);
  f.page.addSubscriptionCredit(); assert.equal(f.natives.length, 1);
  f.page.addSubscriptionCredit(); assert.equal(f.natives.length, 1);
  await Promise.all([f.natives[0].success({ [GRANT.template_id]: 'accept' }), f.natives[0].success({ [GRANT.template_id]: 'accept' })]);
  assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 1);
  assert.equal(f.posts('event-subscriptions/').length, 1); assert.equal(f.page.data.dialogFinished, true);
  assert.deepEqual(f.posts('weather-data/reminders/grants/one-grant/confirm/')[0].options.data, { template_id: GRANT.template_id, decision: 'accept' });
});

for (const decision of ['reject', 'ban', 'unknown']) test(decision + ' cannot add credit or reserve an activity', async () => {
  const f = fixture(); await open(f); f.page.addSubscriptionCredit(); await f.natives[0].success({ [GRANT.template_id]: decision });
  assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 0); assert.equal(f.posts('event-subscriptions/').length, 0);
  assert.equal(f.page.data.busy, false); assert.match(f.page.data.dialogNotice, /未增加/);
});

test('accepted consent with failed save retries the same grant without another permission request, even after dialog close', async () => {
  let fails = true;
  const f = fixture({ handler: (path) => { if (path.endsWith('/confirm/') && fails) throw new Error('网络中断'); } });
  await open(f); f.page.addSubscriptionCredit(); await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  assert.equal(f.page.data.canRetryGrant, true); assert.equal(f.posts('event-subscriptions/').length, 0);
  f.page.closeDialog(); await f.page.load(); assert.equal(f.posts('weather-data/reminders/grants/').length, 1);
  f.page.resumeDialog(); fails = false;
  await Promise.all([f.page.retrySubscriptionCredit(), f.page.retrySubscriptionCredit()]);
  assert.equal(f.natives.length, 1); assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 2); assert.equal(f.posts('event-subscriptions/').length, 1);
});

test('an accepted callback while hidden waits until visible and reuses the same grant', async () => {
  const f = fixture(); await open(f); f.page.addSubscriptionCredit(); f.page.onHide();
  await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 0); assert.equal(f.page.data.dialogOpen, false);
  await f.page.onShow(); assert.equal(f.natives.length, 1); assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 1); assert.equal(f.page.data.dialogFinished, true);
});

test('save response while hidden is reconciled by idempotent same-grant confirmation on return', async () => {
  const delayed = deferred(); let first = true;
  const f = fixture({ handler: path => { if (path.endsWith('/confirm/') && first) { first = false; return delayed.promise; } } });
  await open(f); f.page.addSubscriptionCredit(); const saving = f.natives[0].success({ [GRANT.template_id]: 'accept' }); await tick();
  f.page.onHide(); delayed.resolve({ data: { state: 'accepted', subscription_pool: { remaining: 1 } } }); await saving;
  assert.equal(f.posts('event-subscriptions/').length, 0);
  await f.page.onShow(); assert.equal(f.natives.length, 1); assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 2); assert.equal(f.posts('event-subscriptions/').length, 1);
});

test('account switch or unload invalidates native authorization callbacks', async () => {
  for (const action of ['account', 'unload']) {
    const f = fixture(); await open(f); f.page.addSubscriptionCredit();
    if (action === 'account') f.application.session.save({ token: 'account-b', user: { id: 'b' } }); else f.page.onUnload();
    await f.natives[0].success({ [GRANT.template_id]: 'accept' });
    assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 0); assert.equal(f.posts('event-subscriptions/').length, 0); assert.equal(f.page.data.subscriptionPool.remaining, 0);
  }
});

test('expired prepared permission needs preparation and another user tap; no async native request', async () => {
  const f = fixture(); await open(f); f.page.setData({ grantIntent: { ...GRANT, expires_at: NOW } });
  await f.page.addSubscriptionCredit(); assert.equal(f.natives.length, 0); assert.equal(f.posts('weather-data/reminders/grants/').length, 2);
  f.page.addSubscriptionCredit(); assert.equal(f.natives.length, 1);
});

test('a credit race returns to explicit +1, while uncertain booking retries only the same event', async () => {
  let failures = 1;
  const f = fixture({ remaining: 1, handler: (p, o) => { if (p === 'event-subscriptions/' && o && o.method === 'POST' && failures-- > 0) throw Object.assign(new Error('额度不足'), { code: 'SUBSCRIPTION_CREDIT_REQUIRED' }); } });
  await open(f); await f.page.confirmBooking(); assert.equal(f.page.data.needsCredit, true); assert.equal(f.natives.length, 0); assert.equal(f.posts('weather-data/reminders/grants/').length, 1);
  f.page.addSubscriptionCredit(); await f.natives[0].success({ [GRANT.template_id]: 'accept' }); assert.equal(f.page.data.dialogFinished, true);
  let first = true;
  const retry = fixture({ remaining: 1, handler: (p, o) => { if (p === 'event-subscriptions/' && o && o.method === 'POST' && first) { first = false; throw new Error('网络超时'); } } });
  await open(retry); await retry.page.confirmBooking(); assert.equal(retry.page.data.canRetryBooking, true); await retry.page.confirmBooking();
  assert.equal(retry.natives.length, 0); assert.equal(retry.posts('event-subscriptions/').length, 2); assert.equal(retry.page.data.dialogFinished, true);
});

test('guests, disabled service and non-WeChat sessions cannot request consent or book', async () => {
  for (const options of [{ guest: true }, { enabled: false }, { wechat: false }]) {
    const f = fixture(options); await open(f); f.page.addSubscriptionCredit(); await f.page.confirmBooking();
    assert.equal(f.natives.length, 0); assert.equal(f.posts('event-subscriptions/').length, 0); assert.equal(f.posts('weather-data/reminders/grants/').length, 0);
  }
});

test('already scheduled, sent or unknown reminders cannot trigger another booking', async () => {
  for (const state of ['pending', 'sent', 'unknown']) {
    const f = fixture({ remaining: 2, items: [{ event_id: EVENT.id, event: EVENT, reminder: { ...REMINDER, state } }] });
    await open(f); assert.equal(f.page.data.dialogOpen, false); await f.page.confirmBooking(); assert.equal(f.posts('event-subscriptions/').length, 0);
  }
});


test('expired accepted grants can be replaced only with a fresh explicit +1 click', async () => {
  for (const code of ['REMINDER_CONSENT_EXPIRED', 'NOT_FOUND']) {
    const f = fixture({ handler: path => { if (path.endsWith('/confirm/')) throw Object.assign(new Error('确认失效'), { code }); } });
    await open(f); f.page.addSubscriptionCredit(); f.page.onHide();
    await f.natives[0].success({ [GRANT.template_id]: 'accept' }); await f.page.onShow();
    assert.equal(f.page.data.canRetryGrant, false); assert.equal(f.page._grantAccepted, null); assert.equal(f.page.data.grantIntent, null);
    assert.equal(f.natives.length, 1); assert.equal(f.posts('event-subscriptions/').length, 0);
    await f.page.prepareSubscriptionGrant(); assert.equal(f.natives.length, 1);
    f.page.addSubscriptionCredit(); assert.equal(f.natives.length, 2);
  }
});

test('balance +1 is a direct user gesture, adds only shared credit and never books an event', async () => {
  const f = fixture(); await f.page.onShow();
  assert.equal(f.natives.length, 0);
  f.page.addPoolCredit(); f.page.addPoolCredit(); assert.equal(f.natives.length, 1);
  await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  assert.equal(f.page.data.subscriptionPool.remaining, 1);
  assert.equal(f.posts('event-subscriptions/').length, 0);
  assert.equal(f.page.data.dialogOpen, false);
  assert.match(f.page.data.poolNotice, /已 \+1/);
});

test('balance +1 denied or failed does not confirm credit and can be explicitly retried', async () => {
  for (const failure of ['reject', 'fail']) {
    const f = fixture(); await f.page.onShow(); f.page.addPoolCredit();
    if (failure === 'fail') f.natives[0].fail(); else await f.natives[0].success({ [GRANT.template_id]: 'reject' });
    assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 0);
    assert.equal(f.posts('event-subscriptions/').length, 0);
    assert.equal(f.page.data.busy, false);
    f.page.addPoolCredit(); assert.equal(f.natives.length, 2);
  }
});

test('balance grant survives hiding, resumes only its own save and never leaks into activity booking', async () => {
  const f = fixture(); await f.page.onShow(); f.page.addPoolCredit(); f.page.onHide();
  await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  await f.page.onShow();
  assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 1);
  assert.equal(f.posts('event-subscriptions/').length, 0); assert.equal(f.page.data.dialogOpen, false);
  assert.equal(f.page.data.subscriptionPool.remaining, 1);
});

test('failed balance save retries the same grant; selecting an activity cannot change its purpose', async () => {
  let fail = true;
  const f = fixture({ handler: path => { if (path.endsWith('/confirm/') && fail) throw new Error('网络中断'); } });
  await f.page.onShow(); f.page.addPoolCredit(); await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  assert.equal(f.page.data.canRetryGrant, true);
  await f.page.subscribe(click(EVENT.id)); assert.equal(f.page.data.dialogOpen, false);
  fail = false; await f.page.retrySubscriptionCredit();
  assert.equal(f.natives.length, 1); assert.equal(f.posts('event-subscriptions/').length, 0);
  assert.equal(f.page.data.subscriptionPool.remaining, 1);
});

test('switching accounts invalidates a balance permission callback', async () => {
  const f = fixture(); await f.page.onShow(); f.page.addPoolCredit();
  f.application.session.save({ token: 'account-b', user: { id: 'b' } });
  await f.natives[0].success({ [GRANT.template_id]: 'accept' });
  assert.equal(f.posts('weather-data/reminders/grants/one-grant/confirm/').length, 0);
  assert.equal(f.posts('event-subscriptions/').length, 0);
});

test('calendar day and month filters retain the same event IDs and subscription state', async () => {
  const f = fixture({ remaining: 1 }); await f.page.onShow();
  assert.equal(f.page.data.calendarTitle, '2030年10月');
  f.page.calendarDay({ currentTarget: { dataset: { date: '2030-10-21' } } });
  assert.equal(f.page.data.visibleItems.length, 0);
  f.page.calendarDay({ currentTarget: { dataset: { date: '2030-10-20' } } });
  assert.equal(f.page.data.visibleItems[0].id, EVENT.id);
  await f.page.subscribe(click(EVENT.id)); await f.page.confirmBooking();
  assert.equal(f.page.data.visibleItems[0].reminder.id, REMINDER.id);
});
