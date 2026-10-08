// Only public presentation assets belong here; identity and private files never do.
// Discard v1's optimistic one-hour URLs. Requested storage TTL is not proof of
// actual URL validity; keep the server expiry and an independent short cap.
const KEY = 'hyhq.theme-assets.v2.';
const THEMES = ['forest', 'design-2', 'design-3'];
const ASSETS = ['weatherRiver', 'entryExplore', 'entryFlower', 'entryLearn', 'entryRiver', 'emptyState', 'paperTile', 'contours', 'riverExample'];
const MAX_AGE = 5 * 60 * 1000;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
function scope(config = {}) {
  const cloud = config.cloud || {};
  return config.transport === 'cloud-function' ? ['cloud-function', cloud.env || '', cloud.function || ''].join('|')
    : config.transport === 'cloud' ? ['cloud', cloud.env || '', cloud.service || ''].join('|')
      : ['http', String(config.baseURL || 'unconfigured').replace(/\/+$/, '')].join('|');
}
function safeURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f'"\\()<>]/.test(value)) return false;
  const match = /^https:\/\/([a-z\d.-]+)(\/[^#]*)$/i.exec(value);
  if (!match || match[1].split('.').some(label => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return false;
  const host = match[1].toLowerCase();
  return ['tcb.qcloud.la', 'tcb.qcloud.com', 'myqcloud.com', 'tcloudbase.com'].some(suffix => host.endsWith('.' + suffix));
}
function assetStyle(assets = {}) {
  return [['paper-image', 'paperTile'], ['contours-image', 'contours']].map(([name, key]) =>
    '--hyhq-' + name + ':' + (safeURL(assets[key]) ? 'url("' + assets[key] + '")' : 'none')).join(';');
}
function normalized(raw, theme, now) {
  if (!plain(raw) || raw.theme !== theme || !plain(raw.assets) || !['string', 'number'].includes(typeof raw.version)) return null;
  const expires = Date.parse(raw.expires_at);
  // The server already subtracts its signature safety margin. Partial results
  // intentionally expire after 30 seconds so missing files can be retried.
  if (!Number.isFinite(expires) || expires <= now) return null;
  const assets = {};
  for (const key of ASSETS) if (safeURL(raw.assets[key])) assets[key] = raw.assets[key];
  if (!Object.keys(assets).length) return null;
  return { version: raw.version, theme, assets, expires_at: new Date(Math.min(expires, now + MAX_AGE)).toISOString() };
}
function createThemeAssetStore(platform = {}, config = {}, now = Date.now) {
  const prefix = KEY + encodeURIComponent(scope(config)) + '.';
  const memory = new Map(), pending = new Map();
  function read(theme) {
    if (!THEMES.includes(theme)) return null;
    let saved = memory.get(theme);
    if (!saved) { try { saved = platform.getStorageSync(prefix + theme); } catch (_) { /* Storage may be unavailable. */ } }
    const value = normalized(saved, theme, now());
    if (!value) {
      memory.delete(theme);
      try { if (saved && platform.removeStorageSync) platform.removeStorageSync(prefix + theme); } catch (_) { /* Expired entries remain unusable. */ }
      return null;
    }
    memory.set(theme, value);
    return { ...value, assets: { ...value.assets } };
  }
  function load(theme, api, options = {}) {
    if (!THEMES.includes(theme)) return Promise.reject(new Error('主题素材不可用'));
    const saved = read(theme);
    if (saved && !options.force) return Promise.resolve(saved);
    if (pending.has(theme)) return pending.get(theme);
    const operation = Promise.resolve().then(() => api.request('theme-assets/', { data: { theme }, cache: false })).then(response => {
      const value = normalized(response && response.data, theme, now());
      if (!value) throw new Error('主题素材暂不可用');
      memory.set(theme, value);
      try { platform.setStorageSync(prefix + theme, { ...value, assets: { ...value.assets } }); } catch (_) { /* Keep the in-memory copy. */ }
      return { ...value, assets: { ...value.assets } };
    }).finally(() => { if (pending.get(theme) === operation) pending.delete(theme); });
    pending.set(theme, operation);
    return operation;
  }
  return { read, load };
}
module.exports = { KEY, ASSETS, safeURL, assetStyle, createThemeAssetStore };
