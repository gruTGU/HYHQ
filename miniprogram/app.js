const config = require('./config/index');
const { createClient } = require('./lib/client');
const { createSession } = require('./lib/session');
const { createThemeStore } = require('./lib/theme');
const { createThemeAssetStore } = require('./lib/theme-assets');
App({
  config,
  // A new session starts in Tianjin; explicit city/GPS choices apply within it.
  globalData: { region: null, health: null, weatherLocation: 'tianjin' },
  onLaunch() {
    this.theme = createThemeStore(wx);
    const cloud = config.cloud || {};
    const sessionScope = config.transport === 'cloud-function'
      ? 'cloud-function.' + (cloud.env || 'unconfigured') + '.' + (cloud.function || 'unconfigured')
      : config.transport === 'cloud' ? 'cloud.' + (cloud.env || 'unconfigured') + '.' + (cloud.service || 'unconfigured') : '';
    this.session = createSession(wx, sessionScope);
    this.api = createClient(wx, config, this.session);
    this.themeAssets = createThemeAssetStore(wx, config);
  },
});
