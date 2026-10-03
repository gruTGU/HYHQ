'use strict';
const { ApiError, response, requireUser, uuid, sha256, paginate } = require('./core');
const { getPublicItem, UUID } = require('./catalog');

const COLLECTIONS = ['favorites', 'histories', 'visits', 'feedback'];
const LIMITS = { favorites: 1000, histories: 1000, visits: 1000, feedback: 100 };
const bad = (message) => { throw new ApiError('VALIDATION_ERROR', message, 400); };
const notFound = () => { throw new ApiError('NOT_FOUND', '记录不存在', 404); };
function deterministicId(key) {
  const hex = sha256(key).slice(0, 32).split(''); hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const text = hex.join(''); return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
function shanghaiDay(now) { return new Date(Date.parse(now) + 8 * 3600000).toISOString().slice(0, 10); }
async function activeOwner(store, id) {
  const owner = await store.get('users', id);
  if (!owner || owner.is_active !== true) throw new ApiError('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
  return owner;
}
async function touchOwner(store, owner, collection, change) {
  const counts = { ...(owner.activity_counts || {}) };
  const count = Math.max(0, Number(counts[collection]) || 0);
  if (change > 0 && count >= LIMITS[collection]) throw new ApiError('STORAGE_QUOTA', '个人记录已达上限，请先删除旧记录', 429);
  counts[collection] = Math.max(0, count + change);
  await store.update('users', owner.id, { record_revision: (Number(owner.record_revision) || 0) + 1, activity_counts: counts });
}
async function targetInput(ctx, collection) {
  const body = ctx.body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('请选择一个地点或一篇文章');
  const keys = ['place_id', 'content_id'].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (keys.length !== 1 || !UUID.test(body[keys[0]]) || (collection === 'visits' && keys[0] !== 'place_id')) bad(collection === 'visits' ? '游览记录必须选择地点' : '请选择一个地点或一篇文章');
  const key = keys[0], item = await getPublicItem(ctx, key === 'place_id' ? 'places' : 'contents', body[key]);
  if (!item) bad('地点或文章不存在或未发布');
  return { key, id: item.id };
}
async function serialize(ctx, collection, record) {
  if (collection === 'feedback') return { id: record.id, body: record.body, status: record.status, created_at: record.created_at,
    reply: record.status === 'resolved' ? record.reply || '' : '', resolved_at: record.status === 'resolved' ? record.resolved_at || null : null };
  const place = record.place_id && await getPublicItem(ctx, 'places', record.place_id);
  const content = record.content_id && await getPublicItem(ctx, 'contents', record.content_id);
  const common = { id: record.id, place: place ? { id: place.id, name: place.name } : null, place_id: record.place_id || null };
  if (collection === 'visits') return { ...common, visited_at: record.visited_at, visited_on: record.visited_on };
  return { ...common, content: content ? { id: content.id, title: content.title } : null, content_id: record.content_id || null,
    created_at: record.created_at, ...(collection === 'histories' ? { viewed_at: record.viewed_at } : {}) };
}
async function readRecords(ctx, collection, owner) {
  const where = { owner_id: owner.id };
  if (['favorites', 'histories'].includes(collection)) for (const key of ['place_id', 'content_id']) if (ctx.query.has(key)) {
    if (ctx.query.getAll(key).length !== 1 || !UUID.test(ctx.query.get(key))) bad('筛选 ID 无效');
    where[key] = ctx.query.get(key);
  }
  const field = collection === 'histories' ? 'viewed_at' : collection === 'visits' ? 'visited_at' : 'created_at';
  const rows = [];
  for (let offset = 0; offset <= LIMITS[collection]; offset += 100) {
    const batch = await ctx.store.list(collection, { where, limit: 100, offset,
      orderBy: [{ field, direction: 'desc' }, { field: 'id', direction: 'desc' }] });
    rows.push(...batch);
    if (rows.length > LIMITS[collection]) throw new ApiError('RECORD_LIMIT', '记录超过当前版本查询容量，请联系管理员整理', 503);
    if (batch.length < 100) break;
  }
  return paginate(ctx, await Promise.all(rows.map((row) => serialize(ctx, collection, row))));
}
async function handle(ctx) {
  const match = /^\/?(favorites|histories|visits|feedback)\/(?:([^/]+)\/)?$/.exec(ctx.path);
  if (!match) return undefined;
  const collection = match[1], id = match[2];
  const user = requireUser(ctx);
  if (id) {
    if (!UUID.test(id)) notFound();
    if (ctx.method !== 'DELETE') throw new ApiError('METHOD_NOT_ALLOWED', '记录仅支持删除', 405);
    await ctx.store.transaction(async (tx) => {
      const owner = await activeOwner(tx, user.id), record = await tx.get(collection, id);
      if (!record || record.owner_id !== user.id) notFound();
      await touchOwner(tx, owner, collection, -1);
      await tx.remove(collection, id);
    });
    return response(null, 204);
  }
  if (ctx.method === 'GET') {
    const owner = await activeOwner(ctx.store, user.id);
    return readRecords(ctx, collection, owner);
  }
  if (ctx.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', '不支持此请求方法', 405);
  let target, feedbackBody;
  if (collection === 'feedback') {
    feedbackBody = ctx.body && ctx.body.body;
    if (typeof feedbackBody !== 'string' || !feedbackBody.trim() || feedbackBody.trim().length > 1000) bad('反馈须为 1 至 1000 个字符');
    feedbackBody = feedbackBody.trim();
  } else target = await targetInput(ctx, collection);
  // Deterministic record IDs avoid query-based uniqueness checks. Each operation
  // touches the owner document so privacy changes and account deletion conflict
  // with it and CloudBase retries against a fresh active user.
  const day = shanghaiDay(ctx.now);
  const recordId = target ? deterministicId([collection, user.id, target.key, target.id, collection === 'visits' ? day : ''].join(':')) : uuid();
  const outcome = await ctx.store.transaction(async (tx) => {
    const owner = await activeOwner(tx, user.id);
    if (target) {
      const kind = target.key === 'place_id' ? 'places' : 'contents';
      const changed = await tx.get('catalog', kind + '_' + target.id);
      if (changed && (changed.deleted === true || !changed.value || changed.value.is_published === false
        || (kind === 'contents' && changed.value.status && changed.value.status !== 'published'))) bad('地点或文章不存在或未发布');
    }
    if (collection === 'histories' && !owner.record_history) throw new ApiError('HISTORY_DISABLED', '浏览记录已关闭', 409);
    const existing = await tx.get(collection, recordId);
    if (existing) {
      if (existing.owner_id !== user.id) throw new ApiError('RECORD_CONFLICT', '记录标识冲突，请重试', 409);
      await touchOwner(tx, owner, collection, 0);
      if (collection === 'histories') { await tx.update(collection, recordId, { viewed_at: ctx.now }); existing.viewed_at = ctx.now; }
      return { row: existing, created: false };
    }
    await touchOwner(tx, owner, collection, 1);
    const row = collection === 'feedback'
      ? { id: recordId, owner_id: user.id, body: feedbackBody, status: 'pending', reply: '', resolved_at: null, created_at: ctx.now }
      : collection === 'visits'
        ? { id: recordId, owner_id: user.id, place_id: target.id, visited_on: day, visited_at: ctx.now }
        : { id: recordId, owner_id: user.id, place_id: target.key === 'place_id' ? target.id : null,
          content_id: target.key === 'content_id' ? target.id : null, created_at: ctx.now,
          ...(collection === 'histories' ? { viewed_at: ctx.now } : {}) };
    await tx.create(collection, recordId, row);
    return { row, created: true };
  });
  return response(await serialize(ctx, collection, outcome.row), outcome.created ? 201 : 200);
}

module.exports = { handle, deterministicId, shanghaiDay, COLLECTIONS, LIMITS };
