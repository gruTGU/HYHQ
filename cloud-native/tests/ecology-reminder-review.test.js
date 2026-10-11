'use strict';
// Isolated contract tests: no real WeChat consent, SDK, provider or cloud store.
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const simulation = require('../../cloudfunctions/hyhqApi/lib/ecology-simulation');
const { SCENARIOS, METRICS } = require('../../miniprogram/lib/simulation-journal');
const NOW = '2026-12-31T15:50:00.000Z';
const AT = '2026-12-31T16:05:00.000Z';
async function fixture() {
  const sent = [], store = new MemoryStore(), user = { id: 'review-owner', nickname: '🌿'.repeat(40), is_active: true };
  await store.set('users', user.id, user);
  return { sent, ctx: { store, user, wechatOpenId: 'review-fixture-openid', now: NOW, query: new URLSearchParams(),
    config: { qweatherEnabled: false, qweatherMonthlyLimit: 0, weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } },
    providers: { fetchWeather: async () => { throw new Error('simulation must never fetch weather'); }, sendWeatherReminder: async request => { sent.push(request); return { errCode: 0 }; } } } };
}
const call = (ctx, path, body) => reminders.handle({ ...ctx, path: 'weather-data/reminders/' + path, method: 'POST', body });
const body = (scenario = 'check', scheduled_for = AT) => ({ type: 'ecology_simulation', scenario, scheduled_for });
const prepare = async (ctx, input = body()) => (await call(ctx, 'intents/', input)).data.data;
const accept = async (ctx, row) => (await call(ctx, `intents/${row.id}/confirm/`, { template_id: reminders.TEMPLATE_ID, decision: 'accept' })).data.data;

test('simulation notification samples agree with the visible journal and never accept coercible scenario aliases', () => {
  for (const scenario of SCENARIOS) {
    const preview = simulation.preview(scenario.id);
    assert.equal(preview.source_type, 'simulation'); assert.equal(preview.campus, '海晏河清示范校园');
    assert.match(preview.sample_label, /15:00/); assert.match(preview.rule_notice, /不是水质标准/);
    assert.deepEqual(preview.metrics.map(item => item.value), METRICS.map(metric => scenario.series[metric.id][3]));
    assert.match(preview.reminder_text, /^模拟/); assert.ok(Array.from(preview.reminder_text).length <= 20);
  }
  for (const invalid of [undefined, null, ['rain'], {}, 1, true, 'constructor', '__proto__', 'RAIN', 'rain ']) assert.equal(simulation.preview(invalid), null);
  assert.deepEqual(['steady', 'rain', 'heat', 'check'].map(key => simulation.preview(key).alert_count), [0, 1, 2, 3]);
});

test('strict simulation input rejects injected readings, thresholds, recipients and non-string scenarios', async () => {
  const { ctx } = await fixture();
  for (const input of [
    body(['rain']), body('constructor'), { ...body(), source_type: 'real' },
    { ...body(), temperature: 99 }, { ...body(), threshold: 0 }, { ...body(), metrics: [] },
    { ...body(), touser: 'different-person' }, { ...body(), owner_id: 'different-person' },
    { ...body(), type: 'weather', location: 'tianjin' },
  ]) await assert.rejects(prepare(ctx, input), { code: 'VALIDATION_ERROR' });
  assert.equal(await ctx.store.count('weather_reminders'), 0); assert.equal(await ctx.store.count('weather_requests'), 0);
});

test('a simulated appointment without provider configuration needs consent and sends exactly one bounded mock template', async () => {
  const { ctx, sent } = await fixture();
  const prepared = await prepare(ctx);
  assert.equal(prepared.type, 'ecology_simulation'); assert.equal(prepared.location_name, '海晏河清示范校园');
  assert.equal(prepared.target_date, '2027-01-01');
  await reminders.runDueReminders({ ...ctx, now: AT }); assert.equal(sent.length, 0);
  // This is an isolated protocol fixture, not a user or platform authorization.
  await accept(ctx, prepared);
  const results = await Promise.all([reminders.runDueReminders({ ...ctx, now: AT }), reminders.runDueReminders({ ...ctx, now: AT })]);
  assert.equal(results.reduce((n, result) => n + result.sent, 0), 1); assert.equal(sent.length, 1);
  assert.match(sent[0].page, /^pages\/weather\/index\?type=ecology_simulation&scenario=check$/);
  assert.equal(sent[0].data.thing2.value, '生态模拟提醒'); assert.match(sent[0].data.thing4.value, /^模拟/);
  for (const key of ['thing1', 'thing2', 'thing4']) assert.ok(Array.from(sent[0].data[key].value).length <= 20);
  assert.equal(sent[0].data.time26.value, '2027-01-01 00:05');
  assert.equal(await ctx.store.count('weather_requests'), 0); assert.equal(await ctx.store.count('weather_cache'), 0);
});

test('simulated appointments bind authorization and cancellation to their owner, including year-boundary day locks', async () => {
  const { ctx, sent } = await fixture();
  const first = await prepare(ctx, body('steady', '2026-12-31T15:59:00.000Z'));
  const nextDay = await prepare(ctx, body('rain'));
  assert.notEqual(first.id, nextDay.id); assert.equal(first.target_date, '2026-12-31'); assert.equal(nextDay.target_date, '2027-01-01');
  const otherUser = { id: 'review-other', is_active: true }; await ctx.store.set('users', otherUser.id, otherUser);
  const other = { ...ctx, user: otherUser, wechatOpenId: 'other-fixture-openid' };
  await assert.rejects(accept(other, nextDay), { code: 'NOT_FOUND' });
  await assert.rejects(call(other, `${nextDay.id}/cancel/`, {}), { code: 'NOT_FOUND' });
  const list = await reminders.handle({ ...other, method: 'GET', path: 'weather-data/reminders/' }); assert.deepEqual(list.data.data.items, []);
  await accept(ctx, first); await accept(ctx, nextDay);
  await call(ctx, `${first.id}/cancel/`, {});
  await reminders.runDueReminders({ ...ctx, now: AT }); assert.equal(sent.length, 1); assert.match(sent[0].page, /scenario=rain$/);
  assert.equal(await ctx.store.count('weather_requests'), 0);
});

test('an ambiguous mock WeChat result must not consume another consent or resend a simulated message', async () => {
  const { ctx } = await fixture(); let attempts = 0;
  ctx.providers.sendWeatherReminder = async () => { attempts++; throw new Error('unknown transport outcome'); };
  const prepared = await prepare(ctx); await accept(ctx, prepared);
  const result = await reminders.runDueReminders({ ...ctx, now: AT }); assert.equal(result.unknown, 1);
  await reminders.runDueReminders({ ...ctx, now: '2026-12-31T16:10:00.000Z' });
  assert.equal(attempts, 1); assert.equal((await ctx.store.get('weather_reminders', prepared.id)).state, 'unknown');
  assert.equal(await ctx.store.count('weather_requests'), 0);
});
