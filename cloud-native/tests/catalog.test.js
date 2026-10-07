'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const catalog = require('../../cloudfunctions/hyhqApi/lib/catalog');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-03T12:00:00.000Z';
const region = { id: uid(1), slug: 'demo-campus', name: '示范校区', is_demo: true, description: '模拟区域' };
const place = { id: uid(2), slug: 'lake', name: '湿地湖', kind: 'lake', region: region.id, description: '水资源保护', source_note: '模拟来源',
  map_layout: uid(3), x_ratio: 0.5, y_ratio: 0.2, latitude: 39, longitude: 117, coordinate_system: 'GCJ02', _updated_at: now };
const source = { id: uid(4), code: 'simulation', name: '模拟数据', kind: 'simulation', attribution: '课程生成', license: 'CC0', original_url: '' };
const station = { id: uid(5), code: 'water-01', name: '湖心站', kind: 'water', region: region.id, place: place.id, water_body: uid(6) };
const run = { id: uid(7), source, scenario: { code: 'normal', name: '日常' }, start: '2026-10-03T00:00:00Z', end: '2026-10-03T04:00:00Z', created_at: now, generator_version: 'test' };
const metric = { id: uid(8), code: 'ph', name: 'pH', unit: '', station_kind: 'water' };
function seed() {
  return { schema_version: 1, collections: { regions: [region], places: [place], maps: [{ id: uid(3), region: region.id, name: '示意图' }],
    data_sources: [source], stations: [station], water_bodies: [{ id: uid(6), _place_id: place.id, description: '科普湖泊' }],
    metrics: [metric], simulation_runs: [run], scenarios: [{ id: uid(9), code: 'normal', name: '日常' }],
    observations: ['valid', 'missing', 'suspect', 'valid'].map((quality_status, index) => ({ id: uid(20 + index), station_id: station.id,
      metric_code: metric.code, value: quality_status === 'missing' ? null : index + 6, observed_at: `2026-10-03T0${index}:00:00Z`,
      ingested_at: now, source_id: source.id, quality_status, simulation_run_id: run.id })),
    contents: [{ id: uid(30), title: '湿地植物手记', slug: 'plants', body: '湿地植物参与水资源保护，不能代表实时水质。', summary: '湿地植物',
      place: place.id, category: 'plants', plant_label: 'daisy', source: '植物园公开资料', is_demo: false, published_at: now, updated_at: now },
    { id: uid(31), title: '通用环保知识', slug: 'general', body: '通用环保手记', summary: '环保', place: null, category: 'green', plant_label: '', source: '', published_at: now }],
    routes: [{ id: uid(40), title: '湿地漫步', slug: 'wetland', region: region.id, description: '沿湿地步行观察植物', source: '公园路线说明', is_demo: true,
      _updated_at: now, stops: [{ id: uid(41), order: 1, note: '观察植物', place }] }] } };
}
function ctx(path, query = '', store = new MemoryStore(), options = {}) { return { path, query: new URLSearchParams(query), method: 'GET', store, now,
  config: { catalogSeed: seed() }, ...options }; }
const payload = async (context) => (await catalog.handle(context)).data.data;
const code = (expected) => (error) => error.code === expected;

test('bundled snapshot contains published articles/routes and only simulated observation sources', () => {
  assert.equal(snapshot.collections.contents.length, 38); assert.equal(snapshot.collections.routes.length, 31);
  assert.equal(snapshot.collections.places.length, 82);
  assert.ok(snapshot.collections.observations.length > 1000);
  assert.ok(snapshot.collections.observations.every((row) => row.source_type === 'simulation' && row.is_simulated && row.simulation_run_id));
  const serialized = JSON.stringify(snapshot);
  for (const key of ['wechat_openid', 'token_digest', 'DEEPSEEK_API_KEY', 'QWEATHER_API_KEY', 'owner_id', 'password']) assert.equal(serialized.includes('"' + key + '"'), false);
});

test('public list/detail projection preserves legacy fields without internal override metadata', async () => {
  const result = await catalog.handle(ctx('places/'));
  assert.equal(result.statusCode, 200); assert.equal(result.data.meta.count, 1);
  const row = result.data.data[0]; assert.equal(row.region_name, region.name); assert.equal(row.water_body_id, uid(6));
  assert.equal(row.is_demo, true); assert.equal('_updated_at' in row, false);
  assert.deepEqual(await payload(ctx(`places/${place.id}/`)), row);
  await assert.rejects(payload(ctx('places/not-a-uuid/')), code('NOT_FOUND'));
  assert.equal(await catalog.handle(ctx('unrelated/')), undefined);
  await assert.rejects(catalog.handle(ctx('places/', '', undefined, { method: 'POST' })), code('METHOD_NOT_ALLOWED'));
});

test('administrator overrides and withdrawals propagate through maps stations routes and knowledge', async () => {
  const store = new MemoryStore();
  await store.set('catalog', 'places_' + place.id, { id: 'places_' + place.id, kind: 'places', value: { ...place, name: '修订湖泊' } });
  assert.equal((await payload(ctx('maps/', '', store)))[0].points[0].name, '修订湖泊');
  assert.equal((await payload(ctx('routes/', '', store)))[0].stops[0].place.name, '修订湖泊');
  await store.set('catalog', 'places_' + place.id, { id: 'places_' + place.id, kind: 'places', deleted: true });
  assert.deepEqual(await payload(ctx('places/', '', store)), []);
  assert.deepEqual(await payload(ctx('stations/', '', store)), []);
  assert.deepEqual(await payload(ctx('water-bodies/', '', store)), []);
  assert.equal((await payload(ctx('maps/', '', store)))[0].points.length, 0);
  assert.equal((await payload(ctx('routes/', '', store)))[0].stop_count, 0);
  const article = await payload(ctx(`contents/${uid(30)}/`, '', store)); assert.equal(article.place, null); assert.equal(article.place_summary, null);
  assert.equal((await payload(ctx('knowledge-search/', 'q=湿地&kind=content', store))).count, 0);
  assert.equal((await payload(ctx('contents/', 'region=demo-campus', store))).length, 1);
});

test('draft content, inactive data sources and unpublished routes never become public', async () => {
  const store = new MemoryStore();
  for (const [kind, id, value] of [['contents', uid(30), { ...seed().collections.contents[0], status: 'draft' }],
    ['routes', uid(40), { ...seed().collections.routes[0], published: false }], ['data_sources', source.id, { ...source, is_active: false }]]) {
    await store.set('catalog', kind + '_' + id, { id: kind + '_' + id, kind, value });
  }
  await assert.rejects(payload(ctx(`contents/${uid(30)}/`, '', store)), code('NOT_FOUND'));
  assert.deepEqual(await payload(ctx('routes/', '', store)), []);
  assert.equal((await payload(ctx('observation-series/', 'station=water-01', store))).status, 'unavailable');
});

test('filter contracts reject unknown region/kind and duplicate parameters', async () => {
  for (const [path, query] of [['places/', 'region=no-such-region'], ['stations/', 'kind=invalid'], ['places/', 'kind=invalid'],
    ['stations/', 'region=demo-campus&region=demo-campus'], ['stations/', 'place=absent'], ['contents/', 'category=secret'],
    ['contents/', 'plant_label=../'], ['contents/', 'search=' + 'a'.repeat(101)]]) {
    await assert.rejects(payload(ctx(path, query)), (error) => [400, 404].includes(error.status));
  }
  assert.equal((await payload(ctx('places/', 'region=demo-campus&kind=lake'))).length, 1);
  assert.equal((await payload(ctx('stations/', 'place=lake&water_body=' + uid(6)))).length, 1);
});

test('content tags use the same publication, region and category filters', async () => {
  const tags = await payload(ctx('content-tags/', 'region=demo-campus&category=plants'));
  assert.deepEqual(tags.categories, [{ value: 'plants', name: '植物知识', count: 1 }]);
  assert.deepEqual(tags.plant_labels, [{ value: 'daisy', name: '雏菊类花卉', count: 1 }]);
  assert.equal(tags.content_count, 1);
});

test('keyword retrieval returns real excerpts and reviewable paths, no evidence stays explicit', async () => {
  const found = await payload(ctx('knowledge-search/', 'q=湿地&kind=all&page_size=2'));
  assert.equal(found.count, 3); assert.equal(found.results.length, 2); assert.equal(found.has_more, true);
  assert.equal(found.answer_kind, 'published_excerpts');
  assert.ok(found.results.every((row) => row.source_path.startsWith('/api/v1/') && row.source && !('score' in row)));
  const second = await payload(ctx('knowledge-search/', 'q=湿地&page_size=2&page=2')); assert.equal(second.results.length, 1);
  const empty = await payload(ctx('knowledge-search/', 'q=不存在的资料')); assert.equal(empty.answer_kind, 'no_evidence'); assert.deepEqual(empty.results, []);
  assert.match(empty.answer, /无法依据/); assert.match(empty.notice, /不联网/);
  const tags = await payload(ctx('knowledge-search/', 'plant_label=daisy&kind=content')); assert.equal(tags.count, 1);
  const placeQuery = await payload(ctx('knowledge-search/', 'place=lake')); assert.equal(placeQuery.query.place, place.id);
});

test('retrieval rejects unsupported, oversized, ambiguous and empty queries', async () => {
  for (const query of ['', 'q=a&q=b', 'q=a&external=true', 'q=a&kind=admin', 'category=plants&kind=route', 'place=none',
    'q=' + 'a'.repeat(101), 'q=a+b+c+d+e+f', 'q=a&page_size=21', 'q=a&page=0']) await assert.rejects(payload(ctx('knowledge-search/', query)), code('VALIDATION_ERROR'));
});

test('series honors a single source/run and preserves missing, suspect and empty buckets', async () => {
  const data = await payload(ctx('observation-series/', 'station=water-01&metrics=ph&start=2026-10-03T00:00:00Z&end=2026-10-03T04:00:00Z&max_points=4'));
  assert.equal(data.source.id, source.id); assert.equal(data.simulation_run_id, run.id); assert.equal(data.is_simulated, true);
  assert.equal(data.bucket_seconds, 3600); assert.equal(data.series.length, 1);
  assert.deepEqual(data.series[0].points.map((point) => point.quality_status), ['valid', 'missing', 'suspect', 'valid']);
  assert.deepEqual(data.series[0].points.map((point) => point.value), [6, null, null, 9]);
  assert.deepEqual(data.series[0].summary, { valid_count: 2, missing_count: 1, suspect_count: 1, min: 6, max: 9, mean: 7.5 });
  const mixed = await payload(ctx('observation-series/', 'station=water-01&start=2026-10-03T00:00:00Z&end=2026-10-03T04:00:00Z&max_points=1'));
  assert.equal(mixed.series[0].points[0].value, null); assert.equal(mixed.series[0].points[0].quality_status, 'suspect');
  const empty = await payload(ctx('observation-series/', 'station=water-01&start=2026-10-02T00:00:00Z&end=2026-10-02T04:00:00Z&max_points=4'));
  assert.equal(empty.status, 'unavailable'); assert.equal(empty.series[0].points.length, 4); assert.ok(empty.series[0].points.every((point) => point.value === null));
});

test('series rejects invalid windows, metrics and simulation source mixing', async () => {
  for (const query of ['station=missing', 'station=water-01&metrics=ph,ph', 'station=water-01&metrics=temperature', 'station=water-01&start=2026-10-01T00:00:00Z',
    'station=water-01&hours=745', 'station=water-01&max_points=241', 'station=water-01&source_type=secret', 'station=water-01&simulation_run=bad',
    'station=water-01&scenario=unknown', 'station=water-01&source_type=api&scenario=normal', 'station=water-01&source=missing',
    'station=water-01&start=2026-10-03T00:00:00&end=2026-10-03T04:00:00Z']) await assert.rejects(payload(ctx('observation-series/', query)), code('VALIDATION_ERROR'));
  const fixture = seed(), second = { ...source, id: uid(80), code: 'second' }, secondRun = { ...run, id: uid(81), source: second };
  fixture.collections.data_sources.push(second); fixture.collections.simulation_runs.push(secondRun);
  fixture.collections.observations.push({ ...fixture.collections.observations[0], id: uid(82), source_id: second.id, simulation_run_id: secondRun.id });
  await assert.rejects(payload(ctx('observation-series/', 'station=water-01', undefined, { config: { catalogSeed: fixture } })), code('VALIDATION_ERROR'));
  assert.equal((await payload(ctx('observation-series/', 'station=water-01&source=simulation', undefined, { config: { catalogSeed: fixture } }))).source.id, source.id);
});

test('observations simulation runs and dashboard retain source and batch counts', async () => {
  const rows = await payload(ctx('observations/', 'station=water-01&metric=ph&limit=2')); assert.equal(rows.length, 2);
  assert.equal(rows[0].source_type, 'simulation'); assert.equal(rows[0].is_simulated, true);
  const runs = await payload(ctx('simulation-runs/', 'station=water-01&scenario=normal')); assert.equal(runs[0].counts, 4);
  const dashboard = await payload(ctx('dashboard/')); assert.equal(dashboard.observation_count, 4); assert.equal(dashboard.station_count, 1); assert.equal(dashboard.place_count, 1);
  assert.equal(dashboard.latest_observations.length, 1);
});

test('weather and alerts cannot masquerade as current official observations', async () => {
  const weather = await payload(ctx('weather/')); assert.equal(weather.status, 'unavailable'); assert.equal(weather.temperature, null); assert.equal(weather.is_simulated, true);
  const air = await payload(ctx('air-quality/')); assert.equal(air.aqi, null); assert.equal(air.aqi_standard, null);
  const alerts = await payload(ctx('weather-alerts/')); assert.equal(alerts.status, 'not_connected'); assert.match(alerts.notice, /不代表/);
  await assert.rejects(payload(ctx('weather/', 'source_type=api')), code('VALIDATION_ERROR'));
});

test('nearby suggestion requires finite coordinates and matching coordinate systems without echoing location', async () => {
  assert.equal((await payload(ctx('nearby-water-bodies/', 'lat=39&lng=117&coordinate_system=GCJ02'))).match, null);
  const real = seed(); real.collections.regions[0] = { ...region, is_demo: false };
  real.collections.places[0] = { ...place, is_demo: false, coordinates_verified: true, checked_at: '2026-10-03', source_url: 'https://example.org/verified' };
  const result = await payload(ctx('nearby-water-bodies/', 'lat=39&lng=117&coordinate_system=GCJ02', new MemoryStore(), { config: { catalogSeed: real } }));
  assert.equal(result.match.water_body_id, uid(6)); assert.equal(result.match.distance_m, 0); assert.equal(result.match.suggestion_only, true);
  assert.equal('latitude' in result, false);
  assert.equal((await payload(ctx('nearby-water-bodies/', 'lat=39&lng=117&coordinate_system=WGS84'))).match, null);
  for (const query of ['', 'lat=&lng=117&coordinate_system=GCJ02', 'lat=Infinity&lng=117&coordinate_system=GCJ02', 'lat=100&lng=117&coordinate_system=GCJ02', 'lat=39&lng=117&coordinate_system=BD09'])
    await assert.rejects(payload(ctx('nearby-water-bodies/', query)), code('VALIDATION_ERROR'));
});

test('LLM server context contains the actual article and changes after revision or withdrawal even in same ctx', async () => {
  const store = new MemoryStore(), context = ctx('contents/', '', store);
  const first = await catalog.getContext(context, 'content', uid(30)); assert.equal(first.context.body, seed().collections.contents[0].body);
  assert.equal(first.citations[0].source_path, `/api/v1/contents/${uid(30)}/`);
  await store.set('catalog', 'contents_' + uid(30), { id: 'contents_' + uid(30), kind: 'contents', value: { ...seed().collections.contents[0], body: '正文已修订' } });
  const revised = await catalog.getContext(context, 'content', uid(30)); assert.notEqual(first.revision, revised.revision);
  await store.set('catalog', 'contents_' + uid(30), { id: 'contents_' + uid(30), kind: 'contents', deleted: true });
  await assert.rejects(catalog.getContext(context, 'content', uid(30)), code('SOURCE_UNAVAILABLE'));
});

test('community remains closed and narration returns no invented licensed audio', async () => {
  assert.equal((await payload(ctx('community/status/'))).enabled, false);
  await assert.rejects(payload(ctx('community/comments/')), code('COMMUNITY_DISABLED'));
  assert.equal(await payload(ctx('narrations/', 'content=' + uid(30))), null);
  await assert.rejects(payload(ctx('narrations/', 'content=' + uid(30) + '&route=' + uid(40))), code('VALIDATION_ERROR'));
  await assert.rejects(payload(ctx('narrations/' + uid(30) + '/audio/')), code('NOT_FOUND'));
});

test('page context includes only published related sources and single-batch past simulated metrics', async () => {
  const context = ctx('places/');
  const facts = await catalog.getContext(context, 'place', place.id);
  assert.equal(facts.context.articles[0].id, uid(30));
  assert.equal(facts.context.measurements.length, 1);
  assert.equal(facts.context.measurements[0].is_simulated, true); assert.equal(facts.context.measurements[0].simulation_run_id, run.id);
  assert.equal(facts.context.measurements[0].metrics[0].value, 9); assert.match(facts.context.measurements[0].notice, /非实时实测/);
  await context.store.set('catalog', 'contents_' + uid(30), { id: 'contents_' + uid(30), kind: 'contents', deleted: true });
  const changed = await catalog.getContext(context, 'place', place.id);
  assert.equal(changed.context.articles, undefined); assert.notEqual(changed.revision, facts.revision);
  assert.equal(changed.citations.some(row => row.id === uid(30)), false);
  const area = await catalog.getContext(context, 'region', region.id);
  assert.equal(area.citations[0].source_path, '/api/v1/regions/'); assert.equal(area.context.routes.length, 1);
});

test('AI simulated context does not merge ambiguous sources or include observations after the current time', async () => {
  const fixture = seed(), second = { ...source, id: uid(80), code: 'other' }, secondRun = { ...run, id: uid(81), source: second };
  fixture.collections.data_sources.push(second); fixture.collections.simulation_runs.push(secondRun);
  fixture.collections.observations.push({ ...fixture.collections.observations[0], id: uid(82), source_id: second.id, simulation_run_id: secondRun.id });
  const context = ctx('places/', '', undefined, { config: { catalogSeed: fixture } });
  assert.equal((await catalog.getContext(context, 'place', place.id)).context.measurements[0].status, 'ambiguous_source');
  const historical = ctx('places/', '', undefined, { now: '2026-10-03T00:30:00Z' });
  const data = await catalog.getContext(historical, 'place', place.id);
  assert.equal(data.context.measurements[0].metrics[0].value, 6);
});

test('every bundled region builds usable bounded LLM facts while retaining its primary page and source', async () => {
  const { factsFor } = require('../../cloudfunctions/hyhqApi/lib/llm');
  for (const area of snapshot.collections.regions) for (const scope of ['learn', 'explore']) {
    const context = ctx('regions/', '', undefined, { config: {} });
    const session = { scope, source_type: 'region', source_id: area.id, expires_at: '2026-10-04T12:00:00Z', weather_location: '' };
    const facts = await factsFor(context, session, {});
    assert.equal(facts.context.current_page.id, area.id); assert.equal(facts.context.current_page.name, area.name);
    assert.equal(facts.context.current_page.is_demo, area.is_demo); assert.ok(Buffer.byteLength(JSON.stringify(facts.context.current_page)) <= 6300);
    assert.ok(facts.source.citations.some(row => row.id === area.id && row.source_path === '/api/v1/regions/'));
    assert.equal(facts.context.weather.status, 'unavailable');
  }
});

test('omitted supplementary facts still affect the server revision and never leave detached citations', async () => {
  const context = ctx('regions/', '', undefined, { config: {} });
  const area = snapshot.collections.regions[0];
  const before = await catalog.getContext(context, 'region', area.id);
  assert.ok(Buffer.byteLength(JSON.stringify(before.context)) <= 6000);
  const included = new Set((before.context.places || []).map(row => row.id));
  // Use an originally selected but budget-omitted supplemental place.
  const relevant = snapshot.collections.places.filter(row => row.region === area.id).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id)).slice(0, 6);
  const removed = relevant.find(row => !included.has(row.id)); assert.ok(removed);
  await context.store.set('catalog', 'places_' + removed.id, { id: 'places_' + removed.id, kind: 'places', value: { ...removed, description: '已编辑而没有附入短上下文的资料' } });
  const edited = await catalog.getContext(context, 'region', area.id); assert.notEqual(edited.revision, before.revision);
  assert.ok(edited.citations.every(row => row.kind !== 'content' || (edited.context.articles || []).some(article => article.id === row.id)));
});
