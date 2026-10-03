const test = require('node:test');
const assert = require('node:assert/strict');

function fixture(patch = {}) {
  let definition;
  const navigation = [];
  global.getApp = () => ({ globalData: { region: { id: 'previous-region' } } });
  global.Page = value => { definition = value; };
  global.wx = { navigateTo: ({ url }) => navigation.push(url) };
  delete require.cache[require.resolve('../pages/home/index')];
  require('../pages/home/index');
  const page = { ...definition, _alive: true, data: { ...structuredClone(definition.data), loading: false, region: { id: 'current-region' }, cities: [{ slug: 'tianjin', name: '天津市' }], city: { slug: 'tianjin', latitude: 39.09, longitude: 117.2 }, ...patch }, setData(values) { Object.assign(this.data, values); } };
  return { page, navigation };
}

test('home AI binds the displayed region and allowlisted city without forwarding location or weather payloads', () => {
  const { page, navigation } = fixture({ citySummary: { weather: { temperature: 18, privateField: 'do-not-forward' } } });
  page.openAI();
  const query = new URL(navigation[0], 'https://local.invalid').searchParams;
  assert.deepEqual([...query], [['scope', 'explore'], ['source_type', 'region'], ['source_id', 'current-region'], ['weather_location', 'tianjin']]);
  page.data.region = { id: 'next-region' };
  page.data.city = { slug: 'unsupported-city' };
  page.openAI();
  const next = new URL(navigation[1], 'https://local.invalid').searchParams;
  assert.equal(next.get('source_id'), 'next-region');
  assert.equal(next.has('weather_location'), false);
});

test('home AI cannot open stale, failed, loading or hidden page context', () => {
  for (const patch of [{ loading: true }, { error: '资料加载失败' }, { region: null }]) {
    const { page, navigation } = fixture(patch);
    page.openAI();
    assert.deepEqual(navigation, []);
  }
  for (const lifecycle of ['onHide', 'onUnload']) {
    const { page, navigation } = fixture();
    page[lifecycle]();
    page.openAI();
    assert.deepEqual(navigation, []);
  }
});

test('home AI stays available for public context when weather is missing', () => {
  const { page, navigation } = fixture({ cities: [], city: null, cityError: '天气暂不可用' });
  page.openAI();
  assert.equal(navigation[0], '/pages/llm/index?scope=explore&source_type=region&source_id=current-region');
});
