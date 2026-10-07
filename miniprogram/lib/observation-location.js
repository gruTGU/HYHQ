// Explicit, one-shot observation choices. All three APIs below return GCJ02
// because getFuzzyLocation requests it and WeChat's two pickers specify that system.
// Weather separately requests WGS84: never relabel one system as the other.
const METHODS = Object.freeze({ current: 'getFuzzyLocation', map: 'chooseLocation', poi: 'choosePoi' });
function point(value) {
  if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number'
    || !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)
    || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return null;
  return { latitude: value.latitude, longitude: value.longitude, coordinate_system: 'GCJ02' };
}
function label(value) { return typeof value === 'string' ? Array.from(value.replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, 80).join('') : ''; }
function selected(kind, result) {
  // choosePoi's coordinates are deprecated. A city-only selection must never
  // become a river observation point; a missing precise point is not (0, 0).
  if (kind === 'poi' && result && result.type === 1) return { status: 'city-only', label: label(result.city || result.name) };
  if (kind === 'poi' && (!result || result.type !== 2)) return { status: 'invalid' };
  const location = point(result);
  if (!location) return { status: 'invalid' };
  if (kind === 'current') {
    const accuracy = result && result.accuracy;
    return { status: 'selected', location, source: 'fuzzy', label: '模糊参考位置',
      accuracy_m: typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
  }
  return { status: 'selected', location, source: kind, label: label(result.name) || '已选观察位置' };
}
function requestObservationLocation(platform, kind) {
  let stop = () => {}, finish;
  const promise = new Promise(resolve => {
    let completed = false, timer;
    finish = result => { if (completed) return; completed = true; if (timer) clearTimeout(timer); resolve(result); };
    stop = () => finish({ status: 'cancelled' });
    const name = METHODS[kind];
    if (!name || !platform || typeof platform[name] !== 'function') { finish({ status: 'unavailable' }); return; }
    // Native pickers stay open until the user finishes/cancels. Page teardown
    // cancels our result without trying to control the native picker itself.
    if (kind === 'current') timer = setTimeout(() => finish({ status: 'timeout' }), 12000);
    const options = {
      success: result => finish(selected(kind, result)),
      fail: error => finish({ status: /cancel/i.test(error && error.errMsg || '') ? 'cancelled' : /auth|deny|denied/i.test(error && error.errMsg || '') ? 'denied' : 'unavailable' }),
    };
    if (kind === 'current') Object.assign(options, { type: 'gcj02' });
    try { platform[name](options); } catch (_) { finish({ status: 'unavailable' }); }
  });
  promise.cancel = () => stop();
  return promise;
}
module.exports = { requestObservationLocation, selected };
