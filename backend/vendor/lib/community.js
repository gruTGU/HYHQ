'use strict';
// Text-only submissions and comments. Public access is fail-closed until the
// operator verifies service-category eligibility, moderation and WeChat safety.
const { ApiError, response, requireUser, uuid, sha256, paginate, dateCN } = require('./core');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = { content: 'contents', route: 'routes', place: 'places' };
const COLLECTIONS = ['community_submissions', 'community_comments', 'community_reports', 'community_requests'];
const REASONS = ['spam', 'abuse', 'privacy', 'inaccurate', 'other'];
const CLOSED = '公开评论尚未开放。';
const FEEDBACK_CLOSED = '资料反馈尚未开放，可先保存私人草稿。';
const editorialMode = ctx => (ctx.config.community || {}).mode !== 'public-community';
const fail = (code, message, status = 409) => { throw new ApiError(code, message, status); };
const bad = message => fail('VALIDATION_ERROR', message, 400);
function strict(body, fields) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !fields.includes(k))) bad('提交参数无效'); }
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || [...value.trim()].length > max || (required && !value.trim()) || /[<>\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(value)) bad(label + '格式或长度无效，请使用普通文字');
  return value.trim();
}
function revision(body) { if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 1) bad('请刷新当前稿件后再操作'); return body.expected_version; }
function requestKey(ctx, kind) { if (!UUID.test(ctx.body.request_id || '')) bad('请提供有效的提交标识'); return sha256(ctx.user.id + ':' + kind + ':' + ctx.body.request_id); }
async function owner(tx, id) { const user = await tx.get('users', id); if (!user || user.is_active !== true || user.deleting) fail('AUTH_REQUIRED', '登录已过期，请重新登录', 401); return user; }
async function touch(tx, user, kind, delta = 0) {
  const counts = { ...(user.community_counts || {}) }, count = counts[kind] || 0;
  if (delta > 0 && count >= 100) fail('STORAGE_QUOTA', '个人记录已达上限，请先删除旧记录', 429);
  counts[kind] = Math.max(0, count + delta);
  await tx.update('users', user.id, { record_revision: (user.record_revision || 0) + 1, community_counts: counts });
}
async function audit(tx, ctx, user, action, kind, id) {
  const key = uuid(); await tx.create('admin_audit', key, { id: key, actor_ref: sha256('hyhq-community:' + (user.quota_key || user.id)), action,
    kind, target_id: id, changed_fields: ['status'], counts: {}, created_at: ctx.now });
}
async function admin(ctx, store = ctx.store) {
  const user = requireUser(ctx), config = ctx.config.management || {};
  if (config.enabled !== true || !(config.adminUserIds || []).includes(user.id)) fail('FORBIDDEN', '当前账号没有管理权限', 403);
  return owner(store, user.id);
}
async function readiness(ctx, store = ctx.store, feedback = false) {
  const raw = ctx.config.community || {};
  const config = feedback ? { qualificationConfirmed: raw.feedbackQualificationConfirmed, qualificationReference: raw.feedbackQualificationReference, qualificationDate: raw.feedbackQualificationDate, moderationReady: raw.moderationReady } : raw, management = ctx.config.management || {};
  const day = dateCN(ctx.now);
  if (!config.qualificationConfirmed || typeof config.qualificationReference !== 'string' || !config.qualificationReference.trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(config.qualificationDate || '') || !Number.isFinite(Date.parse(config.qualificationDate)) || new Date(config.qualificationDate).toISOString().slice(0, 10) !== config.qualificationDate || config.qualificationDate > day
    || !config.moderationReady || management.enabled !== true) return false;
  for (const id of management.adminUserIds || []) { const reviewer = await store.get('users', id); if (reviewer && reviewer.is_active === true && !reviewer.deleting) return true; }
  return false;
}
async function safetyReady(ctx, store) {
  const proof = await store.get('admin_config', 'community_safety');
  return Boolean(proof && proof.app_id === ctx.config.appId && proof.checked_at <= ctx.now && Date.parse(proof.checked_at) > Date.parse(ctx.now) - 7 * 86400000);
}
async function enabled(ctx, store = ctx.store) { return !editorialMode(ctx) && (ctx.config.community || {}).enabled === true && await readiness(ctx, store) && await safetyReady(ctx, store); }
async function feedbackEnabled(ctx, store = ctx.store) { return editorialMode(ctx) && (ctx.config.community || {}).feedbackEnabled === true && await readiness(ctx, store, true) && await safetyReady(ctx, store); }
async function publicationEnabled(ctx, value, store = ctx.store) { return value && value._editorial_feedback === true ? feedbackEnabled(ctx, store) : false; }
async function opened(ctx, store = ctx.store, submission = false) { if (!await (submission ? feedbackEnabled(ctx, store) : enabled(ctx, store))) fail('COMMUNITY_DISABLED', submission ? FEEDBACK_CLOSED : CLOSED, 503); }
function present(row, ctx, adminView = false) {
  const mine = Boolean(ctx.user && row.owner_id === ctx.user.id);
  const fields = row.type === 'submission' ? ['id', 'title', 'body', 'source', 'category', 'status', 'version', 'created_at', 'updated_at', 'published_id']
    : row.type === 'report' ? ['id', 'reason', 'detail', 'status', 'created_at', 'version'] : ['id', 'body', 'status', 'kind', 'target_id', 'created_at', 'version'];
  const value = Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
  if (adminView && row.type === 'submission') Object.assign(value, { editorial: row.editorial || null, editorial_safety_status: row.editorial_safety_status || 'unchecked' });
  if (row.type === 'submission') value.original_private = true;
  if (adminView && row.type === 'report') Object.assign(value, { kind: row.kind, target_id: row.target_id });
  if (row.type !== 'report') Object.assign(value, { is_owner: mine, author: mine ? '我' : '生态同行者', ...(mine || adminView ? { review_reason: row.review_reason || '', safety_status: row.safety_status || 'unchecked' } : {}) });
  return value;
}
async function rows(store, kind, where) {
  const result = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const batch = await store.list(kind, { where, limit: 100, offset, orderBy: [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'desc' }] });
    result.push(...batch); if (batch.length < 100) return result;
  }
  fail('RECORD_LIMIT', '记录较多，请按状态筛选后重试', 503);
}
async function activePublicAuthor(ctx, row) {
  const user = row && row.owner_id && await ctx.store.get('users', row.owner_id);
  return Boolean(user && user.is_active === true);
}
async function linked(ctx, kind, id) {
  if (!TYPES[kind] || !UUID.test(id || '')) bad('请选择有效的公开对象');
  const item = await require('./catalog').getPublicItem(ctx, TYPES[kind], id);
  if (!item) fail('NOT_FOUND', '对象不存在或已撤下', 404);
  return item;
}
async function linkedTransaction(tx, kind, id, ctx) {
  const row = await tx.get('catalog', TYPES[kind] + '_' + id);
  if (row && row.value && row.value._community_submission && !await activePublicAuthor({ store: tx }, { owner_id: row.value._community_owner_id })) fail('NOT_FOUND', '对象不存在或已撤下', 404);
  if (row && (row.deleted || !row.value || row.value.is_published === false || (kind === 'content' && row.value.status && row.value.status !== 'published') || (kind === 'route' && row.value.published === false))) fail('NOT_FOUND', '对象不存在或已撤下', 404);
  if (kind === 'route' || kind === 'place') {
    const snapshot = ctx.config.catalogSeed || require('../data/catalog.json');
    const value = row && row.value || (snapshot.collections[TYPES[kind]] || []).find(item => item.id === id);
    if (!value || !value.region) fail('NOT_FOUND', '对象不存在或已撤下', 404);
    const region = await tx.get('catalog', 'regions_' + value.region);
    if (region && (region.deleted || !region.value || region.value.is_active === false)) fail('NOT_FOUND', '所属区域已撤下', 404);
  }
}
async function bumpCatalog(tx, ctx) { const before = await tx.get('admin_config', 'catalog_revision') || { revision: 0 }; await tx.set('admin_config', 'catalog_revision', { id: 'catalog_revision', revision: before.revision + 1, updated_at: ctx.now }); }
async function withdrawCatalog(tx, ctx, row) {
  if (!row.published_id) return;
  const id = 'contents_' + row.published_id, prior = await tx.get('catalog', id);
  await tx.set('catalog', id, { id, kind: 'contents', value: prior && prior.value || { id: row.published_id }, deleted: true, updated_at: ctx.now }); await bumpCatalog(tx, ctx);
}
async function chargeSafety(tx, ctx, user, kind) {
  const day = dateCN(ctx.now), id = sha256('community:' + (user.quota_key || user.id)), gate = await tx.get('community_limits', id) || {};
  const used = gate.day === day ? gate.attempts || 0 : 0;
  if (used >= 10) fail('COMMUNITY_DAILY_LIMIT', '今日提交较多，请明天再试', 429);
  if (gate.last_at && Date.parse(ctx.now) - Date.parse(gate.last_at) < 60000) fail('COMMUNITY_RATE_LIMITED', '提交较频繁，请稍后再试', 429);
  const global = await tx.get('community_safety_days', day) || { count: 0 };
  if (global.count >= 80) fail('CONTENT_SAFETY_UNAVAILABLE', '内容检查暂不可用，请稍后再试', 503);
  await tx.set('community_limits', id, { id, day, attempts: used + 1, last_at: ctx.now });
  await tx.set('community_safety_days', day, { id: day, count: global.count + 1 });
}
async function checkText(ctx, content, scene) {
  if (typeof ctx.checkCommunityText !== 'function') return 'unavailable';
  let timer;
  try {
    const result = await Promise.race([ctx.checkCommunityText({ content, scene, version: 2 }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); })]);
    const code = result && (result.errcode === undefined ? result.errCode : result.errcode), suggestion = result && result.result && result.result.suggest;
    return code === 0 && ['pass', 'review', 'risky'].includes(suggestion) ? suggestion : 'unavailable';
  } catch (_) { return 'unavailable'; } finally { clearTimeout(timer); }
}
async function verify(ctx) {
  const user = await admin(ctx);
  if (!await readiness(ctx, ctx.store, editorialMode(ctx))) fail('COMMUNITY_NOT_READY', '请先核实业务资格并确认人工审核流程', 409);
  await ctx.store.transaction(async tx => { const active = await admin(ctx, tx); await chargeSafety(tx, ctx, active, 'verify'); await touch(tx, active, 'verification'); });
  const result = await checkText(ctx, '自然观察资料安全检查', 2);
  if (result !== 'pass') fail('CONTENT_SAFETY_UNAVAILABLE', '微信内容检查未通过联通验证，未启用公开功能', 503);
  await ctx.store.transaction(async tx => { const active = await admin(ctx, tx); await touch(tx, active, 'verification');
    await tx.set('admin_config', 'community_safety', { id: 'community_safety', app_id: ctx.config.appId, checked_at: ctx.now }); await audit(tx, ctx, user, 'community_safety_verified', 'community', ''); });
  return response({ verified_at: ctx.now, expires_at: new Date(Date.parse(ctx.now) + 7 * 86400000).toISOString(), enabled: await enabled(ctx), submissions_enabled: await feedbackEnabled(ctx) });
}
async function draft(ctx, id) {
  const user = requireUser(ctx); strict(ctx.body, ['title', 'body', 'category', 'source', 'expected_version', 'request_id']);
  const value = { title: text(ctx.body.title || '', '标题', 80, false), body: text(ctx.body.body || '', '正文', 2000, false), source: text(ctx.body.source || '', '参考来源', 300, false), category: ctx.body.category || 'green' };
  if (!['plants', 'water', 'green', 'travel'].includes(value.category)) bad('请选择有效分类');
  const expected = id ? revision(ctx.body) : null, key = id ? null : requestKey(ctx, 'draft'), hash = sha256(JSON.stringify(value));
  const result = await ctx.store.transaction(async tx => {
    const active = await owner(tx, user.id), request = key && await tx.get('community_requests', key);
    if (request) { if (request.fingerprint !== hash) fail('IDEMPOTENCY_CONFLICT', '提交标识对应其他内容'); const existing = await tx.get('community_submissions', request.target_id); if (!existing) fail('NOT_FOUND', '稿件已删除', 404); return existing; }
    const existing = id && await tx.get('community_submissions', id);
    if (id && (!existing || existing.owner_id !== user.id)) fail('NOT_FOUND', '稿件不存在', 404);
    if (existing && (existing.version !== expected || !['draft', 'rejected', 'withdrawn'].includes(existing.status))) fail('SUBMISSION_CHANGED', '稿件状态已变化，请先刷新或撤回');
    await touch(tx, active, 'submissions', existing ? 0 : 1);
    const row = { ...(existing || {}), ...value, id: id || uuid(), owner_id: user.id, type: 'submission', status: 'draft', safety_status: 'unchecked', editorial: null, editorial_safety_status: 'unchecked', review_reason: '', version: existing ? existing.version + 1 : 1, created_at: existing ? existing.created_at : ctx.now, updated_at: ctx.now };
    await tx.set('community_submissions', row.id, row);
    if (key) await tx.create('community_requests', key, { id: key, owner_id: user.id, target_id: row.id, fingerprint: hash, created_at: ctx.now });
    return row;
  }); return response(present(result, ctx), id ? 200 : 201);
}
async function submit(ctx, id, type) {
  const user = requireUser(ctx), submission = type === 'submission', collection = submission ? 'community_submissions' : 'community_comments';
  strict(ctx.body, submission ? ['expected_version', 'request_id'] : ['kind', 'target_id', 'body', 'request_id']);
  await opened(ctx, ctx.store, submission);
  let value = {}, expected;
  if (submission) expected = revision(ctx.body);
  else { value = { kind: ctx.body.kind, target_id: ctx.body.target_id, body: text(ctx.body.body, '评论', 500) }; await linked(ctx, value.kind, value.target_id); }
  const key = requestKey(ctx, type), fingerprint = sha256(JSON.stringify(submission ? { id, expected } : value));
  const reservation = await ctx.store.transaction(async tx => {
    const active = await owner(tx, user.id); await opened(ctx, tx, submission);
    const request = await tx.get('community_requests', key);
    if (request) { if (request.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '提交标识对应其他内容'); const existing = await tx.get(collection, request.target_id); if (!existing) fail('NOT_FOUND', '记录已删除', 404); return { row: existing, execute: false }; }
    const previous = submission && await tx.get(collection, id);
    if (submission && (!previous || previous.owner_id !== user.id)) fail('NOT_FOUND', '稿件不存在', 404);
    if (submission && (previous.version !== expected || !['draft', 'rejected', 'withdrawn'].includes(previous.status))) fail('SUBMISSION_CHANGED', '稿件状态已变化，请刷新后重试');
    if (submission) { text(previous.title, '标题', 80); text(previous.body, '正文', 2000); value = previous; }
    else await linkedTransaction(tx, value.kind, value.target_id, ctx);
    await chargeSafety(tx, ctx, active, type); await touch(tx, active, submission ? 'submissions' : 'comments', submission ? 0 : 1);
    const row = { ...value, id: id || uuid(), owner_id: user.id, type, status: 'checking', safety_status: 'checking', review_reason: '', version: previous ? previous.version + 1 : 1, created_at: previous ? previous.created_at : ctx.now, updated_at: ctx.now };
    await tx.set(collection, row.id, row); await tx.create('community_requests', key, { id: key, owner_id: user.id, target_id: row.id, fingerprint, created_at: ctx.now });
    return { row, execute: true };
  });
  if (!reservation.execute) return response(present(reservation.row, ctx));
  const row = reservation.row, outcome = await checkText(ctx, submission ? [row.title, row.body, row.source].join('\n') : row.body, submission ? 3 : 2);
  const final = await ctx.store.transaction(async tx => {
    const active = await owner(tx, user.id), current = await tx.get(collection, row.id);
    if (!current || current.owner_id !== user.id || current.version !== row.version || current.status !== 'checking') fail('SUBMISSION_CHANGED', '稿件状态已变化，请刷新记录');
    let available = await (submission ? feedbackEnabled(ctx, tx) : enabled(ctx, tx));
    if (!submission) { try { await linkedTransaction(tx, current.kind, current.target_id, ctx); } catch (_) { available = false; } }
    const status = outcome === 'pass' && available ? 'pending' : 'rejected';
    const updated = { ...current, status, safety_status: outcome, review_reason: !available ? '投稿服务或关联资料已变更，请稍后重试' : outcome === 'unavailable' ? '内容检查未完成，请稍后重试' : outcome === 'pass' ? '' : '内容检查未通过，请修改后重试', version: current.version + 1, updated_at: ctx.now };
    await touch(tx, active, submission ? 'submissions' : 'comments'); await tx.set(collection, row.id, updated); await audit(tx, ctx, active, 'community_submitted', collection, row.id);
    return updated;
  }); return response(present(final, ctx), 201);
}
async function removeOrWithdraw(ctx, collection, id, remove) {
  const user = requireUser(ctx); strict(ctx.body, ['expected_version']); const expected = revision(ctx.body);
  return ctx.store.transaction(async tx => {
    const active = await owner(tx, user.id), row = await tx.get(collection, id);
    if (!row || row.owner_id !== user.id) fail('NOT_FOUND', '记录不存在', 404);
    if (row.version !== expected) fail('SUBMISSION_CHANGED', '记录已变化，请刷新后重试');
    await touch(tx, active, row.type === 'submission' ? 'submissions' : 'comments', remove ? -1 : 0);
    if (row.type === 'submission') await withdrawCatalog(tx, ctx, row);
    if (remove) await tx.remove(collection, id);
    else await tx.update(collection, id, { status: 'withdrawn', version: row.version + 1, safety_status: 'unchecked', updated_at: ctx.now });
    await audit(tx, ctx, active, remove ? 'community_deleted' : 'community_withdrawn', collection, id);
    return response(null, 204);
  });
}
async function catalogCapacity(ctx) {
  const before = await ctx.store.get('admin_config', 'catalog_revision') || { revision: 0 };
  const count = await ctx.store.count('catalog');
  const after = await ctx.store.get('admin_config', 'catalog_revision') || { revision: 0 };
  if (before.revision !== after.revision) fail('ADMIN_REVISION_CHANGED', '资料正在更新，请刷新后重试');
  return { count, revision: after.revision };
}
async function publishEdited(ctx, id) {
  const actor = await admin(ctx), expected = revision(ctx.body);
  const editorial = { title: text(ctx.body.edited_title, '编辑后标题', 80), body: text(ctx.body.edited_body, '编辑后正文', 2000), source: text(ctx.body.edited_source, '已核实的公开来源', 300) };
  const key = requestKey(ctx, 'editorial-review'), fingerprint = sha256(JSON.stringify({ id, expected, editorial }));
  const capacity = await catalogCapacity(ctx);
  const reserved = await ctx.store.transaction(async tx => {
    const reviewer = await admin(ctx, tx); await opened(ctx, tx, true);
    const request = await tx.get('community_requests', key);
    if (request) {
      if (request.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '提交标识对应其他内容');
      const current = await tx.get('community_submissions', request.target_id);
      if (!current) fail('NOT_FOUND', '记录已删除', 404);
      return { row: current, execute: false };
    }
    const row = await tx.get('community_submissions', id);
    if (!row) fail('NOT_FOUND', '记录不存在', 404);
    if (row.version !== expected || row.status !== 'pending') fail('SUBMISSION_CHANGED', '记录状态已变化，请刷新');
    await owner(tx, row.owner_id);
    if (row.safety_status !== 'pass') fail('CONTENT_SAFETY_REQUIRED', '原始反馈安全检查未通过');
    if (editorial.body.replace(/\s/g, '') === row.body.replace(/\s/g, '')) bad('请核实来源并独立编辑正文，不能直接公开原始反馈');
    const currentRevision = await tx.get('admin_config', 'catalog_revision') || { revision: 0 };
    if (currentRevision.revision !== capacity.revision) fail('ADMIN_REVISION_CHANGED', '资料正在更新，请刷新后重试');
    if (!await tx.get('catalog', 'contents_' + (row.published_id || row.id)) && capacity.count >= 4900) fail('CATALOG_LIMIT', '公开资料条目已达当前容量，请联系管理员整理', 429);
    await chargeSafety(tx, ctx, reviewer, 'editorial'); await touch(tx, reviewer, 'moderation');
    const updated = { ...row, status: 'reviewing', editorial, editorial_safety_status: 'checking', version: row.version + 1, updated_at: ctx.now };
    await tx.set('community_submissions', id, updated);
    await tx.create('community_requests', key, { id: key, owner_id: reviewer.id, target_id: id, fingerprint, created_at: ctx.now });
    return { row: updated, execute: true };
  });
  if (!reserved.execute) return response(present(reserved.row, ctx, true));
  const outcome = await checkText(ctx, [editorial.title, editorial.body, editorial.source].join('\n'), 3);
  // Re-snapshot after the external check; revision comparison below closes races.
  let result;
  try {
  const finalCapacity = await catalogCapacity(ctx);
  result = await ctx.store.transaction(async tx => {
    const reviewer = await admin(ctx, tx), row = await tx.get('community_submissions', id);
    if (!row || row.version !== reserved.row.version || row.status !== 'reviewing') fail('SUBMISSION_CHANGED', '反馈已撤回、删除或更新，请刷新');
    const author = await owner(tx, row.owner_id), available = await feedbackEnabled(ctx, tx);
    const revisionNow = await tx.get('admin_config', 'catalog_revision') || { revision: 0 };
    const existing = await tx.get('catalog', 'contents_' + (row.published_id || row.id));
    const capacityReady = revisionNow.revision === finalCapacity.revision && (existing || finalCapacity.count < 4900);
    const publish = outcome === 'pass' && available && capacityReady;
    const updated = { ...row, status: publish ? 'approved' : 'pending', editorial_safety_status: outcome,
      review_reason: publish ? '' : !available ? '资料反馈服务状态已变化，未发布' : !capacityReady ? '公开资料正在更新或容量已满，请刷新后重试' : '编辑内容检查未通过或未完成，请修改后重试', version: row.version + 1, updated_at: ctx.now };
    await touch(tx, reviewer, 'moderation'); if (author.id !== reviewer.id) await touch(tx, author, 'submissions');
    if (publish) {
      updated.published_id = row.published_id || row.id;
      const value = { id: updated.published_id, title: editorial.title, slug: 'official-' + row.id, body: editorial.body,
        summary: editorial.body.slice(0, 160), category: row.category, source: '官方编辑整理 · 来源：' + editorial.source,
        is_demo: false, place: null, plant_label: '', status: 'published', published_at: ctx.now, updated_at: ctx.now,
        _community_submission: true, _editorial_feedback: true, _community_owner_id: row.owner_id };
      await tx.set('catalog', 'contents_' + value.id, { id: 'contents_' + value.id, kind: 'contents', value, deleted: false, updated_at: ctx.now });
      await bumpCatalog(tx, ctx);
    }
    await tx.set('community_submissions', id, updated); await audit(tx, ctx, reviewer, publish ? 'community_approved' : 'community_editorial_check_failed', 'community_submissions', id);
    return updated;
  });
  } catch (error) {
    // The safety reservation remains charged. A failed publication can be
    // reviewed again after refresh, without leaving a permanent checking lock.
    // Version comparison protects concurrent withdrawal/deletion or a commit
    // whose acknowledgement was lost. A storage outage can still be recovered
    // by the administrator's explicit rejection or the owner's withdrawal.
    try {
      await ctx.store.transaction(async tx => {
        const current = await tx.get('community_submissions', id);
        if (current && current.status === 'reviewing' && current.version === reserved.row.version) {
          await tx.update('community_submissions', id, { status: 'pending', editorial_safety_status: outcome,
            review_reason: '发布未完成，请刷新记录、核对编辑稿后重试', version: current.version + 1, updated_at: ctx.now });
        }
      });
    } catch (_) { /* Fail closed: no alternate publication path. */ }
    throw error;
  }
  return response(present(result, ctx, true));
}
async function review(ctx, collection, id) {
  await admin(ctx); strict(ctx.body, ['decision', 'reason', 'expected_version', ...(collection === 'community_submissions' ? ['edited_title', 'edited_body', 'edited_source', 'request_id'] : [])]);
  const expected = revision(ctx.body), decision = ctx.body.decision;
  if (!['approved', 'rejected'].includes(decision)) bad('请选择通过或驳回');
  const reason = text(ctx.body.reason || '', '审核说明', 300, decision === 'rejected');
  if (collection === 'community_submissions' && decision === 'approved') return publishEdited(ctx, id);
  const result = await ctx.store.transaction(async tx => {
    const actor = await admin(ctx, tx), row = await tx.get(collection, id);
    if (!row) fail('NOT_FOUND', '记录不存在', 404);
    if (row.version !== expected || !['pending', 'approved', 'reviewing'].includes(row.status)) fail('SUBMISSION_CHANGED', '记录状态已变化，请刷新');
    const author = await owner(tx, row.owner_id);
    if (decision === 'approved') {
      await opened(ctx, tx); if (row.safety_status !== 'pass') fail('CONTENT_SAFETY_REQUIRED', '内容安全检查未通过，不能公开');
      await linked(ctx, row.kind, row.target_id); await linkedTransaction(tx, row.kind, row.target_id, ctx);
    }
    await touch(tx, actor, 'moderation'); if (author.id !== actor.id) await touch(tx, author, row.type === 'submission' ? 'submissions' : 'comments');
    const updated = { ...row, status: decision, review_reason: reason, version: row.version + 1, updated_at: ctx.now };
    if (row.type === 'submission') await withdrawCatalog(tx, ctx, row);
    await tx.set(collection, row.id, updated); await audit(tx, ctx, actor, 'community_' + decision, collection, id); return updated;
  }); return response(present(result, ctx, true));
}
async function report(ctx) {
  const user = requireUser(ctx); await opened(ctx); strict(ctx.body, ['kind', 'target_id', 'reason', 'detail', 'request_id']);
  const { kind, target_id, reason } = ctx.body; if (!REASONS.includes(reason)) bad('请选择举报原因');
  const detail = text(ctx.body.detail || '', '举报说明', 300, false), key = requestKey(ctx, 'report');
  if (kind === 'comment') { const row = UUID.test(target_id || '') && await ctx.store.get('community_comments', target_id); if (!row || row.status !== 'approved' || !await activePublicAuthor(ctx, row)) fail('NOT_FOUND', '评论不存在', 404); await linked(ctx, row.kind, row.target_id); }
  else await linked(ctx, kind, target_id);
  const id = require('./activity').deterministicId(user.id + ':' + kind + ':' + target_id), fingerprint = sha256(JSON.stringify({ kind, target_id, reason, detail }));
  const result = await ctx.store.transaction(async tx => {
    const active = await owner(tx, user.id); await opened(ctx, tx);
    const request = await tx.get('community_requests', key); if (request && request.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '提交标识对应其他内容');
    const existing = await tx.get('community_reports', id); if (existing) {
      if (!request) await tx.create('community_requests', key, { id: key, owner_id: user.id, target_id: id, fingerprint, created_at: ctx.now });
      return existing;
    }
    if (kind === 'comment') { const row = await tx.get('community_comments', target_id); if (!row || row.status !== 'approved' || !await activePublicAuthor({ ...ctx, store: tx }, row)) fail('NOT_FOUND', '评论不存在', 404); await linkedTransaction(tx, row.kind, row.target_id, ctx); }
    else await linkedTransaction(tx, kind, target_id, ctx);
    const limitId = sha256('reports:' + (active.quota_key || active.id)), limit = await tx.get('community_limits', limitId) || {}, day = dateCN(ctx.now);
    if (limit.last_at && Date.parse(ctx.now) - Date.parse(limit.last_at) < 60000) fail('COMMUNITY_RATE_LIMITED', '举报较频繁，请稍后再试', 429);
    const count = limit.day === day ? limit.attempts || 0 : 0;
    if (count >= 20) fail('COMMUNITY_DAILY_LIMIT', '今日举报较多，请明天再试', 429);
    await tx.set('community_limits', limitId, { id: limitId, day, attempts: count + 1, last_at: ctx.now });
    await touch(tx, active, 'reports', 1);
    const row = { id, owner_id: user.id, type: 'report', kind, target_id, reason, detail, status: 'pending', version: 1, created_at: ctx.now };
    await tx.create('community_reports', id, row); await tx.set('community_requests', key, { id: key, owner_id: user.id, target_id: id, fingerprint, created_at: ctx.now }); await audit(tx, ctx, active, 'community_reported', 'community_reports', id); return row;
  }); return response(present(result, ctx), 201);
}
async function purgeOwner(ctx, user) {
  const submissions = await rows(ctx.store, 'community_submissions', { owner_id: user.id });
  for (const row of submissions) await ctx.store.transaction(async tx => { await withdrawCatalog(tx, ctx, row); await tx.remove('community_submissions', row.id); });
  for (const collection of COLLECTIONS.slice(1)) for (let round = 0; round < 100; round++) { const batch = await ctx.store.list(collection, { where: { owner_id: user.id }, limit: 100 }); if (!batch.length) break; for (const row of batch) await ctx.store.remove(collection, row.id); if (round === 99) fail('CLEANUP_PENDING', '私人社区记录仍在清理', 503); }
}
async function handle(ctx) {
  const path = ctx.path;
  if (!path.startsWith('community/') && !path.startsWith('personal-admin/community/')) return;
  if (path === 'community/status/' && ctx.method === 'GET') { const open = await enabled(ctx), feedback = await feedbackEnabled(ctx); return response({ mode: editorialMode(ctx) ? 'official-editorial' : 'public-community', enabled: open, comments_enabled: open, submissions_enabled: feedback, drafts_enabled: true, reason: feedback ? '' : FEEDBACK_CLOSED, max_comment_length: 500, max_submission_length: 2000 }); }
  if (path.startsWith('personal-admin/community/')) {
    await admin(ctx);
    if (path === 'personal-admin/community/status/' && ctx.method === 'GET') { const proof = await ctx.store.get('admin_config', 'community_safety'); return response({ mode: editorialMode(ctx) ? 'official-editorial' : 'public-community', enabled: await enabled(ctx), submissions_enabled: await feedbackEnabled(ctx), prerequisites_ready: await readiness(ctx, ctx.store, editorialMode(ctx)), safety_verified_at: proof && proof.checked_at || null }); }
    if (path === 'personal-admin/community/verify-safety/' && ctx.method === 'POST') return verify(ctx);
    const match = /^personal-admin\/community\/(submissions|comments|reports)\/(?:([a-f0-9-]+)\/review\/)?$/.exec(path);
    if (!match) fail('NOT_FOUND', '管理接口不存在', 404);
    const collection = 'community_' + match[1];
    if (ctx.method === 'GET' && !match[2]) { const status = ctx.query.get('status'); if (status && !['pending', 'approved', 'rejected', 'resolved', 'dismissed', 'checking', 'reviewing'].includes(status)) bad('状态筛选无效'); return paginate(ctx, (await rows(ctx.store, collection, status ? { status } : {})).filter(row => row.status !== 'draft' && row.status !== 'withdrawn').map(row => present(row, ctx, true))); }
    if (ctx.method === 'POST' && UUID.test(match[2] || '')) {
      if (match[1] !== 'reports') return review(ctx, collection, match[2]);
      strict(ctx.body, ['decision', 'expected_version']); const expected = revision(ctx.body); if (!['resolved', 'dismissed'].includes(ctx.body.decision)) bad('处理状态无效');
      return ctx.store.transaction(async tx => { const actor = await admin(ctx, tx), row = await tx.get(collection, match[2]); if (!row || row.version !== expected) fail('SUBMISSION_CHANGED', '记录已变化，请刷新'); await touch(tx, actor, 'moderation'); await tx.update(collection, row.id, { status: ctx.body.decision, version: row.version + 1 }); await audit(tx, ctx, actor, 'community_report_handled', collection, row.id); return response({ id: row.id, status: ctx.body.decision }); });
    }
    fail('METHOD_NOT_ALLOWED', '不支持此操作', 405);
  }
  const submission = /^community\/submissions\/(?:([a-f0-9-]+)\/(submit\/|withdraw\/)?)?$/.exec(path);
  if (submission) {
    const user = requireUser(ctx), id = submission[1], action = submission[2];
    if (id && !UUID.test(id)) bad('稿件标识无效');
    if (ctx.method === 'GET' && !action) { if (!id) return paginate(ctx, (await rows(ctx.store, 'community_submissions', { owner_id: user.id })).map(row => present(row, ctx))); const row = await ctx.store.get('community_submissions', id); if (!row || row.owner_id !== user.id) fail('NOT_FOUND', '稿件不存在', 404); return response(present(row, ctx)); }
    if (ctx.method === 'POST' && !id || ctx.method === 'PATCH' && id && !action) return draft(ctx, id);
    if (ctx.method === 'POST' && action === 'submit/') return submit(ctx, id, 'submission');
    if (ctx.method === 'DELETE' && id && !action || ctx.method === 'POST' && action === 'withdraw/') return removeOrWithdraw(ctx, 'community_submissions', id, ctx.method === 'DELETE');
  }
  if (path === 'community/comments/' && ctx.method === 'POST') return submit(ctx, null, 'comment');
  if (path === 'community/comments/' && ctx.method === 'GET') {
    await opened(ctx); const kind = ctx.query.get('kind'), id = ctx.query.get('target_id'); await linked(ctx, kind, id);
    const visible = [];
    for (const row of await rows(ctx.store, 'community_comments', { kind, target_id: id })) if ((row.status === 'approved' || ctx.user && row.owner_id === ctx.user.id) && await activePublicAuthor(ctx, row)) visible.push(present(row, ctx));
    return paginate(ctx, visible);
  }
  if (path === 'community/comments/mine/' && ctx.method === 'GET') { const user = requireUser(ctx), visible = []; for (const row of await rows(ctx.store, 'community_comments', { owner_id: user.id })) { try { await linked(ctx, row.kind, row.target_id); visible.push(present(row, ctx)); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; } } return paginate(ctx, visible); }
  const comment = /^community\/comments\/([a-f0-9-]+)\/$/.exec(path);
  if (comment && ctx.method === 'DELETE' && UUID.test(comment[1])) { const row = await ctx.store.get('community_comments', comment[1]); if (!row || !ctx.user || row.owner_id !== ctx.user.id) fail('NOT_FOUND', '评论不存在', 404); ctx.body = { expected_version: row.version }; return removeOrWithdraw(ctx, 'community_comments', comment[1], true); }
  if (path === 'community/reports/' && ctx.method === 'POST') return report(ctx);
  if (path === 'community/reports/' && ctx.method === 'GET') { const user = requireUser(ctx); return paginate(ctx, (await rows(ctx.store, 'community_reports', { owner_id: user.id })).map(row => present(row, ctx))); }
  fail('METHOD_NOT_ALLOWED', '不支持此操作', 405);
}
module.exports = { handle, enabled, feedbackEnabled, publicationEnabled, editorialMode, purgeOwner, checkText, COLLECTIONS };
