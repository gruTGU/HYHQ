const KEY = 'hyhq.session.v1';
const DEVICE_KEY = 'hyhq.device.v1';

function createSession(platform, scope) {
  const suffix = scope ? '.' + scope : '';
  const sessionKey = KEY + suffix;
  const deviceKey = DEVICE_KEY + suffix;
  let current = null;
  let revision = 0;
  let invalidation = null;
  const listeners = new Set();
  function changed() {
    revision += 1;
    listeners.forEach((listener) => { try { listener(); } catch (error) { /* One listener cannot stop logout. */ } });
  }
  try { current = platform.getStorageSync(sessionKey) || null; } catch (error) { /* Storage can be disabled. */ }
  function clear(reason = 'logout') {
    const hadSession = !!current;
    const userId = current && current.user && current.user.id;
    current = null;
    // Keep no token here. Pages can distinguish expiry from an intentional
    // logout when deciding whether a not-yet-submitted local photo may remain.
    invalidation = { reason, userId, revision: revision + (hadSession ? 1 : 0) };
    if (hadSession) changed();
    try { platform.removeStorageSync(sessionKey); } catch (error) { /* Clear in-memory state regardless. */ }
  }
  function get() {
    if (current && current.expires_at && Date.parse(current.expires_at) <= Date.now()) clear('expired');
    return current;
  }
  return {
    get,
    revision: () => revision,
    invalidation: () => invalidation,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    token: () => (get() || {}).token || '',
    save(value) {
      const previous = current;
      current = value;
      if ((previous || {}).token !== (value || {}).token || ((previous || {}).user || {}).id !== ((value || {}).user || {}).id) changed();
      try { platform.setStorageSync(sessionKey, value); } catch (error) { /* Session remains memory-only. */ }
    },
    updateUser(user) {
      if (get()) this.save(Object.assign({}, current, { user }));
    },
    clear,
    deviceId() {
      let id;
      try { id = platform.getStorageSync(deviceKey); } catch (error) { /* Generate memory fallback. */ }
      if (!id) {
        id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
        try { platform.setStorageSync(deviceKey, id); } catch (error) { /* Never use this as authentication. */ }
      }
      return id;
    },
  };
}
module.exports = { createSession };
