'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const weather = require('../../cloudfunctions/hyhqApi/lib/weather');
const { ProviderError } = require('../../cloudfunctions/hyhqApi/lib/providers');
const NOW = '2026-10-07T00:00:00.000Z', SCHEDULE = '2026-10-07T00:10:00.000Z';
const stamp = n => new Date(Date.parse(NOW) + n * 60000).toISOString();
function forecast() { return { data: { schema_version: 2, timezone: 'Asia/Shanghai', days: [{ date: '2026-10-07', starts_at: '2026-10-06T22:00:00.000Z', ends_at: '2026-10-07T22:00:00.000Z', temperature_min: 10, temperature_max: 20, temperature_unit: '°C', daytime: { condition: '晴' }, nighttime: { condition: '晴' } }] }, attributions: ['fixture attribution'], refer: { sources: ['QWeather'] }, observed_at: null }; }
async function context(extra = {}) {
  const ctx = { method: 'GET', path: 'weather-data/reminders/', query: new URLSearchParams(), body: {}, now: NOW, store: new MemoryStore(),
    user: { id: 'owner-1', nickname: '测试用户', is_active: true }, wechatOpenId: 'trusted-fixture-openid',
    config: { qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'test-key-only', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 30, weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } },
    providers: { fetchWeather: async () => forecast(), sendWeatherReminder: async () => ({ errCode: 0 }) }, ...extra };
  if (ctx.user) await ctx.store.set('users', ctx.user.id, ctx.user); return ctx;
}
async function intent(ctx, body = { location: 'tianjin', scheduled_for: SCHEDULE }) { return (await reminders.handle({ ...ctx, method: 'POST', path: 'weather-data/reminders/intents/', body })).data.data; }
async function confirm(ctx, row, decision = 'accept') { return (await reminders.handle({ ...ctx, method: 'POST', path: `weather-data/reminders/intents/${row.id}/confirm/`, body: { template_id: reminders.TEMPLATE_ID, decision } })).data.data; }
async function cancel(ctx, row) { return (await reminders.handle({ ...ctx, method: 'POST', path: `weather-data/reminders/${row.id}/cancel/`, body: {} })).data.data; }
async function booked(ctx) { return confirm(ctx, await intent(ctx)); }
const record = (ctx, row) => ctx.store.get('weather_reminders', row.id);
test('public availability and reminder records never contain recipient identifiers', async () => {
  const ctx = await context(), out = (await reminders.handle(ctx)).data.data;
  assert.equal(out.enabled, true); assert.equal(out.template_id, reminders.TEMPLATE_ID); assert.equal(out.max_ahead_hours, 48);
  const row = await intent(ctx); assert.equal(row.state, 'prepared'); assert.equal(row.can_cancel, true); assert.equal(row.location.name, '天津市');
  assert.equal(await ctx.store.count('weather_recipients'), 0);
  await confirm(ctx, row); const list = (await reminders.handle(ctx)).data.data;
  assert.ok(!JSON.stringify(list).includes(ctx.wechatOpenId)); assert.ok(!JSON.stringify(list).includes('owner_id')); assert.equal(list.items[0].state, 'pending');
  assert.equal((await ctx.store.get('weather_recipients', ctx.user.id)).openid, ctx.wechatOpenId);
});
test('disabled template, anonymous and untrusted recipient contexts cannot create appointments', async () => {
  const ctx = await context();
  for (const config of [{ ...ctx.config, weatherReminders: { enabled: false, templateId: reminders.TEMPLATE_ID } }, { ...ctx.config, weatherReminders: { enabled: true, templateId: 'old-chat-template' } }, { ...ctx.config, qweatherMonthlyLimit: 0 }]) {
    await assert.rejects(intent({ ...ctx, config }), { code: 'SUBSCRIPTIONS_DISABLED' });
  }
  await assert.rejects(intent({ ...ctx, user: null }), { code: 'NOT_AUTHENTICATED' });
  await assert.rejects(intent({ ...ctx, wechatOpenId: undefined }), { code: 'WECHAT_IDENTITY_REQUIRED' });
  await assert.rejects(intent(ctx, { location: 'tianjin', scheduled_for: SCHEDULE, touser: 'attacker' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(intent(ctx, { location: 'tianjin', scheduled_for: SCHEDULE, message: 'arbitrary content' }), { code: 'VALIDATION_ERROR' });
  assert.equal(await ctx.store.count('weather_reminders'), 0);
});
test('allowlisted locations, zoned times and five-minute to forty-eight-hour admission are enforced', async () => {
  const ctx = await context();
  for (const scheduled_for of ['tomorrow morning', '2026-10-07T08:10', stamp(4), stamp(2881), '2026-13-07T00:10:00Z']) await assert.rejects(intent(ctx, { location: 'tianjin', scheduled_for }));
  await assert.rejects(intent(ctx, { location: '39,116', scheduled_for: SCHEDULE }), { code: 'VALIDATION_ERROR' });
  const row = await intent(ctx, { location: 'beijing', scheduled_for: '2026-10-07T08:05:00+08:00' }); assert.equal(row.scheduled_for, stamp(5));
  assert.equal(row.expires_at, stamp(35)); assert.equal(row.consent_expires_at, stamp(5));
});
test('concurrent intent requests reserve one active reminder per owner and Beijing target date', async () => {
  const ctx = await context(), rows = await Promise.all(Array.from({ length: 12 }, () => intent(ctx)));
  assert.equal(new Set(rows.map(x => x.id)).size, 1); assert.equal(await ctx.store.count('weather_reminders'), 1);
  await assert.rejects(intent(ctx, { location: 'beijing', scheduled_for: stamp(15) }), { code: 'WEATHER_REMINDER_EXISTS' });
  const tomorrow = await intent(ctx, { location: 'beijing', scheduled_for: stamp(1440) }); assert.notEqual(tomorrow.id, rows[0].id);
});
test('matching platform consent is mandatory, idempotent and expires without dispatch', async () => {
  const ctx = await context(), row = await intent(ctx);
  await assert.rejects(reminders.handle({ ...ctx, method: 'POST', path: `weather-data/reminders/${row.id}/consent/`, body: { template_id: 'mismatch', acceptance: 'accept' } }), { code: 'VALIDATION_ERROR' });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).processed, 0);
  await assert.rejects(confirm({ ...ctx, now: stamp(10) }, row), { code: 'REMINDER_CONSENT_EXPIRED' });
  assert.equal(((await reminders.handle({ ...ctx, now: stamp(10) })).data.data.items[0]).state, 'expired');
  const newRow = await intent(ctx, { location: 'tianjin', scheduled_for: stamp(20) });
  const response = await reminders.handle({ ...ctx, method: 'POST', path: `weather-data/reminders/${newRow.id}/consent/`, body: { template_id: reminders.TEMPLATE_ID, acceptance: 'accept' } });
  assert.equal(response.data.data.state, 'pending'); assert.equal((await confirm(ctx, newRow)).state, 'pending');
  assert.equal(await ctx.store.count('weather_recipients'), 1);
});
test('reject and ban never produce a pending delivery or recipient record', async () => {
  for (const decision of ['reject', 'ban']) { const ctx = await context(), row = await intent(ctx); assert.equal((await confirm(ctx, row, decision)).state, 'cancelled'); assert.equal(await ctx.store.count('weather_recipients'), 0); }
});
test('ownership gates consent and cancellation; pending can be cancelled idempotently', async () => {
  const ctx = await context(), row = await booked(ctx), stranger = { ...ctx, user: { id: 'other', is_active: true }, wechatOpenId: 'another-trusted-openid' };
  await ctx.store.set('users', 'other', stranger.user);
  await assert.rejects(cancel(stranger, row), { code: 'NOT_FOUND' }); await assert.rejects(confirm(stranger, row), { code: 'NOT_FOUND' });
  assert.equal((await cancel(ctx, row)).state, 'cancelled'); assert.equal((await cancel(ctx, row)).state, 'cancelled');
  assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).processed, 0);
});
test('delivery sends exactly one bounded appointment template using trusted recipient and actual Beijing times', async () => {
  const ctx = await context(); ctx.user.nickname = '用户'.repeat(40); await ctx.store.set('users', ctx.user.id, ctx.user);
  let sent; ctx.providers.sendWeatherReminder = async request => { sent = request; return { errCode: 0 }; };
  const row = await booked(ctx), due = { ...ctx, now: stamp(10) };
  assert.equal((await reminders.runDueReminders(ctx)).processed, 0);
  assert.equal((await reminders.runDueReminders(due)).sent, 1); assert.equal((await record(ctx, row)).state, 'sent');
  assert.equal(sent.touser, ctx.wechatOpenId); assert.equal(sent.templateId, reminders.TEMPLATE_ID); assert.equal(sent.page, 'pages/weather/index?location=tianjin');
  assert.deepEqual(Object.keys(sent.data), ['thing1', 'thing2', 'thing4', 'time26', 'time9']);
  for (const key of ['thing1', 'thing2', 'thing4']) assert.ok(Array.from(sent.data[key].value).length <= 20);
  assert.equal(sent.data.thing4.value, '天津：晴，10～20℃');
  assert.equal(sent.data.time26.value, '2026-10-07 08:10'); assert.equal(sent.data.time9.value, '2026-10-07 08:40');
  assert.equal((await reminders.runDueReminders(due)).processed, 0); assert.equal(await ctx.store.count('weather_requests'), 1);
});
test('reminder text uses the booked city and date forecast, including night conditions and truncated Celsius temperatures', async () => {
  for (const [clock, expected] of [['05:59', '夜间小雨，-2～11℃'], ['06:00', '多云，-2～11℃'], ['19:29', '多云，-2～11℃'], ['19:30', '夜间小雨，-2～11℃']]) {
    const ctx = await context(), scheduled = '2026-10-08T' + clock + ':00+08:00';
    let sent, requestedCity;
    ctx.providers.fetchWeather = async (_config, kind, location) => {
      assert.equal(kind, 'daily'); requestedCity = location.slug;
      const f = forecast();
      f.data.days.push({ ...f.data.days[0], date: '2026-10-08', starts_at: '2026-10-07T16:00:00Z', ends_at: '2026-10-08T16:00:00Z', temperature_min: -2.9, temperature_max: 11.9, daytime: { condition: '多云' }, nighttime: { condition: '小雨' } });
      return f;
    };
    ctx.providers.sendWeatherReminder = async request => { sent = request; return { errCode: 0 }; };
    await confirm(ctx, await intent(ctx, { location: 'beijing', scheduled_for: scheduled }));
    // A delayed timer crossing into the next day/night period still uses the appointment's time.
    assert.equal((await reminders.runDueReminders({ ...ctx, now: new Date(Date.parse(scheduled) + 60000).toISOString() })).sent, 1);
    assert.equal(requestedCity, 'beijing'); assert.equal(sent.data.thing2.value, '北京市天气预约');
    assert.equal(sent.data.thing4.value, '北京：' + expected); assert.equal(sent.page, 'pages/weather/index?location=beijing');
  }
});
test('long forecast descriptions preserve the full temperature range inside the template limit', async () => {
  const ctx = await context(); let sent;
  ctx.providers.fetchWeather = async () => { const f = forecast(); Object.assign(f.data.days[0], { temperature_min: -20.8, temperature_max: 0.9, daytime: { condition: '局部\n地区多云间阴有雷阵雨并伴有短时大风天气' } }); return f; };
  ctx.providers.sendWeatherReminder = async request => { sent = request; return { errCode: 0 }; };
  await booked(ctx); assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).sent, 1);
  assert.equal(Array.from(sent.data.thing4.value).length, 20); assert.match(sent.data.thing4.value, /…，-20～0℃$/);
  assert.doesNotMatch(sent.data.thing4.value, /[\x00-\x1f\x7f]/);
});
test('partial measurements never become zero, Fahrenheit never becomes Celsius, and empty weather defers sending', async () => {
  for (const [overrides, expected] of [
    [{ temperature_min: null }, '晴，最高20℃'],
    [{ temperature_max: null }, '晴，最低10℃'],
    [{ temperature_min: 0, temperature_max: 0 }, '晴，0～0℃'],
    [{ temperature_unit: '°F' }, '晴'],
    [{ temperature_unit: '' }, '晴'],
    [{ temperature_min: 22, temperature_max: 20 }, '晴'],
    [{ daytime: {}, temperature_min: 10, temperature_max: 20 }, '10～20℃'],
    [{ daytime: {}, temperature_min: null, temperature_max: null }, null],
  ]) {
    const ctx = await context(); let sent;
    ctx.providers.fetchWeather = async () => { const f = forecast(); Object.assign(f.data.days[0], overrides); return f; };
    ctx.providers.sendWeatherReminder = async request => { sent = request; return { errCode: 0 }; };
    const row = await booked(ctx), result = await reminders.runDueReminders({ ...ctx, now: stamp(10) });
    if (expected === null) { assert.equal(result.deferred, 1); assert.equal(sent, undefined); assert.equal((await record(ctx, row)).attempts, 0); }
    else { assert.equal(result.sent, 1); assert.equal(sent.data.thing4.value, '天津：' + expected); }
  }
});
test('concurrent timers and two recipients in one city share one daily request and never double-send', async () => {
  const ctx = await context(); let sends = 0, requests = 0;
  ctx.providers.fetchWeather = async () => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return forecast(); };
  ctx.providers.sendWeatherReminder = async () => { sends++; return { errCode: 0 }; };
  const first = await booked(ctx), other = { ...ctx, user: { id: 'other', is_active: true }, wechatOpenId: 'trusted-other-openid' }; await ctx.store.set('users', 'other', other.user); const second = await booked(other);
  await Promise.all(Array.from({ length: 8 }, () => reminders.runDueReminders({ ...ctx, now: stamp(10) })));
  assert.equal(requests, 1); assert.ok(sends >= 1 && sends <= 2);
  // Retry begins five minutes after the actual refresh completion, not the
  // batch's nominal admission timestamp. Allow that measured processing time.
  await reminders.runDueReminders({ ...ctx, now: stamp(16) });
  assert.equal(sends, 2); assert.equal((await record(ctx, first)).state, 'sent'); assert.equal((await record(ctx, second)).state, 'sent');
});
test('cancel during forecast refresh prevents dispatch; cancellation after committed send cannot promise recall', async () => {
  const ctx = await context(), row = await booked(ctx); let ready, release, sends = 0;
  const blocked = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  ctx.providers.fetchWeather = async () => { ready(); await blocked; return forecast(); }; ctx.providers.sendWeatherReminder = async () => { sends++; return { errCode: 0 }; };
  const pending = reminders.runDueReminders({ ...ctx, now: stamp(10) }); await entered; await cancel(ctx, row); release(); await pending;
  assert.equal(sends, 0); assert.equal((await record(ctx, row)).state, 'cancelled');
  const ctx2 = await context(), row2 = await booked(ctx2); let enteredSend, endSend;
  const waitSend = new Promise(resolve => { endSend = resolve; }), sending = new Promise(resolve => { enteredSend = resolve; });
  ctx2.providers.sendWeatherReminder = async () => { enteredSend(); await waitSend; return { errCode: 0 }; };
  const running = reminders.runDueReminders({ ...ctx2, now: stamp(10) }); await sending;
  await assert.rejects(cancel(ctx2, row2), { code: 'REMINDER_ALREADY_SENDING' }); endSend(); await running;
});
test('account deletion during weather refresh removes recipients and cannot resurrect records or dispatch', async () => {
  const ctx = await context(), row = await booked(ctx); let enter, release;
  const waiting = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  ctx.providers.fetchWeather = async () => { enter(); await waiting; return forecast(); }; ctx.providers.sendWeatherReminder = () => assert.fail('deleted account');
  const running = reminders.runDueReminders({ ...ctx, now: stamp(10) }); await entered;
  await ctx.store.update('users', ctx.user.id, { is_active: false, deleting: true }); await reminders.purgeOwnerReminders(ctx, ctx.user.id); release(); await running;
  assert.equal(await record(ctx, row), null); assert.equal(await ctx.store.count('weather_recipients'), 0); assert.equal(await ctx.store.count('weather_reminder_days'), 0);
  await assert.rejects(intent(ctx), { code: 'NOT_AUTHENTICATED' });
});
test('missing target date, old forecasts and exhausted weather budget never claim a successful reminder', async () => {
  for (const variant of ['date', 'budget', 'failure']) {
    const ctx = await context(), row = await booked(ctx); let sends = 0; ctx.providers.sendWeatherReminder = async () => { sends++; return { errCode: 0 }; };
    if (variant === 'date') ctx.providers.fetchWeather = async () => { const f = forecast(); f.data.days[0].date = '2026-10-06'; return f; };
    if (variant === 'budget') await ctx.store.set('weather_gate', 'budget', { id: 'budget', days: { '2026-10-07': 30 }, recent: [] });
    if (variant === 'failure') ctx.providers.fetchWeather = async () => { throw new ProviderError('timeout'); };
    const out = await reminders.runDueReminders({ ...ctx, now: stamp(10) }); assert.equal(out.deferred, 1); assert.equal(sends, 0); assert.equal((await record(ctx, row)).state, 'retry');
    await reminders.runDueReminders({ ...ctx, now: stamp(41) }); assert.equal((await record(ctx, row)).state, 'expired');
  }
});
test('ambiguous transport, missing acknowledgement and late sending leases never auto-resend', async () => {
  for (const outcome of ['throw', 'missing']) {
    const ctx = await context(), row = await booked(ctx); let sends = 0;
    ctx.providers.sendWeatherReminder = async () => { sends++; if (outcome === 'throw') throw new Error('timeout fixture'); return {}; };
    const out = await reminders.runDueReminders({ ...ctx, now: stamp(10) }); assert.equal(out.unknown, 1); assert.equal((await record(ctx, row)).state, 'unknown');
    await reminders.runDueReminders({ ...ctx, now: stamp(15) }); assert.equal(sends, 1);
  }
  const ctx = await context(), row = await booked(ctx); await ctx.store.update('weather_reminders', row.id, { state: 'sending', lease_token: 'lost-claim', lease_until: stamp(11) });
  await reminders.runDueReminders({ ...ctx, now: stamp(12) }); assert.equal((await record(ctx, row)).state, 'unknown'); assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('confirmed transient platform refusals retry once, permanent rejection does not retry', async () => {
  for (const errorCode of [43101, 45009]) {
    const ctx = await context(), row = await booked(ctx); let sends = 0; ctx.providers.sendWeatherReminder = async () => { sends++; return { errCode: errorCode }; };
    await reminders.runDueReminders({ ...ctx, now: stamp(10) }); assert.equal((await record(ctx, row)).state, errorCode === 45009 ? 'retry' : 'failed');
    await reminders.runDueReminders({ ...ctx, now: stamp(16) }); assert.equal(sends, errorCode === 45009 ? 2 : 1); assert.equal((await record(ctx, row)).state, 'failed');
  }
});
test('forged confirmation payload cannot change appointment or recipient and disabled worker does no work', async () => {
  const ctx = await context(), row = await intent(ctx);
  await assert.rejects(reminders.handle({ ...ctx, method: 'POST', path: `weather-data/reminders/${row.id}/consent/`, body: { template_id: reminders.TEMPLATE_ID, acceptance: 'accept', touser: 'attack' } }), { code: 'VALIDATION_ERROR' });
  ctx.config.weatherReminders.enabled = false; assert.deepEqual(await reminders.runDueReminders(ctx), { enabled: false, processed: 0 }); assert.equal((await record(ctx, row)).state, 'prepared');
});
test('abandoned preparing lease is safe to recover while completed dispatch is never recovered as pending', async () => {
  const ctx = await context(), row = await booked(ctx); let sends = 0;
  ctx.providers.sendWeatherReminder = async () => { sends++; return { errCode: 0 }; };
  await ctx.store.update('weather_reminders', row.id, { state: 'preparing', lease_token: 'abandoned', lease_until: stamp(11), weather_attempts: 1 });
  assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).processed, 0);
  assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(12) })).sent, 1); assert.equal(sends, 1);
  assert.equal((await record(ctx, row)).attempts, 1);
});
test('deletion after dispatch cannot retract an accepted message or recreate purged identity data', async () => {
  const ctx = await context(), row = await booked(ctx); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  ctx.providers.sendWeatherReminder = async () => { enter(); await wait; return { errCode: 0 }; };
  const run = reminders.runDueReminders({ ...ctx, now: stamp(10) }); await entered;
  await ctx.store.update('users', ctx.user.id, { is_active: false, deleting: true }); await reminders.purgeOwnerReminders(ctx, ctx.user.id); release(); await run;
  assert.equal(await record(ctx, row), null); assert.equal(await ctx.store.count('weather_recipients'), 0);
});
test('recipient binding lasts only while accepted appointments remain and is deleted after final cancellation or result', async () => {
  const ctx = await context(), first = await booked(ctx), second = await confirm(ctx, await intent(ctx, { location: 'beijing', scheduled_for: stamp(1440) }));
  assert.equal(Object.keys((await ctx.store.get('weather_recipients', ctx.user.id)).pending).length, 2);
  await cancel(ctx, first); assert.deepEqual(Object.keys((await ctx.store.get('weather_recipients', ctx.user.id)).pending), [second.id]);
  await cancel(ctx, second); assert.equal(await ctx.store.get('weather_recipients', ctx.user.id), null);
  for (const mode of ['sent', 'unknown', 'failed', 'expired']) {
    const c = await context(), r = await booked(c);
    c.providers.sendWeatherReminder = async () => mode === 'sent' ? { errCode: 0 } : mode === 'failed' ? { errCode: 43101 } : {};
    await reminders.runDueReminders({ ...c, now: stamp(mode === 'expired' ? 41 : 10) });
    assert.equal((await record(c, r)).state, mode); assert.equal(await c.store.get('weather_recipients', c.user.id), null);
  }
});
test('maintenance expires unaccepted prepared appointments without granting consent or dispatching', async () => {
  const ctx = await context(), row = await intent(ctx); ctx.config.weatherReminders.enabled = false;
  ctx.providers.sendWeatherReminder = () => assert.fail('cleanup cannot send');
  const out = await reminders.cleanupReminders({ ...ctx, now: stamp(11) });
  assert.equal(out.prepared_expired, 1); assert.equal(out.expired, 1); assert.equal(out.processed, 1);
  assert.equal((await record(ctx, row)).state, 'expired'); assert.equal(await ctx.store.count('weather_recipients'), 0); assert.equal(await ctx.store.count('weather_requests'), 0);
});
test('maintenance terminates overdue accepted and uncertain sending appointments even while feature is disabled', async () => {
  for (const sending of [false, true]) {
    const ctx = await context(), row = await booked(ctx); ctx.config.weatherReminders.enabled = false;
    if (sending) await ctx.store.update('weather_reminders', row.id, { state: 'sending', lease_until: stamp(11), lease_token: 'lost-worker' });
    const out = await reminders.cleanupReminders({ ...ctx, now: stamp(41) });
    assert.equal((await record(ctx, row)).state, sending ? 'unknown' : 'expired');
    assert.equal(out[sending ? 'unknown' : 'expired'], 1); assert.equal(await ctx.store.count('weather_recipients'), 0); assert.equal(await ctx.store.count('weather_requests'), 0);
  }
});
test('maintenance retains terminal records for thirty days and daily abuse locks for ninety days', async () => {
  const ctx = await context(), base = await booked(ctx); await cancel(ctx, base);
  const old = new Date(Date.parse(NOW) - 31 * 86400000).toISOString(), recent = new Date(Date.parse(NOW) - 29 * 86400000).toISOString();
  await ctx.store.set('weather_reminders', 'old-terminal', { ...(await record(ctx, base)), id: 'old-terminal', state: 'sent', updated_at: old });
  await ctx.store.set('weather_reminders', 'recent-terminal', { ...(await record(ctx, base)), id: 'recent-terminal', state: 'failed', updated_at: recent });
  for (const [id, age] of [['old-lock', 91], ['recent-lock', 89], ['active-lock', 91]]) await ctx.store.set('weather_reminder_days', id, { id, owner_id: ctx.user.id, target_date: weather.dayOf(Date.parse(NOW) - age * 86400000), reminder_id: id === 'active-lock' ? 'future-active' : 'old-terminal' });
  await ctx.store.set('weather_reminders', 'future-active', { ...(await record(ctx, base)), id: 'future-active', state: 'pending', updated_at: NOW, expires_at: stamp(1440) });
  const out = await reminders.cleanupReminders(ctx);
  assert.equal(out.reminders_removed, 1); assert.equal(out.day_locks_removed, 1);
  assert.equal(await ctx.store.get('weather_reminders', 'old-terminal'), null); assert.ok(await ctx.store.get('weather_reminders', 'recent-terminal'));
  assert.equal(await ctx.store.get('weather_reminder_days', 'old-lock'), null); assert.ok(await ctx.store.get('weather_reminder_days', 'recent-lock')); assert.ok(await ctx.store.get('weather_reminder_days', 'active-lock'));
});
test('cleanup batches respect mutation limits and stop safely when maintenance budget expires', async () => {
  const ctx = await context(), row = await intent(ctx), stored = await record(ctx, row);
  for (let i = 0; i < 8; i++) await ctx.store.set('weather_reminders', 'old-intent-' + i, { ...stored, id: 'old-intent-' + i });
  const late = { ...ctx, now: stamp(11) };
  const none = await reminders.cleanupReminders(late, { limit: 3, alive: () => false }); assert.equal(none.processed, 0);
  const limited = await reminders.cleanupReminders(late, { limit: 3 }); assert.ok(limited.processed <= 3); assert.ok(limited.prepared_expired > 0);
  assert.ok(await ctx.store.count('weather_reminders', { state: 'prepared' }) > 0);
  for (let i = 0; i < 8; i++) await reminders.cleanupReminders(late, { limit: 3 });
  assert.equal(await ctx.store.count('weather_reminders', { state: 'prepared' }), 0); assert.equal(await ctx.store.count('weather_recipients'), 0);
});
test('weather refresh uses live batch time and expired appointments cannot send after a slow provider', async t => {
  const ctx = await context(), row = await booked(ctx); let elapsed = 0;
  t.mock.method(Date, 'now', () => 1791331800000 + elapsed);
  ctx.providers.fetchWeather = async () => { elapsed = 31 * 60000; return forecast(); };
  ctx.providers.sendWeatherReminder = () => assert.fail('appointment expired during provider call');
  await reminders.runDueReminders({ ...ctx, now: stamp(10) });
  assert.notEqual((await record(ctx, row)).state, 'sent'); assert.equal(await ctx.store.count('weather_recipients'), 0);
});


test('ecology simulation uses the same fixed journal sample on both ends and bounded explicit template text', async () => {
  const simulation = require('../../cloudfunctions/hyhqApi/lib/ecology-simulation');
  const client = require('../../miniprogram/lib/weather-forecast');
  for (const [scenario, count] of [['steady', 0], ['rain', 1], ['heat', 2], ['check', 3]]) {
    const sample = simulation.preview(scenario); assert.deepEqual(sample, client.simulationPreview(scenario));
    assert.equal(sample.alert_count, count); assert.equal(sample.source_type, 'simulation');
    assert.match(sample.sample_label, /固定15:00/); assert.match(sample.rule_notice, /不是水质标准/);
    const ctx = await context(); let sent;
    ctx.config.qweatherEnabled = false; ctx.config.qweatherApiKey = ''; ctx.config.qweatherMonthlyLimit = 0;
    ctx.providers.fetchWeather = () => assert.fail('simulation cannot request QWeather');
    ctx.providers.sendWeatherReminder = async request => { sent = request; return { errCode: 0 }; };
    const status = (await reminders.handle(ctx)).data.data;
    assert.equal(status.enabled, false); assert.equal(status.simulation_enabled, true); assert.equal(status.template_id, reminders.TEMPLATE_ID);
    const row = await intent(ctx, { type: 'ecology_simulation', scenario, scheduled_for: SCHEDULE });
    assert.equal(row.location_name, simulation.CAMPUS); assert.equal(row.type, 'ecology_simulation'); assert.equal(row.scenario, scenario);
    assert.deepEqual(row.simulation_preview, sample); assert.equal(row.state, 'prepared');
    assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).sent, 0);
    await confirm(ctx, row); assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).sent, 1);
    assert.equal(sent.data.thing2.value, '生态模拟提醒'); assert.equal(sent.data.thing4.value, sample.reminder_text);
    for (const [field, value] of Object.entries(sent.data)) if (field.startsWith('thing')) assert.ok([...value.value].length <= 20, value.value);
    assert.match(sent.data.thing4.value, /模拟/); assert.equal(sent.page, 'pages/weather/index?type=ecology_simulation&scenario=' + scenario);
    assert.equal(await ctx.store.count('weather_requests'), 0); assert.equal(await ctx.store.count('weather_gate'), 0);
    assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(15) })).sent, 0);
  }
});

test('weather and simulation reserve independent day slots while scenario changes cannot reuse an accepted intent', async () => {
  const ctx = await context(), weatherRow = await intent(ctx);
  const body = { type: 'ecology_simulation', scenario: 'rain', location: 'tianjin', scheduled_for: SCHEDULE };
  const rows = await Promise.all(Array.from({ length: 8 }, () => intent(ctx, body)));
  assert.equal(new Set(rows.map(row => row.id)).size, 1); assert.notEqual(rows[0].id, weatherRow.id);
  assert.equal(await ctx.store.count('weather_reminder_days'), 2);
  await confirm(ctx, rows[0]);
  await assert.rejects(intent(ctx, { ...body, scenario: 'heat' }), { code: 'WEATHER_REMINDER_EXISTS' });
  await cancel(ctx, rows[0]); const edited = await intent(ctx, { ...body, scenario: 'heat' });
  assert.notEqual(edited.id, rows[0].id); assert.equal(edited.state, 'prepared');
  assert.equal((await record(ctx, weatherRow)).state, 'prepared');
});

test('simulation request accepts no user metrics, thresholds, source claims or non-string scenarios', async () => {
  const ctx = await context(), base = { type: 'ecology_simulation', scenario: 'rain', scheduled_for: SCHEDULE };
  for (const patch of [{ scenario: 'unknown' }, { scenario: ['rain'] }, { scenario: { toString: () => 'rain' } }, { scenario: '__proto__' }, { type: 'live_ecology' }, { metrics: { ph: 1 } }, { thresholds: { ph: 0 } }, { source_type: 'live' }, { message: '实测污染' }]) {
    await assert.rejects(intent(ctx, { ...base, ...patch }), { code: 'VALIDATION_ERROR' });
  }
  await assert.rejects(intent(ctx, { location: 'tianjin', scheduled_for: SCHEDULE, scenario: 'rain' }), { code: 'VALIDATION_ERROR' });
  assert.equal(await ctx.store.count('weather_reminders'), 0); assert.equal(await ctx.store.count('weather_recipients'), 0);
});

test('simulated delivery keeps ownership, refusal, cancellation and ambiguous-send protections', async () => {
  const ctx = await context(), body = { type: 'ecology_simulation', scenario: 'check', scheduled_for: SCHEDULE };
  ctx.providers.fetchWeather = () => assert.fail('simulation cannot request weather');
  let sent = 0; ctx.providers.sendWeatherReminder = async () => { sent++; throw new Error('uncertain delivery'); };
  const row = await intent(ctx, body), stranger = { ...ctx, user: { id: 'stranger', is_active: true } };
  await ctx.store.set('users', 'stranger', stranger.user);
  await assert.rejects(cancel(stranger, row), { code: 'NOT_FOUND' }); await assert.rejects(confirm(stranger, row), { code: 'NOT_FOUND' });
  await confirm(ctx, row); assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).unknown, 1);
  await reminders.runDueReminders({ ...ctx, now: stamp(15) }); assert.equal(sent, 1); assert.equal((await record(ctx, row)).state, 'unknown');
  assert.equal(await ctx.store.count('weather_requests'), 0);
  const ctx2 = await context(), rejected = await intent(ctx2, body); await confirm(ctx2, rejected, 'reject');
  ctx2.providers.sendWeatherReminder = () => assert.fail('rejected consent cannot send');
  assert.equal((await reminders.runDueReminders({ ...ctx2, now: stamp(10) })).sent, 0);
});

test('legacy weather rows without type remain weather and retain their original day lock', async () => {
  const ctx = await context(), row = await intent(ctx), stored = await record(ctx, row);
  delete stored.type; delete stored.scenario; await ctx.store.set('weather_reminders', row.id, stored);
  assert.equal((await intent(ctx)).id, row.id); assert.equal((await reminders.handle(ctx)).data.data.items[0].type, 'weather');
  await confirm(ctx, row); assert.equal((await reminders.runDueReminders({ ...ctx, now: stamp(10) })).sent, 1);
  assert.equal(await ctx.store.count('weather_requests'), 1);
});
