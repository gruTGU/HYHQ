const test = require('node:test');
const assert = require('node:assert/strict');

function home(summary) {
  let definition;
  const calls = [], application = { globalData: {}, api: { request: async (path) => { calls.push(path); return { data: summary }; } } };
  global.Page = input => { definition = input; };
  global.getApp = () => application;
  global.wx = {};
  delete require.cache[require.resolve('../pages/home/index')];
  require('../pages/home/index');
  const instance = { ...definition, data: structuredClone(definition.data), _cityGeneration: 1 };
  instance.setData = patch => Object.assign(instance.data, patch);
  return { instance, calls, application };
}
const announcement = {
  id: 'warning-1', title: '大风预警', description: '保留完整公告正文。'.repeat(100), instruction: '注意户外活动安排。',
  sender: '气象台', issued_at: '2026-10-03T10:00:00Z', effective_at: '2026-10-03T10:00:00Z', expires_at: '2026-10-04T10:00:00Z', message_type: 'alert',
};
function summary(status = 'fresh', items = [announcement]) {
  return { weather: { status: 'fresh', data: { temperature: 0, humidity_percent: 0 } }, alerts: {
    status, fetched_at: '2026-10-03T12:00:00Z', expires_at: '2026-10-03T12:15:00Z',
    data: { items, zero_result: items.length === 0 }, attributions: ['气象资料署名'], refer: { sources: ['气象台'] },
  } };
}

test('home warning disclosure starts collapsed and preserves the complete bulletin and audit metadata without extra requests', async () => {
  const { instance, calls } = home(summary());
  await instance.loadCitySummary('tianjin', 1); instance.data.cityLoading = false;
  assert.equal(instance.data.alertsExpanded, false);
  assert.equal(instance.data.alertBadge.tone, 'active');
  assert.equal(instance.data.alertBadge.label, '1 条公告');
  instance.toggleAlerts();
  assert.equal(instance.data.alertsExpanded, true);
  const item = instance.data.citySummary.alerts.items[0];
  for (const key of ['id', 'title', 'description', 'instruction', 'sender']) assert.equal(item[key], announcement[key]);
  assert.match(item.issued_label, /2026-10-03 18:00/);
  assert.match(item.effective_label, /2026-10-03 18:00/);
  assert.match(item.expires_label, /2026-10-04 18:00/);
  assert.equal(instance.data.citySummary.alerts.sources, '气象台');
  assert.equal(instance.data.citySummary.alerts.attribution, '气象资料署名');
  assert.equal(instance.data.citySummary.weather.temp_label, '0°C');
  instance.toggleAlerts(); assert.equal(instance.data.alertsExpanded, false);
  assert.deepEqual(calls, ['weather-data/summary/']);
});

test('home warning badge never turns stale, unavailable or ambiguous empty results into a fresh no-warning claim', async () => {
  for (const [status, items, tone, label] of [
    ['empty', [], 'empty', '暂无预警'], ['stale', [], 'stale', '历史缓存'],
    ['stale', [announcement], 'stale', '历史公告 1 条'], ['unavailable', [], 'unavailable', '查询不可用'],
    ['fresh', [], 'unavailable', '状态待确认'],
    ['fresh', [{ ...announcement, message_type: 'cancel' }], 'active', '1 条公告'],
  ]) {
    const { instance } = home(summary(status, items));
    await instance.loadCitySummary('tianjin', 1);
    assert.equal(instance.data.alertBadge.tone, tone, status);
    assert.equal(instance.data.alertBadge.label, label, status);
    if (items.length && items[0].message_type === 'cancel') assert.equal(instance.data.citySummary.alerts.items[0].message_label, '已取消');
  }
});

test('switching city closes old warning and air disclosures immediately even when the new city request fails', async () => {
  const { instance, application } = home(summary());
  await instance.loadCitySummary('tianjin', 1);
  Object.assign(instance.data, { cities: [{ slug: 'tianjin' }, { slug: 'beijing' }], cityLoading: false, cityEnabled: true, alertsExpanded: true, airExpanded: true });
  let reject;
  application.api.request = () => new Promise((resolve, no) => { reject = no; });
  const changing = instance.selectWeatherCity(1, '');
  assert.equal(instance.data.alertsExpanded, false);
  assert.equal(instance.data.airExpanded, false);
  assert.equal(instance.data.alertBadge, null);
  assert.equal(instance.data.citySummary, null);
  instance.toggleAlerts(); assert.equal(instance.data.alertsExpanded, false);
  reject(new Error('新城市暂不可用')); await changing;
  assert.equal(instance.data.citySummary, null);
  assert.equal(instance.data.cityError, '新城市暂不可用');
  instance.toggleAlerts(); assert.equal(instance.data.alertsExpanded, false);
});

test('queued warning taps cannot update a hidden or unloaded home page', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const { instance } = home(summary());
    await instance.loadCitySummary('tianjin', 1); instance.data.cityLoading = false;
    instance[lifecycle]();
    instance.setData = () => assert.fail('hidden page must ignore the queued disclosure action');
    instance.toggleAlerts();
  }
});
