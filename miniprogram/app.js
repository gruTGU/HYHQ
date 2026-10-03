const config = require('./config/index');
const { createClient } = require('./lib/client');
const { createSession } = require('./lib/session');
App({
  config,
  globalData: { region: null, health: null },
  onLaunch() {
    const cloud = config.cloud || {};
    const sessionScope = config.transport === 'cloud-function'
      ? 'cloud-function.' + (cloud.env || 'unconfigured') + '.' + (cloud.function || 'unconfigured')
      : config.transport === 'cloud' ? 'cloud.' + (cloud.env || 'unconfigured') + '.' + (cloud.service || 'unconfigured') : '';
    this.session = createSession(wx, sessionScope);
    this.api = createClient(wx, config, this.session);
  },
});
