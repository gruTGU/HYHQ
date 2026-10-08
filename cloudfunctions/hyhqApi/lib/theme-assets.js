'use strict';

const { ApiError, response } = require('./core');
const deployedManifest = require('../data/theme-assets');
const THEME_KEYS = Object.freeze({
  forest: Object.freeze([]),
  'design-2': Object.freeze(['weatherRiver', 'entryExplore', 'entryFlower', 'entryLearn', 'entryRiver', 'emptyState']),
  'design-3': Object.freeze(['paperTile', 'contours', 'emptyState']),
});
const SHARED_KEYS = Object.freeze(['riverExample']);
// Requested signature TTL is not a guarantee of the returned URL's usable life.
// Cloud links observed in production expired before a requested one-hour TTL;
// conservatively cache for five minutes at most, less the existing safety margin.
const URL_MAX_AGE = 300;
const EXPIRY_MARGIN_MS = 60000;

function isHttpsURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch (_) { return false; }
}

function createThemeAssetsHandler(cloud, { manifest = deployedManifest, clock = Date.now } = {}) {
  // Construct the only signable IDs from trusted deployment data, never query
  // parameters, uploads, database records or the caller's user identity.
  const manifests = {};
  for (const [theme, allowedKeys] of Object.entries(THEME_KEYS)) {
    const assets = {};
    for (const key of [...SHARED_KEYS, ...allowedKeys]) {
      const entry = SHARED_KEYS.includes(key) ? manifest.shared && manifest.shared[key] : manifest.themes && manifest.themes[theme] && manifest.themes[theme][key];
      if (typeof entry === 'string' && /^cloud:\/\/[^\s?#]+$/.test(entry) && entry.length <= 2048) assets[key] = entry;
    }
    manifests[theme] = Object.freeze(assets);
  }
  const version = typeof manifest.version === 'string' ? manifest.version : 'unconfigured';
  // At most the ten manifest files can enter either map. A shared file also
  // shares its signature and in-flight request across different themes.
  const cache = new Map(), pending = new Map();

  async function resolveFiles(ids) {
    const waits = [], batch = [];
    for (const fileID of new Set(ids)) {
      const stored = cache.get(fileID);
      if (stored && stored.expires > clock()) { waits.push(Promise.resolve([fileID, stored])); continue; }
      cache.delete(fileID);
      if (!pending.has(fileID)) {
        let finish;
        const promise = new Promise(resolve => { finish = resolve; });
        pending.set(fileID, promise);
        batch.push({ fileID, finish });
      }
      waits.push(pending.get(fileID).then(value => [fileID, value]));
    }
    if (batch.length) {
      // Resolve all newly missing files together; another simultaneous request
      // joins their promises rather than requesting duplicate signed URLs.
      const entries = new Map();
      try {
        const result = cloud && typeof cloud.getTempFileURL === 'function'
          ? await cloud.getTempFileURL({ fileList: batch.map(({ fileID }) => ({ fileID, maxAge: URL_MAX_AGE })) }) : null;
        for (const item of result && Array.isArray(result.fileList) ? result.fileList : []) {
          if (!item || item.status !== 0 || !isHttpsURL(item.tempFileURL)) continue;
          const age = item.maxAge === undefined ? URL_MAX_AGE : Number(item.maxAge);
          if (!Number.isFinite(age) || age <= EXPIRY_MARGIN_MS / 1000) continue;
          entries.set(item.fileID, { url: item.tempFileURL, expires: clock() + Math.min(age, URL_MAX_AGE) * 1000 - EXPIRY_MARGIN_MS });
        }
      } catch (_) {
        // Theme art is optional. No provider payload, signed URL or file ID is
        // logged, and failure does not prevent the rest of the page loading.
      } finally {
        for (const { fileID, finish } of batch) {
          const entry = entries.get(fileID) || null;
          if (entry) cache.set(fileID, entry);
          pending.delete(fileID);
          finish(entry);
        }
      }
    }
    return new Map(await Promise.all(waits));
  }

  return async function handle(ctx) {
    if (ctx.path !== 'theme-assets/') return undefined;
    if (ctx.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', '此接口仅支持读取主题素材', 405);
    const query = ctx.query || new URLSearchParams();
    const theme = query.get('theme');
    if (!Object.prototype.hasOwnProperty.call(THEME_KEYS, theme) || query.getAll('theme').length !== 1 || [...query.keys()].some(key => key !== 'theme') || Object.keys(ctx.body || {}).length) {
      throw new ApiError('VALIDATION_ERROR', '主题素材参数无效');
    }
    const mapping = manifests[theme], resolved = await resolveFiles(Object.values(mapping));
    const assets = {}, expirations = [];
    for (const [key, fileID] of Object.entries(mapping)) {
      const item = resolved.get(fileID);
      if (item && item.expires > clock()) { assets[key] = item.url; expirations.push(item.expires); }
    }
    // A partial/unavailable theme is retriable shortly; successful URL entries
    // remain cached and are reused when only the missing assets need retrying.
    if (Object.keys(assets).length < Object.keys(mapping).length || !expirations.length) expirations.push(clock() + 30000);
    return response({ version, theme, assets, expires_at: new Date(Math.min(...expirations)).toISOString() });
  };
}

module.exports = { createThemeAssetsHandler };
