const test = require('node:test');
const assert = require('node:assert/strict');
const { nearestWeatherCity, locateWeatherCity, CITY_SLUGS } = require('../lib/weather-location');
const cities = [
  { slug: 'tianjin', name: '天津市', latitude: 39.09, longitude: 117.20, coordinate_system: 'WGS84' },
  { slug: 'beijing', name: '北京市', latitude: 39.90, longitude: 116.41, coordinate_system: 'WGS84' },
  { slug: 'tiangong', name: '天津工业大学', latitude: 39.06, longitude: 117.11, coordinate_system: 'WGS84' },
];
function page() {
  let definition; const requests = [], application = { globalData: {}, api: { request: async (path, options) => { requests.push({ path, options });
    return path === 'weather-data/locations/' ? { data: { items: cities, enabled: true } } : { data: { weather: { status: 'fresh', data: { temperature: 20 } } } };
  } } };
  global.getApp = () => application; global.Page = input => { definition = input; }; global.wx = { stopPullDownRefresh() {} };
  delete require.cache[require.resolve('../pages/home/index')]; require('../pages/home/index');
  const instance = { ...definition, data: structuredClone(definition.data) }; instance.setData = patch => Object.assign(instance.data, patch);
  return { instance, application, requests };
}
test('nearest city matching is bounded, uses WGS84 and never auto-selects a campus', () => {
  assert.equal(CITY_SLUGS.length, 10);
  assert.equal(nearestWeatherCity({ latitude: 39.06, longitude: 117.11 }, cities).slug, 'tianjin');
  assert.equal(nearestWeatherCity({ latitude: 39.9088, longitude: 116.3973 }, cities).slug, 'beijing');
  for (const point of [{ latitude: 31, longitude: 100 }, { latitude: 91, longitude: 116 }, { latitude: '39.9', longitude: 116.4 }, { latitude: 39.9, longitude: 116.4, accuracy: 60000 }]) assert.equal(nearestWeatherCity(point, cities), null);
  assert.equal(nearestWeatherCity({ latitude: 39.9, longitude: 116.4 }, [{ ...cities[1], coordinate_system: 'GCJ02' }]), null);
});
test('location helper requests once and returns only a supported slug, never coordinates or raw errors', async () => {
  let calls = 0;
  const result = await locateWeatherCity({ getLocation(options) { calls++; assert.equal(options.type, 'wgs84'); assert.equal(options.isHighAccuracy, false); options.success({ latitude: 39.9088, longitude: 116.3973, accuracy: 10 }); options.success({ latitude: 39.09, longitude: 117.2 }); } }, cities);
  assert.deepEqual(result, { status: 'selected', slug: 'beijing' }); assert.equal(calls, 1);
  assert.deepEqual(await locateWeatherCity({ getLocation(options) { options.fail({ errMsg: 'private/raw/provider error' }); } }, cities), { status: 'unavailable' });
  assert.deepEqual(await locateWeatherCity({}, cities), { status: 'unavailable' });
});
test('home initial weather loading never requests location', async () => {
  const { instance, requests } = page(); global.wx.getLocation = () => assert.fail('location requires a user tap');
  await instance.loadCityLocations(); assert.equal(requests.length, 2); assert.equal(instance.data.locationBusy, false);
});
test('explicit location sends only city slug and stores no precise location in page or global state', async () => {
  const { instance, application, requests } = page(); await instance.loadCityLocations(); requests.length = 0;
  global.wx.getLocation = options => options.success({ latitude: 39.9088, longitude: 116.3973, accuracy: 10 });
  await instance.locateCity();
  assert.equal(instance.data.city.slug, 'beijing'); assert.equal(application.globalData.weatherLocation, 'beijing');
  assert.deepEqual(requests[0].options.data, { location: 'beijing' }); assert.equal(requests.length, 1);
  assert.match(instance.data.locationNotice, /城市代表点/);
  assert.doesNotMatch(JSON.stringify({ requests, data: instance.data, global: application.globalData }), /39\.9088|116\.3973/);
});
test('denied permission and a location over 100km away keep the current city and permit manual selection', async () => {
  for (const reply of ['denied', 'distant']) {
    const { instance, requests } = page(); await instance.loadCityLocations(); requests.length = 0;
    global.wx.getLocation = options => reply === 'denied' ? options.fail({ errMsg: 'auth deny' }) : options.success({ latitude: 34, longitude: 108 });
    await instance.locateCity(); assert.equal(instance.data.city.slug, 'tianjin'); assert.equal(requests.length, 0); assert.equal(instance.data.locationBusy, false); assert.match(instance.data.locationNotice, /手动/);
    await instance.changeCity({ detail: { value: 1 } }); assert.equal(instance.data.city.slug, 'beijing'); assert.equal(requests.length, 1);
  }
});
test('repeated location taps are coalesced and a manual city choice cancels a late GPS result', async () => {
  const { instance, requests } = page(); await instance.loadCityLocations(); requests.length = 0;
  let pending, count = 0; global.wx.getLocation = options => { pending = options; count++; };
  const first = instance.locateCity(); await instance.locateCity(); assert.equal(count, 1);
  await instance.changeCity({ detail: { value: 0 } });
  pending.success({ latitude: 39.9088, longitude: 116.3973 }); await first;
  assert.equal(instance.data.city.slug, 'tianjin'); assert.equal(requests.length, 1); assert.equal(instance.data.locationNotice, '');
});
test('hiding or unloading ignores late GPS callbacks without state updates or weather requests', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const { instance, requests } = page(); await instance.loadCityLocations(); requests.length = 0;
    let pending; global.wx.getLocation = options => { pending = options; };
    const request = instance.locateCity(); instance[lifecycle]();
    instance.setData = () => assert.fail('late GPS must not update a hidden/unloaded page');
    pending.success({ latitude: 39.9088, longitude: 116.3973 }); await request;
    assert.equal(requests.length, 0);
  }
});
