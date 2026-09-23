const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEMO_IMAGE, dimensions, imageResource, mapPoints, geometry, projection, clampPan, zoomPan } = require('../lib/map-layout');

const region = { id: 'demo', slug: 'demo-campus', name: '虚构校园', is_demo: true };
const otherRegion = { id: 'other', slug: 'another', name: '其他区域', is_demo: false };
const point = (id, extra = {}) => ({ id, name: id, region: 'demo', map_layout: 'map-v1', x_ratio: .26, y_ratio: .48, kind: 'river', ...extra });
const map = (extra = {}) => ({ id: 'map-v1', region: 'demo', version: 1, name: '原创示范', image_url: DEMO_IMAGE, image_width: 1000, image_height: 700, points: [point('river'), point('plant', { kind: 'plant', x_ratio: .35, y_ratio: .25 })], ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function page(api, selectedRegion = null) {
  let definition;
  const application = { globalData: { region: selectedRegion }, api };
  global.Page = (input) => { definition = input; };
  global.getApp = () => application;
  const navigation = [];
  global.wx = { stopPullDownRefresh() {}, getWindowInfo: () => ({ windowWidth: 375 }), navigateTo: (options) => navigation.push(options.url) };
  const modulePath = require.resolve('../pages/explore/index');
  delete require.cache[modulePath];
  require(modulePath);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return { instance, application, navigation };
}
function fixtureApi(extra = {}) {
  const fixtures = { 'regions/': [region], 'places/': map().points, 'maps/': [map()], ...extra };
  return { request: async (url) => {
    if (fixtures[url] instanceof Error) throw fixtures[url];
    return { data: fixtures[url] };
  } };
}
function event(instance, details = {}, dataset = {}) {
  return { currentTarget: { dataset: { generation: instance.data.imageGeneration, viewport: instance.data.viewportGeneration, ...dataset } }, detail: details };
}
function imageReady(instance) { instance.imageLoaded(event(instance, { width: instance.data.activeMap.image_width, height: instance.data.activeMap.image_height })); }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`); }

test('real city landmarks without coordinates stay browsable without a fictional map', async () => {
  const landmarks = ['landmark', 'trail', 'campus'].map((kind) => ({ id: kind, name: kind, kind, region: 'other', map_layout: null }));
  const { instance } = page(fixtureApi({ 'regions/': [otherRegion], 'places/': landmarks, 'maps/': [] }), otherRegion);
  await instance.onShow();
  assert.equal(instance.data.viewMode, 'list');
  assert.equal(instance.data.activeMap, null);
  assert.equal(instance.data.markers.length, 0);
  instance.setData({ activeType: 'walk' }); instance.filter();
  assert.deepEqual(instance.data.filtered.map((item) => item.id), ['landmark', 'trail']);
  instance.setData({ activeType: 'campus' }); instance.filter();
  assert.deepEqual(instance.data.filtered.map((item) => item.id), ['campus']);
});

test('original PNG dimensions agree with its strict registered region and version', () => {
  const png = fs.readFileSync(path.join(__dirname, '../assets/maps/demo-campus-v1.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1000);
  assert.equal(png.readUInt32BE(20), 700);
  assert.equal(imageResource(map(), region).src, DEMO_IMAGE);
  for (const [layout, area] of [[map({ version: 2 }), region], [map(), { ...region, is_demo: false }], [map(), { ...region, slug: 'different' }], [map(), otherRegion], [map({ image_width: 900 }), region], [map({ image_url: '/arbitrary.png' }), region]]) {
    assert.equal(imageResource(layout, area).src, '');
    assert.ok(imageResource(layout, area).notice);
  }
  assert.equal(imageResource(map({ image_url: 'https://example.com/map-v2.png', version: 2 }), region).src, 'https://example.com/map-v2.png');
  assert.equal(imageResource(map({ image_url: 'http://example.com/map.png' }), region).src, '');
  assert.equal(imageResource(map({ image_url: 'https://example.com/map.png' }), otherRegion).src, '');
  for (const size of [null, 0, -1, '1000', 1.2, 8193, Infinity]) assert.equal(dimensions(map({ image_width: size })), null);
});

test('map points are isolated by layout and region and require finite relative coordinates', () => {
  const candidates = [point('valid'), point('valid'), point('corner', { x_ratio: 0, y_ratio: 1 }), point('wrong-map', { map_layout: 'map-v2' }), point('wrong-region', { region: 'other' }), point('missing', { x_ratio: null }), point('string', { y_ratio: '.4' }), point('outside', { x_ratio: 1.01 }), point('negative', { y_ratio: -.01 }), point('nan', { x_ratio: NaN }), null];
  assert.deepEqual(mapPoints(map({ points: candidates }), region).map((item) => item.id), ['valid', 'corner']);
  assert.deepEqual(mapPoints(map(), otherRegion), []);
});

test('relative projection shares the image aspect ratio and zoom keeps the viewport center', () => {
  const original = geometry(map(), 343, 1), enlarged = geometry(map(), 343, 2);
  close(original.viewportHeight, 240.1);
  close(enlarged.mapHeight, 480.2);
  const before = projection(point('river'), original), after = projection(point('river'), enlarged);
  close(after.x, before.x * 2);
  close(after.y, before.y * 2);
  const pan = zoomPan(original, enlarged, 0, 0);
  close(pan.x + enlarged.mapWidth / 2, original.viewportWidth / 2);
  close(pan.y + enlarged.mapHeight / 2, original.viewportHeight / 2);
  assert.deepEqual(clampPan(999, 999, enlarged), { x: 0, y: 0 });
  close(clampPan(-9999, -9999, enlarged).x, -343);
  close(clampPan(-9999, -9999, enlarged).y, -240.1);
  assert.equal(geometry(map(), 343, 100).zoom, 3);
  assert.equal(geometry(map(), 343, -1).zoom, 1);
  assert.equal(geometry(map(), 0, 1), null);
});

test('map load renders matching markers, shared filtering and detail navigation without login', async () => {
  const { instance, application, navigation } = page(fixtureApi());
  await instance.onShow();
  assert.equal(application.globalData.region.id, region.id);
  assert.equal(instance.data.mapImage, DEMO_IMAGE);
  assert.equal(instance.data.imageReady, false);
  assert.equal(instance.data.markers.length, 2);
  assert.equal(instance.data.markers[0].left, 26);
  assert.equal(instance.data.markers[0].top, 48);
  instance.selectPoint(event(instance, {}, { id: 'river' }));
  assert.equal(instance.data.selectedPoint, null);
  imageReady(instance);
  instance.selectPoint(event(instance, {}, { id: 'river' }));
  assert.equal(instance.data.selectedPoint.id, 'river');
  instance.open(event(instance, {}, { id: 'river' }));
  assert.deepEqual(navigation, ['/pages/detail/index?kind=place&id=river']);
  instance.chooseType(event(instance, {}, { type: 'campus' }));
  assert.deepEqual(instance.data.markers.map((item) => item.id), ['plant']);
  assert.deepEqual(instance.data.filtered.map((item) => item.id), ['plant']);
  assert.equal(instance.data.markers[0].order, instance.data.filtered[0].order);
  assert.equal(instance.data.selectedPoint, null);
});

test('native drag state feeds zoom and reset; old map movement cannot move the new version', async () => {
  const { instance } = page(fixtureApi());
  await instance.load();
  imageReady(instance);
  const oldEvent = event(instance, { x: -50, y: -30 });
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  assert.equal(instance.data.zoom, 1.5);
  instance.panMap(event(instance, { x: -100, y: -60 }));
  assert.deepEqual(instance._pan, { x: -100, y: -60 });
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  close(instance.data.panX, 171.5 - (171.5 + 100) * 2 / 1.5);
  instance.zoomMap(event(instance, {}, { action: 'reset' }));
  assert.equal(instance.data.zoom, 1);
  assert.deepEqual(instance._pan, { x: 0, y: 0 });
  instance.selectMap(0);
  imageReady(instance);
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  const pan = { ...instance._pan };
  instance.panMap(oldEvent);
  assert.deepEqual(instance._pan, pan);
});

test('switching map versions replaces the keyed image and ignores late old load/error callbacks', async () => {
  const next = map({ id: 'map-v2', version: 2, image_url: 'https://example.com/map-v2.png', points: [point('v2-place', { map_layout: 'map-v2' }), point('cross-version')] });
  const { instance } = page(fixtureApi({ 'maps/': [map(), next] }));
  await instance.load();
  const stale = event(instance, { width: 1000, height: 700 });
  const oldFrame = instance.data.imageFrames[0].generation;
  instance.chooseMap({ detail: { value: 1 } });
  assert.notEqual(instance.data.imageFrames[0].generation, oldFrame);
  assert.deepEqual(instance.data.markers.map((item) => item.id), ['v2-place']);
  instance.imageLoaded(stale);
  assert.equal(instance.data.imageReady, false);
  imageReady(instance);
  instance.imageFailed(stale);
  assert.equal(instance.data.imageReady, true);
  assert.equal(instance.data.mapImage, next.image_url);
});

test('bad image and incorrect dimensions hide artwork while keeping the list usable', async () => {
  for (const failure of ['error', 'dimensions']) {
    const { instance, navigation } = page(fixtureApi());
    await instance.load();
    const originalEvent = event(instance, { width: 1000, height: 700 });
    if (failure === 'error') instance.imageFailed(originalEvent);
    else instance.imageLoaded(event(instance, { width: 999, height: 700 }));
    assert.equal(instance.data.imageReady, false);
    assert.equal(instance.data.mapImage, '');
    assert.deepEqual(instance.data.imageFrames, []);
    assert.match(instance.data.mapNotice, /地点列表仍可使用/);
    assert.equal(instance.data.filtered.length, 2);
    instance.imageLoaded(originalEvent);
    assert.equal(instance.data.imageReady, false);
    instance.open(event(instance, {}, { id: 'plant' }));
    assert.equal(navigation.length, 1);
  }
});

test('failed maps directory keeps places, and failed places directory keeps a usable map', async () => {
  const { instance } = page(fixtureApi({ 'maps/': new Error('maps unavailable') }));
  await instance.load();
  assert.equal(instance.data.error, '');
  assert.equal(instance.data.filtered.length, 2);
  assert.match(instance.data.mapNotice, /maps unavailable/);
  const second = page(fixtureApi({ 'places/': new Error('places unavailable') })).instance;
  await second.load();
  assert.equal(second.data.error, '');
  assert.match(second.data.placesError, /places unavailable/);
  assert.equal(second.data.markers.length, 2);
  imageReady(second);
  second.selectPoint(event(second, {}, { id: 'river' }));
  assert.equal(second.data.selectedPoint.id, 'river');
});

test('paginated places and maps include later results and exclude other regions', async () => {
  const requested = [];
  const nextMap = map({ id: 'map-v2', version: 2, image_url: 'https://example.com/v2.png' });
  const { instance } = page({ request: async (url, options) => {
    requested.push({ url, options });
    if (url === 'regions/') return { data: [region, otherRegion] };
    if (url === 'places/') return { data: [point('first')], meta: { next: 'places/?page=2' } };
    if (url === 'places/?page=2') return { data: [point('later'), point('leak', { region: 'other' })] };
    if (url === 'maps/') return { data: [map()], meta: { next: 'maps/?page=2' } };
    return { data: [nextMap, map({ region: 'other' })] };
  } });
  await instance.load();
  assert.deepEqual(instance.data.places.map((item) => item.id), ['first', 'later']);
  assert.deepEqual(instance.data.maps.map((item) => item.id), ['map-v1', 'map-v2']);
  assert.equal(requested.find((call) => call.url === 'places/').options.data.region, 'demo');
});

test('a newer region selection wins over an older pending catalogue response', async () => {
  const oldPlaces = deferred(), oldMaps = deferred();
  const { instance, application } = page({ request: async (url, options) => {
    if (url === 'regions/') return { data: [region, otherRegion] };
    const id = options.data.region;
    if (id === 'demo') return url === 'places/' ? oldPlaces.promise : oldMaps.promise;
    return { data: url === 'places/' ? [point('other-place', { region: 'other', map_layout: 'other-map' })] : [map({ id: 'other-map', region: 'other', image_url: 'https://example.com/other.png', points: [] })] };
  } });
  const oldLoad = instance.load();
  await new Promise((resolve) => setImmediate(resolve));
  await instance.changeRegion({ detail: { value: 1 } });
  oldPlaces.resolve({ data: map().points });
  oldMaps.resolve({ data: [map()] });
  await oldLoad;
  assert.equal(application.globalData.region.id, 'other');
  assert.equal(instance.data.region.id, 'other');
  assert.equal(instance.data.activeMap.id, 'other-map');
  assert.equal(instance.data.mapImage, 'https://example.com/other.png');
  assert.deepEqual(instance.data.filtered.map((item) => item.id), ['other-place']);
});

test('unloading during region lookup never writes page state or the shared region', async () => {
  const pending = deferred();
  const { instance, application } = page({ request: () => pending.promise }, otherRegion);
  const loading = instance.load();
  instance.onUnload();
  instance.setData = () => { throw new Error('setData after unload'); };
  pending.resolve({ data: [region] });
  await loading;
  assert.equal(application.globalData.region.id, 'other');
});

test('empty and failing regions show clear states without requesting dependent resources', async () => {
  for (const value of [[], new Error('regions unavailable')]) {
    let calls = 0;
    const { instance } = page({ request: async (url) => {
      calls += 1;
      assert.equal(url, 'regions/');
      if (value instanceof Error) throw value;
      return { data: value };
    } });
    await instance.load();
    assert.equal(instance.data.loading, false);
    assert.equal(instance.data.mapImage, '');
    assert.equal(calls, 1);
    assert.ok(value instanceof Error ? instance.data.error : instance.data.mapNotice);
  }
});

test('late movement from an old zoom or resized native node cannot shift the next zoom center', async () => {
  const { instance } = page(fixtureApi());
  await instance.load();
  imageReady(instance);
  const originalImage = instance.data.imageGeneration;
  const originalViewport = instance.data.viewportFrames[0].generation;
  const lateOneX = event(instance, { x: 0, y: 0 });
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  assert.equal(instance.data.imageGeneration, originalImage);
  assert.notEqual(instance.data.viewportFrames[0].generation, originalViewport);
  close(instance._pan.x, -85.75);
  close(instance._pan.y, -60.025);
  instance.panMap(lateOneX);
  close(instance._pan.x, -85.75);
  close(instance._pan.y, -60.025);
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  close(instance.data.panX, -171.5);
  close(instance.data.panY, -120.05);

  const beforeResize = event(instance, { x: -250, y: -180 });
  const viewportBeforeResize = instance.data.viewportFrames[0].generation;
  global.wx.getWindowInfo = () => ({ windowWidth: 750 });
  instance.onResize();
  assert.notEqual(instance.data.viewportFrames[0].generation, viewportBeforeResize);
  const panAfterResize = { ...instance._pan };
  instance.panMap(beforeResize);
  assert.deepEqual(instance._pan, panAfterResize);
  instance.imageFailed(beforeResize);
  assert.equal(instance.data.mapImage, DEMO_IMAGE);
  assert.equal(instance.data.imageReady, true);
  // The native node must be replaced, not reused with a new global dataset value.
  const template = fs.readFileSync(path.join(__dirname, '../pages/explore/index.wxml'), 'utf8');
  const node = template.match(/<movable-view\b[^>]*>/)[0];
  assert.match(node, /wx:for="{{viewportFrames}}"/);
  assert.match(node, /wx:key="generation"/);
  assert.match(node, /data-viewport="{{viewport\.generation}}"/);
});

test('queued UI callbacks after hide or unload cannot mutate state, request data or navigate', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const { instance, application, navigation } = page(fixtureApi());
    await instance.onShow();
    imageReady(instance);
    const queuedImage = event(instance, { width: 1000, height: 700 });
    const queuedDrag = event(instance, { x: -50, y: -30 });
    instance[lifecycle]();
    const before = structuredClone(instance.data);
    const pan = { ...instance._pan };
    instance.setData = () => { throw new Error(`setData after ${lifecycle}`); };
    application.api.request = () => { throw new Error(`request after ${lifecycle}`); };
    const callbacks = [
      () => instance.zoomMap(event(instance, {}, { action: 'in' })),
      () => instance.chooseType(event(instance, {}, { type: 'campus' })),
      () => instance.chooseMap({ detail: { value: 0 } }),
      () => instance.selectMap(0),
      () => instance.changeRegion({ detail: { value: 0 } }),
      () => instance.open(event(instance, {}, { id: 'river' })),
      () => instance.selectPoint(event(instance, {}, { id: 'river' })),
      () => instance.imageLoaded(queuedImage),
      () => instance.imageFailed(queuedImage),
      () => instance.panMap(queuedDrag),
      () => instance.onResize(),
      () => instance.resizeMap(),
      () => instance.applyViewport(instance._metrics, { x: 0, y: 0 }),
      () => instance.filter(),
      () => instance.onPullDownRefresh(),
      () => instance.load(),
    ];
    if (lifecycle === 'onUnload') callbacks.push(() => instance.onShow());
    for (const callback of callbacks) await callback();
    assert.deepEqual(instance.data, before);
    assert.deepEqual(instance._pan, pan);
    assert.deepEqual(navigation, []);
    assert.equal(application.globalData.region.id, region.id);
  }
});


test('map and list switching preserves selection and zoom without fetching again; failed images use the list', async () => {
  const { instance, application } = page(fixtureApi());
  await instance.onShow(); imageReady(instance);
  instance.selectPoint(event(instance, {}, { id: 'river' }));
  instance.zoomMap(event(instance, {}, { action: 'in' }));
  const selected = instance.data.selectedPoint;
  application.api.request = () => { throw new Error('view switch must not fetch again'); };
  instance.changeView(event(instance, {}, { mode: 'list' }));
  assert.equal(instance.data.viewMode, 'list');
  instance.changeView(event(instance, {}, { mode: 'map' }));
  assert.equal(instance.data.viewMode, 'map');
  assert.equal(instance.data.zoom, 1.5);
  assert.equal(instance.data.selectedPoint, selected);
  instance.changeView(event(instance, {}, { mode: 'unsupported' }));
  assert.equal(instance.data.viewMode, 'map');
  instance.imageFailed(event(instance));
  assert.equal(instance.data.viewMode, 'list');
  assert.equal(instance.data.filtered.length, 2);
  instance.onHide();
  instance.setData = () => { throw new Error('late view callback'); };
  instance.changeView(event(instance, {}, { mode: 'map' }));
});
