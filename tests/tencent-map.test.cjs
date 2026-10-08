"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
let map;
test.before(async () => { map = await import("../frontend/src/lib/tencent-map.js"); });
const key = "TEST0-TEST0-TEST0-TEST0-TEST0-TEST0";
const point = { id: "one", name: "生态点", latitude: 39.916527, longitude: 116.397128, coordinate_system: "GCJ02", kind: "river" };
function browser() {
  const scripts = [], win = {};
  return { window: win, scripts, document: { createElement: () => ({ remove() { this.removed = true; } }), head: { appendChild: script => scripts.push(script) } } };
}
function sdk({ failLayer = false } = {}) {
  const maps = [], layers = [], observers = [], events = [];
  class LatLng { constructor(lat, lng) { this.lat = lat; this.lng = lng; } }
  class Map {
    constructor(el, options) { this.el = el; this.options = options; this.listeners = new global.Map(); this.movements = []; maps.push(this); }
    on(name, fn) { this.listeners.set(name, fn); }
    off(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    setCenter(center) { this.center = center; }
    setZoom(zoom) { this.zoom = zoom; }
    fitBounds(bounds) { this.bounds = bounds; }
    easeTo(target) { this.movements.push(target); }
    destroy() { this.destroyed = true; }
  }
  class Layer {
    constructor(options) { if (failLayer) throw Error("UNSUPPORTED_GPU"); this.options = options; this.listeners = new global.Map(); this.geometries = []; layers.push(this); }
    on(name, fn) { this.listeners.set(name, fn); }
    off(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    setGeometries(value) { this.geometries = value; }
    setMap(value) { this.map = value; }
    destroy() { this.destroyed = true; }
  }
  class ResizeObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.disconnected = true; } }
  class Style { constructor(options) { Object.assign(this, options); } }
  class LatLngBounds { constructor(sw, ne) { this.sw = sw; this.ne = ne; } }
  return { TMap: { Map, LatLng, LatLngBounds, MultiMarker: Layer, MarkerStyle: Style, MultiPolyline: Layer, PolylineStyle: Style }, maps, layers, observers, events, ResizeObserver, window: { Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => events.push(event) } };
}
test("empty or malformed server map config cannot load an arbitrary external script", async () => {
  assert.deepEqual(map.mapConfiguration({ provider: "tencent", js_key: "" }), { provider: "openstreetmap", js_key: "" });
  assert.equal(map.mapConfiguration({ provider: "other", js_key: key }).provider, "openstreetmap");
  const b = browser(); await assert.rejects(map.loadTencentMaps("https://evil.test/script.js", b), /UNCONFIGURED/);
  assert.equal(b.scripts.length, 0);
});
test("SDK loads only fixed official HTTPS origin, deduplicates mounts, and clears callback", async () => {
  const b = browser(), first = map.loadTencentMaps(key, b), second = map.loadTencentMaps(key, b);
  assert.equal(first, second); assert.equal(b.scripts.length, 1);
  const url = new URL(b.scripts[0].src), callback = url.searchParams.get("callback");
  assert.equal(url.origin, "https://map.qq.com"); assert.equal(url.pathname, "/api/gljs");
  assert.equal(url.searchParams.get("key"), key); assert.equal(url.searchParams.get("v"), "1.exp");
  b.window.TMap = { Map: class {} }; b.window[callback]();
  assert.equal(await first, b.window.TMap); assert.equal(b.window[callback], undefined);
  await assert.rejects(map.loadTencentMaps(key + "1", b), /RELOAD/);
});
test("script network failure and timeout release their cache and allow explicit retry", async () => {
  const b = browser(), failed = map.loadTencentMaps(key, b);
  b.scripts[0].onerror(); await assert.rejects(failed, /NETWORK/); assert.equal(b.scripts[0].removed, true);
  await assert.rejects(map.loadTencentMaps(key, { ...b, timeoutMs: 5 }), /TIMEOUT/);
  assert.equal(b.scripts[1].removed, true);
  const retry = map.loadTencentMaps(key, b), url = new URL(b.scripts[2].src);
  b.window.TMap = { Map: class {} }; b.window[url.searchParams.get("callback")]();
  await retry;
});
test("SDK callback without actual API is a failure, not a successful blank map", async () => {
  const b = browser(), promise = map.loadTencentMaps(key, b), callback = new URL(b.scripts[0].src).searchParams.get("callback");
  b.window[callback](); await assert.rejects(promise, /SDK_UNAVAILABLE/);
});
test("catalog GCJ02 is unchanged; only browser WGS84 is converted, unknown systems rejected", () => {
  assert.deepEqual(map.browserPosition(point), [point.latitude, point.longitude]);
  const p = map.browserPosition({ latitude: 39.91512384213972, longitude: 116.39088606072372 });
  assert.ok(Math.abs(p[0] - point.latitude) < 0.000002); assert.ok(Math.abs(p[1] - point.longitude) < 0.000002);
  assert.deepEqual(map.browserPosition({ latitude: 51.5, longitude: -0.12 }), [51.5, -0.12]);
  assert.equal(map.browserPosition({ ...point, coordinate_system: "BD09" }), null);
  assert.equal(map.browserPosition({ latitude: NaN, longitude: 1 }), null);
});
test("invalid/duplicate/unidentified coordinates and unverified river geometry never render", () => {
  assert.deepEqual(map.mapPoints([point, point, { ...point, id: "wrong", coordinate_system: "WGS84" }, { ...point, id: undefined }, { ...point, id: "nan", latitude: NaN }]), [point]);
  const river = { id: "river", coordinate_system: "GCJ02", geometry_verified: true, path: [point, { ...point, latitude: 39.91 }] };
  assert.deepEqual(map.mapRivers([river, { ...river, geometry_verified: false }, { ...river, path: [point] }, { ...river, coordinate_system: "WGS84" }]), [river]);
});
test("controller updates current markers and selected coordinates without double offset or stale click", () => {
  const s = sdk(), selected = [], loaded = [], unavailable = [];
  const controller = map.createTencentController(s.TMap, {}, { ...s, onSelect: p => selected.push(p), onLoaded: () => loaded.push(true), onUnavailable: () => unavailable.push(true) });
  const props = { region: { id: "r", real_map: { center_latitude: 39.12, center_longitude: 117.2, scale: 11 } }, points: [point], selected: point };
  controller.update(props);
  assert.equal(s.layers[0].geometries[0].position.lat, point.latitude);
  assert.equal(s.layers[0].geometries[0].position.lng, point.longitude);
  assert.equal(s.maps[0].movements.length, 1);
  controller.update(props); assert.equal(s.maps[0].movements.length, 1); // Rerender must not steal user pan/zoom.
  s.layers[0].listeners.get("click")({ geometry: { id: "one" } }); assert.equal(selected[0], point);
  controller.update({ ...props, points: [] }); s.layers[0].listeners.get("click")({ geometry: { id: "one" } }); assert.equal(selected.length, 1);
  s.maps[0].listeners.get("tilesloaded")(); s.maps[0].listeners.get("context_lost")();
  assert.equal(loaded.length, 1); assert.equal(unavailable.length, 1);
  controller.destroy(); controller.destroy();
  assert.equal(s.maps[0].destroyed, true); assert.equal(s.maps[0].listeners.size, 0);
  assert.ok(s.layers.every(l => l.map === null && l.destroyed)); assert.equal(s.observers[0].disconnected, true);
});
test("location is optional, is cleared on removal, and converts only explicit browser position", () => {
  const s = sdk(), controller = map.createTencentController(s.TMap, {}, s);
  controller.update({ points: [point] }); assert.deepEqual(s.layers[1].geometries, []);
  controller.update({ points: [point], position: { latitude: 39.91512384213972, longitude: 116.39088606072372 } });
  assert.ok(Math.abs(s.layers[1].geometries[0].position.lng - point.longitude) < 0.000002);
  controller.update({ points: [point], position: null }); assert.deepEqual(s.layers[1].geometries, []);
  controller.destroy();
});
test("every marker content is a string so the SDK never renders an undefined label", () => {
  const s = sdk(), controller = map.createTencentController(s.TMap, {}, s);
  const second = { ...point, id: "two", name: "第二地点", longitude: 116.41 };
  controller.update({ points: [point, second] });
  assert.deepEqual(s.layers[0].geometries.map(p => p.content), ["", ""]);
  controller.update({ points: [point, second], selected: point, position: point });
  assert.deepEqual(s.layers[0].geometries.map(p => p.content), [point.name, ""]);
  assert.ok([s.layers[0], s.layers[1]].flatMap(layer => layer.geometries).every(p => typeof p.content === "string"));
  controller.update({ points: [point, second], selected: null });
  assert.deepEqual(s.layers[0].geometries.map(p => p.content), ["", ""]);
  controller.destroy();
});
test("responsive resize skips hidden zero-size maps, deduplicates equal size and cancels after unmount", async () => {
  const s = sdk(), controller = map.createTencentController(s.TMap, {}, s), observer = s.observers[0];
  observer.fn([{ contentRect: { width: 0, height: 0 } }]);
  observer.fn([{ contentRect: { width: 360, height: 400 } }]);
  observer.fn([{ contentRect: { width: 360, height: 400 } }]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(s.events.length, 1); assert.equal(s.events[0].type, "resize");
  observer.fn([{ contentRect: { width: 400, height: 360 } }]); controller.destroy();
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(s.events.length, 1);
});
test("partial SDK initialization failure destroys the map instead of leaking WebGL instances", () => {
  const s = sdk({ failLayer: true });
  assert.throws(() => map.createTencentController(s.TMap, {}, s), /UNSUPPORTED_GPU/);
  assert.equal(s.maps[0].destroyed, true);
});

test("an asynchronously arriving point list establishes bounds after an empty first render", () => {
  const s = sdk(), controller = map.createTencentController(s.TMap, {}, s);
  controller.update({ region: { id: "r" }, points: [] });
  assert.equal(s.maps[0].bounds, undefined);
  controller.update({ region: { id: "r" }, points: [point] });
  assert.equal(s.maps[0].bounds.sw.lng, point.longitude);
  controller.destroy();
});
