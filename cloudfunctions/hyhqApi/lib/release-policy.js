'use strict';
const { ApiError } = require('./core');
const RELEASE_ID = 'wechat-event-reminders-20261019';
function applyReleasePolicy(config = {}) {
  return { ...config, instantSimulationOnly: true, llmWeatherContextEnabled: false };
}
async function enforceRequestPolicy(ctx) {
  // This edition restores only the guide, learning and weather-draft entry points.
  if (ctx.method === 'POST' && ctx.path === 'llm/sessions/' && !['explore', 'learn'].includes(ctx.body.scope)) {
    throw new ApiError('LLM_SCOPE_DISABLED', '请从生态导览或科普智游进入 AI 对话。', 403);
  }
  const turn = ctx.path.match(/^llm\/sessions\/([^/]+)\/turns\/$/);
  if (ctx.method === 'POST' && turn && ctx.user) {
    const session = await ctx.store.get('llm_sessions', turn[1]);
    if (session && session.owner_id === ctx.user.id && !['explore', 'learn'].includes(session.scope || session.kind)) {
      throw new ApiError('LLM_SCOPE_DISABLED', '此版本仅开放生态导览与科普智游对话。', 403);
    }
  }
}
module.exports = { RELEASE_ID, applyReleasePolicy, enforceRequestPolicy };
