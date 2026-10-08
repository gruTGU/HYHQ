'use strict';
const { ApiError, response, uuid } = require('./lib/core');
const { configFromEnvironment } = require('./lib/config');
const accounts = require('./lib/accounts');
const { storageFor } = require('./lib/files');
const { runtimeProviders } = require('./lib/subscription-transport');
function createApp({ store, cloud, config, now = () => new Date().toISOString(), providers }) {
  providers = runtimeProviders(cloud, config, providers);
  const themeAssets = require('./lib/theme-assets').createThemeAssetsHandler(cloud);
  return async function dispatch(event, identity = {}) {
    const requestId = uuid();
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event) || JSON.stringify(event).length > 400000) throw new ApiError('INVALID_REQUEST', '请求格式无效');
      const { method, path, body, headers } = event;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method) || typeof path !== 'string' || path.length > 4096 || !path.startsWith('/api/v1/') || /[\\\s#\x00-\x1f]/.test(path)) throw new ApiError('INVALID_REQUEST', '接口路径或方法无效');
      const url = new URL(path, 'https://hyhq.invalid');
      if (/\/\/|(?:^|\/)\.{1,2}(?:\/|$)|%/.test(path.split('?')[0]) || url.pathname !== path.split('?')[0]) throw new ApiError('INVALID_REQUEST', '接口路径无效');
      if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) throw new ApiError('INVALID_REQUEST', '请求内容无效');
      const ctx = { method, path: url.pathname.slice('/api/v1/'.length), query: url.searchParams, body: body || {}, user: null, store, config, now: now(), providers };
      // Only this entry obtains identity from the server SDK. Client event fields
      // named OPENID/APPID/user/header identity are intentionally never consumed.
      ctx.identityKey = accounts.identityOf(identity, config);
      // Verified SDK identity only. Its one private use is subscription-recipient
      // binding after explicit consent; never include it in public responses/logs.
      ctx.wechatOpenId = identity.OPENID;
      ctx.checkCommunityText = providers && providers.checkCommunityText || (cloud && cloud.openapi && cloud.openapi.security && cloud.openapi.security.msgSecCheck
        ? payload => cloud.openapi.security.msgSecCheck({ ...payload, openid: identity.OPENID, version: 2 }) : null);
      ctx.storage = storageFor(ctx, cloud);
      if (ctx.path !== 'auth/wechat/') await accounts.authenticate(ctx, headers);
      if (ctx.path === 'health/' && method === 'GET') {
        const capabilities = await require('./lib/recognition').status(ctx);
        let llm = false;
        try { llm = require('./lib/llm').configFor(ctx).enabled; } catch (_) { /* Invalid optional configuration is unavailable. */ }
        const weather = require('./lib/weather').configured(config);
        return response({ status: 'ok', runtime: 'wechat-personal', api_version: 1, version: 'm5', mode: 'mixed', dev_auth_enabled: false,
          features: { recognition: capabilities.recognition.enabled, assessment: capabilities.assessment.enabled, llm },
          ...capabilities, optional_services: { weather, llm, inference: capabilities.recognition.enabled && capabilities.assessment.enabled } });
      }
      for (const handler of [themeAssets, accounts.handle, () => ctx.storage.handle(), require('./lib/community').handle, require('./lib/management').handle, require('./lib/maintenance').handle, require('./lib/weather-booking-ai').handle, require('./lib/weather').handle, require('./lib/recognition').handle, require('./lib/llm').handle, require('./lib/activity').handle, require('./lib/catalog').handle]) {
        const result = await handler(ctx);
        if (result !== undefined) return result;
      }
      throw new ApiError('NOT_FOUND', '此接口尚未开放', 404);
    } catch (error) {
      // Never log event, identity, token, provider payloads or private file IDs.
      const known = error instanceof ApiError;
      if (!known) console.error(JSON.stringify({ event: 'request_failed', request_id: requestId, error_type: 'internal' }));
      return { statusCode: known ? error.status : 500, data: { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务暂时不可用，请稍后重试', ...(known && error.details ? { details: error.details } : {}) }, request_id: requestId } };
    }
  };
}
function createRuntime(dependencies) {
  const providers = runtimeProviders(dependencies.cloud, dependencies.config, dependencies.providers);
  const application = createApp({ ...dependencies, providers });
  return async (event, identity, trustedRuntime = {}) => {
    const config = dependencies.config;
    // Event names select work only after the invocation source and deployment
    // environment have been verified from server process.env, never client data.
    const trustedTimer = config.deploymentEnv && trustedRuntime.source === 'wx_trigger' && trustedRuntime.env === config.deploymentEnv;
    if (trustedTimer && event && event.Type === 'Timer') {
      const ctx = { store: dependencies.store, config, providers, now: dependencies.now ? dependencies.now() : new Date().toISOString(), user: null };
      if (event.TriggerName === 'hyhqWeatherReminders' && config.weatherReminders && config.weatherReminders.enabled === true) {
        // A reminder run has its own 60-second invocation, not the remainder of
        // the maintenance sweep's 25-second work window.
        const summary = await require('./lib/weather-reminders').runDueReminders(ctx, { limit: 3 });
        return response({ kind: 'weather-reminders', ...summary });
      }
      if (event.TriggerName === 'hyhqMaintenance' && config.maintenanceEnabled === true) {
        const started = Date.now();
        ctx.storage = storageFor(ctx, dependencies.cloud);
        const summary = await require('./lib/maintenance').runMaintenance(ctx, { limit: 20 });
        const cleanupStarted = Date.now(), deadline = Math.min(started + 45000, cleanupStarted + 15000);
        let reminderCleanup = { processed: 0, skipped: true };
        try {
          if (cleanupStarted < deadline) reminderCleanup = await require('./lib/weather-reminders').cleanupReminders(
            { ...ctx, now: new Date(Date.parse(ctx.now) + Math.max(0, cleanupStarted - started)).toISOString() },
            { limit: 20, alive: () => Date.now() < deadline });
        } catch (_) { reminderCleanup = { failed: 1 }; }
        // Retention runs even when new subscriptions are disabled. Store only
        // aggregate outcomes; recipient/appointment contents never enter logs.
        summary.reminder_cleanup = { ...reminderCleanup, finished_at: new Date(Date.parse(ctx.now) + Math.max(0, Date.now() - started)).toISOString() };
        await ctx.store.transaction(async tx => {
          const current = await tx.get('maintenance_state', 'global');
          if (current) await tx.update('maintenance_state', 'global', { ...(!summary.failed ? { timer_verified_at: ctx.now } : {}), reminder_cleanup: summary.reminder_cleanup });
        });
        return response({ kind: 'maintenance', ...summary });
      }
      return response({ kind: 'timer-ignored' });
    }
    return application(event, identity);
  };
}

let application, sdk;
exports.main = async event => {
  if (!application) {
    sdk = require('wx-server-sdk'); sdk.init({ env: sdk.DYNAMIC_CURRENT_ENV });
    let deployment = {}; try { deployment = require('./deployment.local.json'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    const { CloudStore } = require('./lib/store');
    application = createRuntime({ store: new CloudStore(sdk.database()), cloud: sdk, config: configFromEnvironment(process.env, deployment) });
  }
  return application(event, sdk.getWXContext(), { source: process.env.TCB_SOURCE, env: process.env.TCB_ENV || process.env.SCF_NAMESPACE });
};
exports.createApp = createApp;
exports.createRuntime = createRuntime;
