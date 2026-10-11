const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SCENARIOS, METRICS } = require('../lib/simulation-journal');
const click = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
function fixture() {
  let definition;
  global.Component = value => { definition = value; };
  global.wx = { getWindowInfo: () => ({ pixelRatio: 2 }) };
  const file = require.resolve('../components/simulation-journal/index'); delete require.cache[file]; require(file);
  const queries = [], writes = [], events = [];
  const instance = {
    ...definition.methods, data: structuredClone(definition.data),
    setData(value, callback) { Object.assign(this.data, value); writes.push(value); if (callback) callback(); },
    triggerEvent(name, detail) { events.push({ name, detail }); },
    createSelectorQuery() {
      const query = { select(selector) { assert.equal(selector, '.simulation-canvas'); return query; }, fields(options, callback) { assert.deepEqual(options, { node: true, size: true }); queries.push(callback); return query; }, exec() {} };
      return query;
    },
  };
  definition.lifetimes.attached.call(instance); definition.lifetimes.ready.call(instance);
  function bounds() {
    const commands = [], ctx = {};
    for (const method of ['scale', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill']) ctx[method] = (...args) => commands.push({ method, args });
    const node = { getContext(kind) { assert.equal(kind, '2d'); return ctx; } };
    return { node, width: 320, height: 160, commands, ctx };
  }
  return { definition, instance, queries, writes, events, bounds };
}

test('simulation starts expanded with four local scenarios and four consistent metrics and table columns', () => {
  const f = fixture(), state = f.instance.data;
  assert.equal(state.scenario.id, 'steady'); assert.equal(state.metric.id, 'oxygen');
  assert.equal(state.scenarios.length, 4); assert.equal(state.metrics.length, 4);
  assert.equal(state.rows.length, 7); assert.equal(state.showTable, false);
  for (const scenario of SCENARIOS) {
    f.instance.chooseScenario(click('id', scenario.id));
    for (const metric of METRICS) {
      f.instance.chooseMetric(click('id', metric.id));
      const chosen = f.instance.data;
      assert.deepEqual(chosen.values, scenario.series[metric.id]);
      assert.equal(chosen.minimum, Math.min(...chosen.values)); assert.equal(chosen.maximum, Math.max(...chosen.values));
      assert.equal(chosen.metric.id, metric.id); assert.equal(chosen.scenario.id, scenario.id);
      for (const [index, row] of chosen.rows.entries()) {
        assert.match(row.time, /^\d{2}:00$/);
        assert.deepEqual(row.values, METRICS.map(column => ({ id: column.id, value: scenario.series[column.id][index] })));
      }
      assert.deepEqual(chosen.metrics.map(item => item.value), METRICS.map(column => scenario.series[column.id][3]));
    }
  }
  assert.equal(state.rows[0].time, '06:00'); assert.equal(state.rows[6].time, '24:00');
});

test('table disclosure retains selected scenario and metric, while malformed events cannot alter data', () => {
  const f = fixture();
  f.instance.chooseScenario(click('id', 'rain')); f.instance.chooseMetric(click('id', 'turbidity'));
  f.instance.toggleTable(); assert.equal(f.instance.data.showTable, true);
  assert.equal(f.instance.data.scenario.id, 'rain'); assert.equal(f.instance.data.metric.id, 'turbidity');
  const before = structuredClone(f.instance.data), count = f.queries.length;
  for (const event of [null, {}, { currentTarget: {} }, click('id', 'missing'), click('id', '__proto__')]) {
    f.instance.chooseScenario(event); f.instance.chooseMetric(event); f.instance.navigate(event);
  }
  assert.deepEqual(f.instance.data, before); assert.equal(f.queries.length, count); assert.deepEqual(f.events, []);
  f.instance.toggleTable(); assert.equal(f.instance.data.showTable, false);
});

test('only the two known simulation destinations emit navigation', () => {
  const f = fixture();
  for (const destination of ['water', 'data-center', 'llm', 'profile', 'https://example.com']) f.instance.navigate(click('page', destination));
  assert.deepEqual(f.events, [{ name: 'navigate', detail: { page: 'water' } }, { name: 'navigate', detail: { page: 'data-center' } }]);
});

test('simulation reminder opens an independent modal without navigation or depending on the selected curve', () => {
  const f = fixture();
  f.instance.chooseScenario(click('id', 'rain'));
  f.instance.bookReminder();
  assert.deepEqual(f.events, []); assert.equal(f.instance.data.showReminder, true); f.instance.closeReminder(); assert.equal(f.instance.data.showReminder, false);
  f.definition.pageLifetimes.hide.call(f.instance);
  f.instance.bookReminder();
  assert.equal(f.events.length, 0); assert.equal(f.instance.data.showReminder, false);
});

test('reminder removes the native canvas, ignores queued drawing, then redraws the current chart after closing', () => {
  const f = fixture(), pending = f.queries[0], priorQueries = f.queries.length;
  f.instance.bookReminder();
  const stale = f.bounds(); pending(stale); pending(null);
  f.instance.draw(); f.instance.canvasFailure(); f.definition.observers.appearance.call(f.instance); f.definition.pageLifetimes.resize.call(f.instance);
  assert.equal(stale.commands.length, 0); assert.equal(f.queries.length, priorQueries);
  assert.equal(f.instance.data.chartError, ''); assert.equal(f.instance.data.showTable, false);
  f.instance.chooseScenario(click('id', 'heat')); assert.equal(f.queries.length, priorQueries);
  f.instance.closeReminder(); assert.equal(f.instance.data.showReminder, false); assert.equal(f.queries.length, priorQueries + 1);
  const current = f.bounds(); f.queries.at(-1)(current);
  assert.equal(current.ctx.strokeStyle, SCENARIOS.find(item => item.id === 'heat').color);
  assert.equal(current.commands.filter(command => command.method === 'arc').length, 7);
  const markup = fs.readFileSync(path.join(__dirname, '../components/simulation-journal/index.wxml'), 'utf8');
  assert.match(markup, /<canvas wx:if="\{\{!showReminder\}\}"/);
  assert.match(markup, /<view wx:else class="simulation-chart-placeholder"/);
});

test('leaving with a reminder open cannot redraw off-screen and returning restores the chart', () => {
  const f = fixture(); f.instance.bookReminder(); f.definition.pageLifetimes.hide.call(f.instance);
  const priorQueries = f.queries.length; f.instance.closeReminder();
  assert.equal(f.queries.length, priorQueries); assert.equal(f.instance.data.showReminder, false);
  f.definition.pageLifetimes.show.call(f.instance); assert.equal(f.queries.length, priorQueries + 1);
  const current = f.bounds(); f.queries.at(-1)(current); assert.equal(current.commands.filter(command => command.method === 'arc').length, 7);
});

test('same-layer chart draws all seven points within its bounds and scales for screen density', () => {
  const f = fixture(), bounds = f.bounds(); f.queries.at(-1)(bounds);
  assert.equal(bounds.node.width, 640); assert.equal(bounds.node.height, 320);
  assert.deepEqual(bounds.commands[0], { method: 'scale', args: [2, 2] });
  const points = bounds.commands.filter(command => command.method === 'arc'); assert.equal(points.length, 7);
  for (const point of points) { assert.ok(point.args[0] >= 14 && point.args[0] <= 306); assert.ok(point.args[1] >= 20 && point.args[1] <= 140); }
  assert.equal(bounds.ctx.strokeStyle, SCENARIOS[0].color); assert.equal(f.instance.data.chartError, '');
  const markup = fs.readFileSync(path.join(__dirname, '../components/simulation-journal/index.wxml'), 'utf8');
  assert.match(markup, /<canvas[^>]*type="2d"/); assert.doesNotMatch(markup, /canvas-id=/);
  assert.match(markup, /科普模拟 · 非实测/); assert.match(markup, /海晏河清示范校园/);
});

test('missing canvas or unsupported drawing degrades to complete numeric data and can recover', () => {
  for (const failure of [null, { width: 0, height: 160, node: {} }, { width: 320, height: 160, node: { getContext() { throw new Error('unsupported'); } } }]) {
    const f = fixture(); f.queries.at(-1)(failure);
    assert.match(f.instance.data.chartError, /图表暂不可用/); assert.equal(f.instance.data.showTable, true); assert.equal(f.instance.data.rows.length, 7);
    f.instance.chooseScenario(click('id', 'check')); f.instance.chooseMetric(click('id', 'ph'));
    assert.equal(f.instance.data.rows[3].values.find(item => item.id === 'ph').value, 9.1);
    const bounds = f.bounds(); f.queries.at(-1)(bounds);
    assert.equal(f.instance.data.chartError, ''); assert.equal(f.instance.data.showTable, true);
  }
});

test('an earlier chart query cannot draw stale data or replace a later successful chart with an error', () => {
  const f = fixture(), first = f.queries[0];
  f.instance.chooseScenario(click('id', 'heat')); const latest = f.queries.at(-1), stale = f.bounds(), current = f.bounds();
  first(stale); assert.equal(stale.commands.length, 0);
  latest(current); assert.equal(current.ctx.strokeStyle, SCENARIOS.find(item => item.id === 'heat').color);
  first(null); assert.equal(f.instance.data.chartError, ''); assert.equal(f.instance.data.showTable, false);
});

test('hidden and detached components ignore late drawing, input, theme and resize callbacks', () => {
  for (const detached of [false, true]) {
    const f = fixture(), pending = f.queries[0];
    if (detached) f.definition.lifetimes.detached.call(f.instance);
    else f.definition.pageLifetimes.hide.call(f.instance);
    const writes = f.writes.length, count = f.queries.length, before = structuredClone(f.instance.data), bounds = f.bounds();
    pending(bounds); f.instance.draw(); f.instance.canvasFailure(); f.instance.chooseScenario(click('id', 'rain'));
    f.instance.chooseMetric(click('id', 'ph')); f.instance.toggleTable(); f.instance.navigate(click('page', 'water'));
    f.definition.observers.appearance.call(f.instance); f.definition.pageLifetimes.resize.call(f.instance);
    assert.equal(f.writes.length, writes); assert.equal(f.queries.length, count); assert.equal(bounds.commands.length, 0);
    assert.deepEqual(f.instance.data, before); assert.deepEqual(f.events, []);
    f.definition.pageLifetimes.show.call(f.instance);
    assert.equal(f.queries.length, count + (detached ? 0 : 1));
  }
});

test('a queued setData drawing callback after navigation cannot query a hidden component', () => {
  const f = fixture(); let finish;
  f.instance.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) finish = callback; };
  f.instance.chooseMetric(click('id', 'temperature')); assert.equal(typeof finish, 'function');
  const count = f.queries.length; f.definition.pageLifetimes.hide.call(f.instance); finish();
  assert.equal(f.queries.length, count);
});
