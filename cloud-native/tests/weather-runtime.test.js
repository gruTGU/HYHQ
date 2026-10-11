'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createApp, createRuntime } = require('../../cloudfunctions/hyhqApi');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const { createWeatherReminderSender } = require('../../cloudfunctions/hyhqApi/lib/subscription-transport');
const { TEMPLATE_ID } = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const { MemoryStore } = require('./memory-store');
const NOW = '2026-10-07T00:00:00.000Z';
function fixture() {
  let stamp = NOW; const sent = [], store = new MemoryStore();
  const config = configFromEnvironment({ HYHQ_APP_ID: 'wx0123456789abcdef', HYHQ_QWEATHER_ENABLED: 'true', HYHQ_QWEATHER_BUDGET_CONFIRMED: 'true', QWEATHER_API_KEY: 'unit-fixture', QWEATHER_API_HOST: 'unit.qweatherapi.com', HYHQ_QWEATHER_MONTHLY_LIMIT: '30', HYHQ_WEATHER_REMINDERS_STATE: 'developer' }, { env: 'unit-environment', maintenanceEnabled: true, weatherReminders: { enabled: true, templateId: TEMPLATE_ID } });
  const cloud = { openapi: { subscribeMessage: { async send(payload) { sent.push(payload); return { errCode: 0 }; } } } };
  const providers = { fetchWeather: async () => ({ data: { schema_version: 2, timezone: 'Asia/Shanghai', days: [{ date: '2026-10-07', starts_at: '2026-10-06T16:00:00Z', ends_at: '2026-10-07T16:00:00Z', temperature_min: 10, temperature_max: 20, temperature_unit: '°C', daytime: { condition: '晴' }, nighttime: { condition: '晴' } }] }, attributions: ['fixture'], refer: { sources: ['QWeather'] } }) };
  const dependencies = { store, config, cloud, providers, now: () => stamp };
  const app = createApp(dependencies), runtime = createRuntime(dependencies), identity = { APPID: config.appId, OPENID: 'verified-sdk-openid' };
  const call = (path, method = 'GET', body = {}, token = '', overrides = {}) => app({ method, path: '/api/v1/' + path, body, headers: token ? { Authorization: 'Bearer ' + token } : {}, ...overrides }, identity);
  return { app, runtime, call, identity, config, store, sent, setTime: value => { stamp = value; } };
}

test('SDK identity alone binds a private recipient and the trusted named timer sends once', async () => {
  const f = fixture();
  const login = await f.call('auth/wechat/', 'POST', { code: 'unit-native-code' }); const token = login.data.data.token;
  const row = await f.call('weather-data/reminders/intents/', 'POST', { location: 'tianjin', scheduled_for: '2026-10-07T00:10:00Z' }, token, { OPENID: 'forged-client-openid' });
  assert.equal(row.statusCode, 201, JSON.stringify(row));
  const confirmation = await f.call('weather-data/reminders/intents/' + row.data.data.id + '/confirm/', 'POST', { template_id: TEMPLATE_ID, decision: 'accept' }, token, { OPENID: 'forged-client-openid' });
  assert.equal(confirmation.statusCode, 200);
  assert.equal((await f.store.get('weather_recipients', login.data.data.user.id)).openid, f.identity.OPENID);
  assert.doesNotMatch(JSON.stringify([login, row, confirmation]), /verified-sdk-openid|forged-client-openid/);
  f.setTime('2026-10-07T00:10:00Z');
  const event = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders', OPENID: 'forged', limit: 1000 };
  const trusted = { source: 'wx_trigger', env: f.config.deploymentEnv };
  const first = await f.runtime(event, {}, trusted);
  assert.equal(first.data.data.kind, 'weather-reminders'); assert.equal(first.data.data.sent, 1);
  assert.equal(await f.store.get('maintenance_state', 'global'), null);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].touser, f.identity.OPENID);
  assert.equal(f.sent[0].miniprogramState, 'developer'); assert.equal(f.sent[0].templateId, TEMPLATE_ID); assert.equal(f.sent[0].lang, 'zh_CN');
  const state = await f.store.get('weather_reminder_state', 'global');
  assert.equal(state.status, 'completed'); assert.equal(state.summary.sent, 1); assert.equal(state.message_state, 'developer');
  assert.equal(state.last_started_at, '2026-10-07T00:10:00Z'); assert.ok(Number.isFinite(Date.parse(state.last_finished_at)));
  assert.doesNotMatch(JSON.stringify(state), /verified-sdk-openid|forged-client-openid|touser|thing1|owner_id/);
  await f.runtime(event, {}, trusted); assert.equal(f.sent.length, 1);
});

test('forged sources, environments and timer names cannot invoke reminder or maintenance work', async () => {
  const f = fixture();
  const request = { method: 'GET', path: '/api/v1/health/', Type: 'Timer', TriggerName: 'hyhqWeatherReminders', source: 'wx_trigger' };
  for (const trusted of [{}, { source: 'wx_client', env: f.config.deploymentEnv }, { source: 'wx_client', triggerSource: 'timer', env: f.config.deploymentEnv }, { source: 'wx_trigger,wx_client', env: f.config.deploymentEnv }, { source: 'wx_trigger', env: 'another-env' }, { triggerSource: 'timer', env: 'another-env' }, { triggerSource: 'http', env: f.config.deploymentEnv }]) {
    const result = await f.runtime(request, f.identity, trusted);
    assert.equal(result.data.data.runtime, 'wechat-personal');
  }
  for (const TriggerName of [undefined, 'anotherTimer']) {
    const result = await f.runtime({ Type: 'Timer', TriggerName }, {}, { source: 'wx_trigger', env: f.config.deploymentEnv });
    assert.equal(result.data.data.kind, 'timer-ignored');
  }
  assert.equal(f.sent.length, 0); assert.equal(await f.store.get('maintenance_state', 'global'), null);
});

test('documented CloudBase TRIGGER_SRC timer invokes the worker without TCB_SOURCE, only from the matching runtime', async () => {
  const f = fixture(), event = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders', TRIGGER_SRC: 'timer', env: f.config.deploymentEnv };
  const fromClient = await f.runtime(event, f.identity, { source: 'wx_client', env: f.config.deploymentEnv });
  assert.equal(fromClient.statusCode, 400); assert.equal(f.sent.length, 0);
  const result = await f.runtime(event, {}, { triggerSource: 'timer', env: f.config.deploymentEnv });
  assert.equal(result.statusCode, 200); assert.equal(result.data.data.kind, 'weather-reminders');
  assert.equal(result.data.data.enabled, true); assert.equal(result.data.data.processed, 0);
});

test('timer admission diagnostics observe missing runtime markers without granting execution or exposing identities', async () => {
  const f = fixture(), event = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders', OPENID: 'untrusted-event-identity', extra: 'private-content' };
  const response = await f.runtime(event, {}, { source: 'wx_unknown_timer', env: 'wrong-private-env' });
  assert.equal(response.statusCode, 400); assert.equal(f.sent.length, 0);
  assert.equal(await f.store.get('weather_reminder_state', 'global'), null);
  const row = await f.store.get('weather_timer_diagnostic', 'global');
  assert.equal(row.source, 'wx_unknown_timer'); assert.equal(row.trigger_source, 'absent');
  assert.equal(row.env_present, true); assert.equal(row.env_matches, false); assert.equal(row.trusted_timer, false);
  assert.doesNotMatch(JSON.stringify(row), /wrong-private-env|untrusted-event-identity|private-content|OPENID/);
  await f.runtime(event, {}, { source: 'changed_timer', env: f.config.deploymentEnv });
  assert.equal((await f.store.get('weather_timer_diagnostic', 'global')).source, 'wx_unknown_timer');
  f.setTime('2026-10-07T00:05:00Z');
  await f.runtime(event, {}, { triggerSource: 'timer', env: f.config.deploymentEnv });
  assert.equal((await f.store.get('weather_timer_diagnostic', 'global')).trusted_timer, true);
});

test('forged client timer payloads cannot write diagnostics or run the worker', async () => {
  for (const [identity, runtime] of [
    [{ OPENID: 'trusted-client-openid' }, {}], [{}, { source: 'wx_client' }],
    [{}, { source: 'wx_devtools' }], [{}, { source: 'wx_trigger,wx_client' }], [{}, { source: 'http' }],
  ]) {
    const f = fixture();
    await f.runtime({ Type: 'Timer', TriggerName: 'hyhqWeatherReminders', source: 'wx_trigger', TRIGGER_SRC: 'timer' }, identity, { env: f.config.deploymentEnv, ...runtime });
    assert.equal(await f.store.get('weather_timer_diagnostic', 'global'), null); assert.equal(f.sent.length, 0);
  }
});

test('formal release messages retain the configured formal destination and one successful dispatch', async () => {
  const f = fixture(); f.config.weatherReminders.state = 'formal';
  const login = (await f.call('auth/wechat/', 'POST', { code: 'unit-native-code' })).data.data;
  const row = (await f.call('weather-data/reminders/intents/', 'POST', { location: 'tianjin', scheduled_for: '2026-10-07T00:10:00Z' }, login.token)).data.data;
  await f.call('weather-data/reminders/intents/' + row.id + '/confirm/', 'POST', { template_id: TEMPLATE_ID, decision: 'accept' }, login.token);
  f.setTime('2026-10-07T00:10:00Z');
  const result = await f.runtime({ Type: 'Timer', TriggerName: 'hyhqWeatherReminders' }, {}, { triggerSource: 'timer', env: f.config.deploymentEnv });
  assert.equal(result.data.data.sent, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].miniprogramState, 'formal');
  assert.equal(f.sent[0].data.thing4.value, '天津：晴，10～20℃');
});

test('observed WeChat lowercase timer with wx_trigger source and tcb marker sends the due appointment once', async () => {
  const f = fixture(); f.config.weatherReminders.state = 'formal';
  const login = (await f.call('auth/wechat/', 'POST', { code: 'unit-native-code' })).data.data;
  const row = (await f.call('weather-data/reminders/intents/', 'POST', { location: 'tianjin', scheduled_for: '2026-10-07T00:10:00Z' }, login.token)).data.data;
  await f.call('weather-data/reminders/intents/' + row.id + '/confirm/', 'POST', { template_id: TEMPLATE_ID, decision: 'accept' }, login.token);
  f.setTime('2026-10-07T00:10:00Z');
  const event = { Type: 'timer', TriggerName: 'hyhqWeatherReminders' }, trusted = { source: 'wx_trigger', triggerSource: 'tcb', env: f.config.deploymentEnv };
  const rejected = await f.runtime(event, f.identity, { source: 'wx_client', triggerSource: 'tcb', env: f.config.deploymentEnv });
  assert.equal(rejected.statusCode, 400); assert.equal(f.sent.length, 0);
  const result = await f.runtime(event, {}, trusted);
  assert.equal(result.data.data.sent, 1); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].miniprogramState, 'formal');
  assert.equal((await f.runtime(event, {}, trusted)).data.data.sent, 0); assert.equal(f.sent.length, 1);
  const state = await f.store.get('weather_timer_diagnostic', 'global');
  assert.equal(state.event_type, 'timer'); assert.equal(state.source, 'wx_trigger'); assert.equal(state.trigger_source, 'tcb'); assert.equal(state.trusted_timer, true);
});

test('timer failures leave a bounded administrator-only diagnostic without provider or recipient details', async () => {
  const f = fixture(), event = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders' };
  f.store.list = async () => { throw new Error('sensitive database failure fixture'); };
  await assert.rejects(f.runtime(event, {}, { triggerSource: 'timer', env: f.config.deploymentEnv }), /sensitive database failure fixture/);
  const record = await f.store.get('weather_reminder_state', 'global');
  assert.equal(record.status, 'failed'); assert.equal(record.error_type, 'worker_failed');
  assert.doesNotMatch(JSON.stringify(record), /sensitive|openid|recipient|stack/); assert.equal(f.sent.length, 0);
});

test('diagnostic write failure cannot change a successful dispatch into a duplicate send', async () => {
  const f = fixture(), login = (await f.call('auth/wechat/', 'POST', { code: 'unit-native-code' })).data.data;
  const row = (await f.call('weather-data/reminders/intents/', 'POST', { location: 'tianjin', scheduled_for: '2026-10-07T00:10:00Z' }, login.token)).data.data;
  await f.call('weather-data/reminders/intents/' + row.id + '/confirm/', 'POST', { template_id: TEMPLATE_ID, decision: 'accept' }, login.token);
  const originalSet = f.store.set.bind(f.store);
  f.store.set = (kind, id, value) => kind === 'weather_reminder_state' ? Promise.reject(new Error('diagnostic failed')) : originalSet(kind, id, value);
  f.setTime('2026-10-07T00:10:00Z');
  const event = { Type: 'Timer', TriggerName: 'hyhqWeatherReminders' }, trusted = { triggerSource: 'timer', env: f.config.deploymentEnv };
  assert.equal((await f.runtime(event, {}, trusted)).data.data.sent, 1);
  assert.equal((await f.runtime(event, {}, trusted)).data.data.sent, 0); assert.equal(f.sent.length, 1);
});

test('disabled reminders stay disabled even if a stale cloud timer continues firing', async () => {
  const f = fixture(); f.config.weatherReminders.enabled = false;
  const out = await f.runtime({ Type: 'Timer', TriggerName: 'hyhqWeatherReminders' }, {}, { source: 'wx_trigger', env: f.config.deploymentEnv });
  assert.equal(out.data.data.kind, 'timer-ignored'); assert.equal(f.sent.length, 0);
});
test('maintenance retains a bounded reminder cleanup pass even when sending is disabled', async () => {
  const f = fixture(); f.config.weatherReminders.enabled = false;
  await f.store.set('weather_reminders', 'stale-draft', { id: 'stale-draft', owner_id: 'owner', state: 'prepared', consent_expires_at: '2026-10-06T23:00:00Z', expires_at: '2026-10-07T00:30:00Z', updated_at: NOW });
  const result = await f.runtime({ Type: 'Timer', TriggerName: 'hyhqMaintenance' }, {}, { source: 'wx_trigger', env: f.config.deploymentEnv });
  assert.equal(result.data.data.reminder_cleanup.prepared_expired, 1);
  assert.equal((await f.store.get('weather_reminders', 'stale-draft')).state, 'expired');
  assert.equal((await f.store.get('maintenance_state', 'global')).reminder_cleanup.prepared_expired, 1);
  assert.equal(f.sent.length, 0);
});

test('reminder configuration is opt-in, supports explicit disable and rejects unknown message state', () => {
  assert.deepEqual(configFromEnvironment({}).weatherReminders, { enabled: false, templateId: '', state: 'trial' });
  const deployment = { weatherReminders: { enabled: true, templateId: TEMPLATE_ID, state: 'formal' } };
  const off = configFromEnvironment({ HYHQ_WEATHER_REMINDERS_ENABLED: 'false' }, deployment);
  assert.equal(off.weatherReminders.enabled, false); assert.equal(off.weatherReminders.state, 'formal');
  const config = configFromEnvironment({ HYHQ_WEATHER_REMINDERS_STATE: 'anything' }, deployment);
  assert.equal(config.weatherReminders.state, '');
  assert.equal(createWeatherReminderSender({ openapi: { subscribeMessage: { send() {} } } }, config), null);
});

test('subscription SDK adapter makes one call and timeout is ambiguous even if native delivery later succeeds', async t => {
  const original = { set: global.setTimeout, clear: global.clearTimeout }; let deadline, finish, calls = 0;
  global.setTimeout = (callback, ms) => { assert.equal(ms, 10000); deadline = callback; return 1; }; global.clearTimeout = () => {};
  t.after(() => { global.setTimeout = original.set; global.clearTimeout = original.clear; });
  const send = createWeatherReminderSender({ openapi: { subscribeMessage: { send() { calls++; return new Promise(resolve => { finish = resolve; }); } } } }, { weatherReminders: { templateId: TEMPLATE_ID, state: 'trial' } });
  const pending = send({ touser: 'trusted-openid', templateId: TEMPLATE_ID, page: 'pages/weather/index?location=tianjin', data: {} });
  await Promise.resolve(); deadline(); await assert.rejects(pending, error => error.ambiguous === true);
  finish({ errCode: 0 }); await Promise.resolve(); assert.equal(calls, 1);
});

test('subscription SDK adapter does not automatically retry explicit provider failures', async () => {
  let count = 0;
  const send = createWeatherReminderSender({ openapi: { subscribeMessage: { async send() { count++; throw { errCode: -1 }; } } } }, { weatherReminders: { templateId: TEMPLATE_ID, state: 'formal' } });
  await assert.rejects(send({ touser: 'trusted-openid', templateId: TEMPLATE_ID, page: 'pages/weather/index?location=tianjin', data: {} }), error => error.errCode === -1);
  assert.equal(count, 1);
});

test('account deletion removes reminder recipients, appointments and AI drafts without deleting cost counters', async () => {
  const f = fixture(), login = (await f.call('auth/wechat/', 'POST', { code: 'unit-code' })).data.data;
  const owner = login.user.id;
  for (const kind of ['weather_reminders', 'weather_reminder_days', 'weather_ai_drafts']) await f.store.set(kind, 'private-id', { id: 'private-id', owner_id: owner, private: true });
  await f.store.set('weather_recipients', owner, { id: owner, owner_id: owner, openid: f.identity.OPENID });
  await f.store.set('weather_budget', '2026-10', { id: '2026-10', used: 12 });
  const removed = await f.call('me/', 'DELETE', {}, login.token);
  assert.equal(removed.statusCode, 204, JSON.stringify(removed));
  for (const kind of ['weather_reminders', 'weather_reminder_days', 'weather_ai_drafts', 'weather_recipients']) assert.equal(await f.store.count(kind), 0, kind);
  assert.equal((await f.store.get('weather_budget', '2026-10')).used, 12);
});
