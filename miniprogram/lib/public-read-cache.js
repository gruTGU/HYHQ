// Volatile public read-through cache. It never persists identity or data to disk.
// Details/RAG, private records, job polling and AI usage always reach the server.
const { publicRead } = require('./public-read-policy');
const MAX_ENTRIES = 48, MAX_VALUE_BYTES = 384 * 1024;
function descriptor(path, options = {}) {
  if (options.cache === false) return null;
  const info = publicRead(path, options);
  return info && { route: info.route, ttl: info.ttl, key: JSON.stringify([info.route, info.entries, options.timeout || null]) };
}
function createPublicReadCache(client, session, apiError, now = Date.now) {
  const values = new Map(), pending = new Map();
  let epoch = 0, lastToken = session.token();
  const revision = () => typeof session.revision === 'function' ? session.revision() : 0;
  let lastRevision = revision();
  function invalidatePublicCache() { epoch += 1; values.clear(); pending.clear(); }
  function identity() {
    const token = session.token(), currentRevision = revision();
    if (token !== lastToken || currentRevision !== lastRevision) { invalidatePublicCache(); lastToken = token; lastRevision = currentRevision; }
    return { token, revision: currentRevision };
  }
  if (typeof session.subscribe === 'function') session.subscribe(() => { invalidatePublicCache(); lastToken = session.token(); lastRevision = revision(); });
  function attach(entry, selectedIdentity) {
    let finished = false, rejectCaller;
    entry.listeners += 1;
    const result = new Promise((resolve, reject) => {
      rejectCaller = reject;
      entry.promise.then(value => {
        if (finished) return;
        finished = true; entry.listeners -= 1;
        const recoveredGuest = entry.anonymousRevision !== undefined && !session.token() && revision() === entry.anonymousRevision;
        if (!recoveredGuest && (session.token() !== selectedIdentity.token || revision() !== selectedIdentity.revision)) return reject(apiError('SESSION_CHANGED', '登录状态已变化，请重新操作'));
        try { resolve(JSON.parse(value)); } catch (_) { reject(apiError('INVALID_RESPONSE', '接口返回格式不正确，请重试')); }
      }, error => { if (!finished) { finished = true; entry.listeners -= 1; reject(error); } });
    });
    result.abort = () => {
      if (finished) return;
      finished = true; entry.listeners -= 1;
      rejectCaller(apiError('CANCELLED', '操作已取消'));
      if (!entry.listeners) {
        if (pending.get(entry.key) === entry) pending.delete(entry.key);
        entry.cancelled = true; if (entry.abort) entry.abort();
      }
    };
    return result;
  }
  function request(path, options = {}) {
    const selectedIdentity = identity();
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase());
    if (mutation) {
      invalidatePublicCache();
      const result = client.request(path, options);
      // Invalidate both sides: concurrent reads during a mutation cannot outlive it.
      result.then(invalidatePublicCache, invalidatePublicCache);
      return result;
    }
    const info = descriptor(path, options);
    if (!info) return client.request(path, options);
    const saved = values.get(info.key);
    if (saved && saved.until > now()) return attach({ promise: Promise.resolve(saved.json), listeners: 0 }, selectedIdentity);
    values.delete(info.key);
    if (pending.has(info.key)) return attach(pending.get(info.key), selectedIdentity);
    const started = now(), generation = epoch, raw = client.request(path, options);
    const entry = { key: info.key, listeners: 0, cancelled: false, abort: typeof raw.abort === 'function' ? () => raw.abort() : null };
    entry.promise = raw.catch(error => {
      // A server-confirmed expired login should not blank public browsing. Only
      // one anonymous retry is allowed, never after manual logout/account switch.
      if (!entry.cancelled && (error.status === 401 || error.code === 'SESSION_CHANGED')
        && client.canRetryPublicAfterUnauthorized && client.canRetryPublicAfterUnauthorized(selectedIdentity)) {
        entry.anonymousRevision = revision();
        const retry = client.request(path, options);
        entry.abort = typeof retry.abort === 'function' ? () => retry.abort() : null;
        return retry;
      }
      throw error;
    }).then(response => {
      const json = JSON.stringify(response), data = response && response.data;
      const list = ['regions/', 'places/', 'maps/', 'contents/', 'routes/', 'water-bodies/'].includes(info.route);
      const validShape = data && typeof data === 'object' && !response.error && (list ? Array.isArray(data) : !Array.isArray(data));
      let until = started + info.ttl;
      if (info.route === 'weather-data/summary/') {
        // Never extend provider freshness or reuse unavailable/stale weather.
        const data = response && response.data;
        for (const name of ['weather', 'air', 'alerts']) {
          const slot = data && data[name];
          if (!slot || !['fresh', 'empty'].includes(slot.status)) { until = 0; break; }
          if (slot.expires_at) until = Math.min(until, Date.parse(slot.expires_at) || 0);
        }
      }
      if (validShape && !entry.cancelled && generation === epoch && until > now() && json && json.length * 2 <= MAX_VALUE_BYTES) {
        values.set(info.key, { json, until });
        while (values.size > MAX_ENTRIES) values.delete(values.keys().next().value);
      }
      return json;
    }).finally(() => { if (pending.get(info.key) === entry) pending.delete(info.key); });
    pending.set(info.key, entry);
    return attach(entry, selectedIdentity);
  }
  return Object.assign({}, client, { request, invalidatePublicCache });
}
module.exports = { createPublicReadCache, descriptor };
