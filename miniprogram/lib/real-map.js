/** Reviewed real coordinates are kept separate from image-relative demo positions. */
const MARKER_ICON = '/assets/icons/map-pin.png';
function gcj02(value) { return typeof value === 'string' && value.toUpperCase() === 'GCJ02'; }
function coordinates(value) {
  return !!value && typeof value.latitude === 'number' && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && typeof value.longitude === 'number' && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}
function cityMap(region) {
  const map = region && region.is_demo === false && region.real_map;
  if (!map || !gcj02(map.coordinate_system)) return null;
  const center = { latitude: map.center_latitude, longitude: map.center_longitude };
  if (!coordinates(center)) return null;
  return Object.assign(center, { scale: Number.isFinite(map.scale) ? Math.max(3, Math.min(20, map.scale)) : 12 });
}
function publishedReal(item) { return !!item && item.is_demo === false && item.is_published === true; }
function navigable(item) { return publishedReal(item) && item.coordinates_verified === true && gcj02(item.coordinate_system) && coordinates(item); }
function realPoints(places, region) {
  const seen = new Set();
  return (places || []).filter((point) => {
    if (!point || !region || point.region !== region.id || !navigable(point) || !point.id || seen.has(point.id)) return false;
    seen.add(point.id); return true;
  });
}
function marker(point, id) {
  return { id, latitude: point.latitude, longitude: point.longitude, iconPath: MARKER_ICON, width: 28, height: 36, anchor: { x: .5, y: 1 }, title: point.name,
    callout: { content: point.name, display: id === 0 ? 'ALWAYS' : 'BYCLICK', color: '#244b39', bgColor: '#fffefa', padding: 8, borderRadius: 8, fontSize: 13 } };
}
function riverLines(rivers, region) {
  if (!region) return [];
  return (rivers || []).filter((river) => river && river.region === region.id && river.is_demo !== true && river.is_published === true && river.geometry_verified === true && gcj02(river.coordinate_system) && Array.isArray(river.path) && river.path.length >= 2 && river.path.length <= 200 && river.path.every(coordinates))
    .map((river) => ({ points: river.path.map((point) => ({ latitude: point.latitude, longitude: point.longitude })), color: '#4388AADD', width: 5, borderColor: '#FFFFFFAA', borderWidth: 1 }));
}
function locationRequest(api) {
  let cancel;
  const promise = new Promise((resolve) => {
    let done = false, timer;
    const finish = (result) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(result); };
    cancel = () => finish({ status: 'cancelled' });
    if (typeof api.getFuzzyLocation !== 'function') return finish({ status: 'unavailable' });
    timer = setTimeout(() => finish({ status: 'timeout' }), 12000);
    try {
      api.getFuzzyLocation({ type: 'gcj02', success(result) { finish(coordinates(result) ? { status: 'selected', location: { latitude: result.latitude, longitude: result.longitude } } : { status: 'unavailable' }); },
        fail() { finish({ status: 'unavailable' }); } });
    } catch (_) { finish({ status: 'unavailable' }); }
  });
  promise.cancel = () => cancel();
  return promise;
}
function openLocation(api, item, fail) {
  if (!navigable(item)) return false;
  if (typeof api.openLocation !== 'function') { if (fail) fail(); return false; }
  try { api.openLocation({ latitude: item.latitude, longitude: item.longitude, name: item.name || '生态地点', address: item.address || item.access_note || '', scale: 16, fail }); return true; }
  catch (_) { if (fail) fail(); return false; }
}
module.exports = { MARKER_ICON, coordinates, cityMap, publishedReal, navigable, realPoints, marker, riverLines, locationRequest, openLocation };
