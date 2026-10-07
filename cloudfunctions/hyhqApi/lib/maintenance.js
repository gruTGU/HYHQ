'use strict';
// This module has no event/type/cron identity shortcut. The HTTP-style handler
// requires a fresh administrator account; runMaintenance is server code only.
const { ApiError, response, requireUser, uuid } = require('./core');
const llm = require('./llm');
const DAY = 86400000, CHUNK = 196608;
const KINDS = Object.freeze(['sessions', 'uploads', 'upload_chunks', 'assets', 'storage_cleanup', 'llm_sessions', 'llm_turns', 'recognition_jobs', 'assessment_jobs', 'asset_usage', 'llm_owners', 'llm_ledger', 'llm_quotas', 'llm_days', 'upload_budget', 'inference_daily', 'weather_requests', 'auth_gates', 'weather_ai_drafts']);
const POLICY = Object.freeze({ original_hours: 24, recognition_thumbnail_days: 30, pinned_avatar: 'until_replaced_or_account_deleted', login_session_days: 7, upload_hours: 1, accounting_days: 90, max_batch_size: 20, automatic_schedule_enabled: false });
function stamp(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
function due(value, now) { const n = stamp(value); return n !== null && n <= now; }
function dayOld(value, now) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Date.parse(value + 'T23:59:59+08:00') < now - 90 * DAY; }
async function administrator(ctx) {
  const user = requireUser(ctx), cfg = ctx.config && ctx.config.management;
  if (!cfg || cfg.enabled !== true || !Array.isArray(cfg.adminUserIds) || !cfg.adminUserIds.includes(user.id)) throw new ApiError('MANAGEMENT_DISABLED', '此管理入口未开放', 403);
  const fresh = await ctx.store.get('users', user.id);
  if (!fresh || fresh.is_active !== true) throw new ApiError('AUTH_REQUIRED', '管理员登录已失效', 401);
  return fresh;
}
async function removeIf(ctx, kind, id, predicate) {
  return ctx.store.transaction(async tx => {
    const row = await tx.get(kind, id);
    if (!row || !await predicate(row, tx)) return false;
    await tx.remove(kind, id); return true;
  });
}
async function cleanupUpload(ctx, row, now, alive) {
  const claimed = await ctx.store.transaction(async tx => {
    const current = await tx.get('uploads', row.id);
    if (!current || (!due(current.expires_at, now) && !['failed', 'cancelled'].includes(current.status))) return null;
    await tx.update('uploads', row.id, { status: 'cancelled' }); return current;
  });
  if (!claimed) return false;
  if (claimed.pending_file_ids && claimed.pending_file_ids.length) await ctx.storage.deleteObjects(claimed.pending_file_ids);
  const count = Math.ceil(claimed.total_size / CHUNK);
  if (!Number.isInteger(count) || count < 1 || count > 27) throw new ApiError('CLEANUP_STATE_INVALID', '上传清理记录需要管理员检查', 503);
  // Keep the cancelled parent until all children have been removed. A crash or
  // partial deletion is retried idempotently on the next maintenance sweep.
  for (let i = 0; i < count; i++) { if (!alive()) return false; await ctx.store.remove('upload_chunks', row.id + '_' + i); }
  return ctx.store.transaction(async tx => {
    const current = await tx.get('uploads', row.id); if (!current || current.status !== 'cancelled') return false;
    const gate = await tx.get('upload_gate', 'global');
    if (gate && gate.active && gate.active[row.id]) { const active = { ...gate.active }; delete active[row.id]; await tx.update('upload_gate', 'global', { active }); }
    await tx.remove('uploads', row.id); return true;
  });
}
async function cleanupAsset(ctx, row, now) {
  const plan = await ctx.store.transaction(async tx => {
    const current = await tx.get('assets', row.id); if (!current) return null;
    const owner = await tx.get('users', current.owner_id);
    const pinned = owner && owner.is_active === true && current.purpose === 'avatar' && owner.avatar_id === current.id;
    // Explicit deletion always wins. Active pinned avatars have no TTL; an
    // unpinned avatar with old null TTLs is treated as abandoned after one day.
    if (current.deleting || !owner || owner.is_active !== true || (!pinned && (due(current.expires_at, now) || (current.purpose === 'avatar' && !current.expires_at && stamp(current.created_at) < now - DAY)))) {
      await tx.update('assets', row.id, { deleting: true });
      return { kind: 'all', files: [current.original_file_id, current.thumbnail_file_id].filter(Boolean) };
    }
    if (pinned) return null;
    if (current.original_deleting || (current.original_file_id && due(current.original_expires_at, now))) {
      await tx.update('assets', row.id, { original_deleting: true }); return { kind: 'original', files: [current.original_file_id].filter(Boolean) };
    }
    return null;
  });
  if (!plan) return false;
  // Mark-before-delete blocks download and avatar-pinning races. Keep the
  // marker and file IDs after a provider error so retries actually free bytes.
  await ctx.storage.deleteObjects(plan.files);
  return ctx.store.transaction(async tx => {
    const current = await tx.get('assets', row.id); if (!current) return false;
    if (plan.kind === 'all') {
      if (!current.deleting) return false;
      await tx.remove('assets', row.id); return true;
    }
    if (current.original_deleting && (!current.original_file_id || plan.files.includes(current.original_file_id))) await tx.update('assets', row.id, { original_file_id: null, original_deleting: false, original_deleted_at: ctx.now });
    return false; // Thumbnail/document remain until their own expiry.
  });
}
async function cleanupJob(ctx, kind, row, now) {
  return ctx.store.transaction(async tx => {
    const current = await tx.get(kind, row.id); if (!current || !due(current.expires_at, now)) return false;
    const gate = await tx.get('inference_gate', 'cpu');
    // Do not release a currently executing inference lease early.
    if (gate && gate.job_id === row.id && !due(gate.expires_at, now)) return false;
    if (gate && gate.job_id === row.id) await tx.remove('inference_gate', 'cpu');
    const usage = current.asset_id && await tx.get('asset_usage', current.asset_id);
    if (usage && usage.job_id === row.id) await tx.remove('asset_usage', current.asset_id);
    const owner = current.owner_id && await tx.get('users', current.owner_id);
    if (owner && current.status !== 'deleted') {
      const modelKind = kind === 'recognition_jobs' ? 'recognition' : 'assessment', counts = { ...(owner.inference_counts || {}) };
      counts[modelKind] = Math.max(0, (Number(counts[modelKind]) || 0) - 1);
      await tx.update('users', owner.id, { inference_counts: counts, record_revision: (Number(owner.record_revision) || 0) + 1 });
    }
    await tx.remove(kind, row.id); return true;
  });
}
async function cleanRow(ctx, kind, row, now, alive) {
  if (!row || typeof row.id !== 'string') throw new ApiError('CLEANUP_STATE_INVALID', '维护记录缺少编号', 503);
  if (kind === 'uploads') return cleanupUpload(ctx, row, now, alive);
  if (kind === 'assets') return cleanupAsset(ctx, row, now);
  if (kind === 'storage_cleanup') { if (!Array.isArray(row.file_ids) || !row.file_ids.length || row.file_ids.length > 2) throw new ApiError('CLEANUP_STATE_INVALID', '存储清理记录需要管理员检查', 503); await ctx.storage.deleteObjects(row.file_ids); return !await ctx.store.get('storage_cleanup', row.id); }
  if (kind === 'llm_sessions') return llm.expireSession(ctx, row.id);
  if (kind === 'recognition_jobs' || kind === 'assessment_jobs') return cleanupJob(ctx, kind, row, now);
  return removeIf(ctx, kind, row.id, async (fresh, tx) => {
    if (kind === 'sessions' || kind === 'weather_ai_drafts') return due(fresh.expires_at, now);
    if (kind === 'upload_chunks') {
      const match = /^([a-f0-9-]{36})_(\d+)$/.exec(row.id);
      return !!match && !await tx.get('uploads', match[1]);
    }
    if (kind === 'llm_turns') { const session = await tx.get('llm_sessions', fresh.session_id); return !session || session.deleted || due(session.expires_at, now); }
    if (kind === 'llm_owners') return !await tx.get('users', fresh.owner_id);
    if (kind === 'asset_usage') return !await tx.get('assets', row.id) && !await tx.get(fresh.kind === 'recognition' ? 'recognition_jobs' : 'assessment_jobs', fresh.job_id);
    if (kind === 'llm_ledger') return ['succeeded', 'failed'].includes(fresh.status) && due(fresh.finished_at, now - 90 * DAY) && dayOld(fresh.day, now);
    if (kind === 'llm_quotas') return !fresh.reserved && dayOld(fresh.day, now);
    if (kind === 'llm_days') return !fresh.reserved_tokens && dayOld(row.id, now);
    if (kind === 'upload_budget' || kind === 'inference_daily') return dayOld(fresh.day, now);
    if (kind === 'weather_requests') return due(fresh.reserved_at, now - 90 * DAY);
    if (kind === 'auth_gates') return typeof fresh.hour === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(fresh.hour) && due(fresh.hour + ':00:00Z', now - 7 * DAY);
    return false;
  });
}
async function runMaintenance(ctx, options = {}) {
  const now = stamp(ctx.now); if (now === null) throw new ApiError('CLEANUP_CONFIG_INVALID', '维护时间无效', 503);
  const requested = options.kind, limit = options.limit === undefined ? 10 : options.limit;
  if ((requested !== undefined && !KINDS.includes(requested)) || !Number.isInteger(limit) || limit < 1 || limit > 20 || Object.keys(options).some(k => !['kind', 'limit'].includes(k))) throw new ApiError('VALIDATION_ERROR', '请使用有效维护类型和1至20条批量数量');
  const token = uuid();
  const state = await ctx.store.transaction(async tx => {
    const old = await tx.get('maintenance_state', 'global') || { offsets: {}, next_kind: 0, recent: [] };
    if (old.lease_token && Date.parse(old.lease_until) > now) throw new ApiError('MAINTENANCE_BUSY', '已有维护批次正在执行，请稍后重试', 409);
    const kind = requested || KINDS[old.next_kind % KINDS.length], offset = Number.isSafeInteger(old.offsets[kind]) ? old.offsets[kind] : 0;
    const next = { ...old, id: 'global', lease_token: token, lease_until: new Date(now + 60000).toISOString(), kind, offset };
    await tx.set('maintenance_state', 'global', next); return next;
  });
  const started = Date.now(), alive = () => Date.now() - started < 25000;
  const summary = { kind: state.kind, scanned: 0, removed: 0, failed: 0, finished_at: null, complete_cycle: false, resumed_offset: state.offset };
  let fatal;
  try {
    // Recover abandoned LLM claims before retention, keeping attempts and billed
    // or ambiguous tokens counted. No provider request is made here.
    await ctx.store.transaction(async tx => { const gate = await tx.get('llm_gate', 'runtime'); if (gate) { await llm.recover(tx, gate, now); await tx.set('llm_gate', 'runtime', gate); } });
    const rows = await ctx.store.list(state.kind, { limit, offset: state.offset, orderBy: [{ field: 'id', direction: 'asc' }] });
    for (const row of rows) {
      if (!alive()) break;
      summary.scanned++;
      try { if (await cleanRow(ctx, state.kind, row, now, alive)) summary.removed++; } catch (_) { summary.failed++; }
    }
    summary.complete_cycle = summary.scanned === rows.length && rows.length < limit;
  } catch (error) { fatal = error; }
  finally {
    summary.finished_at = new Date(now + Date.now() - started).toISOString();
    await ctx.store.transaction(async tx => {
      const fresh = await tx.get('maintenance_state', 'global'); if (!fresh || fresh.lease_token !== token) return;
      const offsets = { ...fresh.offsets, [state.kind]: summary.complete_cycle ? 0 : state.offset + summary.scanned - summary.removed };
      await tx.set('maintenance_state', 'global', { id: 'global', offsets, next_kind: (KINDS.indexOf(state.kind) + 1) % KINDS.length, recent: [{ ...summary, aborted: !!fatal }, ...(fresh.recent || [])].slice(0, 20), lease_token: null, lease_until: null, timer_verified_at: fresh.timer_verified_at || null, reminder_cleanup: fresh.reminder_cleanup || null });
    });
  }
  if (fatal) throw fatal;
  return summary;
}
async function handle(ctx) {
  if (ctx.path !== 'management/maintenance/') return undefined;
  await administrator(ctx);
  if (ctx.query && [...ctx.query.keys()].length) throw new ApiError('VALIDATION_ERROR', '维护接口不接受查询参数');
  if (ctx.method === 'GET') {
    const state = await ctx.store.get('maintenance_state', 'global');
    return response({ policy: { ...POLICY, automatic_schedule_enabled: ctx.config.maintenanceEnabled === true && !!(state && state.timer_verified_at) }, kinds: KINDS, recent: state && state.recent || [], timer_verified_at: state && state.timer_verified_at || null, reminder_cleanup: state && state.reminder_cleanup || null, running: !!(state && state.lease_token && state.lease_until > ctx.now) });
  }
  if (ctx.method === 'POST') return response(await runMaintenance(ctx, ctx.body));
  throw new ApiError('METHOD_NOT_ALLOWED', '不支持此维护操作', 405);
}
module.exports = { handle, runMaintenance, administrator, KINDS, POLICY };
