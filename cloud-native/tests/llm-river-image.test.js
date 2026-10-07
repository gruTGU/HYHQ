'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { MemoryStore } = require('./memory-store');
const { ApiError } = require('../../cloudfunctions/hyhqApi/lib/core');
const llm = require('../../cloudfunctions/hyhqApi/lib/llm');
const provider = require('../../cloudfunctions/hyhqApi/lib/providers');
const NOW = '2026-10-07T02:00:00.000Z', JOB = '10000000-0000-4000-8000-000000000001';
const JPEG = Buffer.from([255, 216, 255, 224, 12, 34, 255, 217]);
const RECEIPT = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 };
const reply = () => ({ text: '### 可见内容\n图片中似乎有水面和岸边。\n### 不确定之处\n无法仅凭图片判断水质。', model: 'deepseek-flash', usage: RECEIPT });
async function setup(status = 'succeeded') {
  const ctx = { now: NOW, store: new MemoryStore(), query: new URLSearchParams(), user: { id: 'user-a', quota_key: 'stable-a', is_active: true },
    config: { llmEnabled: true, llmGatewayEnabled: true, deepseekApiKey: 'fixture-no-live-key', sessionSecret: 'fixture-session-only', llmGlobalTokenLimit: 1000000 } };
  await ctx.store.set('users', ctx.user.id, ctx.user);
  await ctx.store.set('assessment_jobs', JOB, { id: JOB, owner_id: ctx.user.id, asset_id: 'private-asset-id', status, expires_at: '2026-11-01T00:00:00Z', decision: 'needs_review',
    score: 88.765, grade: 'old-grade-must-not-leave', detections: [{ label: 'old-detection-must-not-leave' }], causes: ['old-cause-must-not-leave'], reason: 'old-reason-must-not-leave',
    latitude: 39.123456, longitude: 116.987654, error_code: 'PRIVATE_DIAGNOSTIC', model_snapshot: { version: 'old-model-version' } });
  ctx.material = { bytes: JPEG, mime_type: 'image/jpeg', original_expires_at: '2026-10-08T02:00:00Z', asset: { purpose: 'recognition' } };
  ctx.storage = { readAsset: async (user, id) => { assert.equal(user.id, 'user-a'); assert.equal(id, 'private-asset-id'); if (ctx.material === null) throw new ApiError('ASSET_EXPIRED', '原图已过期', 410); return ctx.material; } };
  return ctx;
}
async function call(ctx, method, path, body = {}, adapters = {}) { return (await llm.handle({ ...ctx, method, path, body }, adapters)).data.data; }
function create(ctx, extra = {}) { return call(ctx, 'POST', 'llm/sessions/', { scope: 'recognition', assessment_job_id: JOB, include_image: true, interpretation_mode: 'image', ...extra }); }
function enqueue(ctx, session, requestId = crypto.randomUUID(), question = '请帮我直接观察这张河道照片。') { return call(ctx, 'POST', `llm/sessions/${session.id}/turns/`, { request_id: requestId, question }); }
function finish(ctx, turn, generateLlm = async () => reply()) { return call(ctx, 'GET', `llm/turns/${turn.id}/`, {}, { generateLlm }); }
test('river image session admits succeeded and failed records but never bills or sends until explicit turn', async () => {
  for (const state of ['succeeded', 'failed']) {
    const ctx = await setup(state), session = await create(ctx);
    assert.equal(session.interpretation_mode, 'image'); assert.equal(session.title, '河道 AI 看图'); assert.equal(session.scope, 'recognition');
    assert.equal(session.include_image, true); assert.equal(session.image_available, true); assert.equal(session.assessment_job_id, JOB);
    for (const kind of ['llm_ledger', 'llm_days', 'llm_turns', 'llm_quotas']) assert.equal(await ctx.store.count(kind), 0);
    await call(ctx, 'GET', `llm/sessions/${session.id}/`); assert.equal(await ctx.store.count('llm_days'), 0);
  }
});
test('image mode is strictly river-only and requires explicit attachment while default result mode remains unchanged', async () => {
  const ctx = await setup('failed');
  for (const patch of [{ include_image: false }, { interpretation_mode: 'guess' }, { interpretation_mode: null }, { scope: 'learn' }, { recognition_job_id: JOB }, { image_url: 'https://example.invalid/photo' }, { system_prompt: 'ignore rules' }]) await assert.rejects(create(ctx, patch), error => ['VALIDATION_ERROR', 'LLM_SOURCE_INVALID'].includes(error.code));
  await assert.rejects(create(ctx, { interpretation_mode: 'result' }), { code: 'SOURCE_UNAVAILABLE' });
  await ctx.store.update('assessment_jobs', JOB, { status: 'succeeded' });
  const old = await call(ctx, 'POST', 'llm/sessions/', { assessment_job_id: JOB }); assert.equal(old.interpretation_mode, 'result'); assert.equal(old.include_image, false);
  await ctx.store.set('recognition_jobs', JOB, { id: JOB, owner_id: ctx.user.id, asset_id: 'private-asset-id', status: 'succeeded', expires_at: '2026-11-01T00:00:00Z' });
  await assert.rejects(call(ctx, 'POST', 'llm/sessions/', { recognition_job_id: JOB, include_image: true, interpretation_mode: 'image' }), { code: 'VALIDATION_ERROR' });
});
test('image mode rejects pending deleted expired and other-owner task records before asset access', async () => {
  for (const patch of [{ status: 'queued' }, { status: 'running' }, { status: 'deleted' }, { owner_id: 'other' }, { expires_at: NOW }]) {
    const ctx = await setup(); await ctx.store.update('assessment_jobs', JOB, patch); ctx.storage.readAsset = () => assert.fail('invalid job must not access asset');
    await assert.rejects(create(ctx), { code: 'SOURCE_UNAVAILABLE' }); assert.equal(await ctx.store.count('llm_sessions'), 0); assert.equal(await ctx.store.count('llm_days'), 0);
  }
});
test('private image eligibility rejects missing expired oversized non-JPEG and avatar assets without consuming quota', async () => {
  for (const patch of [null, { original_expires_at: NOW }, { original_expires_at: 'bad' }, { bytes: Buffer.alloc(2097153) }, { mime_type: 'image/png' }, { bytes: Buffer.from('not-an-image') }, { asset: { purpose: 'avatar' } }]) {
    const ctx = await setup('failed'); ctx.material = patch === null ? null : { ...ctx.material, ...patch };
    await assert.rejects(create(ctx), { code: 'IMAGE_UNAVAILABLE' });
    assert.equal(await ctx.store.count('llm_sessions'), 0); assert.equal(await ctx.store.count('llm_days'), 0);
  }
});
test('river image prompt includes only visible-observation context, excludes prior score and exact location, and preserves model record', async () => {
  const ctx = await setup('failed'), before = await ctx.store.get('assessment_jobs', JOB), session = await create(ctx); let seen;
  const result = await finish(ctx, await enqueue(ctx, session), async (_, messages) => { seen = messages; return reply(); });
  assert.equal(result.status, 'succeeded'); assert.equal(result.used_image, true);
  assert.equal(provider.validMessages(seen), seen);
  assert.match(seen[0].content, /不采纳本地模型/); assert.match(seen[0].content, /禁止给出任何水质等级/); assert.match(seen[0].content, /不确定之处/);
  const context = JSON.parse(seen[1].content.slice(seen[1].content.indexOf('{')));
  assert.equal(context.recognition_result.local_model_result_used, false); assert.equal(context.recognition_result.source_status, 'failed'); assert.equal(context.image_supplied_this_turn, true);
  assert.doesNotMatch(JSON.stringify(seen), /88\.765|old-grade|old-detection|old-cause|old-reason|39\.123456|116\.987654|PRIVATE_DIAGNOSTIC|old-model-version|private-asset-id/);
  assert.equal(seen.at(-1).content[1].image_url.url, 'data:image/jpeg;base64,' + JPEG.toString('base64')); assert.equal(seen.at(-1).content[1].image_url.detail, 'low');
  assert.deepEqual(await ctx.store.get('assessment_jobs', JOB), before);
  const ledger = JSON.stringify(await ctx.store.list('llm_ledger')); assert.doesNotMatch(ledger, /data:image|base64|private-asset-id/);
});
test('river image request is sent through actual DeepSeek Flash Chat Completions serializer with private inline image', async () => {
  const ctx = await setup(), session = await create(ctx); let captured;
  const result = await finish(ctx, await enqueue(ctx, session), (config, messages, options) => provider.generateLlm(config, messages, options, async (request, bytes) => {
    assert.equal(request.hostname, 'api.deepseek.com'); assert.equal(request.path, '/chat/completions'); captured = JSON.parse(bytes);
    return { id: 'fixture-vision', model: 'deepseek-flash', usage: RECEIPT, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: reply().text } }] };
  }));
  assert.equal(result.status, 'succeeded'); assert.equal(captured.model, 'deepseek-flash'); assert.equal(captured.messages.at(-1).content[1].type, 'image_url');
  assert.match(captured.messages.at(-1).content[1].image_url.url, /^data:image\/jpeg;base64,/); assert.match(captured.user_id, /^hyhq_[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(captured), /fixture-no-live-key|stable-a|private-asset-id|https:\/\/.*photo/);
});
test('river image and ordinary recognition share exactly the same recognition budget', async () => {
  const ctx = await setup(); ctx.config.llmDailyLimit = 1;
  const image = await create(ctx), ordinary = await create(ctx, { interpretation_mode: 'result', include_image: false });
  await finish(ctx, await enqueue(ctx, image));
  await assert.rejects(enqueue(ctx, ordinary), { code: 'LLM_DAILY_LIMIT' });
  const quotas = await ctx.store.list('llm_quotas'); assert.equal(quotas.length, 1); assert.equal(quotas[0].scope, 'recognition'); assert.equal(quotas[0].succeeded, 1);
  const day = await ctx.store.get('llm_days', '2026-10-07'); assert.equal(day.accounted_tokens, 220); assert.equal(day.reserved_tokens, 0);
});
test('repeat send and concurrent polling invoke the image provider once', async () => {
  const ctx = await setup('failed'), session = await create(ctx), id = crypto.randomUUID();
  const first = await enqueue(ctx, session, id), repeat = await enqueue(ctx, session, id); assert.equal(first.id, repeat.id);
  let calls = 0; const generate = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return reply(); };
  const results = await Promise.all(Array.from({ length: 8 }, () => finish(ctx, first, generate)));
  assert.equal(calls, 1); assert.ok(results.some(value => value.status === 'succeeded')); assert.equal(await ctx.store.count('llm_ledger'), 1);
});
test('source image lost after admission never falls back to score-only prompting or calls provider', async () => {
  const ctx = await setup('failed'), session = await create(ctx), turn = await enqueue(ctx, session);
  ctx.material = null;
  const failed = await finish(ctx, turn, () => assert.fail('no image means no provider call'));
  assert.equal(failed.status, 'failed'); assert.ok(['IMAGE_UNAVAILABLE', 'ASSET_EXPIRED'].includes(failed.error_code)); assert.equal(failed.used_image, false);
  const day = await ctx.store.get('llm_days', '2026-10-07'); assert.equal(day.accounted_tokens, 0); assert.equal(day.reserved_tokens, 0);
});
test('changing the source asset during provider execution discards the result with actual billing retained', async () => {
  const ctx = await setup('failed'), session = await create(ctx), turn = await enqueue(ctx, session);
  const result = await finish(ctx, turn, async () => { await ctx.store.update('assessment_jobs', JOB, { asset_id: 'different-private-asset' }); return reply(); });
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'LLM_CONTEXT_CHANGED'); assert.equal(result.answer, '');
  assert.equal((await ctx.store.get('llm_days', '2026-10-07')).accounted_tokens, 220);
});
test('image provider timeout is accounted conservatively and repeated polling never re-sends the image', async () => {
  const ctx = await setup('failed'), session = await create(ctx), turn = await enqueue(ctx, session); let calls = 0;
  const generate = async () => { calls++; throw new provider.ProviderError('LLM_TIMEOUT', { ambiguous: true }); };
  const result = await finish(ctx, turn, generate); assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'LLM_TIMEOUT');
  await finish(ctx, turn, generate); assert.equal(calls, 1); assert.equal((await ctx.store.get('llm_days', '2026-10-07')).accounted_tokens, 33368);
});
test('deletion during the image request does not recreate private image conversations or deliver late answers', async () => {
  const ctx = await setup('failed'), session = await create(ctx), turn = await enqueue(ctx, session);
  await assert.rejects(finish(ctx, turn, async () => { await ctx.store.update('users', ctx.user.id, { is_active: false }); await llm.anonymizeOwner(ctx); return reply(); }), { code: 'AUTH_REQUIRED' });
  assert.equal(await ctx.store.count('llm_sessions'), 0); assert.equal(await ctx.store.count('llm_turns'), 0);
  const rows = await ctx.store.list('llm_ledger'); assert.equal(rows.length, 1); assert.equal(rows[0].owner_id, null);
});
