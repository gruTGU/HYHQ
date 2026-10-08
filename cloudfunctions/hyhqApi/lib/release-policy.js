'use strict';
// This special release keeps generic LLM libraries and their accounting readable,
// but production assembly has no environment/client switch that enables generation.
const { ApiError } = require('./core');
const RELEASE_ID = 'wechat-no-qa-20261008';
function applyReleasePolicy(config = {}) {
  const output = { ...config };
  for (const key of ['llmEnabled', 'llmGatewayEnabled']) {
    Object.defineProperty(output, key, { value: false, enumerable: true, writable: false, configurable: false });
  }
  return output;
}
function enforceRequestPolicy(ctx) {
  // History/status reads and private-data deletion stay available. In particular,
  // queued-turn GETs reach the normal disabled-gateway settlement path so their
  // reservations are released without deleting past attempts or billed usage.
  if (ctx.method === 'POST' && (ctx.path.startsWith('llm/') || ctx.path === 'weather-data/reminders/interpret/')) {
    throw new ApiError('LLM_DISABLED', '此特别版本已关闭 AI 问答与自然语言预约，请使用手动功能。', 503);
  }
}
module.exports = { RELEASE_ID, applyReleasePolicy, enforceRequestPolicy };
