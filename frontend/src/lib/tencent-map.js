import { coordinates, gcjToWgs, matchesType } from "../pages/public-domain.js";

const loads = new WeakMap();
let callbackNumber = 0, instanceNumber = 0;
export const validMapKey = key => typeof key === "string" && /^[A-Za-z0-9-]{12,128}$/.test(key);
export function mapConfiguration(value) {
  return value?.provider === "tencent" && validMapKey(value.js_key)
    ? { provider: "tencent", js_key: value.js_key }
    : { provider: "openstreetmap", js_key: "" };
}
// Browser geolocation is WGS84. Invert the existing GCJ->WGS transform locally;
// catalog/map-point GCJ02 coordinates never pass through this conversion.
export function browserPosition(position) {
  if (!coordinates(position)) return null;
  const type = String(position.coordinate_system || "WGS84").toUpperCase();
  if (type === "GCJ02") return [position.latitude, position.longitude];
  if (type !== "WGS84") return null;
  const lat = position.latitude, lng = position.longitude;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lat, lng];
  let a = lat, b = lng;
  for (let i = 0; i < 4; i++) {
    const [actualLat, actualLng] = gcjToWgs(a, b);
    a += lat - actualLat; b += lng - actualLng;
  }
  return [a, b];
}
export function mapPoints(points = []) {
  const ids = new Set();
  return (Array.isArray(points) ? points : []).filter(p => {
    if (!coordinates(p) || p.id === undefined || p.id === null
      || String(p.coordinate_system).toUpperCase() !== "GCJ02" || ids.has(String(p.id))) return false;
    ids.add(String(p.id)); return true;
  });
}
export function mapRivers(rivers = []) {
  return (Array.isArray(rivers) ? rivers : []).filter(r => r && r.geometry_verified === true
    && String(r.coordinate_system).toUpperCase() === "GCJ02"
    && Array.isArray(r.path) && r.path.length >= 2 && r.path.length <= 200 && r.path.every(coordinates));
}
export function loadTencentMaps(key, { window: win = globalThis.window, document: doc = globalThis.document, timeoutMs = 12000 } = {}) {
  if (!validMapKey(key) || !win || !doc) return Promise.reject(new Error("MAP_UNCONFIGURED"));
  const prior = loads.get(win);
  if (prior) return prior.key === key ? prior.promise : Promise.reject(new Error("MAP_KEY_CHANGED_RELOAD"));
  const state = { key, promise: null };
  loads.set(win, state);
  state.promise = new Promise((resolve, reject) => {
    const script = doc.createElement("script"), name = "__hyhqTencentReady" + (++callbackNumber);
    let done = false;
    const finish = error => {
      if (done) return;
      done = true; clearTimeout(timer); script.onerror = null;
      delete win[name];
      if (error) { script.remove(); if (loads.get(win) === state) loads.delete(win); reject(error); }
      else resolve(win.TMap);
    };
    const timer = setTimeout(() => finish(new Error("MAP_LOAD_TIMEOUT")), timeoutMs);
    win[name] = () => finish(typeof win.TMap?.Map === "function" ? null : new Error("MAP_SDK_UNAVAILABLE"));
    script.async = true; script.charset = "utf-8";
    script.referrerPolicy = "strict-origin-when-cross-origin";
    const url = new URL("https://map.qq.com/api/gljs");
    url.searchParams.set("v", "1.exp"); url.searchParams.set("key", key); url.searchParams.set("callback", name);
    script.src = url.href;
    script.onerror = () => finish(new Error("MAP_NETWORK_ERROR"));
    doc.head.appendChild(script);
  });
  return state.promise;
}
function markerImage(color, selected = false) {
  // Original code-drawn marker, same-origin data URI, never includes user text.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40"><path d="M16 38C13 31 3 25 3 16a13 13 0 0 1 26 0c0 9-10 15-13 22Z" fill="${color}" stroke="${selected ? "#183c2b" : "#fff"}" stroke-width="${selected ? 3 : 2}"/><circle cx="16" cy="16" r="5" fill="#fff"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
export function createTencentController(TMap, element, { onSelect = () => {}, onLoaded = () => {}, onUnavailable = () => {}, window: win = globalThis.window, ResizeObserver: RO = globalThis.ResizeObserver } = {}) {
  let instance, pointsLayer, riverLayer, locationLayer, observer;
  let disposed = false, current = new Map(), previousRegion, previousSelected, previousPosition, resizeTimer, framedRegion = false;
  const prefix = "hyhq-map-" + (++instanceNumber);
  const ll = p => new TMap.LatLng(p.latitude, p.longitude);
  const click = event => { if (!disposed) { const p = current.get(String(event?.geometry?.id)); if (p) onSelect(p); } };
  const loaded = () => { if (!disposed) onLoaded(); };
  const lost = () => { if (!disposed) onUnavailable(); };
  const destroy = () => {
    if (disposed) return;
    disposed = true; clearTimeout(resizeTimer); observer?.disconnect();
    pointsLayer?.off("click", click);
    instance?.off("tilesloaded", loaded); instance?.off("context_lost", lost);
    for (const layer of [pointsLayer, riverLayer, locationLayer]) {
      try { layer?.setMap(null); layer?.destroy?.(); } catch (_) { /* Continue releasing the map. */ }
    }
    try { instance?.destroy(); } catch (_) { /* A lost GPU context must not break page unmount. */ }
    current.clear();
  };
  try {
    instance = new TMap.Map(element, {
      center: new TMap.LatLng(39.12, 117.2), zoom: 11, viewMode: "2D", pitch: 0, rotation: 0,
      draggable: true, touchZoomable: true, scrollable: true,
    });
    const styles = {};
    for (const [kind, color] of Object.entries({ water: "#578fa4", land: "#6b8957", campus: "#c3914d", location: "#236fc1" })) {
      for (const selected of [false, true]) styles[(selected ? "selected-" : "") + kind] = new TMap.MarkerStyle({
        width: selected ? 36 : 30, height: selected ? 45 : 38, anchor: { x: selected ? 18 : 15, y: selected ? 44 : 37 },
        src: markerImage(color, selected), color: "#233b2e", size: 12, direction: "top", offset: { x: 0, y: -4 },
      });
    }
    pointsLayer = new TMap.MultiMarker({ id: prefix + "-points", map: instance, styles, geometries: [] });
    locationLayer = new TMap.MultiMarker({ id: prefix + "-location", map: instance, styles, geometries: [], disableInteractive: true });
    riverLayer = new TMap.MultiPolyline({ id: prefix + "-rivers", map: instance,
      styles: { river: new TMap.PolylineStyle({ color: "rgba(66,139,171,0.7)", width: 4, lineCap: "round" }) }, geometries: [], disableInteractive: true });
    pointsLayer.on("click", click); instance.on("tilesloaded", loaded); instance.on("context_lost", lost);
    // SDK owns canvas resizing; notify its window resize handler also when a
    // responsive sidebar or hidden tab changes container size without rotation.
    if (RO && win?.dispatchEvent && win?.Event) {
      let previousSize = "";
      observer = new RO(entries => {
        const rect = entries[0]?.contentRect;
        if (!rect || rect.width <= 0 || rect.height <= 0 || disposed) return;
        const size = Math.round(rect.width) + ":" + Math.round(rect.height);
        if (size === previousSize) return;
        previousSize = size; clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (!disposed) win.dispatchEvent(new win.Event("resize")); }, 80);
      });
      observer.observe(element);
    }
  } catch (error) { destroy(); throw error; }
  return {
    update({ region, points = [], rivers = [], selected, position, resetToken } = {}) {
      if (disposed) return;
      const valid = mapPoints(points); current = new Map(valid.map(p => [String(p.id), p]));
      pointsLayer.setGeometries(valid.map(p => ({
        id: String(p.id), styleId: (selected?.id === p.id ? "selected-" : "") + (matchesType(p, "water") ? "water" : matchesType(p, "campus") ? "campus" : "land"),
        position: ll(p), content: selected?.id === p.id ? String(p.name || "地点") : "",
      })));
      riverLayer.setGeometries(mapRivers(rivers).map((r, i) => ({ id: String(r.id ?? i), styleId: "river", paths: r.path.map(ll) })));
      const center = region?.real_map, regionKey = [region?.id, center?.center_latitude, center?.center_longitude, resetToken].join(":");
      if (regionKey !== previousRegion || !framedRegion) {
        previousRegion = regionKey; previousSelected = undefined; previousPosition = undefined; framedRegion = false;
        const p = { latitude: center?.center_latitude, longitude: center?.center_longitude };
        if (coordinates(p)) { instance.setCenter(ll(p)); instance.setZoom(Math.min(18, Math.max(3, Number(center.scale) || 11))); framedRegion = true; }
        else if (valid.length) {
          const lats = valid.map(p => p.latitude), lngs = valid.map(p => p.longitude);
          instance.fitBounds(new TMap.LatLngBounds(new TMap.LatLng(Math.min(...lats), Math.min(...lngs)), new TMap.LatLng(Math.max(...lats), Math.max(...lngs))), { padding: 40, maxZoom: 12 });
          framedRegion = true;
        }
      }
      const p = browserPosition(position), locationKey = p?.join(":") || "";
      locationLayer.setGeometries(p ? [{ id: "current-position", styleId: "location", position: new TMap.LatLng(...p), content: "本次附近位置" }] : []);
      if (p && locationKey !== previousPosition) instance.easeTo({ center: new TMap.LatLng(...p), zoom: 13 }, { duration: 400 });
      previousPosition = locationKey;
      const chosen = selected && current.get(String(selected.id));
      const selectedKey = chosen ? [chosen.id, chosen.latitude, chosen.longitude].join(":") : "";
      if (chosen && selectedKey !== previousSelected) instance.easeTo({ center: ll(chosen), zoom: 14 }, { duration: 400 });
      previousSelected = selectedKey;
    },
    destroy,
  };
}
