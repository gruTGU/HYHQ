// Public city weather only. No account, GPS result, token, or private record is stored.
const HOUR = 3600000, RETAIN = 24 * HOUR, RETRY = 300000, MAX_BYTES = 256 * 1024;
const KEY = 'hyhq.weather-snapshot.v1.';
const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
function scope(config = {}) {
  const cloud = config.cloud || {};
  return config.transport === 'cloud-function' ? ['cloud-function', cloud.env, cloud.function].join('|')
    : config.transport === 'cloud' ? ['cloud', cloud.env, cloud.service].join('|')
      : ['http', String(config.baseURL || 'unconfigured').replace(/\/+$/, '')].join('|');
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function summaryData(raw, slug) {
  if (!plain(raw) || !plain(raw.location) || raw.location.slug !== slug || !plain(raw.weather)) return null;
  const out = { location: { slug, name: String(raw.location.name || '').slice(0, 100) }, source_label: raw.source_label, source_kind: raw.source_kind };
  for (const name of ['weather', 'air', 'alerts', 'daily']) {
    const item = raw[name]; if (!plain(item)) continue;
    if (item.data !== null && item.data !== undefined && !plain(item.data)) return null;
    for (const list of name === 'air' ? ['pollutants'] : name === 'alerts' ? ['items'] : name === 'daily' ? ['days'] : []) {
      const rows = item.data && item.data[list];
      if (rows !== undefined && (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !plain(row)))) return null;
    }
    out[name] = {};
    for (const key of ['status', 'stale', 'reason', 'data', 'attributions', 'refer', 'observed_at', 'fetched_at', 'expires_at', 'source_label', 'source_kind']) {
      if (item[key] !== undefined) out[name][key] = item[key];
    }
  }
  return out;
}
function refreshAt(data, now) {
  let until = now + HOUR;
  for (const name of ['weather', 'air', 'alerts']) {
    const slot = data[name], fetched = Date.parse(slot && slot.fetched_at), expires = Date.parse(slot && slot.expires_at);
    if (!slot || !['fresh', 'empty'].includes(slot.status) || !Number.isFinite(fetched) || !Number.isFinite(expires) || fetched > now || expires <= fetched || expires <= now) {
      until = Math.min(until, now + RETRY); continue;
    }
    until = Math.min(until, expires, fetched + HOUR);
    if (name === 'alerts') for (const item of slot.data && slot.data.items || []) {
      const end = Date.parse(item.expires_at);
      if (Number.isFinite(end) && end > now) until = Math.min(until, end);
    }
  }
  const daily = data.daily;
  if (daily && daily.status === 'fresh') {
    const expiry = Date.parse(daily.expires_at);
    if (Number.isFinite(expiry) && expiry > now) until = Math.min(until, expiry);
  }
  return Math.max(now + 1000, until);
}
function createWeatherSnapshotStore(platform = {}, config = {}, now = Date.now) {
  const key = KEY + encodeURIComponent(scope(config));
  let state = { version: 1, directory: null, summaries: {}, selected: '' };
  const pending = new Map(), failures = new Map();
  function persist() {
    try { if (JSON.stringify(state).length * 2 <= MAX_BYTES) platform.setStorageSync(key, copy(state)); } catch (_) { /* The in-memory cache remains usable. */ }
  }
  function validAge(saved, age) { return plain(saved) && Number.isFinite(saved.writtenAt) && saved.writtenAt <= now() && saved.writtenAt > now() - age; }
  try {
    const saved = platform.getStorageSync(key);
    if (plain(saved) && saved.version === 1 && JSON.stringify(saved).length * 2 <= MAX_BYTES) {
      if (validAge(saved.directory, RETAIN) && validDirectory(saved.directory.data)) state.directory = saved.directory;
      if (typeof saved.selected === 'string' && slugPattern.test(saved.selected)) state.selected = saved.selected;
      for (const [slug, entry] of Object.entries(plain(saved.summaries) ? saved.summaries : {}).slice(-16)) {
        if (!slugPattern.test(slug) || !validAge(entry, RETAIN) || !Number.isFinite(entry.refreshAt) || entry.refreshAt > entry.writtenAt + HOUR) continue;
        const data = summaryData(entry.data, slug);
        if (data) state.summaries[slug] = { ...entry, data };
      }
    }
  } catch (_) { /* Corrupt or unavailable storage cannot prevent a fresh request. */ }
  function validDirectory(data) {
    return plain(data) && typeof data.enabled === 'boolean' && Array.isArray(data.items) && data.items.length <= 32 && data.items.every(item => plain(item) && slugPattern.test(item.slug) && typeof item.name === 'string' && item.name.length <= 100);
  }
  function directory(allowStale = false) { return validAge(state.directory, allowStale ? RETAIN : HOUR) && validDirectory(state.directory.data) ? copy(state.directory.data) : null; }
  function read(slug) {
    const saved = state.summaries[slug];
    if (!slugPattern.test(slug) || !validAge(saved, RETAIN)) return null;
    // Rebound to the original source expiry when restoring from disk. The
    // provider timestamps, never another cache hit, establish normal freshness.
    const bound = refreshAt(saved.data, saved.writtenAt);
    const next = Math.max(Math.min(saved.refreshAt, bound), (failures.get('summary:' + slug) || {}).until || 0);
    return { data: copy(saved.data), refreshAt: next, fresh: next > now() };
  }
  function saveSummary(slug, raw) {
    const data = summaryData(raw, slug), writtenAt = now();
    if (!data || JSON.stringify(data).length * 2 > MAX_BYTES / 2) return;
    state.summaries[slug] = { data: copy(data), writtenAt, refreshAt: refreshAt(data, writtenAt) };
    const ids = Object.keys(state.summaries).sort((a, b) => state.summaries[a].writtenAt - state.summaries[b].writtenAt);
    while (ids.length && (ids.length > 16 || JSON.stringify(state).length * 2 > MAX_BYTES)) delete state.summaries[ids.shift()];
    persist();
  }
  function once(id, operation, force) {
    if (pending.has(id)) return pending.get(id);
    const failed = failures.get(id);
    if (!force && failed && failed.until > now()) return Promise.reject(failed.error);
    const promise = Promise.resolve().then(operation).then(value => { failures.delete(id); return value; }, error => {
      failures.set(id, { until: now() + RETRY, error }); throw error;
    }).finally(() => { if (pending.get(id) === promise) pending.delete(id); });
    pending.set(id, promise); return promise;
  }
  return {
    directory, read,
    selected: () => state.selected,
    select(slug) { if (slugPattern.test(slug)) { state.selected = slug; persist(); } },
    async locations(api, force = false) {
      const saved = directory(); if (saved && !force) return saved;
      return once('locations', async () => {
        const data = (await api.request('weather-data/locations/', { cache: false })).data || {};
        if (validDirectory(data)) {
          const items = data.items.map(item => Object.fromEntries(['slug', 'name', 'kind', 'latitude', 'longitude', 'coordinate_system', 'scope_note'].filter(k => item[k] !== undefined).map(k => [k, item[k]])));
          state.directory = { data: { items, enabled: data.enabled, forecast_enabled: data.forecast_enabled === true }, writtenAt: now() };
          if (data.enabled === false) state.summaries = {};
          persist();
        }
        return data;
      }, force);
    },
    async load(slug, api, force = false) {
      const saved = read(slug); if (saved && saved.fresh && !force) return saved.data;
      return once('summary:' + slug, async () => {
        const data = (await api.request('weather-data/summary/', { data: { location: slug }, timeout: 55000, cache: false })).data;
        saveSummary(slug, data); return data;
      }, force);
    },
  };
}
module.exports = { createWeatherSnapshotStore, scope, refreshAt, HOUR, RETRY };
