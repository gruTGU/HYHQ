'use strict';
// Structured drafts use the same durable admission, concurrency and billing
// records as public-context chat. No model output can execute an appointment.
const { ApiError, uuid, sha256 } = require('./core');
const llm = require('./llm');
const weather = require('./weather');
const provider = require('./providers');
const iso = ms => new Date(ms).toISOString();
const fail = (code, message, status = 409) => { throw new ApiError(code, message, status); };
async function run(ctx, { requestKey, fingerprint, messages, decode }, adapters = ctx.providers || {}) {
  const user = await llm.activeUser(ctx), cfg = llm.configFor(ctx), now = Date.parse(ctx.now), started = Date.now();
  const liveNow = () => now + Date.now() - started;
  const id = sha256(llm.identity(user) + ':weather-booking:' + requestKey), token = uuid();
  await llm.recoverExpired(ctx);
  const claim = await ctx.store.transaction(async tx => {
    await llm.activeUser(ctx, tx);
    const old = await tx.get('llm_ledger', id);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', '此请求编号已用于其他内容。');
      if (old.owner_id !== user.id) fail('REQUEST_ALREADY_CONSUMED', '此请求已处理，请重新输入。');
      const cached = await tx.get('weather_ai_drafts', id);
      if (old.status === 'succeeded' && cached && cached.owner_id === user.id && Date.parse(cached.expires_at) > liveNow()) return { cached: cached.result };
      if (old.status === 'running') fail('LLM_USER_BUSY', '预约内容仍在整理，请稍后重试。');
      fail('REQUEST_ALREADY_CONSUMED', '本次整理已结束但没有可用草稿，请重新输入。');
    }
    llm.requireEnabled(ctx);
    const gate = await tx.get('llm_gate', 'runtime') || { id: 'runtime', active: [] };
    if (gate.active.some(x => x.owner_id === user.id)) fail('LLM_USER_BUSY', '你已有一条 AI 请求正在处理，请等待完成。');
    if (gate.active.filter(x => x.status === 'running').length >= cfg.concurrency) fail('LLM_BUSY', 'AI 正忙，请稍后再试。', 429);
    const dayKey = weather.dayOf(now), qid = llm.quotaId(llm.identity(user), 'explore', dayKey);
    const day = await tx.get('llm_days', dayKey) || { id: dayKey, attempts: 0, accounted_tokens: 0, reserved_tokens: 0 };
    const q = await tx.get('llm_quotas', qid) || { id: qid, owner_id: user.id, scope: 'explore', day: dayKey, succeeded: 0, reserved: 0, attempts: 0 };
    if (q.succeeded + q.reserved >= cfg.daily) fail('LLM_DAILY_LIMIT', '生态导览今日对话次数已用完，仍可手动预约。', 429);
    if (q.attempts >= cfg.attempts) fail('LLM_ATTEMPT_LIMIT', '今日 AI 提交次数已达到上限，仍可手动预约。', 429);
    if (gate.active.length >= cfg.queue || day.attempts >= cfg.globalAttempts) fail('LLM_GLOBAL_LIMIT', 'AI 调用次数暂达上限，仍可手动预约。', 429);
    const reserved = 32768 + cfg.output;
    if (day.accounted_tokens + day.reserved_tokens + reserved > cfg.globalTokens) fail('LLM_BUDGET_LIMIT', 'AI 用量暂达上限，仍可手动预约。', 429);
    const deadline = iso(liveNow() + (cfg.timeout + 15) * 1000);
    const entry = { id, owner_id: user.id, session_id: null, turn_id: null, kind: 'weather_booking_draft', fingerprint, scope: 'explore', day: dayKey, quota_id: qid, status: 'running', claim_token: token, lease_until: deadline, reserved_tokens: reserved, accounted_tokens: 0, usage: {}, dispatched: false, max_output_tokens: cfg.output, timeout_seconds: cfg.timeout, created_at: iso(now), finished_at: null };
    day.attempts++; day.reserved_tokens += reserved; q.attempts++; q.reserved++;
    gate.active.push({ id, owner_id: user.id, status: 'running', deadline });
    await tx.set('llm_days', dayKey, day); await tx.set('llm_quotas', qid, q); await tx.set('llm_gate', 'runtime', gate); await tx.set('llm_ledger', id, entry);
    return { entry };
  });
  if (claim.cached) return claim.cached;
  let receipt, result, failure, dispatched = false, settled = false;
  try {
    await ctx.store.transaction(async tx => {
      await llm.activeUser(ctx, tx); llm.requireEnabled(ctx);
      const entry = await tx.get('llm_ledger', id);
      if (!entry || entry.status !== 'running' || entry.claim_token !== token || Date.parse(entry.lease_until) <= liveNow()) fail('LLM_WORKER_TIMEOUT', '整理已超时，请重新输入。');
      await tx.update('llm_ledger', id, { dispatched: true });
    });
    dispatched = true;
    receipt = await (adapters.generateLlm || provider.generateLlm)(ctx.config, messages, { maxTokens: cfg.output, timeoutSeconds: cfg.timeout, ownerId: llm.identity(user) });
    if (!receipt || typeof receipt.text !== 'string' || !receipt.text.trim() || Buffer.byteLength(receipt.text) > 8192 || !provider.usage(receipt.usage) || receipt.usage.completion_tokens > cfg.output) throw new provider.ProviderError('LLM_RESPONSE_INVALID', { ambiguous: true });
    result = decode(receipt.text, liveNow());
  } catch (error) { failure = error; }
  await ctx.store.transaction(async tx => {
    const gate = await tx.get('llm_gate', 'runtime') || { id: 'runtime', active: [] }, entry = await tx.get('llm_ledger', id), active = await tx.get('users', user.id);
    if (!entry || entry.status !== 'running' || entry.claim_token !== token) return;
    if (!active || active.is_active === false) failure = new ApiError('AUTH_REQUIRED', '账号已退出或注销，草稿未保存。', 401);
    if (Date.parse(entry.lease_until) <= liveNow()) failure = new provider.ProviderError('LLM_WORKER_TIMEOUT', { ambiguous: dispatched });
    const code = failure instanceof ApiError || failure instanceof provider.ProviderError ? failure.code : 'LLM_TRANSPORT_ERROR';
    await llm.settle(tx, gate, entry, { success: !!result && !failure, code: failure ? code : '', receipt: receipt && receipt.usage || failure && failure.usage, ambiguous: dispatched && (!failure || failure.ambiguous !== false), finishedAt: iso(liveNow()) });
    await tx.set('llm_gate', 'runtime', gate);
    if (result && !failure) await tx.set('weather_ai_drafts', id, { id, owner_id: user.id, result, expires_at: iso(liveNow() + 86400000) });
    settled = true;
  });
  await llm.activeUser(ctx);
  if (!settled || failure) fail('WEATHER_AI_UNAVAILABLE', '本次未能整理预约，请检查文字后重试，或直接手动预约。', 503);
  return result;
}
module.exports = { run };
