const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastView, localDate, localClock, bookingFields, validateBooking, aiDraftView, reminderView } = require('../lib/weather-forecast');
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
  assert.equal(result.days[0].temperature_label, '0 ~ 12℃'); assert.equal(result.days[0].rain_label, '0%');
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


test('booking uses Beijing dates and validates exact calendar dates and 5 minute to 48 hour limits', () => {
  const now = Date.parse('2026-10-07T15:58:00Z');
  assert.deepEqual(bookingFields(now), { bookingDate: '2026-10-08', bookingTime: '08:00', minDate: '2026-10-08', maxDate: '2026-10-09' });
  assert.equal(localClock(now), '23:58');
  assert.equal(validateBooking('2026-10-08', '00:03', now).scheduled_for, '2026-10-07T16:03:00.000Z');
  assert.match(validateBooking('2026-10-08', '00:02', now).error, /5 分钟/);
  assert.equal(validateBooking('2026-10-09', '23:58', now).scheduled_for, '2026-10-09T15:58:00.000Z');
  assert.match(validateBooking('2026-10-09', '23:59', now).error, /48 小时/);
  for (const [date, clock] of [['2026-02-30', '08:00'], ['2026-10-08', '25:00'], ['2026-10-8', '08:00'], ['', '08:00']]) assert.ok(validateBooking(date, clock, now).error);
});

test('forecast truncates Celsius including negative temperatures and hides advice for expired forecasts', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const raw = { status: 'fresh', expires_at: '2026-10-07T01:00:00Z', data: { days: [{ starts_at: '2026-10-06T16:00:00Z', ends_at: '2026-10-07T16:00:00Z', temperature_min: -0.8, temperature_max: 12.9, temperature_unit: '°C', daytime: { precipitation_probability_percent: 60, wind_direction: '北风', wind_scale: '3~4' } }] } };
  const view = forecastView(raw, now);
  assert.equal(view.days[0].temperature_label, '0 ~ 12℃'); assert.equal(view.days[0].wind_label, '北风 3~4级');
  assert.deepEqual(view.days[0].tips, ['降水概率较高，出门带伞', '早晚偏冷，适当添衣']);
  const expired = forecastView(raw, Date.parse('2026-10-07T02:00:00Z'));
  assert.equal(expired.stale, true); assert.deepEqual(expired.days[0].tips, []);
  raw.data.days[0].temperature_min = null; raw.data.days[0].temperature_max = null;
  assert.equal(forecastView(raw, now).days[0].temperature_label, '— ~ —℃');
});

test('AI drafts require supported cities, Shanghai timezone, and a valid future schedule', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const raw = { location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: '2026-10-08T00:00:00Z', summary: '明早天津天气' };
  assert.equal(aiDraftView(raw, locations, now).bookingTime, '08:00');
  assert.equal(aiDraftView(raw, locations, now).location.name, '天津');
  for (const invalid of [{ ...raw, timezone: 'UTC' }, { ...raw, location: 'other' }, { ...raw, scheduled_for: 'bad' }, { ...raw, scheduled_for: '2026-10-07T00:01:00Z' }]) assert.equal(aiDraftView(invalid, locations, now), null);
  assert.equal(reminderView({ location: locations[1], state: 'unknown' }).location_name, '天津');
  assert.equal(reminderView({ state: 'unknown' }).state_label, '发送结果待核实');
});

test('manual review posts the chosen Beijing schedule without asking native subscription yet', async () => {
  const calls = [];
  const { page } = harness(async (path, options) => { calls.push({ path, options }); return { data: intent }; }, { requestSubscribeMessage() { throw new Error('review must not authorize'); } });
  enable(page); page.data.intent = null;
  const schedule = validateBooking(page.data.bookingDate, page.data.bookingTime);
  await page.prepareReminder();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, 'weather-data/reminders/intents/');
  assert.deepEqual(calls[0].options.data, { location: 'beijing', scheduled_for: schedule.scheduled_for });
  assert.equal(page.data.intent.id, intent.id);
});

test('invalid manual dates do not create an intent, and expired reviews do not open permission', async () => {
  let asks = 0, calls = 0;
  const { page } = harness(async () => { calls++; }, { requestSubscribeMessage() { asks++; } });
  enable(page); page.data.bookingDate = '2026-02-30'; await page.prepareReminder();
  assert.equal(calls, 0); assert.match(page.data.actionError, /日期或时间无效/);
  page.data.intent = { ...intent, consent_expires_at: '2020-01-01T00:00:00Z' }; page.authorizeReminder();
  assert.equal(asks, 0); assert.equal(page.data.intent, null); assert.match(page.data.actionError, /过期/);
});

test('natural language fills an editable draft but never creates an intent or subscribes', async () => {
  const calls = [], schedule = new Date(Date.now() + 86400000).toISOString();
  const { page } = harness(async (path, options) => {
    calls.push({ path, options });
    return { data: { draft: { location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: schedule, summary: '天津天气提醒' }, needs_clarification: false } };
  }, { requestSubscribeMessage() { throw new Error('AI must not subscribe'); } });
  enable(page); page.data.locations = locations; page.data.intent = null; page.data.aiText = '明天提醒我看天津天气';
  await page.interpretReminder();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, 'weather-data/reminders/interpret/');
  assert.match(calls[0].options.data.request_key, /^[0-9a-f-]{36}$/); assert.equal(calls[0].options.timeout, 55000);
  assert.equal(page.data.location.slug, 'tianjin'); assert.equal(page.data.bookingDate, localDate(schedule));
  assert.equal(page.data.intent, null); assert.match(page.data.aiNotice, /请核对/);
  page.changeBookingTime({ detail: { value: '09:00' } }); assert.equal(page.data.bookingTime, '09:00');
});

test('ambiguous AI input keeps manual fields usable and a failed retry reuses its request key', async () => {
  const keys = [];
  const { page } = harness(async (path, options) => { keys.push(options.data.request_key); if (keys.length === 1) throw new Error('网络暂不可用'); return { data: { needs_clarification: true, message: '请写明具体时间。', draft: null } }; });
  enable(page); page.data.intent = null; page.data.locations = locations; page.data.aiText = '提醒我';
  const selectedDate = page.data.bookingDate;
  await page.interpretReminder(); assert.match(page.data.aiError, /手动预约/); assert.equal(page.data.busy, false);
  await page.interpretReminder(); assert.equal(keys[0], keys[1]); assert.equal(page.data.bookingDate, selectedDate); assert.match(page.data.aiNotice, /具体时间/);
  page.inputAiText({ detail: { value: '明早提醒我' } }); await page.interpretReminder(); assert.notEqual(keys[1], keys[2]);
});

test('account changes and page departure discard delayed AI drafts', async () => {
  for (const leave of [false, true]) {
    let resolve;
    const env = harness(() => new Promise((done) => { resolve = done; }));
    enable(env.page); env.page.data.locations = locations; env.page.data.aiText = '明早天津'; env.page.data.intent = null;
    const pending = env.page.interpretReminder();
    if (leave) env.page.onHide(); else env.token('user-b');
    resolve({ data: { draft: { location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: new Date(Date.now() + 86400000).toISOString() } } });
    await pending; assert.equal(env.page.data.location.slug, 'beijing'); assert.equal(env.page.data.intent, null);
  }
});

test('public forecast remains available when private reminder status fails', async () => {
  const calls = [];
  const { page } = harness(async (path) => {
    calls.push(path);
    if (path === 'weather-data/locations/') return { data: { items: locations, forecast_enabled: true } };
    if (path === 'weather-data/reminders/') throw new Error('session offline');
    return { data: { forecast: { status: 'fresh', data: { days: [{ starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString() }] } } } };
  });
  await page.onShow(); assert.equal(page.data.forecast.available, true); assert.equal(page.data.subscriptionEnabled, false);
  assert.match(page.data.subscriptionNotice, /暂不可用/); assert.equal(calls.length, 3);
});

test('default city is Tianjin and explicit fuzzy location sends only the selected city slug', async () => {
  const directory = [{ ...locations[0], latitude: 39.9042, longitude: 116.4074, coordinate_system: 'WGS84' }, { ...locations[1], latitude: 39.0851, longitude: 117.1994, coordinate_system: 'WGS84' }];
  const calls = []; let fuzzy = 0;
  const { page } = harness(async (path, options) => { calls.push({ path, options }); return { data: path === 'weather-data/locations/' ? { items: directory, forecast_enabled: false } : { enabled: true, wechat_login: true, items: [] } }; }, {
    getFuzzyLocation(options) { fuzzy++; options.success({ latitude: 39.09, longitude: 117.20 }); },
    getLocation() { throw new Error('weather must not request precise location'); },
  });
  page._wantedLocation = ''; await page.onShow(); assert.equal(page.data.location.slug, 'tianjin'); assert.equal(fuzzy, 0);
  page._wantedLocation = 'beijing'; await page.load(); await page.locateCity();
  assert.equal(fuzzy, 1); assert.equal(page.data.location.slug, 'tianjin'); assert.equal(page.data.locationNotice, '');
  assert.ok(calls.every((call) => !call.options || !call.options.data || !('latitude' in call.options.data)));
});

test('editing a prepared appointment cancels the old intent before allowing a new review', async () => {
  const calls = [];
  const { page } = harness(async (path) => { calls.push(path); return { data: { ...intent, state: 'cancelled', can_cancel: false } }; });
  enable(page); await page.editReminder();
  assert.deepEqual(calls, ['weather-data/reminders/intent-1/cancel/']); assert.equal(page.data.intent, null);
  assert.equal(page.data.reminders[0].state, 'cancelled');
});


test('forecast attribution keeps source text and uses compact links without printing raw URLs', () => {
  const view = forecastView({ attributions: ['和风天气', 'https://developer.qweather.com/attribution.html', 'https://developer.qweather.com/attribution.html'] });
  assert.equal(view.attribution, '和风天气');
  assert.deepEqual(view.attribution_links, [{ url: 'https://developer.qweather.com/attribution.html', label: '来源说明' }]);
  const copied = [];
  const { page } = harness(async () => {}, { setClipboardData({ data }) { copied.push(data); } });
  page.data.forecast = view;
  page.copyForecastSource({ currentTarget: { dataset: { url: 'https://unexpected.example' } } });
  page.copyForecastSource({ currentTarget: { dataset: { url: view.attribution_links[0].url } } });
  assert.deepEqual(copied, ['https://developer.qweather.com/attribution.html']);
});
