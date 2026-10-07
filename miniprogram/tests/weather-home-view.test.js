const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { weatherView } = require('../lib/weather');
const NOW = Date.parse('2026-10-07T02:00:00Z');
const future = '2026-10-07T03:00:00Z';
const current = (extra = {}) => ({ status: 'fresh', fetched_at: '2026-10-07T01:30:00Z', expires_at: future, data: { temperature: 23.9, temperature_unit: '°C' }, ...extra });
const day = (extra = {}) => ({ date: '2026-10-07', starts_at: '2026-10-06T22:00:00Z', ends_at: '2026-10-07T22:00:00Z', temperature_min: -0.9, temperature_max: 23.9, temperature_unit: '°C', ...extra });
const daily = (extra = {}) => ({ status: 'fresh', fetched_at: '2026-10-07T01:00:00Z', expires_at: future, data: { days: [day()], today: day(), timezone: 'Asia/Shanghai' }, ...extra });

test('current temperature uses Celsius and truncates toward zero without rounding or negative zero', () => {
  for (const [input, expected] of [[23.9, '23℃'], [-5.9, '-5℃'], [-0.9, '0℃'], [0, '0℃'], [null, '—'], [Infinity, '—'], ['23.9', '—']]) {
    assert.equal(weatherView({ weather: current({ data: { temperature: input, temperature_unit: '°C' } }) }, NOW).weather.temp_label, expected);
  }
  assert.equal(weatherView({ weather: current({ data: { temperature: 72, temperature_unit: '°F' } }) }, NOW).weather.temp_label, '—');
});

test('today high and low use Beijing period dates, inclusive start/exclusive end and valid Celsius only', () => {
  const view = weatherView({ daily: daily() }, NOW).daily;
  assert.equal(view.today_available, true); assert.equal(view.max_label, '23℃'); assert.equal(view.min_label, '0℃');
  const cases = [
    daily({ data: { today: day({ date: '2026-10-06', starts_at: '2026-10-05T22:00:00Z', ends_at: '2026-10-07T22:00:00Z' }) } }),
    daily({ data: { today: day({ starts_at: '2026-10-07T04:00:00Z' }) } }),
    daily({ data: { today: day({ ends_at: '2026-10-07T02:00:00Z' }) } }),
    daily({ data: { today: day({ starts_at: 'invalid' }) } }),
    daily({ data: { today: day({ temperature_unit: '°F' }) } }),
    daily({ data: { today: day({ temperature_unit: '' }) } }),
    daily({ data: { today: day({ temperature_min: 25, temperature_max: 20 }) } }),
    daily({ data: { today: null, days: [day()] } }),
    daily({ status: 'stale' }), daily({ stale: true }), daily({ expires_at: '2026-10-07T02:00:00Z' }),
  ];
  for (const data of cases) assert.equal(weatherView({ daily: data }, NOW).daily.today_available, false, JSON.stringify(data));
});

test('date rollover never labels yesterday period as today; partial missing temperatures remain honest', () => {
  const yesterday = daily({ expires_at: '2026-10-08T00:00:00Z' });
  assert.equal(weatherView({ daily: yesterday }, Date.parse('2026-10-07T16:01:00Z')).daily.today_available, false);
  const partial = weatherView({ daily: daily({ data: { today: day({ temperature_min: null }) } }) }, NOW).daily;
  assert.equal(partial.today_available, true); assert.equal(partial.min_available, false); assert.equal(partial.min_label, ''); assert.equal(partial.max_label, '23℃');
});

test('long attribution addresses become compact links while non-URL text and air sources stay visible and deduplicated', () => {
  const url = 'https://www.qweather.com/attribution?dataset=weather';
  const extra = 'https://example.org/air/source';
  const view = weatherView({ weather: current({ attributions: [url, '版权所有，引用时须保留完整说明。'], refer: { sources: ['QWeather'] } }), air: current({ attributions: [url, extra], refer: { sources: ['QWeather', '中国环境监测总站'] } }), daily: daily({ attributions: [url] }) }, NOW);
  assert.deepEqual(view.attribution_links.map(link => link.url), [url, extra]);
  assert.ok(view.attribution_links.every(link => !link.label.includes('http')));
  assert.deepEqual(view.source_notes, ['版权所有，引用时须保留完整说明。', '中国环境监测总站']);
  const mixed = weatherView({ weather: current({ attributions: ['Original data: ' + url + ' 使用须注明许可。'] }) }, NOW);
  assert.equal(mixed.source_notes[0], 'Original data:  使用须注明许可。'); assert.equal(mixed.attribution_links[0].url, url);
});

test('fresh source cache is reclassified when expiry or observation age passes; invalid times are unavailable', () => {
  assert.equal(weatherView({ weather: current({ expires_at: '2026-10-07T01:59:59Z' }) }, NOW).weather.stale, true);
  assert.equal(weatherView({ air: current({ observed_at: '2026-10-06T22:59:59Z' }) }, NOW).air.stale, true);
  assert.equal(weatherView({ weather: current({ expires_at: 'not-a-time' }) }, NOW).weather.available, false);
  assert.equal(weatherView({ air: current({ observed_at: '2026-10-07T03:00:00Z' }) }, NOW).air.status, 'unavailable');
});

test('expired announcements remain readable as historical but cannot count as current or imply no warning', () => {
  const old = { id: 'old', title: '旧公告', description: '完整旧正文', issued_at: '2026-10-06T23:00:00Z', effective_at: '2026-10-06T23:00:00Z', expires_at: '2026-10-07T01:59:59Z' };
  const newer = { ...old, id: 'new', expires_at: '2026-10-07T03:00:00Z' };
  const cached = data => ({ status: 'fresh', fetched_at: '2026-10-07T01:55:00Z', expires_at: future, data });
  const history = weatherView({ alerts: cached({ items: [old], zero_result: false }) }, NOW).alerts;
  assert.equal(history.status, 'stale'); assert.equal(history.empty, false); assert.equal(history.current_count, 0); assert.equal(history.items[0].description, '完整旧正文');
  const mixed = weatherView({ alerts: cached({ items: [old, newer], zero_result: false }) }, NOW).alerts;
  assert.equal(mixed.current_count, 1); assert.equal(mixed.items.length, 2);
  const pending = weatherView({ alerts: cached({ items: [{ ...newer, effective_at: '2026-10-07T02:30:00Z' }], zero_result: false }) }, NOW).alerts;
  assert.equal(pending.status, 'unknown'); assert.equal(pending.empty, false);
  const expiredEmpty = weatherView({ alerts: { ...cached({ items: [], zero_result: true }), status: 'empty', expires_at: '2026-10-07T01:59:59Z' } }, NOW).alerts;
  assert.equal(expiredEmpty.empty, false); assert.equal(expiredEmpty.stale, true);
});

test('home template hides empty badge, timestamps and scope prose while retaining expanded alert times and visible credits', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/home/index.wxml'), 'utf8');
  assert.match(wxml, /wx:if="\{\{alertBadge\.visible\}\}" class="alert-badge/);
  assert.doesNotMatch(wxml, /citySummary\.(?:weather|air)\.(?:fetched_label|expires_label|attribution)\}\}|city\.scope_note/);
  assert.match(wxml, /citySummary\.daily\.today_available/);
  assert.match(wxml, /wx:for="\{\{citySummary\.source_notes\}\}"/);
  assert.match(wxml, /bindtap="weatherSource"[^>]*>和风天气/);
  assert.match(wxml, /data-url="\{\{item\.url\}\}"[^>]*bindtap="weatherAttribution"/);
  assert.match(wxml, /item\.issued_label/); assert.match(wxml, /item\.effective_label/); assert.match(wxml, /item\.expires_label/);
});

test('cancelled notices remain readable but never count as active even with a future expiry', () => {
  const notice = { id: 'cancelled-1', title: '预警取消通知', description: '完整取消公告正文', issued_at: '2026-10-07T01:00:00Z', effective_at: '2026-10-07T01:00:00Z', expires_at: future };
  const component = items => ({ status: 'fresh', fetched_at: '2026-10-07T01:30:00Z', expires_at: future, data: { items, zero_result: false } });
  for (const message_type of ['cancel', 'cancelled', 'canceled', 'CANCELLED', 'cancellation', '已取消', '解除']) {
    const alerts = weatherView({ alerts: component([{ ...notice, message_type }]) }, NOW).alerts;
    assert.equal(alerts.current_count, 0, message_type); assert.deepEqual(alerts.current_items, []);
    assert.equal(alerts.status, 'unknown'); assert.equal(alerts.empty, false);
    assert.equal(alerts.items[0].message_label, '已取消'); assert.equal(alerts.items[0].description, notice.description);
  }
  const mixed = weatherView({ alerts: component([{ ...notice, message_type: 'cancel' }, { ...notice, id: 'active-2', message_type: 'alert' }]) }, NOW).alerts;
  assert.equal(mixed.status, 'fresh'); assert.equal(mixed.current_count, 1); assert.equal(mixed.current_items[0].id, 'active-2'); assert.equal(mixed.items.length, 2);
});

test('tomorrow temperatures reuse existing daily rows with independent integer Celsius ranges', () => {
  const tomorrow = day({ date: '2026-10-08', starts_at: '2026-10-07T22:00:00Z', ends_at: '2026-10-08T22:00:00Z', temperature_min: -3.9, temperature_max: 18.9 });
  const source = daily({ data: { today: day(), days: [day(), tomorrow], timezone: 'Asia/Shanghai' } });
  const original = structuredClone(source);
  const view = weatherView({ daily: source }, NOW).daily;
  assert.equal(view.today_available, true); assert.equal(view.max_label, '23℃'); assert.equal(view.min_label, '0℃');
  assert.equal(view.tomorrow_available, true); assert.equal(view.tomorrow_max_label, '18℃'); assert.equal(view.tomorrow_min_label, '-3℃');
  assert.deepEqual(source, original);
  const partial = weatherView({ daily: daily({ data: { today: null, days: [{ ...tomorrow, temperature_max: null }] } }) }, NOW).daily;
  assert.equal(partial.today_available, false); assert.equal(partial.tomorrow_available, true);
  assert.equal(partial.tomorrow_max_available, false); assert.equal(partial.tomorrow_max_label, ''); assert.equal(partial.tomorrow_min_label, '-3℃');
});

test('missing, stale, expired or invalid tomorrow rows are hidden rather than inferred from today', () => {
  const tomorrow = day({ date: '2026-10-08', starts_at: '2026-10-07T22:00:00Z', ends_at: '2026-10-08T22:00:00Z' });
  const withTomorrow = (extra = {}) => daily({ data: { today: day(), days: [day(), tomorrow] }, ...extra });
  for (const source of [daily(), withTomorrow({ status: 'stale' }), withTomorrow({ status: 'unavailable' }), withTomorrow({ stale: true }),
    withTomorrow({ expires_at: '2026-10-07T02:00:00Z' }), withTomorrow({ expires_at: null }), withTomorrow({ fetched_at: future }),
    ...[{ date: '2026-10-09' }, { starts_at: 'invalid' }, { ends_at: 'invalid' }, { starts_at: '2026-10-07T00:00:00Z' },
      { ends_at: '2026-10-07T22:00:00Z' }, { temperature_unit: '°F' }, { temperature_unit: '' },
      { temperature_min: 30, temperature_max: 20 }, { temperature_min: null, temperature_max: null }, { temperature_min: NaN, temperature_max: Infinity }]
      .map(extra => withTomorrow({ data: { today: day(), days: [{ ...tomorrow, ...extra }] } }))]) {
    const view = weatherView({ daily: source }, NOW).daily;
    assert.equal(view.tomorrow_available, false, JSON.stringify(source));
    assert.equal(view.tomorrow_max_label, ''); assert.equal(view.tomorrow_min_label, '');
  }
});

test('tomorrow follows the Beijing calendar at midnight and year boundaries', () => {
  const tomorrow = day({ date: '2026-10-08', starts_at: '2026-10-07T22:00:00Z', ends_at: '2026-10-08T22:00:00Z' });
  const cached = daily({ fetched_at: '2026-10-07T15:00:00Z', expires_at: '2026-10-07T17:00:00Z', data: { days: [tomorrow], today: null } });
  assert.equal(weatherView({ daily: cached }, Date.parse('2026-10-07T15:59:59Z')).daily.tomorrow_available, true);
  assert.equal(weatherView({ daily: cached }, Date.parse('2026-10-07T16:00:00Z')).daily.tomorrow_available, false);
  const newYear = daily({ fetched_at: '2026-12-31T01:00:00Z', expires_at: '2026-12-31T07:00:00Z', data: { days: [day({ date: '2027-01-01', starts_at: '2026-12-31T22:00:00Z', ends_at: '2027-01-01T22:00:00Z', temperature_min: 0 })] } });
  const view = weatherView({ daily: newYear }, Date.parse('2026-12-31T02:00:00Z')).daily;
  assert.equal(view.tomorrow_available, true); assert.equal(view.tomorrow_min_label, '0℃');
});
