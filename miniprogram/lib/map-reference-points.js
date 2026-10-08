/** Local POI references are separate from published place records and navigation destinations. */
const snapshot = require('../data/map-reference-points');

// Reversible column packing reduces upload size without changing point IDs,
// coordinates, source metadata, or the records consumed by the map and AI.
function expandSnapshot(source) {
  if (Array.isArray(source.locations)) return source;
  if (source.format !== 'hyhq.map-columns.v1' || !Array.isArray(source.rows)) return { locations: [] };
  const locations = source.rows.map((row) => {
    const point = Object.assign({}, source.defaults);
    source.fields.forEach((key, index) => {
      const value = row[index];
      const dictionary = source.dictionaries[index];
      if (dictionary) {
        if (value >= 0 && value < dictionary.length) {
          const decoded = dictionary[value];
          point[key] = Array.isArray(decoded) ? decoded.slice() : decoded;
        }
      } else if (value !== null) point[key] = value;
    });
    return point;
  });
  return Object.assign({}, source, { locations });
}

const catalog = expandSnapshot(snapshot);
const { coordinates, MARKER_ICON } = require('./real-map');
const { matchesType } = require('./map-layout');
const MARKER_OFFSET = 1000000;
const CITY_WEATHER = { 'tianjin-nature': 'tianjin', 'beijing-nature': 'beijing' };

function sourceLabel(point) {
  if (point && ['腾讯地图 POI', 'Tencent地图 POI'].includes(point.source_note)) return '腾讯地图 POI';
  return '地图点位资料';
}

function valid(point) {
  return !!point && typeof point.id === 'string' && point.id.length <= 120 && /^reference-[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(point.id) &&
    Object.prototype.hasOwnProperty.call(CITY_WEATHER, point.region_slug) &&
    point.coordinate_system === 'GCJ02' && coordinates(point) &&
    Number.isInteger(point.marker_id) && point.marker_id > 0;
}

function byId(id) {
  if (typeof id !== 'string' || !Array.isArray(catalog.locations)) return null;
  return catalog.locations.find((point) => valid(point) && point.id === id) || null;
}

function weatherSlug(id) { const point = byId(id); return point ? CITY_WEATHER[point.region_slug] : ''; }

function sourceCard(id) {
  const point = byId(id);
  if (!point) return null;
  const location = [point.city, point.district, point.address].filter(Boolean).join(' · ');
  return {
    id: point.id, type: 'map_reference', region: '', label: point.kind === 'campus' ? '校园参考点' : '地图参考点', title: point.name,
    summary: [point.description, location, sourceLabel(point) + (point.checked_at ? ' · 核对日期 ' + point.checked_at : ''),
      catalog.scope_note || '参考点，不代表入口、完整河道或导航路线。', point.access_note,
      'AI 结合这个点位和可核对资料回答。'].filter(Boolean).join('\n'),
  };
}

function forRegion(region) {
  if (!region || region.is_demo !== false || !Array.isArray(catalog.locations)) return [];
  return catalog.locations.filter((point) => point.region_slug === region.slug && valid(point))
    .map((point, index) => Object.assign({}, point, {
      markerId: MARKER_OFFSET + point.marker_id,
      order: String(index + 1).padStart(2, '0'),
      displayName: point.name + (point.district ? ' · ' + point.district : ''),
      sourceLabel: sourceLabel(point),
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

module.exports = { byId, weatherSlug, sourceCard, forRegion, filtered, marker, scopeNote: catalog.scope_note || '参考点，不代表入口、完整河道或导航路线。' };
