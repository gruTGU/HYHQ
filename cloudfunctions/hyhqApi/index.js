'use strict';
const { ApiError, response, uuid } = require('./lib/core');
const { configFromEnvironment } = require('./lib/config');
const { RELEASE_ID, applyReleasePolicy, enforceRequestPolicy } = require('./lib/release-policy');
const accounts = require('./lib/accounts');
const { storageFor } = require('./lib/files');
const { runtimeProviders } = require('./lib/subscription-transport');
function isTrustedTimer(config, runtime) {
  // WeChat sets TCB_SOURCE=wx_trigger; CloudBase also documents TRIGGER_SRC=timer.
  // Both values must come from the runtime, never the event. An explicit client
  // source cannot be overridden by a second marker or a forged Timer payload.
  const source = runtime.source;
  return !!config.deploymentEnv && runtime.env === config.deploymentEnv
    && (source === 'wx_trigger' || (!source && runtime.triggerSource === 'timer'));
}
async function recordTimerDiagnostic(ctx, event, identity, runtime) {
  // Observation only: this does not make an invocation trusted. Native client
  // identities and client/devtools/HTTP sources cannot write the diagnostic.
  if (!event || !['Timer', 'timer'].includes(event.Type)
    || !['hyhqWeatherReminders', 'hyhqMaintenance'].includes(event.TriggerName)
    || identity && (identity.OPENID || identity.UNIONID || identity.UID)
    || /client|devtools|http/i.test(String(runtime.source || ''))) return;
  const now = Date.parse(ctx.now); if (!Number.isFinite(now)) return;
  const window = Math.floor(now / 300000);
  // Runtime source labels only; malformed or non-label values are not stored.
  const label = value => typeof value !== 'string' || !value ? 'absent'
    : /^[a-zA-Z][a-zA-Z0-9_-]{0,31}(?:,[a-zA-Z][a-zA-Z0-9_-]{0,31}){0,3}$/.test(value) ? value : 'unrecognized';
  try {
    await ctx.store.transaction(async tx => {
      const previous = await tx.get('weather_timer_diagnostic', 'global');
      if (previous && previous.window >= window) return;
      await tx.set('weather_timer_diagnostic', 'global', { id: 'global', window, observed_at: ctx.now,
        event_type: event.Type, trigger_name: event.TriggerName,
        source: label(runtime.source), trigger_source: label(runtime.triggerSource),
        env_present: !!runtime.env, deployment_env_present: !!ctx.config.deploymentEnv,
        env_matches: !!ctx.config.deploymentEnv && runtime.env === ctx.config.deploymentEnv,
        trusted_timer: isTrustedTimer(ctx.config, runtime) });
    });
  } catch (_) { console.error(JSON.stringify({ event: 'timer_diagnostic_failed', error_type: 'state_write_failed' })); }
}
async function recordReminderRun(ctx, result) {
  // The existing administrator-only collection is enough to inspect execution
  // without enabling a separate log service. Never persist recipients/errors.
  try {
    await ctx.store.set('weather_reminder_state', 'global', { id: 'global',
      last_started_at: ctx.now, last_finished_at: new Date().toISOString(),
      message_state: ctx.config.weatherReminders.state, ...result });
  } catch (_) {
    // Delivery state is already persisted by the worker. Observability failure
    // must not turn a successful send into a retry or another provider call.
    console.error(JSON.stringify({ event: 'weather_reminders_status_failed', error_type: 'state_write_failed' }));
  }
}
function createApp({ store, cloud, config, now = () => new Date().toISOString(), providers }) {
  config = applyReleasePolicy(config);
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
      await enforceRequestPolicy(ctx);
      if (ctx.path === 'health/' && method === 'GET') {
        const capabilities = await require('./lib/recognition').status(ctx);
        let llm = false;
        try { llm = require('./lib/llm').configFor(ctx).enabled; } catch (_) { /* Invalid optional configuration is unavailable. */ }
        const weather = require('./lib/weather').configured(config);
        return response({ status: 'ok', runtime: 'wechat-personal', api_version: 1, version: 'm5', release: RELEASE_ID, mode: 'mixed', dev_auth_enabled: false,
          features: { recognition: capabilities.recognition.enabled, assessment: capabilities.assessment.enabled, llm },
          ...capabilities, optional_services: { weather, llm, inference: capabilities.recognition.enabled && capabilities.assessment.enabled } });
      }
      for (const handler of [themeAssets, accounts.handle, () => ctx.storage.handle(), require('./lib/community').handle, require('./lib/events').handle, require('./lib/environment-reports').handle, require('./lib/management').handle, require('./lib/maintenance').handle, require('./lib/weather-booking-ai').handle, require('./lib/weather').handle, require('./lib/recognition').handle, require('./lib/llm').handle, require('./lib/activity').handle, require('./lib/catalog').handle]) {
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
  dependencies = { ...dependencies, config: applyReleasePolicy(dependencies.config) };
  const providers = runtimeProviders(dependencies.cloud, dependencies.config, dependencies.providers);
  const application = createApp({ ...dependencies, providers });
  return async (event, identity, trustedRuntime = {}) => {
    const config = dependencies.config;
    await recordTimerDiagnostic({ store: dependencies.store, config,
      now: dependencies.now ? dependencies.now() : new Date().toISOString() }, event, identity, trustedRuntime);
    // Event names select work only after the invocation source and deployment
    // environment have been verified from server process.env, never client data.
    const trustedTimer = isTrustedTimer(config, trustedRuntime);
    if (trustedTimer && event && ['Timer', 'timer'].includes(event.Type)) {
      const ctx = { store: dependencies.store, config, providers, now: dependencies.now ? dependencies.now() : new Date().toISOString(), user: null };
      if (event.TriggerName === 'hyhqWeatherReminders' && config.weatherReminders && config.weatherReminders.enabled === true) {
        // A reminder run has its own 60-second invocation, not the remainder of
        // the maintenance sweep's 25-second work window.
        let summary;
        try { summary = await require('./lib/weather-reminders').runDueReminders(ctx, { limit: 3 }); }
        catch (error) {
          await recordReminderRun(ctx, { status: 'failed', error_type: 'worker_failed' });
          console.error(JSON.stringify({ event: 'weather_reminders_failed', started_at: ctx.now, error_type: 'worker_failed' }));
          throw error;
        }
        await recordReminderRun(ctx, { status: summary.enabled ? 'completed' : 'disabled', summary });
        // Safe operational evidence: no user IDs, recipient IDs, message body,
        // tokens or provider errors. A configured timer is not proof it ran.
        console.info(JSON.stringify({ event: 'weather_reminders_finished', started_at: ctx.now,
          message_state: config.weatherReminders.state, ...summary }));
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
  return application(event, sdk.getWXContext(), { source: process.env.TCB_SOURCE, triggerSource: process.env.TRIGGER_SRC, env: process.env.TCB_ENV || process.env.SCF_NAMESPACE });
};
exports.createApp = createApp;
exports.createRuntime = createRuntime;
