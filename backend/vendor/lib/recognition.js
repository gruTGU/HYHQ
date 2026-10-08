'use strict';
const { ApiError, response, requireUser, uuid, paginate, dateCN } = require('./core');
const inference = require('./inference');
const guest = require('../../guest.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = { 'recognition-jobs': 'recognition', 'assessment-jobs': 'assessment' };
const COLLECTION = { recognition: 'recognition_jobs', assessment: 'assessment_jobs' };
const MAX_RECORDS = 500;
const LEASE_MS = 60000;
const BAD = (message) => { throw new ApiError('VALIDATION_ERROR', message, 400); };
const missing = () => { throw new ApiError('NOT_FOUND', '记录不存在或已过期', 404); };
function activeTime(ctx) { const stamp = Date.parse(ctx.now); if (!Number.isFinite(stamp)) throw new Error('Invalid internal clock'); return stamp; }
function limit(value, fallback, maximum) { return Number.isInteger(value) && value > 0 ? Math.min(maximum, value) : fallback; }
async function owner(tx, id) {
  const user = await tx.get('users', id);
  if (!user || user.is_active !== true) throw new ApiError('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
  return user;
}
async function touch(tx, user, kind, delta = 0) {
  const counts = { ...(user.inference_counts || {}) }, previous = Math.max(0, Number(counts[kind]) || 0);
  if (delta > 0 && Object.values(counts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0) >= MAX_RECORDS) throw new ApiError('STORAGE_QUOTA', '识别记录已达上限，请先删除旧记录', 429);
  counts[kind] = Math.max(0, previous + delta);
  await tx.update('users', user.id, { record_revision: (Number(user.record_revision) || 0) + 1, inference_counts: counts });
}
function validAsset(asset, user, now) {
  return asset && asset.owner_id === user.id && asset.purpose === 'recognition' && !asset.deleted && !asset.deleting && asset.status !== 'deleted'
    && Date.parse(asset.original_expires_at) > now && (!asset.expires_at || Date.parse(asset.expires_at) > now);
}
function validJob(job, user, now) { return job && job.owner_id === user.id && job.status !== 'deleted' && Date.parse(job.expires_at) > now; }
function baseJob(kind, user, assetId, now, values) {
  const snap = inference.snapshot(kind), stamp = new Date(now).toISOString();
  const base = { id: uuid(), owner_id: user.id, asset_id: assetId, kind, status: 'queued', visible: true, result: {}, error_code: '', message: '', model_version: snap.id,
    model_snapshot: snap, created_at: stamp, started_at: null, finished_at: null, duration_ms: null, expires_at: new Date(now + 30 * 86400000).toISOString(), claim_id: null, claim_expires_at: null };
  if (kind === 'assessment') Object.assign(base, inference.assessmentResult([], null, null), { water_body: values.water_body || null, station: null, latitude: values.latitude ?? null, longitude: values.longitude ?? null, coordinate_system: values.coordinate_system || '', rule_version: 'v1' });
  return base;
}
async function serialize(ctx, kind, job) {
  const common = Object.fromEntries(['id', 'asset_id', 'status', 'error_code', 'message', 'model_version', 'created_at', 'started_at', 'finished_at', 'duration_ms', 'expires_at'].map(key => [key, job[key] ?? null]));
  if (kind === 'recognition') return { ...common, result: job.result || {} };
  const snap = job.model_snapshot || {}, result = Object.fromEntries(['detections', 'image_width', 'image_height', 'score', 'score_name', 'grade', 'causes', 'issues', 'decision', 'reason', 'limitation', 'rule_version', 'latitude', 'longitude', 'coordinate_system'].map(key => [key, job[key] ?? null]));
  let water = null;
  if (job.water_body) { const item = await require('./catalog').getPublicItem(ctx, 'water_bodies', job.water_body.id); if (item) water = { id: item.id, name: item.name, kind: item.kind }; }
  return { ...common, ...result, model_name: snap.name || null, model: { name: snap.name, version: snap.version, scope: snap.scope, threshold: snap.threshold }, water_body: water, station: null, observation_summary: inference.summary(job) };
}
async function parseCreate(ctx, kind) {
  const body = ctx.body || {};
  if (typeof body !== 'object' || Array.isArray(body) || !UUID.test(body.asset_id || '')) BAD('请选择有效的已上传图片');
  const allowed = kind === 'recognition' ? ['asset_id'] : ['asset_id', 'water_body_id', 'latitude', 'longitude', 'coordinate_system'];
  if (Object.keys(body).some(key => !allowed.includes(key))) BAD('存在不支持的任务参数');
  const values = {};
  if (kind === 'assessment') {
    const lat = body.latitude, lon = body.longitude, absent = value => value === undefined || value === null;
    if (absent(lat) !== absent(lon) || (!absent(lat) && (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !['GCJ02', 'WGS84'].includes(body.coordinate_system))) || (absent(lat) && body.coordinate_system)) BAD('经纬度须成对提供，并注明有效坐标系');
    if (!absent(lat)) Object.assign(values, { latitude: lat, longitude: lon, coordinate_system: body.coordinate_system });
    if (body.water_body_id !== undefined && body.water_body_id !== null) {
      if (!UUID.test(body.water_body_id)) BAD('水体标识无效');
      const water = await require('./catalog').getPublicItem(ctx, 'water_bodies', body.water_body_id);
      if (!water) BAD('水体不存在或未发布'); values.water_body = { id: water.id, name: water.name, kind: water.kind };
    }
  }
  return { asset_id: body.asset_id, values };
}
async function create(ctx, kind, adapters) {
  if (!ctx.config.inferenceEnabled) throw new ApiError('MODEL_NOT_CONFIGURED', '图像识别模型暂未启用', 503);
  const input = await parseCreate(ctx, kind), user = requireUser(ctx), now = activeTime(ctx);
  // Check only the trusted declaration here. Remote weights are downloaded in
  // the claimed GET after this transaction reserves the user/global budget.
  await (adapters.verify || inference.configured)(kind, ctx.config.modelRoot);
  const outcome = await ctx.store.transaction(async (tx) => {
    const current = await owner(tx, user.id), asset = await tx.get('assets', input.asset_id);
    if (!validAsset(asset, current, now)) throw new ApiError('ASSET_EXPIRED', '图片已过期、已删除或不可用于识别，请重新上传', 404);
    const usage = await tx.get('asset_usage', input.asset_id);
    if (usage) {
      if (usage.owner_id !== current.id || usage.kind !== kind || usage.deleted) throw new ApiError('ASSET_IN_USE', '这张图片已用于其他任务，请重新上传', 409);
      const existing = await tx.get(COLLECTION[kind], usage.job_id);
      if (!validJob(existing, current, now)) throw new ApiError('ASSET_EXPIRED', '记录已过期，请重新上传图片', 409);
      await touch(tx, current, kind); return { job: existing, created: false };
    }
    if (!/^[a-f0-9]{64}$/i.test(current.quota_key || '')) throw new ApiError('AUTH_REQUIRED', '账号身份未完成校验，请重新登录', 401);
    const day = dateCN(ctx.now), key = current.quota_key + ':' + day, globalKey = 'global:' + day;
    const personal = await tx.get('inference_daily', key) || { count: 0 }, total = await tx.get('inference_daily', globalKey) || { count: 0 };
    if (![personal.count, total.count].every(value => Number.isInteger(value) && value >= 0)) throw new ApiError('INFERENCE_BUDGET_INVALID', '图像处理预算状态异常，请联系管理员', 503);
    if (personal.count >= limit(ctx.config.recognitionDailyLimit, 20, 100) || total.count >= limit(ctx.config.recognitionGlobalDailyLimit, 200, 2000)) throw new ApiError('RECOGNITION_LIMIT', '今日图像处理暂不可继续，请稍后再试', 429);
    await touch(tx, current, kind, 1);
    await tx.set('inference_daily', key, { day, count: personal.count + 1 });
    await tx.set('inference_daily', globalKey, { day, count: total.count + 1 });
    const job = baseJob(kind, current, input.asset_id, now, input.values);
    await guest.reserveRecognition(tx, ctx, job);
    await tx.create(COLLECTION[kind], job.id, job);
    await tx.create('asset_usage', input.asset_id, { owner_id: current.id, kind, job_id: job.id, deleted: false });
    return { job, created: true };
  });
  return response(await serialize(ctx, kind, outcome.job), outcome.created ? 201 : 200);
}
async function claim(ctx, kind, id) {
  const now = activeTime(ctx), user = requireUser(ctx);
  return ctx.store.transaction(async (tx) => {
    const current = await owner(tx, user.id), job = await tx.get(COLLECTION[kind], id);
    if (!validJob(job, current, now)) missing();
    const gate = await tx.get('inference_gate', 'cpu');
    if (job.status === 'running') {
      if (Date.parse(job.claim_expires_at) <= now) {
        job.status = 'failed'; job.error_code = 'WORKER_TIMEOUT'; job.message = '图像处理已超时，请重新上传图片'; job.finished_at = ctx.now;
        await guest.settleRecognition(tx, job, false);
        await tx.update(COLLECTION[kind], id, job); await touch(tx, current, kind);
        if (gate && gate.claim_id === job.claim_id) await tx.remove('inference_gate', 'cpu');
      }
      return { job, execute: false };
    }
    if (job.status !== 'queued') return { job, execute: false };
    if (!ctx.config.inferenceEnabled) { job.status = 'failed'; job.error_code = 'MODEL_NOT_CONFIGURED'; job.message = '图像识别模型暂未启用'; job.finished_at = ctx.now; await guest.settleRecognition(tx, job, false); await tx.update(COLLECTION[kind], id, job); await touch(tx, current, kind); return { job, execute: false }; }
    if (gate && Date.parse(gate.expires_at) > now) return { job, execute: false };
    // One shared claim serializes both model kinds across instances. Expiry is a
    // recovery lease, not a promise that a stuck native thread was physically killed.
    const claimId = uuid();
    Object.assign(job, { status: 'running', started_at: ctx.now, claim_id: claimId, claim_expires_at: new Date(now + LEASE_MS).toISOString() });
    await tx.set('inference_gate', 'cpu', { job_id: job.id, kind, claim_id: claimId, expires_at: job.claim_expires_at });
    await tx.update(COLLECTION[kind], id, job); await touch(tx, current, kind);
    return { job, execute: true };
  });
}
async function finish(ctx, kind, job, result, code, elapsed) {
  const now = activeTime(ctx) + elapsed, stamp = new Date(now).toISOString();
  return ctx.store.transaction(async (tx) => {
    const current = await tx.get('users', job.owner_id), existing = await tx.get(COLLECTION[kind], job.id), gate = await tx.get('inference_gate', 'cpu');
    const ownsGate = gate && gate.claim_id === job.claim_id;
    if (!current || current.is_active !== true || !existing || existing.status !== 'running' || existing.claim_id !== job.claim_id) { if (ownsGate && code !== 'INFERENCE_TIMEOUT') await tx.remove('inference_gate', 'cpu'); return null; }
    const asset = await tx.get('assets', job.asset_id);
    if (!code && (!validAsset(asset, current, now) || Date.parse(existing.expires_at) <= now)) code = 'ASSET_EXPIRED';
    if (!code && (!ownsGate || Date.parse(existing.claim_expires_at) <= now)) code = 'WORKER_TIMEOUT';
    const patch = { status: code ? 'failed' : 'succeeded', finished_at: stamp, duration_ms: elapsed, error_code: code || '', message: code ? '图像处理未完成，请重新上传或稍后重试' : '' };
    if (kind === 'recognition') patch.result = code ? {} : result;
    else if (!code) Object.assign(patch, result);
    await guest.settleRecognition(tx, existing, !code);
    if (existing.guest_quota_id) patch.guest_quota_state = existing.guest_quota_state;
    await tx.update(COLLECTION[kind], job.id, patch); await touch(tx, current, kind);
    if (ownsGate && code !== 'INFERENCE_TIMEOUT') await tx.remove('inference_gate', 'cpu');
    return { ...existing, ...patch };
  });
}
async function get(ctx, kind, id, adapters) {
  const claimed = await claim(ctx, kind, id);
  if (!claimed.execute) return response(await serialize(ctx, kind, claimed.job));
  const started = Date.now(); let result, failure, timer, timedOut = false;
  try {
    const work = (async () => {
      const asset = await ctx.storage.readAsset(ctx.user, claimed.job.asset_id);
      // Slow storage must not start CPU work after the request has failed.
      if (timedOut) throw new ApiError('INFERENCE_TIMEOUT', '图像处理超时', 503);
      const value = await (adapters.infer || inference.infer)(kind, asset.bytes, { modelRoot: ctx.config.modelRoot });
      if (timedOut) throw new ApiError('INFERENCE_TIMEOUT', '图像处理超时', 503);
      if (kind === 'recognition') {
        const catalog = await require('./catalog').loadCatalog(ctx);
        for (const candidate of value.candidates || []) { const content = catalog.contents.find(row => row.plant_label === candidate.label); candidate.content_id = content ? content.id : null; }
      }
      return value;
    })();
    const seconds = limit(ctx.config.inferenceTimeoutSeconds, 35, 40);
    result = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new ApiError('INFERENCE_TIMEOUT', '图像处理超时', 503)); }, seconds * 1000); })]);
  } catch (error) { failure = error instanceof ApiError ? error.code : 'MODEL_INFERENCE_FAILED'; }
  finally { clearTimeout(timer); }
  const finished = await finish(ctx, kind, claimed.job, result, failure, Math.max(0, Date.now() - started));
  if (!finished) missing();
  return response(await serialize(ctx, kind, finished));
}
async function remove(ctx, kind, id) {
  const user = requireUser(ctx), assetId = await ctx.store.transaction(async (tx) => {
    const current = await owner(tx, user.id), job = await tx.get(COLLECTION[kind], id);
    if (!job || job.owner_id !== user.id) missing();
    if (job.status !== 'deleted') {
      await guest.settleRecognition(tx, job, false);
      await touch(tx, current, kind, -1);
      await tx.update(COLLECTION[kind], id, { status: 'deleted', ...(job.guest_quota_id ? { guest_quota_state: job.guest_quota_state } : {}), visible: false, result: {}, detections: [], latitude: null, longitude: null, claim_id: null });
      await tx.update('asset_usage', job.asset_id, { deleted: true });
    }
    // Keep an executing gate until its worker observes deletion or its lease
    // expires; freeing it early could overlap two native CPU runs.
    return job.asset_id;
  });
  await ctx.storage.deleteAsset(user, assetId);
  return response(null, 204);
}
async function handle(ctx, adapters = {}) {
  const match = /^\/?(recognition-jobs|assessment-jobs)\/(?:([^/]+)\/)?$/.exec(ctx.path);
  if (!match) return undefined;
  const kind = KINDS[match[1]], id = match[2], user = requireUser(ctx);
  if (id) {
    if (!UUID.test(id)) missing();
    if (ctx.method === 'GET') return get(ctx, kind, id, adapters);
    if (ctx.method === 'DELETE') return remove(ctx, kind, id);
  } else {
    if (ctx.method === 'POST') return create(ctx, kind, adapters);
    if (ctx.method === 'GET') {
      await owner(ctx.store, user.id);
      const rows = [];
      for (let offset = 0; offset <= MAX_RECORDS; offset += 100) {
        const batch = await ctx.store.list(COLLECTION[kind], { where: { owner_id: user.id, visible: true }, orderBy: [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'desc' }], offset, limit: 100 });
        rows.push(...batch); if (batch.length < 100) break;
      }
      if (rows.length > MAX_RECORDS) throw new ApiError('RECORD_LIMIT', '历史记录超过查询范围，请联系管理员整理', 503);
      const current = rows.filter(job => validJob(job, user, activeTime(ctx)));
      return paginate(ctx, await Promise.all(current.map(job => serialize(ctx, kind, job))));
    }
  }
  throw new ApiError('METHOD_NOT_ALLOWED', '不支持此请求方法', 405);
}
async function status(ctx, adapters = {}) {
  const out = {};
  for (const kind of ['recognition', 'assessment']) {
    const snap = inference.snapshot(kind); let enabled = ctx.config.inferenceEnabled === true, artifactStatus = 'unavailable';
    if (enabled) { try { artifactStatus = await (adapters.verify || inference.configured)(kind, ctx.config.modelRoot) || 'configured'; } catch (_) { enabled = false; } }
    out[kind] = { enabled, model_name: enabled ? snap.name : null, model_version: enabled ? snap.version : null, labels: enabled ? (kind === 'assessment' ? snap.labels.filter(label => label.id === 9) : snap.labels) : [], scope: snap.scope, threshold: enabled ? snap.threshold : null, ...(kind === 'assessment' ? { rule_version: 'v1' } : {}), preprocessing_version: inference.PREPROCESSING_VERSION, artifact_status: typeof artifactStatus === 'string' ? artifactStatus : 'configured' };
  }
  return out;
}
module.exports = { handle, status, serialize, COLLECTION, MAX_RECORDS, LEASE_MS };
