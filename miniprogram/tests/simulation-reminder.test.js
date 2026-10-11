const test = require('node:test');
const assert = require('node:assert/strict');
const draft = () => ({ id: 'instant-1', mode: 'instant_simulation', state: 'prepared', template_id: 'template', consent_expires_at: new Date(Date.now() + 600000).toISOString() });
function fixture(request, wxExtra = {}) {
  let definition, token = 'user-a';
  global.Component = value => { definition = value; };
  global.getApp = () => ({ session: { token: () => token }, api: { request } });
  global.wx = { ...wxExtra };
  const file = require.resolve('../components/simulation-reminder/index'); delete require.cache[file]; require(file);
  const events = [], instance = { ...definition.methods, data: { ...structuredClone(definition.data), open: false },
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name) { events.push(name); if (name === 'close') this.data.open = false; },
  };
  definition.lifetimes.attached.call(instance); instance.data.open = true;
  return { instance, definition, events, token(value) { token = value; } };
}

test('opening prepares only a fixed simulation intent; one explicit tap asks native subscription synchronously', async () => {
  const calls = []; let callback, asks = 0;
  const f = fixture(async (path, options) => { calls.push({ path, options }); return { data: path.endsWith('/confirm/') ? { state: 'sent' } : draft() }; }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  await f.instance.prepare(); assert.equal(asks, 0); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: 'weather-data/reminders/simulation-intents/', options: { method: 'POST', data: {} } });
  assert.equal(f.instance.data.preview, '模拟异常：浊度偏高，请复核');
  f.instance.authorize(); assert.equal(asks, 1); assert.equal(calls.length, 1);
  await callback({ template: 'accept' }); await callback({ template: 'accept' });
  assert.equal(calls.length, 2); assert.equal(calls[1].path, 'weather-data/reminders/simulation-intents/instant-1/confirm/');
  assert.deepEqual(calls[1].options.data, { template_id: 'template', decision: 'accept' });
  assert.equal(f.instance.data.finished, true); assert.match(f.instance.data.notice, /已发送/); assert.equal(f.instance.data.canRetry, false);
  f.instance.authorize(); assert.equal(asks, 1);
});

test('reject and ban cannot authorize delivery or replenish the daily credit pool', async () => {
  for (const decision of ['reject', 'ban']) {
    const calls = []; let callback;
    const f = fixture(async (path, options) => { calls.push({ path, options }); return { data: path.endsWith('/confirm/') ? { state: 'cancelled' } : draft() }; }, { requestSubscribeMessage(options) { callback = options.success; } });
    await f.instance.prepare(); f.instance.authorize(); await callback({ template: decision });
    assert.equal(calls.length, 2); assert.equal(calls[1].options.data.decision, decision); assert.ok(calls.every(call => !call.path.includes('/grants/')));
    assert.equal(f.instance.data.finished, true); assert.match(f.instance.data.notice, /不会发送/); assert.equal(f.instance._accepted, null);
  }
});

test('uncertain confirmation retries the identical intent without repeating native consent', async () => {
  let callback, asks = 0, confirms = 0; const ids = [];
  const f = fixture(async path => {
    if (!path.endsWith('/confirm/')) return { data: draft() };
    ids.push(path); if (++confirms === 1) throw new Error('网络断开'); return { data: { state: 'sent' } };
  }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  await f.instance.prepare(); f.instance.authorize(); await callback({ template: 'accept' });
  assert.equal(f.instance.data.canRetry, true); f.instance.authorize(); assert.equal(asks, 1);
  await f.instance.retry(); assert.equal(asks, 1); assert.equal(confirms, 2); assert.equal(ids[0], ids[1]); assert.equal(f.instance.data.finished, true);
});

test('ambiguous, rejected-provider and in-progress results never offer a second send under the same consent', async () => {
  for (const state of ['unknown', 'failed', 'sending', 'preparing', 'pending']) {
    let callback, asks = 0;
    const f = fixture(async path => ({ data: path.endsWith('/confirm/') ? { state } : draft() }), { requestSubscribeMessage(options) { asks++; callback = options.success; } });
    await f.instance.prepare(); f.instance.authorize(); await callback({ template: 'accept' });
    assert.equal(f.instance.data.finished, true); assert.equal(f.instance.data.canRetry, false);
    f.instance.authorize(); await f.instance.retry(); assert.equal(asks, 1);
    if (state === 'unknown') assert.match(f.instance.data.notice, /不会重复发送/);
  }
});

test('expired intent cannot trigger a popup until preparation and a separate fresh click', async () => {
  let asks = 0;
  const f = fixture(async () => ({ data: draft() }), { requestSubscribeMessage() { asks++; } });
  await f.instance.prepare(); f.instance.data.intent.consent_expires_at = '2000-01-01T00:00:00Z';
  f.instance.authorize(); assert.equal(asks, 0); assert.equal(f.instance.data.intent, null);
  await f.instance.prepare(); assert.equal(asks, 0); f.instance.authorize(); assert.equal(asks, 1);
});

test('anonymous users see login and no server or native subscription request', async () => {
  const navigations = [];
  const f = fixture(async () => assert.fail('anonymous prepare'), { requestSubscribeMessage() { assert.fail('anonymous consent'); }, switchTab(options) { navigations.push(options.url); } });
  f.token(''); await f.instance.prepare(); f.instance.authorize(); assert.equal(f.instance.data.needsLogin, true);
  f.instance.login(); assert.deepEqual(navigations, ['/pages/profile/index']); assert.equal(f.instance.data.open, false);
});

test('account change before or during consent cannot use another user’s prepared reminder', async () => {
  for (const during of [false, true]) {
    let callback, asks = 0, confirms = 0;
    const f = fixture(async path => { if (path.endsWith('/confirm/')) confirms++; return { data: draft() }; }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
    await f.instance.prepare(); if (during) f.instance.authorize(); f.token('user-b');
    if (during) await callback({ template: 'accept' }); else f.instance.authorize();
    assert.equal(confirms, 0); assert.equal(asks, during ? 1 : 0); assert.equal(f.instance.data.needsLogin, true); assert.equal(f.instance.data.intent, null);
  }
});

test('closing or leaving the page ignores late results and permits a clean later opening', async () => {
  for (const leave of [false, true]) {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.instance.prepare(); if (leave) f.definition.pageLifetimes.hide.call(f.instance); else f.instance.close();
    finish({ data: draft() }); await pending;
    assert.equal(f.instance.data.intent, null); assert.equal(f.instance.data.preparing, false); assert.equal(f.instance.data.open, false);
    f.definition.pageLifetimes.show.call(f.instance); f.instance.data.open = true;
    const next = f.instance.prepare(); finish({ data: draft() }); await next; assert.equal(f.instance.data.intent.id, 'instant-1');
  }
});

test('modal interoperates with real cloud handlers: consent immediately sends one fixed simulation, without weather or daily credits', async () => {
  const { MemoryStore } = require('../../cloud-native/tests/memory-store');
  const { createApp } = require('../../cloudfunctions/hyhqApi');
  const { TEMPLATE_ID } = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
  const store = new MemoryStore(), sent = []; let callback;
  const config = { appId: 'wx0123456789abcdef', sessionSecret: 'unit-only-instant-simulation-secret', weatherReminders: { enabled: true, templateId: TEMPLATE_ID } };
  const cloudApp = createApp({ store, config, providers: { sendWeatherReminder: async payload => { sent.push(payload); return { errCode: 0 }; }, fetchWeather() { assert.fail('instant simulation must not fetch weather'); } } });
  const identity = { APPID: config.appId, OPENID: 'unit_verified_instant_openid' };
  const auth = (await cloudApp({ method: 'POST', path: '/api/v1/auth/wechat/', body: { code: 'unit-sdk-code' } }, identity)).data.data;
  const f = fixture(async (path, options = {}) => {
    const out = await cloudApp({ method: options.method || 'GET', path: '/api/v1/' + path, body: options.data || {}, headers: { Authorization: 'Bearer ' + auth.token } }, identity);
    assert.ok(out.statusCode < 400, JSON.stringify(out)); return { data: out.data.data };
  }, { requestSubscribeMessage(options) { callback = options.success; } });
  f.token(auth.token); await f.instance.prepare(); assert.equal(sent.length, 0);
  f.instance.authorize(); await callback({ [TEMPLATE_ID]: 'accept' }); await callback({ [TEMPLATE_ID]: 'accept' });
  assert.equal(sent.length, 1); assert.equal(sent[0].data.thing4.value, '模拟异常：浊度偏高，请复核');
  assert.equal(sent[0].page, 'pages/home/index'); assert.equal(f.instance.data.finished, true);
  assert.equal(await store.count('weather_requests'), 0); assert.equal(await store.count('weather_subscription_grants'), 0); assert.equal(await store.count('weather_daily_plans'), 0);
});
