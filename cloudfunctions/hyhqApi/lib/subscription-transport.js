'use strict';
// The SDK supplies its own server credentials. No AppSecret/access token is
// passed through application payloads. One call only; an uncertain ACK is final.
const STATES = Object.freeze(['developer', 'trial', 'formal']);
function validPage(page) {
  return page === 'pages/home/index' || page === 'pages/events/index'
    || /^pages\/weather\/index\?location=[a-z0-9][a-z0-9-]{0,79}$/.test(page)
    || /^pages\/weather\/index\?type=ecology_simulation&scenario=(steady|rain|heat|check)$/.test(page);
}
function createWeatherReminderSender(cloud, config) {
  const settings = config && config.weatherReminders || {};
  const api = cloud && cloud.openapi && cloud.openapi.subscribeMessage;
  if (!api || typeof api.send !== 'function' || !STATES.includes(settings.state) || typeof settings.templateId !== 'string' || !settings.templateId) return null;
  return async request => {
    if (!request || request.templateId !== settings.templateId || typeof request.touser !== 'string'
      || !/^[A-Za-z0-9_-]{8,128}$/.test(request.touser) || typeof request.page !== 'string'
      || !validPage(request.page)) throw Object.assign(new Error('subscription_payload_invalid'), { code: 'SUBSCRIPTION_PAYLOAD_INVALID', dispatched: false, ambiguous: false });
    let timer;
    try {
      // The caller's persisted send claim prevents duplicate sends after this
      // deadline. The native request can still complete, so never auto-retry it.
      return await Promise.race([
        Promise.resolve().then(() => api.send({ touser: request.touser, templateId: settings.templateId, page: request.page,
          data: request.data, miniprogramState: settings.state, lang: 'zh_CN' })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('subscription_ack_timeout'), { ambiguous: true })), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
}
function runtimeProviders(cloud, config, providers) {
  const output = { ...(providers || {}) };
  if (!Object.prototype.hasOwnProperty.call(output, 'sendWeatherReminder')) {
    const send = createWeatherReminderSender(cloud, config);
    if (send) output.sendWeatherReminder = send;
  }
  return output;
}
module.exports = { createWeatherReminderSender, runtimeProviders, STATES };
