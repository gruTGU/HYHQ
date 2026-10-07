/** Local POI references are separate from published place records and navigation destinations. */
const catalog = require('../data/map-reference-points');
const { coordinates, MARKER_ICON } = require('./real-map');
const { matchesType } = require('./map-layout');
const MARKER_OFFSET = 1000000;

function forRegion(region) {
  if (!region || region.is_demo !== false || !Array.isArray(catalog.locations)) return [];
  return catalog.locations.filter((point) => point.region_slug === region.slug &&
    point.coordinate_system === 'GCJ02' && coordinates(point) && typeof point.id === 'string' &&
    Number.isInteger(point.marker_id) && point.marker_id > 0)
    .map((point, index) => Object.assign({}, point, {
      markerId: MARKER_OFFSET + point.marker_id,
      order: String(index + 1).padStart(2, '0'),
      displayName: point.name + (point.district ? ' · ' + point.district : ''),
      sourceLabel: catalog.source || '腾讯地图 POI',
    }));
}

function filtered(points, type) { return points.filter((point) => matchesType(point, type)); }

function marker(point) {
  return {
    id: point.markerId, latitude: point.latitude, longitude: point.longitude,
    iconPath: MARKER_ICON, width: 24, height: 31, anchor: { x: .5, y: 1 },
    title: point.displayName,
    label: { content: point.name, color: '#476857', fontSize: 11, bgColor: '#FFFDF5',
      borderColor: '#A8C99B', borderWidth: 1, borderRadius: 5, padding: 3, anchorX: 12, anchorY: -26 },
    callout: { content: point.displayName + ' · 参考点', display: 'BYCLICK', color: '#365642',
      bgColor: '#FFFDF5', padding: 8, borderRadius: 8, fontSize: 13 },
  };
}

module.exports = { forRegion, filtered, marker, scopeNote: catalog.scope_note || '参考点，不代表入口、完整河道或导航路线。' };
