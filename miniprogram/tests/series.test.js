const test = require('node:test');
const assert = require('node:assert/strict');
const { WATER_METRICS, rangeQuery, seriesView, chartGeometry, createSeriesPage } = require('../lib/series');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const at = (hour) => new Date(Date.UTC(2026, 8, 18, hour)).toISOString();
const point = (hour, value, quality = 'valid') => ({ at: at(hour), value, quality_status: quality, valid_count: quality === 'valid' ? 1 : 0, missing_count: quality === 'missing' ? 1 : 0, suspect_count: quality === 'suspect' ? 1 : 0 });
function payload(code = 'ph', marker = 'fresh') { return {
  status: 'available', source_type: 'simulation', source: { id: 'sim', name: marker }, simulation_run_id: 'new',
  window: { start: at(0), end: at(6) }, bucket_seconds: 3600, notice: '模拟数据，仅作演示',
  series: [{ metric: { code, name: code, unit: 'mg/L' }, latest: { value: 0, quality_status: 'valid', observed_at: at(5) },
    summary: { min: 0, max: 4, mean: 2, valid_count: 3, missing_count: 1, suspect_count: 1 }, points: [point(0, 0), point(1, 2), point(2, null, 'missing'), point(3, 3, 'suspect'), point(4, 4)] }],
}; }
function fixture() {
  const calls = [];
  const regions = [{ id: 'r1', slug: 'demo-campus', name: '示范校区' }, { id: 'r2', slug: 'river-b', name: '校区二' }];
  const sources = [{ id: 'sim', kind: 'simulation', name: '正常模拟' }, { id: 'anomaly', kind: 'simulation', name: '浊度模拟' }, { id: 'manual', kind: 'manual', name: '人工资料' }];
  const waters = [{ id: 'w1', region: 'r1', name: '河一' }, { id: 'w2', region: 'r1', name: '河二' }, { id: 'w3', region: 'r2', name: '河三' }];
  const stations = [{ id: 's1', region: 'r1', water_body: 'w1', kind: 'water', name: '水一' }, { id: 's2', region: 'r1', water_body: 'w2', kind: 'water', name: '水二' }, { id: 'sa', region: 'r1', kind: 'air', name: '空气一' }, { id: 'sw', region: 'r1', kind: 'weather', name: '天气一' }, { id: 's3', region: 'r2', water_body: 'w3', kind: 'water', name: '水三' }];
  const runs = [{ id: 'new', source: sources[0], scenario: { code: 'normal', name: '正常' }, start: at(-42), end: at(6), created_at: at(7) },
    { id: 'old', source: sources[0], scenario: { code: 'normal', name: '正常' }, start: at(-66), end: at(-18), created_at: at(-17) },
    { id: 'turbid', source: sources[1], scenario: { code: 'turbidity', name: '浊度升高' }, start: at(-42), end: at(6), created_at: at(8) }];
  const app = { globalData: {}, api: { request: async (path, options = {}) => {
    const query = options.data || {}; calls.push({ path, query });
    if (path === 'regions/') return { data: regions };
    if (path === 'data-sources/') return { data: sources };
    if (path === 'water-bodies/') return { data: waters.filter((item) => item.region === query.region) };
    if (path === 'stations/') return { data: stations.filter((item) => item.region === query.region && (!query.kind || item.kind === query.kind) && (!query.water_body || item.water_body === query.water_body)) };
    if (path === 'simulation-runs/') return { data: runs.filter((item) => item.source.id === query.source) };
    if (path === 'observation-series/') return { data: payload(query.metrics ? 'ph' : query.station) };
    throw new Error('Unexpected API: ' + path);
  } } };
  return { app, calls, regions, sources, stations, runs };
}
function page(mode, app) {
  global.wx = { stopPullDownRefresh() {} };
  global.getApp = () => app;
  const definition = createSeriesPage(mode);
  const instance = { ...definition, data: structuredClone(definition.data), patches: [] };
  instance.setData = (patch) => { instance.patches.push(patch); Object.assign(instance.data, patch); };
  return instance;
}
const change = (value) => ({ detail: { value: String(value) } });

test('series values preserve zero, gaps, suspect status and original observation time', () => {
  const view = seriesView(payload());
  assert.equal(view.series[0].latest_label, '0');
  assert.equal(view.series[0].latest_time, '2026-09-18 13:00 UTC+8');
  assert.equal(view.series[0].points[0].value_label, '0');
  assert.equal(view.series[0].points[2].value, null);
  assert.equal(view.series[0].points[3].value, null);
  assert.equal(view.series[0].points[3].quality_label, '存疑，未连线');
  assert.equal(view.series[0].has_values, true);
  const invalid = payload(); invalid.series[0].latest.quality_status = 'suspect';
  assert.equal(seriesView(invalid).series[0].latest_label, '—');
  assert.equal(seriesView(invalid).series[0].latest_quality, '存疑');
});

test('chart geometry breaks both missing and suspect buckets, includes zero and handles one constant point', () => {
  const geometry = chartGeometry(payload().series[0].points, 320, 210, { start: at(0), end: at(6) });
  assert.deepEqual(geometry.segments.map((segment) => segment.length), [2, 1]);
  assert.ok(geometry.segments.flat().every((item) => Number.isFinite(item.x) && Number.isFinite(item.y)));
  const one = chartGeometry([point(0, 0)], 320, 210, {});
  assert.equal(one.segments.length, 1); assert.ok(one.minimum < 0 && one.maximum > 0);
  assert.equal(chartGeometry([point(0, null, 'missing')], 320, 210, {}), null);
  assert.equal(chartGeometry(Array.from({ length: 241 }, () => point(0, 0)), 320, 210, {}), null);
  assert.equal(chartGeometry([point(0, Infinity)], 320, 210, {}), null);
});

test('rangeQuery uses the run half-open boundary and clamps to the run start without excluding its final sample', () => {
  const run = { start: at(0), end: at(6) };
  assert.deepEqual(rangeQuery(run, 48), { start: at(0), end: at(6) });
  assert.deepEqual(rangeQuery(run, 2), { start: at(4), end: at(6) });
  assert.ok(at(5) < rangeQuery(run, 2).end);
  assert.throws(() => rangeQuery({ start: at(6), end: at(0) }, 48), /批次时间无效/);
  assert.throws(() => rangeQuery({ end: 'invalid' }, 48), /批次时间无效/);
  assert.throws(() => rangeQuery(run, -1), /时间范围无效/);
});

test('water page requests the four metrics and respects region, water-body and station selection', async () => {
  const { app, calls } = fixture(); const instance = page('water', app);
  await instance.onLoad({ region: 'r1', waterBodyId: 'w2' });
  assert.equal(instance.data.waterIndex, 1); assert.equal(instance.data.stations[0].id, 's2');
  let query = calls.findLast((item) => item.path === 'observation-series/').query;
  assert.equal(query.station, 's2'); assert.equal(query.metrics, WATER_METRICS.join(',')); assert.equal(query.max_points, 48);
  assert.equal(query.source, 'sim'); assert.equal(query.simulation_run, 'new');
  await instance.changeWater(change(0));
  assert.equal(calls.findLast((item) => item.path === 'observation-series/').query.station, 's1');
  await instance.changeRegion(change(1));
  assert.equal(instance.data.waterBodies[0].id, 'w3'); assert.equal(app.globalData.region.id, 'r2');
  assert.equal(calls.findLast((item) => item.path === 'observation-series/').query.station, 's3');
  assert.equal(instance.data.loading, false); assert.equal(instance.data.error, '');
});

test('data center route chooses an air station then independently filters kind, source, scenario, run and range', async () => {
  const { app, calls } = fixture(); const instance = page('data-center', app);
  await instance.onLoad({ region: 'r1', stationId: 'sa' });
  assert.equal(instance.data.kindIndex, 1); assert.equal(instance.data.stations[0].id, 'sa');
  await instance.changeRun(change(1)); await instance.changeRange(change(0));
  let query = calls.findLast((item) => item.path === 'observation-series/').query;
  assert.equal(query.simulation_run, 'old'); assert.equal(query.start, at(-24)); assert.equal(query.end, at(-18)); assert.equal(query.max_points, 6);
  assert.equal(query.metrics, undefined);
  await instance.load(); assert.equal(instance.data.runs[instance.data.runIndex].id, 'old');
  await instance.changeSource(change(1));
  query = calls.findLast((item) => item.path === 'observation-series/').query;
  assert.equal(query.source, 'anomaly'); assert.equal(query.simulation_run, 'turbid');
  assert.deepEqual(instance.data.scenarios.map((item) => item.code), ['turbidity']);
  await instance.changeScenario(change(0)); assert.equal(instance.data.selectedRun.id, 'turbid');
  await instance.changeKind(change(2)); assert.equal(instance.data.stations[0].id, 'sw');
  await instance.changeSource(change(2));
  query = calls.findLast((item) => item.path === 'observation-series/').query;
  assert.equal(query.source_type, 'manual'); assert.equal(query.source, 'manual');
  assert.equal(query.simulation_run, undefined); assert.equal(query.scenario, undefined);
  assert.deepEqual(instance.data.runs, []); assert.deepEqual(instance.data.scenarios, []);
});

test('metric selection only changes the displayed metric without new network traffic', async () => {
  const { app, calls } = fixture(); const base = app.api.request;
  app.api.request = async (path, options) => { const response = await base(path, options); if (path === 'observation-series/') response.data.series.push(payload('turbidity').series[0]); return response; };
  const instance = page('water', app); await instance.onLoad({}); const count = calls.length;
  instance.changeMetric(change(1)); assert.equal(instance.data.activeMetric.metric.code, 'turbidity'); assert.equal(calls.length, count);
  await instance.changeRange(change(0)); assert.equal(instance.data.activeMetric.metric.code, 'turbidity');
});

test('public catalogues consume all pages before selecting a routed station', async () => {
  const { app } = fixture(); const base = app.api.request;
  app.api.request = async (path, options) => {
    if (path === 'regions/') return { data: [{ id: 'unused', slug: 'unused' }], meta: { next: 'regions/?page=2' } };
    if (path === 'regions/?page=2') return { data: [{ id: 'r1', slug: 'demo-campus' }] };
    return base(path, options);
  };
  const instance = page('data-center', app); await instance.onLoad({ stationId: 'sa' });
  assert.equal(instance.data.region.id, 'r1'); assert.equal(instance.data.kindIndex, 1);
});

test('absent regions, stations, sources, runs and empty series remain explicit non-fabricated states', async () => {
  for (const absent of ['regions/', 'water-bodies/', 'stations/', 'data-sources/', 'simulation-runs/']) {
    const { app, calls } = fixture(); const base = app.api.request;
    app.api.request = (path, options) => path === absent ? Promise.resolve({ data: [] }) : base(path, options);
    const instance = page('water', app); await instance.onLoad({});
    assert.equal(instance.data.loading, false, absent); assert.equal(instance.data.error, '', absent);
    assert.ok(instance.data.selectionNotice, absent); assert.equal(instance.data.view, null, absent);
    assert.equal(calls.some((item) => item.path === 'observation-series/'), false, absent);
  }
  const { app } = fixture(); const base = app.api.request;
  app.api.request = (path, options) => path === 'observation-series/' ? Promise.resolve({ data: { status: 'unavailable', series: [] } }) : base(path, options);
  const instance = page('water', app); await instance.onLoad({});
  assert.equal(instance.data.view.status, 'unavailable'); assert.equal(instance.data.activeMetric, null);
});

test('request failure is visible and retry reloads the selected catalogue and series', async () => {
  const { app } = fixture(); const base = app.api.request; let fail = true;
  app.api.request = (path, options) => path === 'observation-series/' && fail ? Promise.reject(new Error('网络不可用')) : base(path, options);
  const instance = page('water', app); await instance.onLoad({});
  assert.equal(instance.data.error, '网络不可用'); assert.equal(instance.data.view, null); assert.equal(instance.data.loading, false);
  fail = false; await instance.load(); assert.equal(instance.data.error, ''); assert.equal(instance.data.view.status, 'available');
});

test('an older range response cannot overwrite a newer selection or stop its loading state', async () => {
  const { app } = fixture(); const instance = page('water', app); await instance.onLoad({});
  const older = deferred(), newer = deferred(); let requests = 0;
  app.api.request = () => ++requests === 1 ? older.promise : newer.promise;
  const first = instance.changeRange(change(0)), second = instance.changeRange(change(1));
  older.resolve({ data: payload('ph', 'old') }); await first;
  assert.equal(instance.data.loading, true); assert.equal(instance.data.view, null);
  newer.resolve({ data: payload('ph', 'new') }); await second;
  assert.equal(instance.data.view.source_name, 'new'); assert.equal(instance.data.loading, false);
});

test('hide and unload reject pending responses; show reloads with the shared region', async () => {
  const { app } = fixture(); const instance = page('water', app); await instance.onLoad({});
  const base = app.api.request; const pending = deferred();
  app.api.request = () => pending.promise;
  const request = instance.changeRange(change(0)); instance.onHide(); const patches = instance.patches.length;
  pending.resolve({ data: payload('ph', 'hidden') }); await request; assert.equal(instance.patches.length, patches);
  app.api.request = base; app.globalData.region = { id: 'r2' }; await instance.onShow();
  assert.equal(instance.data.region.id, 'r2'); assert.equal(instance.data.stations[0].id, 's3');
  const later = deferred(); app.api.request = () => later.promise;
  const request2 = instance.changeRange(change(1)); instance.onUnload(); const count = instance.patches.length;
  later.resolve({ data: payload('ph', 'unloaded') }); await request2; assert.equal(instance.patches.length, count);
});

function component() {
  let definition; global.Component = (value) => { definition = value; };
  const path = require.resolve('../components/trend-chart/index'); delete require.cache[path]; require(path);
  const instance = { ...definition.methods, data: { ...structuredClone(definition.data), entry: seriesView(payload()).series[0], start: at(0), end: at(6) }, patches: [] };
  instance.setData = (patch) => { instance.patches.push(patch); Object.assign(instance.data, patch); };
  definition.lifetimes.attached.call(instance);
  return { instance, definition };
}

test('Canvas failures automatically reveal the equivalent text table', () => {
  const { instance } = component(); instance.createSelectorQuery = () => { throw new Error('unsupported'); };
  instance.render(); assert.equal(instance.data.showTable, true); assert.match(instance.data.chartError, /数据表/);
  instance.toggleTable(); assert.equal(instance.data.showTable, false);
});

test('Canvas drawing uses separate segments and rejects a callback after hide, detach or superseding redraw', () => {
  const { instance, definition } = component(); const callbacks = [], operations = [];
  instance.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect(callback) { callbacks.push(callback); return this; }, exec() {} });
  const context = {};
  for (const name of ['clearRect', 'setFontSize', 'setFillStyle', 'fillText', 'setStrokeStyle', 'setLineWidth', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'draw']) context[name] = (...args) => operations.push({ name, args });
  global.wx = { createCanvasContext: () => context };
  instance.render(); instance.render(); callbacks.shift()({ width: 320, height: 210 }); assert.equal(operations.length, 0);
  callbacks.shift()({ width: 320, height: 210 }); assert.equal(operations.filter((item) => item.name === 'arc').length, 3);
  instance.render(); definition.pageLifetimes.hide.call(instance); const total = operations.length;
  callbacks.shift()({ width: 320, height: 210 }); assert.equal(operations.length, total);
  definition.pageLifetimes.show.call(instance); definition.lifetimes.detached.call(instance);
  callbacks.shift()({ width: 320, height: 210 }); assert.equal(operations.length, total);
});

 test('normal simulation is the initial default even when the missing scenario sorts first', async () => {
  const { app, sources } = fixture();
  sources[0].code = 'demo-normal'; sources[1].code = 'demo-missing';
  sources.unshift(sources.splice(1, 1)[0]);
  const instance = page('data-center', app); await instance.onLoad({});
  assert.equal(instance.data.sources[instance.data.sourceIndex].code, 'demo-normal');
  assert.equal(instance.data.selectedRun.scenario.code, 'normal');
});


test('queued filter and retry callbacks after hide or unload neither write state nor start requests', async () => {
  const handlers = ['changeMetric', 'changeRegion', 'changeKind', 'changeWater', 'changeStation', 'changeSource', 'changeScenario', 'changeRun', 'changeRange', 'load', 'onPullDownRefresh'];
  for (const mode of ['water', 'data-center']) {
    for (const lifecycle of ['onHide', 'onUnload']) {
      const { app, calls } = fixture(); const instance = page(mode, app); await instance.onLoad({});
      instance[lifecycle]();
      const patches = instance.patches.length, requests = calls.length, generation = instance._generation;
      const data = structuredClone(instance.data), region = structuredClone(app.globalData.region);
      for (const handler of handlers) {
        await instance[handler](change(handler === 'changeRegion' ? 1 : 0));
        assert.equal(instance.patches.length, patches, `${mode}/${lifecycle}/${handler}: no state write`);
        assert.equal(calls.length, requests, `${mode}/${lifecycle}/${handler}: no request`);
        assert.deepEqual(app.globalData.region, region, `${mode}/${lifecycle}/${handler}: shared region unchanged`);
      }
      assert.deepEqual(instance.data, data); assert.equal(instance._generation, generation);
      await instance.onShow();
      if (lifecycle === 'onHide') {
        assert.ok(calls.length > requests); assert.ok(instance.patches.length > patches);
        assert.equal(instance.data.loading, false); assert.equal(instance.data.view.status, 'available');
      } else {
        assert.equal(instance.patches.length, patches); assert.equal(calls.length, requests);
      }
    }
  }
});


test('measurement screens preserve filters when collapsed and card taps select existing metrics without requests', async () => {
  for (const mode of ['water', 'data-center']) {
    let definition;
    global.Page = (value) => { definition = value; };
    const modulePath = require.resolve('../pages/' + mode + '/index');
    delete require.cache[modulePath]; require(modulePath);
    const { app, calls } = fixture();
    global.wx = { stopPullDownRefresh() {} };
    global.getApp = () => app;
    const base = app.api.request;
    app.api.request = async (path, options) => {
      const response = await base(path, options);
      if (path === 'observation-series/') response.data.series.push(payload('turbidity').series[0]);
      return response;
    };
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = (patch) => Object.assign(instance.data, patch);
    await instance.onLoad({});
    await instance.changeRun(change(1));
    const count = calls.length;
    instance.toggleFilters(); instance.toggleFilters(); instance.toggleProvenance();
    instance.selectMetricCard({ currentTarget: { dataset: { index: 1 } } });
    assert.equal(instance.data.advancedFilters, false);
    assert.equal(instance.data.selectedRun.id, 'old');
    assert.equal(instance.data.metricIndex, 1);
    assert.equal(instance.data.activeMetric.metric.code, 'turbidity');
    instance.selectMetricCard({ currentTarget: { dataset: { index: 99 } } });
    assert.equal(instance.data.metricIndex, 1);
    assert.equal(calls.length, count);
    instance.onHide(); instance.setData = () => { throw new Error('late measurement callback'); };
    instance.toggleFilters(); instance.toggleProvenance();
    instance.selectMetricCard({ currentTarget: { dataset: { index: 0 } } });
  }
});
