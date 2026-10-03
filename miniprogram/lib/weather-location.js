// Weather GPS is ephemeral: match on-device and send only an allowed city slug.
const CITY_SLUGS = Object.freeze(['beijing', 'tianjin', 'shanghai', 'guangzhou', 'shenzhen', 'hangzhou', 'chengdu', 'chongqing', 'wuhan', 'nanjing']);
const MAX_DISTANCE_KM = 100;
function validPoint(point) {
  return point && typeof point.latitude === 'number' && typeof point.longitude === 'number'
    && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
}
function distanceKm(a, b) {
  const rad = degrees => degrees * Math.PI / 180, latitude = rad(b.latitude - a.latitude), longitude = rad(b.longitude - a.longitude);
  const n = Math.sin(latitude / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, n))));
}
function nearestWeatherCity(point, locations) {
  if (!validPoint(point) || (point.accuracy !== undefined && (!Number.isFinite(point.accuracy) || point.accuracy < 0 || point.accuracy > 50000))) return null;
  let selected = null, shortest = MAX_DISTANCE_KM;
  for (const city of Array.isArray(locations) ? locations : []) {
    if (!CITY_SLUGS.includes(city.slug) || city.coordinate_system !== 'WGS84' || !validPoint(city)) continue;
    const distance = distanceKm(point, city);
    if (distance <= shortest) { selected = city; shortest = distance; }
  }
  return selected;
}
function locateWeatherCity(wxApi, locations) {
  if (!wxApi || typeof wxApi.getLocation !== 'function') return Promise.resolve({ status: 'unavailable' });
  return new Promise(resolve => {
    let completed = false;
    const finish = result => { if (completed) return; completed = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => finish({ status: 'timeout' }), 12000);
    try {
      // Invoked only by the explicit tap handler, without high-accuracy polling.
      wxApi.getLocation({ type: 'wgs84', isHighAccuracy: false,
        success: point => {
          if (completed) return;
          const city = nearestWeatherCity(point, locations);
          finish(city ? { status: 'selected', slug: city.slug } : { status: 'unsupported' });
        },
        fail: () => finish({ status: 'unavailable' }),
      });
    } catch (_) { finish({ status: 'unavailable' }); }
  });
}
module.exports = { CITY_SLUGS, MAX_DISTANCE_KM, nearestWeatherCity, locateWeatherCity };
