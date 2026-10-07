// Only endpoints whose GET result is public and has no caller-specific fields.
// This policy controls both the volatile read cache and omission of a business
// bearer. WeChat still supplies/validates trusted SDK identity on every call.
const TTL = {
  'health/': 30000, 'regions/': 30000, 'weather-data/locations/': 30000,
  'weather-data/summary/': 15000,
  'rivers/': 10000, 'places/': 10000, 'maps/': 10000, 'contents/': 10000, 'routes/': 10000,
  'content-tags/': 10000, 'water-bodies/': 10000,
  'weather/': 10000, 'air-quality/': 10000, 'weather-alerts/': 10000,
};
const id = value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const integer = max => value => /^[0-9]{1,6}$/.test(value) && Number(value) >= 1 && Number(value) <= max;
const page = { page: integer(100000), page_size: integer(100) }, region = { region: id };
const contents = { ...region, category: value => ['plants', 'water', 'green', 'travel'].includes(value), plant_label: value => /^[-a-zA-Z0-9_]{1,50}$/.test(value), place: id,
  search: value => Array.from(value).length <= 100 && !/[\x00-\x1f\x7f]/.test(value) };
const provenance = { ...region, source_type: value => value === 'simulation', source: id, scenario: id,
  simulation_run: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) };
const SCHEMAS = {
  'health/': {}, 'weather-data/locations/': {},
  'weather-data/summary/': { location: value => /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) },
  'rivers/': { ...page, ...region }, 'regions/': page, 'maps/': { ...page, ...region }, 'routes/': { ...page, ...region }, 'water-bodies/': { ...page, ...region },
  'places/': { ...page, ...region, kind: value => ['river', 'lake', 'park', 'plant', 'waste', 'trail', 'campus', 'landmark'].includes(value) },
  'contents/': { ...page, ...contents }, 'content-tags/': contents,
  'weather/': provenance, 'air-quality/': provenance, 'weather-alerts/': region,
};
function publicRead(path, options = {}) {
  if (String(options.method || 'GET').toUpperCase() !== 'GET' || typeof path !== 'string' || path.length > 4096 || /[\\\s#\x00-\x1f\x7f]/.test(path)) return null;
  const relative = path.startsWith('/api/v1/') ? path.slice(8) : path;
  const parts = relative.split('?');
  if (parts.length > 2 || !Object.prototype.hasOwnProperty.call(TTL, parts[0])) return null;
  const route = parts[0], schema = SCHEMAS[route], parameters = new Map();
  const add = (key, value) => {
    if (!Object.prototype.hasOwnProperty.call(schema, key) || parameters.has(key) || !schema[key](value)) return false;
    parameters.set(key, value); return true;
  };
  if (parts.length === 2) {
    if (!parts[1]) return null;
    for (const pair of parts[1].split('&')) {
      const equals = pair.indexOf('=');
      if (equals < 1 || !/^[a-z][a-z0-9_]*$/.test(pair.slice(0, equals))) return null;
      let value;
      try { value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' ')); } catch (_) { return null; }
      if (!add(pair.slice(0, equals), value)) return null;
    }
  }
  const data = options.data;
  if (data !== undefined && data !== null) {
    if (typeof data !== 'object' || Array.isArray(data)) return null;
    for (const key of Object.keys(data)) {
      const value = data[key]; if (value === null || value === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || !add(key, String(value))) return null;
    }
  }
  if (route === 'weather-data/summary/' && !parameters.has('location')) return null;
  return { route, ttl: TTL[route], entries: [...parameters].sort(([a], [b]) => a.localeCompare(b)) };
}
module.exports = { publicRead };
