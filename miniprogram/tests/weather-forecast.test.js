const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastView, localDate } = require('../lib/weather-forecast');
const locations = [{ slug: 'beijing', name: '北京' }, { slug: 'tianjin', name: '天津' }];
const intent = { id: 'intent-1', location: 'beijing', location_name: '北京', state: 'prepared', template_id: 'template', can_cancel: true };
function harness(request, overrides = {}) {
  let definition, token = 'user-a';
  const application = { globalData: {}, session: { token: () => token }, api: { request } };
  global.Page = (value) => { definition = value; };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, ...overrides };
  delete require.cache[require.resolve('../pages/weather/index')];
  require('../pages/weather/index');
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = (patch) => Object.assign(page.data, patch);
  page.onLoad({ location: 'beijing' }); page._version = 1; page._token = token;
  return { page, application, token(value) { token = value; } };
}
function enable(page) { Object.assign(page.data, { subscriptionEnabled: true, loggedIn: true, wechatLogin: true, location: locations[0], intent: { ...intent }, reminders: [{ ...intent }] }); }

test('forecast dates use Beijing time, preserve zero and attribution, drop ended periods', () => {
  const day = { starts_at: '2026-09-23T22:00:00Z', ends_at: '2026-09-24T22:00:00Z', temperature_min: 0, temperature_max: 12,
    temperature_unit: '°C', daytime: { condition: '晴', precipitation_probability_percent: 0 } };
  const result = forecastView({ status: 'stale', attributions: ['one', 'two'], data: { days: [day, { ...day, ends_at: '2026-09-23T00:00:00Z' }] } }, Date.parse('2026-09-24T00:00:00Z'));
  assert.equal(result.days.length, 1); assert.equal(result.days[0].date_label, '2026-09-24');
  assert.equal(result.days[0].temperature_label, '0 ~ 12°C'); assert.equal(result.days[0].rain_label, '0%');
  assert.equal(result.attribution, 'one；two'); assert.equal(result.stale, true);
  assert.equal(localDate('bad'), ''); assert.equal(forecastView(null).available, false);
});

test('closed forecast and subscription gates do not invoke those capabilities', async () => {
  const calls = [];
  const { page } = harness(async (path) => {
    calls.push(path);
    if (path === 'weather-data/locations/') return { data: { items: locations, forecast_enabled: false } };
    if (path === 'weather-data/reminders/') return { data: { enabled: false, items: [] } };
    throw new Error('unexpected network call');
  }, { requestSubscribeMessage() { throw new Error('closed gate'); } });
  await page.onShow(); await page.prepareReminder(); page.authorizeReminder();
  assert.deepEqual(calls, ['weather-data/locations/', 'weather-data/reminders/']);
  assert.equal(page.data.forecast, null);
});

test('authorization is invoked synchronously by tap and reject is never recorded as consent', async () => {
  let called = false, callback;
  const { page } = harness(async () => { throw new Error('reject cannot create grant'); }, {
    requestSubscribeMessage(options) { called = true; callback = options.success; },
  });
  enable(page); page.authorizeReminder(); assert.equal(called, true);
  await callback({ template: 'reject' }); assert.equal(page.data.busy, false);
  assert.match(page.data.notice, /未开启/);
});

test('accepted permission is saved once even if platform callback is duplicated', async () => {
  let callback, calls = 0;
  const { page } = harness(async (path, options) => {
    calls++; assert.equal(path, 'weather-data/reminders/intent-1/consent/');
    assert.deepEqual(options.data, { template_id: 'template', acceptance: 'accept' });
    return { data: { ...intent, state: 'pending' } };
  }, { requestSubscribeMessage(options) { callback = options.success; } });
  enable(page); page.authorizeReminder();
  await callback({ template: 'accept' }); await callback({ template: 'accept' });
  assert.equal(calls, 1); assert.equal(page.data.intent, null); assert.equal(page.data.reminders[0].state, 'pending');
});

test('retrying an uncertain save reuses the accepted intent without requesting a second permission', async () => {
  let callback, calls = 0, asks = 0;
  const { page } = harness(async () => {
    if (++calls === 1) throw new Error('连接失败');
    return { data: { ...intent, state: 'pending' } };
  }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  enable(page); page.authorizeReminder(); await callback({ template: 'accept' });
  assert.equal(page.data.canConfirmAgain, true);
  await page.retryConfirmation(); assert.equal(asks, 1); assert.equal(calls, 2);
  assert.equal(page.data.canConfirmAgain, false);
});

test('an account switch before authorization returns cannot authorize for the new account', async () => {
  let callback, calls = 0;
  const environment = harness(async () => { calls++; }, { requestSubscribeMessage(options) { callback = options.success; } });
  enable(environment.page); environment.page.authorizeReminder(); environment.token('user-b');
  await callback({ template: 'accept' }); assert.equal(calls, 0); assert.deepEqual(environment.page.data.reminders, []);
});

test('leaving the page ignores delayed forecasts and private reminders', async () => {
  let complete;
  const { page } = harness((path) => {
    if (path === 'weather-data/locations/') return Promise.resolve({ data: { items: locations, forecast_enabled: false } });
    return new Promise((resolve) => { complete = resolve; });
  });
  const request = page.onShow(); page.onHide();
  complete({ data: { enabled: true, items: [intent] } }); await request;
  assert.deepEqual(page.data.reminders, []); assert.equal(page.data.intent, null);
});

test('cancel uses only owned visible records and remains available when new subscriptions are disabled', async () => {
  const calls = [];
  const { page } = harness(async (path) => { calls.push(path); return { data: { ...intent, state: 'cancelled', can_cancel: false } }; });
  enable(page); page.data.subscriptionEnabled = false;
  await page.cancelReminder({ currentTarget: { dataset: { id: 'other-id' } } });
  await page.cancelReminder({ currentTarget: { dataset: { id: intent.id } } });
  assert.deepEqual(calls, ['weather-data/reminders/intent-1/cancel/']);
  assert.equal(page.data.reminders[0].state, 'cancelled'); assert.equal(page.data.intent, null);
});

test('refresh immediately clears old capabilities and blocks stale reminder actions', async () => {
  const pending = []; let sends = 0;
  const { page } = harness((path, options) => {
    if (options && options.method === 'POST') { sends++; return Promise.resolve({ data: intent }); }
    return new Promise((resolve) => pending.push({ path, resolve }));
  });
  enable(page); const loading = page.load();
  assert.equal(page.data.subscriptionEnabled, false); assert.equal(page.data.wechatLogin, false);
  await page.prepareReminder(); page.authorizeReminder(); assert.equal(sends, 0);
  for (const item of pending) item.resolve({ data: item.path.includes('locations') ? { items: locations, forecast_enabled: false } : { enabled: false, items: [] } });
  await loading; assert.equal(page.data.subscriptionEnabled, false);
});

test('failure to reload service state cannot leave an earlier enabled reminder action usable', async () => {
  const { page } = harness(async () => { throw new Error('offline'); });
  enable(page); await page.load();
  assert.equal(page.data.subscriptionEnabled, false); assert.equal(page.data.wechatLogin, false);
  assert.match(page.data.error, /offline/);
});

test('unknown capability types fail closed instead of treating the string false as enabled', async () => {
  const calls = [];
  const { page } = harness(async (path) => {
    calls.push(path);
    if (path === 'weather-data/locations/') return { data: { items: locations, forecast_enabled: 'false' } };
    return { data: { enabled: 'false', wechat_login: 'false', items: [] } };
  });
  await page.load(); assert.equal(page.data.forecastEnabled, false); assert.equal(page.data.subscriptionEnabled, false);
  assert.equal(page.data.wechatLogin, false); assert.equal(calls.length, 2);
});
