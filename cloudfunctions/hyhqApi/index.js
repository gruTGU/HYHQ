'use strict';
const { ApiError, response, uuid } = require('./lib/core');
const { configFromEnvironment } = require('./lib/config');
const accounts = require('./lib/accounts');
const { storageFor } = require('./lib/files');
function createApp({ store, cloud, config, now = () => new Date().toISOString(), providers }) {
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
      for (const handler of [accounts.handle, () => ctx.storage.handle(), require('./lib/management').handle, require('./lib/maintenance').handle, require('./lib/weather').handle, require('./lib/recognition').handle, require('./lib/llm').handle, require('./lib/activity').handle, require('./lib/catalog').handle]) {
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
  const application = createApp(dependencies);
  return async (event, identity, trustedRuntime = {}) => {
    const config = dependencies.config;
    // Only main reads these values from server process.env. No event field,
    // client header or SDK identity supplied in the request becomes a trigger.
    if (config.maintenanceEnabled === true && config.deploymentEnv && trustedRuntime.source === 'wx_trigger' && trustedRuntime.env === config.deploymentEnv) {
      const ctx = { store: dependencies.store, config, now: dependencies.now ? dependencies.now() : new Date().toISOString(), user: null };
      ctx.storage = storageFor(ctx, dependencies.cloud);
      const summary = await require('./lib/maintenance').runMaintenance(ctx, { limit: 20 });
      if (!summary.failed) await ctx.store.transaction(async tx => {
        const current = await tx.get('maintenance_state', 'global');
        if (current) await tx.update('maintenance_state', 'global', { timer_verified_at: ctx.now });
      });
      return response({ kind: 'maintenance', ...summary });
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
