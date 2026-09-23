const test = require('node:test');
const assert = require('node:assert/strict');
const { weatherView } = require('../lib/weather');

function page(api) {
  let definition;
  const application = { globalData: {}, api };
  global.Page = (input) => { definition = input; };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {} };
  delete require.cache[require.resolve('../pages/home/index')];
  require('../pages/home/index');
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return instance;
}
const cities = [{ slug: 'tianjin', name: '天津市' }, { slug: 'beijing', name: '北京市' }];
const sample = (temperature) => ({ weather: { status: 'fresh', data: { temperature, humidity_percent: 0 } } });

test('weather preserves zero, missing values, stale status and full attribution', () => {
  const view = weatherView({ ...sample(0), air: { status: 'stale', fetched_at: '2026-09-21T00:00:00Z', data: { aqi: 0, pollutants: [{ code: 'pm25', value: null, unit: 'μg/m³' }] }, attributions: ['first', 'second'], refer: { sources: ['source1', 'source2'] } } });
  assert.equal(view.weather.temp_label, '0°C');
  assert.equal(view.weather.humidity_label, '0%');
  assert.equal(view.air.aqi_label, '0');
  assert.equal(view.air.pollutants[0].value_label, '—');
  assert.equal(view.air.stale, true);
  assert.equal(view.air.attribution, 'first；second');
  assert.equal(view.air.sources, 'source1；source2');
  assert.equal(view.air.fetched_label, '2026-09-21 08:00 UTC+8');
});

test('only explicit fresh empty warning result is presented as no alerts', () => {
  for (const status of ['unavailable', 'stale', 'fresh']) {
    assert.equal(weatherView({ alerts: { status, data: { items: [], zero_result: true } } }).alerts.empty, false);
  }
  assert.equal(weatherView({ alerts: { status: 'empty', data: { items: [], zero_result: true } } }).alerts.empty, true);
});

test('disabled weather makes no summary request and leaves simulated data intact', async () => {
  let calls = 0;
  const instance = page({ request: async (path) => { calls++; assert.equal(path, 'weather-data/locations/'); return { data: { items: cities, enabled: false } }; } });
  instance.data.weather = { source_type: 'simulation', temperature: 20 };
  await instance.loadCityLocations();
  assert.equal(calls, 1);
  assert.equal(instance.data.citySummary, null);
  assert.equal(instance.data.weather.temperature, 20);
});

test('city switching discards delayed response from a previous city and hides on leave', async () => {
  const pending = [];
  const instance = page({ request: (path, options) => new Promise((resolve) => { assert.equal(path, 'weather-data/summary/'); assert.equal(options.timeout, 55000); pending.push(resolve); }) });
  instance.data.cities = cities;
  instance.data.cityEnabled = true;
  const first = instance.changeCity({ detail: { value: 0 } });
  const second = instance.changeCity({ detail: { value: 1 } });
  pending[1]({ data: sample(18) }); await second;
  pending[0]({ data: sample(29) }); await first;
  assert.equal(instance.data.city.name, '北京市');
  assert.equal(instance.data.citySummary.weather.temp_label, '18°C');
  const third = instance.changeCity({ detail: { value: 0 } });
  instance.onHide();
  pending[2]({ data: sample(21) }); await third;
  assert.equal(instance.data.citySummary, null);
});

test('summary failure is separate from no-alert and simulated fallback', async () => {
  const instance = page({ request: async (path) => {
    if (path === 'weather-data/locations/') return { data: { items: cities, enabled: true } };
    throw new Error('连接失败');
  } });
  await instance.loadCityLocations();
  assert.equal(instance.data.cityError, '连接失败');
  assert.equal(instance.data.citySummary, null);
  assert.equal(instance.data.cityLoading, false);
});


test('home weather artwork follows the actual condition and an unknown condition stays neutral', async () => {
  for (const [condition, theme] of [['晴', 'sun'], ['晴转雨', 'rain'], ['雷阵雨', 'rain'], ['多云', 'cloud'], ['阴', 'cloud'], ['雨夹雪', 'snow'], ['轻雾', 'mist'], ['', 'calm']]) {
    const instance = page({ request: async () => ({ data: { weather: { status: 'fresh', data: { temperature: 0, condition } } } }) });
    instance._cityGeneration = 1;
    await instance.loadCitySummary('tianjin', 1);
    assert.equal(instance.data.weatherTheme, theme, condition || 'missing condition');
    assert.equal(instance.data.citySummary.weather.temp_label, '0°C');
  }
});

test('home optional detail expansion makes no request and ignores callbacks after hide', () => {
  const instance = page({ request() { throw new Error('expansion must not request weather'); } });
  instance.toggleAir(); instance.toggleObservations();
  assert.equal(instance.data.airExpanded, true);
  assert.equal(instance.data.observationExpanded, true);
  instance.onHide();
  instance.setData = () => { throw new Error('late UI callback'); };
  instance.toggleAir(); instance.toggleObservations();
});
