const test = require('node:test');
const assert = require('node:assert/strict');
const { forecastView, localDate, localClock, bookingFields, validateBooking, nextDailyBooking, aiDraftView, reminderView } = require('../lib/weather-forecast');
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
function enable(page) { Object.assign(page.data, { subscriptionEnabled: true, weatherReminderEnabled: true, simulationEnabled: true, loggedIn: true, wechatLogin: true, location: locations[0], intent: { ...intent }, reminders: [{ ...intent }] }); }

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

test('natural-language drafts only fill editable fields and never silently authorize or book', async () => {
  const calls = [];
  const { page } = harness(async (path, options) => {
    calls.push({ path, options });
    return { data: { draft: { location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: new Date(Date.now() + 86400000).toISOString(), frequency: 'once', summary: '明日天气' } } };
  }, { requestSubscribeMessage() { assert.fail('draft does not authorize'); } });
  enable(page); page.data.locations = locations; page.data.intent = null;
  page.inputAiText({ detail: { value: '明天提醒我看天津天气' } }); await page.interpretReminder();
  assert.equal(calls.length, 1); assert.equal(calls[0].path, 'weather-data/reminders/interpret/');
  assert.equal(page.data.location.slug, 'tianjin'); assert.equal(page.data.intent, null);
  assert.match(page.data.aiNotice, /核对/); assert.equal(page.data.busy, false);
});

test('daily natural-language draft selects usual time but does not create recurring consent', async () => {
  const now = Date.parse('2026-10-11T05:00:00Z'), saved = [];
  const { page } = harness(async () => ({ data: { draft: { location: 'tianjin', timezone: 'Asia/Shanghai', frequency: 'daily', scheduled_for: '2026-10-12T00:00:00Z', summary: '常用时间 08:00' } } }), {
    setStorageSync(key, value) { saved.push(value); }, requestSubscribeMessage() { assert.fail('draft cannot authorize'); },
  });
  enable(page); page.data.locations = locations; page.data.intent = null; page.now = () => now;
  page.inputAiText({ detail: { value: '每天早上八点提醒我看天津天气' } }); await page.interpretReminder();
  assert.equal(page.data.dailyTime, '08:00'); assert.equal(page.data.dailyNextLabel, '2026-10-12 08:00');
  assert.match(page.data.aiNotice, /剩余次数/); assert.deepEqual(saved, ['08:00']);
});

test('late AI drafts are ignored after account changes or page departure', async () => {
  for (const leave of [false, true]) {
    let finish;
    const env = harness(() => new Promise(resolve => { finish = resolve; }));
    enable(env.page); env.page.data.locations = locations; env.page.data.aiText = '明早天津'; env.page.data.intent = null;
    const pending = env.page.interpretReminder();
    if (leave) env.page.onHide(); else env.token('user-b');
    finish({ data: { draft: { location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: new Date(Date.now() + 86400000).toISOString() } } });
    await pending; assert.equal(env.page.data.location.slug, 'beijing'); assert.equal(env.page.data.intent, null);
  }
});

test('daily shortcut picks the next Beijing occurrence and retains its local time preference', () => {
  const now = Date.parse('2026-10-11T05:00:00Z');
  assert.equal(nextDailyBooking('14:00', now).scheduled_for, '2026-10-11T06:00:00.000Z');
  assert.equal(nextDailyBooking('08:00', now).scheduled_for, '2026-10-12T00:00:00.000Z');
  assert.equal(nextDailyBooking('13:05', now).bookingDate, '2026-10-12');
  assert.ok(nextDailyBooking('25:00', now).error);
  assert.equal(nextDailyBooking('00:00', Date.parse('2026-10-11T15:58:00Z')).scheduled_for, '2026-10-12T16:00:00.000Z');
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


test('daily local preference survives reopening without reading or storing an authorization', () => {
  const writes = [];
  const { page } = harness(async () => {}, {
    getStorageSync(key) { assert.equal(key, 'hyhq.weather.daily-time.v1'); return '07:30'; },
    setStorageSync(key, value) { writes.push({ key, value }); },
  });
  assert.equal(page.data.dailyTime, '07:30');
  page.changeDailyTime({ detail: { value: '18:00' } });
  assert.deepEqual(writes, [{ key: 'hyhq.weather.daily-time.v1', value: '18:00' }]);
  assert.equal(page._grantAccepted, undefined); assert.equal(page.data.intent, null);
});

test('prepared manual intent cannot be silently replaced by a late input or AI event', async () => {
  const { page } = harness(async () => assert.fail('editing must cancel the existing intent first'));
  enable(page); const date = page.data.bookingDate;
  page.changeBookingDate({ detail: { value: '2099-01-01' } });
  page.inputAiText({ detail: { value: '明天提醒我' } }); await page.interpretReminder();
  assert.equal(page.data.bookingDate, date); assert.equal(page.data.aiText, ''); assert.equal(page.data.intent.id, intent.id);
});

test('old simulation deep links cannot switch the weather page to a simulated date or daily booking', async () => {
  const { page } = harness(async path => ({ data: path === 'weather-data/locations/' ? { items: locations, forecast_enabled: false } : { enabled: true, wechat_login: true, items: [] } }));
  page.onLoad({ type: 'ecology_simulation', scenario: 'heat' }); await page.onShow();
  assert.equal(page.data.simulationScenario, undefined); assert.equal(page.data.reminderType, undefined);
  assert.equal(page.data.subscriptionEnabled, true);
  assert.deepEqual(page.reminderRequest('2099-01-01T00:00:00Z'), { location: 'tianjin', scheduled_for: '2099-01-01T00:00:00Z' });
});

test('a simulation AI draft points to the instant home experience without converting it into a weather appointment', async () => {
  let request;
  const { page } = harness(async (path, options) => {
    request = { path, options }; return { data: { draft: { type: 'ecology_simulation', scenario: 'heat', location: 'tianjin', timezone: 'Asia/Shanghai', scheduled_for: new Date(Date.now() + 86400000).toISOString() } } };
  });
  enable(page); Object.assign(page.data, { intent: null, locations });
  const date = page.data.bookingDate;
  page.inputAiText({ detail: { value: '模拟异常提醒' } }); await page.interpretReminder();
  assert.equal(request.options.data.type, undefined); assert.equal(page.data.bookingDate, date);
  assert.equal(page.data.location.slug, 'beijing'); assert.equal(page.data.intent, null); assert.match(page.data.aiNotice, /首页.*即时/);
});

test('legacy simulation daily records can still be stopped without new authorization or schedule creation', async () => {
  const calls = [];
  const { page } = harness(async (path, options) => { calls.push({ path, options }); return { data: { enabled: false } }; }, { requestSubscribeMessage() { assert.fail('cancel cannot ask for consent'); } });
  enable(page); page.data.legacySimulationPlans = [{ type: 'ecology_simulation', enabled: true }];
  await page.cancelLegacySimulationPlan();
  assert.deepEqual(calls, [{ path: 'weather-data/reminders/daily/ecology_simulation/cancel/', options: { method: 'POST', data: {} } }]);
  assert.deepEqual(page.data.legacySimulationPlans, []);
});


function grantFixture(id = 'grant-1') { return { id, state: 'prepared', template_id: 'template', expires_at: new Date(Date.now() + 600000).toISOString() }; }
function enableCredits(page) { enable(page); Object.assign(page.data, { intent: null, templateId: 'template', grantIntent: grantFixture(), reminders: [] }); }

test('grant preparation never prompts and +1 invokes the native subscription synchronously in the tap', async () => {
  const calls = []; let asks = 0, callback;
  const { page } = harness(async (path, options) => {
    calls.push({ path, options });
    return { data: path.endsWith('/grants/') ? grantFixture('grant-next') : { id: 'grant-next', state: 'accepted', subscription_pool: { remaining: 1 } } };
  }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  enableCredits(page); page.data.grantIntent = null; await page.prepareSubscriptionGrant();
  assert.equal(asks, 0); assert.equal(calls.length, 1); assert.equal(calls[0].path, 'weather-data/reminders/grants/');
  page.addSubscriptionCredit(); assert.equal(asks, 1); assert.equal(calls.length, 1);
  await callback({ template: 'accept' }); await callback({ template: 'accept' });
  assert.equal(asks, 1); assert.equal(calls.filter(call => call.path.endsWith('/confirm/')).length, 1);
  assert.deepEqual(calls[1].options.data, { template_id: 'template', decision: 'accept' });
  assert.equal(page.data.subscriptionPool.remaining, 1); assert.equal(page.data.grantBusy, false);
  assert.ok(calls.every(call => !call.path.endsWith('/intents/')));
});

test('rejecting +1 never books or credits a delivery', async () => {
  let callback;
  const { page } = harness(async () => assert.fail('rejection must not credit'), { requestSubscribeMessage(options) { callback = options.success; } });
  enableCredits(page); page.addSubscriptionCredit(); await callback({ template: 'reject' });
  assert.equal(page.data.subscriptionPool.remaining, 0); assert.equal(page.data.busy, false); assert.equal(page.data.canRetryGrant, false);
});

test('uncertain credit confirmation retries one grant without asking a second permission', async () => {
  let callback, asks = 0, confirms = 0; const paths = [];
  const { page } = harness(async (path) => {
    paths.push(path);
    if (path.endsWith('/grants/')) return { data: grantFixture('grant-next') };
    if (++confirms === 1) throw new Error('offline');
    return { data: { id: 'grant-1', state: 'accepted', subscription_pool: { remaining: 1 } } };
  }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  enableCredits(page); page.addSubscriptionCredit(); await callback({ template: 'accept' });
  assert.equal(page.data.canRetryGrant, true); assert.equal(page.data.subscriptionPool.remaining, 0);
  page.changeBookingTime({ detail: { value: '19:00' } }); assert.equal(page.data.bookingTime, '08:00');
  await page.retrySubscriptionCredit(); assert.equal(asks, 1); assert.equal(confirms, 2);
  assert.equal(paths[0], paths[1]); assert.equal(page.data.canRetryGrant, false); assert.equal(page.data.subscriptionPool.remaining, 1);
});

test('expired grant can only prepare a replacement; a fresh explicit tap is required to ask permission', async () => {
  let asks = 0;
  const { page } = harness(async () => ({ data: grantFixture('fresh') }), { requestSubscribeMessage() { asks++; } });
  enableCredits(page); page.data.grantIntent.expires_at = '2000-01-01T00:00:00Z';
  await page.addSubscriptionCredit(); assert.equal(asks, 0); assert.equal(page.data.grantIntent.id, 'fresh');
  page.addSubscriptionCredit(); assert.equal(asks, 1);
});

test('changing accounts discards a late +1 acceptance and private balances', async () => {
  let callback;
  const env = harness(async () => assert.fail('must not credit another account'), { requestSubscribeMessage(options) { callback = options.success; } });
  enableCredits(env.page); env.page.data.subscriptionPool = { remaining: 3 };
  env.page.addSubscriptionCredit(); env.token('user-b'); await callback({ template: 'accept' });
  assert.equal(env.page.data.subscriptionPool.remaining, 0); assert.equal(env.page._grantAccepted, null); assert.equal(env.page.data.grantIntent, null);
});

test('daily schedules save and pause independently of the shared credit balance and never request permission themselves', async () => {
  const calls = [];
  const { page } = harness(async (path, options) => {
    calls.push({ path, options });
    return { data: { id: 'daily-weather', type: 'weather', time: '08:00', enabled: !path.endsWith('/cancel/') } };
  }, { requestSubscribeMessage() { assert.fail('saving a plan is not consent'); } });
  enableCredits(page); Object.assign(page.data, { subscriptionPool: { remaining: 3 } });
  await page.saveDailyPlan();
  assert.deepEqual(calls[0].options.data, { type: 'weather', location: 'beijing', time: '08:00', enabled: true });
  assert.equal(page.data.currentDailyPlan.enabled, true); assert.equal(page.data.subscriptionPool.remaining, 3);
  await page.cancelDailyPlan(); assert.equal(calls[1].path, 'weather-data/reminders/daily/weather/cancel/');
  assert.equal(page.data.currentDailyPlan.enabled, false); assert.equal(page.data.subscriptionPool.remaining, 3);
});

test('empty reminder balance preserves an enabled daily plan while explaining the need to add credit', async () => {
  const { page } = harness(async () => ({ data: { id: 'daily-weather', type: 'weather', time: '08:00', enabled: true } }));
  enableCredits(page); await page.saveDailyPlan(); assert.equal(page.data.currentDailyPlan.enabled, true);
  assert.match(page.data.dailyNotice, /点击 \+1 补充/); assert.equal(page.data.subscriptionPool.remaining, 0);
});

test('page +1 and daily weather plan interoperate with real cloud handlers and stop after the one available credit', async () => {
  const { MemoryStore } = require('../../cloud-native/tests/memory-store');
  const { createApp } = require('../../cloudfunctions/hyhqApi');
  const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
  const store = new MemoryStore(), now = new Date().toISOString(); let sent = 0, callback, asks = 0;
  const config = { appId: 'wx0123456789abcdef', sessionSecret: 'unit-only-subscription-pool-secret', weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID }, qweatherEnabled: true, qweatherBudgetConfirmed: true, qweatherApiKey: 'test-only', qweatherApiHost: 'unit.qweatherapi.com', qweatherMonthlyLimit: 100 };
  const providers = { sendWeatherReminder: async () => { sent++; return { errCode: 0 }; }, fetchWeather: async () => ({ data: { schema_version: 2, timezone: 'Asia/Shanghai', days: [0, 1, 2].map(i => ({ date: localDate(Date.parse(now) + i * 86400000), starts_at: new Date(Date.parse(now) + i * 86400000 - 3600000).toISOString(), ends_at: new Date(Date.parse(now) + (i + 1) * 86400000).toISOString(), temperature_min: 10, temperature_max: 20, temperature_unit: '°C', daytime: { condition: '晴' }, nighttime: { condition: '晴' } })) } }) };
  const cloudApp = createApp({ store, config, providers, now: () => now });
  const identity = { APPID: config.appId, OPENID: 'unit_verified_credit_openid' };
  const auth = (await cloudApp({ method: 'POST', path: '/api/v1/auth/wechat/', body: { code: 'unit-sdk-code' } }, identity)).data.data;
  const env = harness(async (path, options = {}) => {
    const out = await cloudApp({ method: options.method || 'GET', path: '/api/v1/' + path, body: options.data || {}, headers: { Authorization: 'Bearer ' + auth.token } }, identity);
    assert.ok(out.statusCode < 400, JSON.stringify(out)); return { data: out.data.data };
  }, { requestSubscribeMessage(options) { asks++; callback = options.success; } });
  env.token(auth.token); env.page.onLoad({ location: 'tianjin' }); await env.page.onShow();
  assert.equal(asks, 0); assert.equal(env.page.data.grantIntent.state, 'prepared');
  env.page.addSubscriptionCredit(); assert.equal(asks, 1); await callback({ [reminders.TEMPLATE_ID]: 'accept' });
  assert.equal(env.page.data.subscriptionPool.remaining, 1);
  await env.page.saveDailyPlan(); const first = env.page.data.currentDailyPlan;
  assert.equal(first.type, 'weather'); assert.equal(first.enabled, true);
  const worker = { store, config, providers, now: first.next_scheduled_for };
  assert.equal((await reminders.runDueReminders(worker)).sent, 1); assert.equal(sent, 1);
  await reminders.runDueReminders({ ...worker, now: new Date(Date.parse(first.next_scheduled_for) + 86400000).toISOString() });
  assert.equal(sent, 1);
  await env.page.load(); assert.equal(env.page.data.subscriptionPool.remaining, 0); assert.equal(env.page.data.currentDailyPlan.last_state, 'no_credit');
  await env.page.cancelDailyPlan(); assert.equal(env.page.data.currentDailyPlan.enabled, false); assert.equal(asks, 1);
});


test('daily plan preview follows its near-future slot and never shows another send on a date already processed', () => {
  const { page } = harness(async () => {}); page.now = () => Date.parse('2026-10-11T05:04:00Z');
  page.data.dailyTime = '13:05'; page.updateDailyLabel(); assert.equal(page.data.dailyNextLabel, '2026-10-11 13:05');
  page.data.currentDailyPlan = { last_target_date: '2026-10-11' }; page.updateDailyLabel();
  assert.equal(page.data.dailyNextLabel, '2026-10-12 13:05');
});

test('daily save gives immediate local feedback and toast only after a confirmed response', async () => {
  let finish; const toasts = [];
  const { page } = harness(() => new Promise(resolve => { finish = resolve; }), { showToast: event => toasts.push(event) });
  enableCredits(page); const saving = page.saveDailyPlan();
  assert.equal(page.data.savingDaily, true); assert.equal(toasts.length, 0); assert.equal(page.data.dailyNotice, '');
  finish({ data: { id: 'daily-weather', type: 'weather', time: '08:00', enabled: true } }); await saving;
  assert.equal(page.data.savingDaily, false); assert.match(page.data.dailyNotice, /已保存/); assert.equal(page.data.notice, '');
  assert.equal(toasts.length, 1); assert.equal(toasts[0].title, '每日安排已保存');
  page.changeDailyTime({ detail: { value: '09:00' } }); assert.equal(page.data.dailyNotice, '');
});

test('daily save error stays by its action and a hidden-page result cannot toast success', async () => {
  const toasts = [];
  const failed = harness(async () => { throw new Error('连接失败'); }, { showToast: e => toasts.push(e) });
  enableCredits(failed.page); await failed.page.saveDailyPlan();
  assert.equal(failed.page.data.dailyError, '连接失败'); assert.equal(failed.page.data.actionError, ''); assert.equal(toasts.length, 0);
  let finish;
  const hidden = harness(() => new Promise(r => { finish = r; }), { showToast: e => toasts.push(e) });
  enableCredits(hidden.page); const saving = hidden.page.saveDailyPlan(); hidden.page.onHide();
  finish({ data: { id: 'daily-weather', type: 'weather', time: '08:00', enabled: true } }); await saving;
  assert.equal(hidden.page.data.dailyNotice, ''); assert.equal(toasts.length, 0);
});
