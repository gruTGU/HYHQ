const { THEMES, FOREST } = require('./themes');
const { assetStyle } = require('./theme-assets');
const KEY = 'hyhq.appearance.v1';
const CSS_NAMES = {
  background: 'background', surface: 'surface', primary: 'primary', text: 'text', muted: 'muted',
  secondary: 'secondary', secondaryText: 'secondary-text', accent: 'accent', lake: 'lake', warning: 'warning',
  border: 'border', notice: 'notice', cardRadius: 'card-radius', buttonRadius: 'button-radius',
  leafPrimary: 'leaf-primary', leafSecondary: 'leaf-secondary',
};
function safeValue(key, value) {
  return typeof value === 'string' && (key.endsWith('Radius') ? /^\d{1,3}rpx$/.test(value) : /^(?:#[a-f\d]{3}(?:[a-f\d]{3})?|rgba?\([\d.,\s]+\))$/i.test(value));
}
function validTheme(theme) {
  return !!(theme && theme.ready === true && /^[a-z][a-z0-9-]{0,40}$/.test(theme.id) && theme.tokens &&
    Object.keys(CSS_NAMES).every(key => safeValue(key, theme.tokens[key])) && theme.navigation &&
    /^#[a-f\d]{6}$/i.test(theme.navigation.backgroundColor) && ['#000000', '#ffffff'].includes(theme.navigation.frontColor));
}
function styleFor(theme) { return Object.keys(CSS_NAMES).map(key => '--hyhq-' + CSS_NAMES[key] + ':' + theme.tokens[key]).join(';'); }
function createThemeStore(platform, registry = THEMES) {
  const entries = registry.map(item => ({ ...item }));
  const usable = entries.filter(validTheme);
  if (!usable.some(item => item.id === FOREST.id)) usable.unshift(FOREST);
  const find = id => usable.find(item => item.id === id);
  let current = FOREST, persisted = true;
  try { const saved = platform.getStorageSync(KEY); current = find(saved && saved.version === 1 && saved.id) || FOREST; } catch (_) { /* Appearance can remain in memory. */ }
  const listeners = new Set();
  function snapshot() { return { id: current.id, name: current.name, style: styleFor(current), navigation: { ...current.navigation }, persisted }; }
  return {
    current: snapshot,
    list: () => entries.map(item => ({ id: item.id, name: item.name, description: item.description, ready: !!find(item.id), previewStyle: find(item.id) ? styleFor(find(item.id)) : '', selected: item.id === current.id })),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    select(id) {
      const selected = find(id);
      if (!selected) throw new Error('这个主题还未开放，请选择已完成的主题');
      current = selected; persisted = true;
      try { platform.setStorageSync(KEY, { version: 1, id }); } catch (_) { persisted = false; }
      const value = snapshot();
      listeners.forEach(fn => { try { fn(value); } catch (_) { /* One page cannot interrupt other subscribers. */ } });
      return value;
    },
  };
}
function applicationTheme() {
  if (typeof getApp !== 'function') return null;
  const app = getApp();
  return app && app.theme;
}
function wantsAssets(target, theme, options) {
  if (theme !== FOREST.id) return theme === 'design-2' || theme === 'design-3';
  const route = String(target.route || target.__route__ || '').replace(/^\//, '');
  return options.loadAssets === true || ['pages/recognize/index', 'pages/assessment/index'].includes(route);
}
function nativeColors(theme) {
  if (typeof wx === 'undefined') return;
  try { if (wx.setNavigationBarColor) wx.setNavigationBarColor({ ...theme.navigation, animation: { duration: 0 }, fail() {} }); } catch (_) { /* Older clients retain their default bar. */ }
  try { if (wx.setBackgroundColor) wx.setBackgroundColor({ backgroundColor: theme.navigation.backgroundColor, fail() {} }); } catch (_) { /* CSS still applies. */ }
}
function connectTheme(target, native = false, options = {}) {
  disconnectTheme(target);
  const theme = applicationTheme();
  if (!theme) return;
  target._themeConnected = true;
  const application = typeof getApp === 'function' && getApp();
  const store = application && application.themeAssets;
  const apply = value => {
    const sequence = target._themeAssetSequence = (target._themeAssetSequence || 0) + 1;
    const needed = store && wantsAssets(target, value.id, options);
    const cached = needed && store.read(value.id);
    const assets = cached && cached.assets || {};
    target.setData({ themeId: value.id, themeName: value.name, themeStyle: value.style, themeAssets: assets, themeAssetStyle: assetStyle(assets) });
    if (native) nativeColors(value);
    if (needed && !cached) store.load(value.id, application.api).then(result => {
      if (!target._themeConnected || sequence !== target._themeAssetSequence) return;
      target.setData({ themeAssets: result.assets, themeAssetStyle: assetStyle(result.assets) });
    }).catch(() => { /* Color-only rendering remains usable; reconnect can retry. */ });
  };
  apply(theme.current()); target._themeUnsubscribe = theme.subscribe(apply);
}
function disconnectTheme(target) {
  target._themeConnected = false;
  target._themeAssetSequence = (target._themeAssetSequence || 0) + 1;
  if (target._themeUnsubscribe) target._themeUnsubscribe(); target._themeUnsubscribe = null;
}
function withTheme(definition) {
  const wrapped = { ...definition, data: { themeId: FOREST.id, themeName: FOREST.name, themeStyle: styleFor(FOREST), themeAssets: {}, themeAssetStyle: assetStyle(), ...(definition.data || {}) } };
  for (const name of ['onLoad', 'onShow', 'onHide', 'onUnload']) {
    const previous = definition[name];
    wrapped[name] = function (...args) {
      if (name === 'onLoad' || name === 'onShow') connectTheme(this, name === 'onShow');
      else disconnectTheme(this);
      return previous && previous.apply(this, args);
    };
  }
  return wrapped;
}
module.exports = { KEY, createThemeStore, withTheme, connectTheme, disconnectTheme, validTheme };
