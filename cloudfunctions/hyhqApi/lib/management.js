'use strict';
// Server-side administrator allowlist only. This module never grants roles and
// never exposes provider credentials, OpenID, session tokens or audit text bodies.
const { ApiError, response, requireUser, uuid, sha256, paginate, dateCN } = require('./core');
const catalog = require('./catalog');
const bundle = require('../data/catalog.json');
const EDITABLE = ['contents', 'routes', 'places'];
const FIELDS = {
  contents: ['title', 'slug', 'body', 'summary', 'category', 'place', 'plant_label', 'source', 'is_demo'],
  routes: ['title', 'slug', 'region', 'description', 'source', 'is_demo', 'stops'],
  places: ['slug', 'name', 'kind', 'description', 'region', 'map_layout', 'x_ratio', 'y_ratio', 'latitude', 'longitude', 'coordinate_system', 'source_note'],
};
const bad = (message) => { throw new ApiError('VALIDATION_ERROR', message, 400); };
const fail = (code, message, status = 409) => { throw new ApiError(code, message, status); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function enabled(ctx) { return ctx.config.management && ctx.config.management.enabled === true; }
async function authorize(ctx, store = ctx.store) {
  if (!enabled(ctx)) fail('MANAGEMENT_DISABLED', '管理入口尚未开放', 404);
  const user = requireUser(ctx), ids = ctx.config.management.adminUserIds || [];
  if (!Array.isArray(ids) || !ids.includes(user.id)) fail('FORBIDDEN', '当前账号没有管理权限', 403);
  const fresh = await store.get('users', user.id);
  if (!fresh || fresh.is_active !== true) fail('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
  return fresh;
}
function strictBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) bad('管理参数无效');
  return body;
}
function expected(body) { if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) bad('请提交当前管理版本 expected_revision'); return body.expected_revision; }
async function state(store) { return await store.get('admin_config', 'catalog_revision') || { id: 'catalog_revision', revision: 0 }; }
async function checkedRead(ctx, read) {
  const before = await state(ctx.store), value = await read(), after = await state(ctx.store);
  if (before.revision !== after.revision) fail('ADMIN_REVISION_CHANGED', '管理内容正在更新，请刷新后重试');
  return { value, revision: before.revision };
}
async function bump(tx, before, ctx) { const next = { id: 'catalog_revision', revision: before.revision + 1, updated_at: ctx.now }; await tx.set('admin_config', next.id, next); return next.revision; }
async function audit(tx, ctx, actor, action, kind, target, fields = [], counts = {}) {
  const id = uuid();
  await tx.create('admin_audit', id, { id, actor_ref: sha256('hyhq-admin:' + (actor.quota_key || actor.id)), action, kind,
    target_id: target || '', changed_fields: [...new Set(fields)].sort(), counts, created_at: ctx.now });
}
async function mutate(ctx, revision, callback) {
  return ctx.store.transaction(async (tx) => {
    const actor = await authorize(ctx, tx), before = await state(tx);
    if (before.revision !== revision) fail('ADMIN_REVISION_CHANGED', '资料或管理状态已更新，请刷新后重试');
    // Account deletion and administrator mutation share the owner document.
    await tx.update('users', actor.id, { record_revision: (actor.record_revision || 0) + 1 });
    const result = await callback(tx, actor);
    return { ...result, revision: await bump(tx, before, ctx) };
  });
}
async function rawEntries(ctx, kind) {
  const snapshot = ctx.config.catalogSeed || bundle;
  const values = new Map((snapshot.collections[kind] || []).map((value) => [value.id, { id: value.id, value, deleted: false }]));
  for (let offset = 0; ; offset += 100) {
    const rows = await ctx.store.list('catalog', { where: { kind }, limit: 100, offset, orderBy: [{ field: 'id', direction: 'asc' }] });
    for (const row of rows) {
      const id = row.value && row.value.id || String(row.id || '').slice(kind.length + 1);
      if (catalog.UUID.test(id)) values.set(id, { id, value: row.value || values.get(id) && values.get(id).value || { id }, deleted: row.deleted === true });
    }
    if (rows.length < 100) break;
    if (offset >= 4900) fail('CATALOG_LIMIT', '资料条目超过当前管理容量', 503);
  }
  return [...values.values()];
}
function text(value, name, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) bad(name + '长度或格式无效');
  return value.trim();
}
function validateValue(kind, previous, change, publication, current, now, id) {
  strictBody(change, FIELDS[kind]);
  const value = { ...(previous || {}), ...change, id };
  value.slug = text(value.slug, 'slug', 100, true);
  if (!/^[-a-zA-Z0-9_]+$/.test(value.slug)) bad('slug只能包含字母、数字、短横线或下划线');
  for (const key of kind === 'places' ? ['name'] : ['title']) value[key] = text(value[key], key, kind === 'places' ? 120 : 180, true);
  const longField = kind === 'contents' ? 'body' : 'description'; value[longField] = text(value[longField], longField, 20000, kind === 'contents');
  if (own(change, 'is_demo') && typeof change.is_demo !== 'boolean') bad('is_demo必须为布尔值');
  if (kind === 'contents') {
    value.summary = text(value.summary, '摘要', 3000); value.source = text(value.source, '来源', 500);
    value.plant_label = text(value.plant_label, '植物标签', 50);
    if (value.plant_label && !/^[-a-zA-Z0-9_]+$/.test(value.plant_label)) bad('植物标签格式无效');
    if (!['plants', 'water', 'green', 'travel'].includes(value.category)) bad('科普分类无效');
    if (value.place && !current.places.some((place) => place.id === value.place)) bad('关联地点须为公开地点');
    value.place ||= null;
    value.status = publication === undefined ? previous ? previous.status || 'published' : 'draft' : publication ? 'published' : 'draft';
    if (value.status === 'published' && !value.source) bad('发布科普前请填写可核对来源');
    value.published_at = value.status === 'published' ? value.published_at || now : null;
    value._created_at ||= now; value.updated_at = now;
  } else {
    if (!current.regions.some((region) => region.id === value.region)) bad('所属区域不存在');
    if (previous && kind === 'places' && previous.region !== value.region) bad('已有地点不能直接跨区域移动，请新建地点');
    value.region_name = current.regions.find((region) => region.id === value.region).name;
    value._updated_at = now;
    if (kind === 'routes') {
      value.source = text(value.source, '来源', 500);
      value.published = publication === undefined ? Boolean(previous && previous.published !== false) : publication;
      if (value.published && !value.source) bad('发布路线前请填写可核对来源');
      if (!Array.isArray(value.stops) || value.stops.length > 50) bad('路线须提供不超过50个节点');
      const orders = new Set();
      value.stops = value.stops.map((stop) => {
        strictBody(stop, ['id', 'order', 'note', 'place', 'place_id']);
        const placeId = stop.place_id || stop.place && stop.place.id;
        const place = current.places.find((item) => item.id === placeId && item.region === value.region);
        if (!place || !Number.isSafeInteger(stop.order) || stop.order < 0 || stop.order > 1000 || orders.has(stop.order)) bad('路线节点须为本区域公开地点，且序号不重复');
        orders.add(stop.order);
        return { id: stop.id && catalog.UUID.test(stop.id) ? stop.id : uuid(), order: stop.order, note: text(stop.note, '节点说明', 300), place: catalog.pick('places', place) };
      }).sort((a, b) => a.order - b.order);
      value.stop_count = value.stops.length;
    } else {
      if (!['river', 'lake', 'park', 'plant', 'waste', 'trail', 'campus', 'landmark'].includes(value.kind)) bad('地点类型无效');
      if (previous && previous.water_body_id && !['river', 'lake'].includes(value.kind)) bad('已有水体关联的地点不能改变为非河湖类型');
      value.source_note = text(value.source_note, '地点来源', 500);
      value.is_published = publication === undefined ? Boolean(previous && previous.is_published !== false) : publication;
      value.is_demo = Boolean(current.regions.find((region) => region.id === value.region).is_demo);
      for (const [first, second, maxFirst, maxSecond] of [['latitude', 'longitude', 90, 180], ['x_ratio', 'y_ratio', 1, 1]]) {
        value[first] ??= null; value[second] ??= null;
        if ((value[first] === null) !== (value[second] === null)) bad('坐标必须成对提供');
        if (value[first] !== null && (![value[first], value[second]].every(Number.isFinite)
          || Math.abs(value[first]) > maxFirst || Math.abs(value[second]) > maxSecond || (first === 'x_ratio' && (value[first] < 0 || value[second] < 0)))) bad('坐标超出范围');
      }
      value.coordinate_system ||= '';
      if (!['', 'GCJ02', 'WGS84', 'BD09'].includes(value.coordinate_system)) bad('坐标系无效');
      if (value.latitude !== null && !['GCJ02', 'WGS84', 'BD09'].includes(value.coordinate_system)) bad('实际坐标必须注明坐标系');
      if (value.map_layout && !current.maps.some((map) => map.id === value.map_layout && map.region === value.region)) bad('底图须属于所选区域');
      if (value.x_ratio !== null && !value.map_layout) bad('示意坐标须关联具体底图');
    }
  }
  return value;
}
function publicState(kind, row) {
  return !row.deleted && (kind === 'contents' ? !row.value.status || row.value.status === 'published' : kind === 'routes' ? row.value.published !== false : row.value.is_published !== false);
}
async function listPage(ctx, kind, where = {}, project = (value) => value) {
  for (const key of ['page', 'page_size']) if (ctx.query.has(key) && (!/^[1-9][0-9]{0,5}$/.test(ctx.query.get(key)) || ctx.query.getAll(key).length !== 1)) bad('分页参数无效');
  const page = Number(ctx.query.get('page') || 1), size = Number(ctx.query.get('page_size') || 20);
  if (size > 100) bad('每页最多100条');
  const count = await ctx.store.count(kind, where), total = Math.max(1, Math.ceil(count / size));
  if (page > total) fail('NOT_FOUND', '该分页不存在', 404);
  const rows = await ctx.store.list(kind, { where, limit: size, offset: (page - 1) * size, orderBy: [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'desc' }] });
  const link = (next) => { const query = new URLSearchParams(ctx.query); query.set('page', String(next)); query.set('page_size', String(size)); return '/api/v1/' + ctx.path + '?' + query; };
  return response(rows.map(project), 200, { count, page, page_size: size, total_pages: total, next: page < total ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null });
}
async function statistics(ctx) {
  const current = await catalog.loadCatalog(ctx), day = dateCN(ctx.now);
  const jobs = {};
  for (const kind of ['recognition_jobs', 'assessment_jobs']) {
    const statuses = {};
    for (const status of ['queued', 'running', 'succeeded', 'failed']) statuses[status] = await ctx.store.count(kind, { visible: true, status });
    jobs[kind] = { visible_total: Object.values(statuses).reduce((sum, value) => sum + value, 0), statuses };
  }
  const budget = await ctx.store.get('weather_gate', 'budget'), llm = await ctx.store.get('llm_days', day);
  const month = day.slice(0, 7), oldest = dateCN(new Date(Date.parse(ctx.now) - 31 * 86400000));
  return { as_of: ctx.now, timezone: 'Asia/Shanghai', counting_note: '用户仅计仍存在且启用账号；公开资料按种子与管理员覆盖合并后的发布状态；识别仅计可见记录；反馈按待处理/已处理；天气记预约次数（失败也计），AI为内部用量账本，不是供应商结算金额。查询非跨集合原子快照。',
    users_active: await ctx.store.count('users', { is_active: true }),
    public_catalog: Object.fromEntries(['regions', 'places', 'contents', 'routes', 'stations', 'water_bodies', 'simulation_runs', 'observations'].map((kind) => [kind, current[kind].length])), jobs,
    feedback: { pending: await ctx.store.count('feedback', { status: 'pending' }), resolved: await ctx.store.count('feedback', { status: 'resolved' }) },
    llm_today: { day, attempts: llm && llm.attempts || 0, accounted_tokens: llm && llm.accounted_tokens || 0, reserved_tokens: llm && llm.reserved_tokens || 0 },
    weather_budget: { month, calendar_month_requests: Object.entries(budget && budget.days || {}).filter(([key]) => key.startsWith(month)).reduce((sum, [, value]) => sum + value, 0),
      rolling_31_days_requests: Object.entries(budget && budget.days || {}).filter(([key]) => key >= oldest && key <= day).reduce((sum, [, value]) => sum + value, 0),
      environment_limit: ctx.config.qweatherMonthlyLimit || 0, note: '此环境账本；多个部署合计上限仍需统一分配，不因此新增免费额度。' } };
}
function policyValue(value = {}) {
  const retain_days = value.retain_days ?? 90, keep_successful = value.keep_successful ?? 3;
  if (!Number.isSafeInteger(retain_days) || retain_days < 30 || retain_days > 3650 || !Number.isSafeInteger(keep_successful) || keep_successful < 1 || keep_successful > 100) bad('保留天数须为30至3650，来源/场景保留批次须为1至100');
  return { retain_days, keep_successful };
}
async function cleanupPreview(ctx) {
  delete ctx._publicCatalogPromise;
  const before = await state(ctx.store), policy = policyValue(await ctx.store.get('admin_config', 'simulation_retention') || {});
  const current = await catalog.loadCatalog(ctx), cutoff = Date.parse(ctx.now) - policy.retain_days * 86400000;
  const runs = [...current.simulation_runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
  const protectedIds = new Set(), groups = new Map(), stationLatest = new Set();
  for (const run of runs) {
    const key = run.source.id + ':' + run.scenario.code;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(run);
  }
  for (const group of groups.values()) {
    group.slice(0, policy.keep_successful).forEach((run) => protectedIds.add(run.id));
    const end = Math.max(...group.map((run) => Date.parse(run.end)));
    group.filter((run) => Date.parse(run.end) === end).forEach((run) => protectedIds.add(run.id));
  }
  const observationsByRun = new Map(runs.map((run) => [run.id, current.observations.filter((row) => row.simulation_run_id === run.id)]));
  for (const run of runs) for (const row of observationsByRun.get(run.id)) {
    const key = run.source.id + ':' + run.scenario.code + ':' + row.station_id;
    if (!stationLatest.has(key)) { stationLatest.add(key); protectedIds.add(run.id); }
  }
  const candidates = [], protectedRows = [];
  for (const run of runs) {
    const rows = observationsByRun.get(run.id), recent = Math.max(Date.parse(run.created_at), Date.parse(run.end));
    let reason = null;
    if (run.source.kind !== 'simulation' || !/^demo-(normal|missing|turbidity)$/.test(run.source.code || '') || run.generator_version !== 'hourly-v1') reason = 'unsafe_source';
    else if (!Number.isFinite(recent) || recent >= cutoff) reason = 'recent';
    else if (protectedIds.has(run.id)) reason = 'latest';
    else if (!Number.isFinite(Date.parse(run.start)) || Date.parse(run.start) >= Date.parse(run.end)
      || rows.length !== run.counts || rows.some((row) => row.source_id !== run.source.id || !row.is_simulated || !Number.isFinite(Date.parse(row.observed_at))
      || Date.parse(row.observed_at) < Date.parse(run.start) || Date.parse(row.observed_at) >= Date.parse(run.end)
      || !current.stations.some((station) => station.id === row.station_id && current.regions.some((region) => region.id === station.region && region.is_demo)
        && current.metrics.some((metric) => metric.code === row.metric_code && metric.station_kind === station.kind)))) reason = 'unsafe_scope';
    const entry = { id: run.id, source: run.source.name, scenario: run.scenario.name, created_at: run.created_at, end: run.end, observation_count: rows.length };
    if (reason) protectedRows.push({ ...entry, reason }); else candidates.push(entry);
  }
  const selected = candidates.slice(-20);
  const signature = sha256(JSON.stringify({ revision: before.revision, policy, candidates, protectedRows }));
  return { revision: before.revision, policy, cutoff: new Date(cutoff).toISOString(), fingerprint: signature,
    total_eligible_count: candidates.length, selected_run_count: selected.length, selected_observation_count: selected.reduce((sum, row) => sum + row.observation_count, 0),
    has_more: candidates.length > selected.length, candidates: selected, protected: protectedRows,
    mode: 'withdraw_simulation_batches', notice: '个人版按批次写撤下标记，公开页面和AI不再读取对应观测；不删除源码内的只读快照，不回收代码包容量。每次最多20批，保留每来源/场景及每站最新批次；真实来源不可清理。' };
}

async function handle(ctx) {
  const path = ctx.path.replace(/^\//, '');
  if (!path.startsWith('personal-admin/')) return undefined;
  if (path === 'personal-admin/status/' && ctx.method === 'GET') {
    let user = null;
    if (enabled(ctx) && ctx.user && (ctx.config.management.adminUserIds || []).includes(ctx.user.id)) user = await ctx.store.get('users', ctx.user.id);
    return response({ enabled: Boolean(user && user.is_active), reason: user && user.is_active ? '' : '管理入口尚未开放或当前账号无管理权限',
      editable_kinds: user && user.is_active ? EDITABLE : [], revision: user && user.is_active ? (await state(ctx.store)).revision : null });
  }
  await authorize(ctx);
  if (path === 'personal-admin/stats/' && ctx.method === 'GET') return response(await statistics(ctx));
  if (path === 'personal-admin/audit/' && ctx.method === 'GET') {
    const where = {}; for (const key of ['action', 'kind']) if (ctx.query.has(key)) { if (!/^[-a-z_]{1,60}$/.test(ctx.query.get(key))) bad('审计筛选无效'); where[key] = ctx.query.get(key); }
    return listPage(ctx, 'admin_audit', where, (row) => Object.fromEntries(['id', 'actor_ref', 'action', 'kind', 'target_id', 'changed_fields', 'counts', 'created_at'].map((key) => [key, row[key]])));
  }
  if (path === 'personal-admin/feedback/' && ctx.method === 'GET') {
    const where = {}; if (ctx.query.has('status')) { if (!['pending', 'resolved'].includes(ctx.query.get('status'))) bad('反馈状态无效'); where.status = ctx.query.get('status'); }
    return listPage(ctx, 'feedback', where, (row) => Object.fromEntries(['id', 'body', 'status', 'reply', 'created_at', 'resolved_at'].map((key) => [key, row[key]])));
  }
  const feedback = /^personal-admin\/feedback\/([^/]+)\/resolve\/$/.exec(path);
  if (feedback && ctx.method === 'POST') {
    if (!catalog.UUID.test(feedback[1])) bad('反馈ID无效');
    const body = strictBody(ctx.body, ['reply', 'expected_revision']), reply = text(body.reply, '处理答复', 1000, true);
    const result = await mutate(ctx, expected(body), async (tx, actor) => {
      const row = await tx.get('feedback', feedback[1]); if (!row) fail('NOT_FOUND', '反馈不存在', 404);
      await tx.update('feedback', row.id, { status: 'resolved', reply, resolved_at: ctx.now });
      await audit(tx, ctx, actor, 'feedback_resolved', 'feedback', row.id, ['reply', 'status', 'resolved_at']);
      return { id: row.id, status: 'resolved', resolved_at: ctx.now };
    }); return response(result);
  }
  if (path === 'personal-admin/simulation/retention/') {
    if (ctx.method === 'GET') {
      const snapshot = await checkedRead(ctx, async () => policyValue(await ctx.store.get('admin_config', 'simulation_retention') || {}));
      return response({ ...snapshot.value, revision: snapshot.revision });
    }
    if (ctx.method === 'PUT') {
      const body = strictBody(ctx.body, ['retain_days', 'keep_successful', 'expected_revision']), policy = policyValue(body);
      return response(await mutate(ctx, expected(body), async (tx, actor) => {
        await tx.set('admin_config', 'simulation_retention', { id: 'simulation_retention', ...policy, updated_at: ctx.now });
        await audit(tx, ctx, actor, 'retention_updated', 'simulation', '', ['retain_days', 'keep_successful']); return policy;
      }));
    }
  }
  if (path === 'personal-admin/simulation/cleanup-preview/' && ctx.method === 'GET') return response(await cleanupPreview(ctx));
  if (path === 'personal-admin/simulation/cleanup/' && ctx.method === 'POST') {
    const body = strictBody(ctx.body, ['fingerprint', 'expected_revision']), revision = expected(body), preview = await cleanupPreview(ctx);
    if (typeof body.fingerprint !== 'string' || body.fingerprint !== preview.fingerprint || revision !== preview.revision) fail('PREVIEW_CHANGED', '清理范围或保留策略已变化，请重新预览');
    return response(await mutate(ctx, revision, async (tx, actor) => {
      for (const row of preview.candidates) await tx.set('catalog', 'simulation_runs_' + row.id, { id: 'simulation_runs_' + row.id, kind: 'simulation_runs', deleted: true, updated_at: ctx.now });
      await audit(tx, ctx, actor, 'simulation_withdrawn', 'simulation', '', [], { runs: preview.selected_run_count, observations: preview.selected_observation_count });
      return { withdrawn_runs: preview.selected_run_count, hidden_observations: preview.selected_observation_count, has_more: preview.has_more,
        mode: preview.mode, notice: preview.notice };
    }));
  }
  const match = /^personal-admin\/catalog\/([a-z_]+)\/(?:([^/]+)\/)?$/.exec(path);
  if (match && EDITABLE.includes(match[1])) {
    const kind = match[1], id = match[2];
    if (id && !catalog.UUID.test(id)) bad('资料ID无效');
    const snapshot = ctx.method === 'GET' ? await checkedRead(ctx, () => rawEntries(ctx, kind)) : null;
    const rows = snapshot ? snapshot.value : await rawEntries(ctx, kind), existing = id && rows.find((row) => row.id === id);
    if (id && !existing) fail('NOT_FOUND', '资料不存在', 404);
    if (ctx.method === 'GET') {
      const revision = snapshot.revision;
      if (id) return response({ ...existing, published: publicState(kind, existing), revision });
      const result = paginate(ctx, rows.map((row) => ({ id: row.id, title: row.value.title || row.value.name || '', slug: row.value.slug,
        deleted: row.deleted, published: publicState(kind, row), category: row.value.category || '', updated_at: row.value.updated_at || row.value._updated_at || null })));
      result.data.meta.revision = revision; return result;
    }
    if (existing && existing.value._community_submission === true && ['PUT', 'PATCH', 'DELETE'].includes(ctx.method)) fail('COMMUNITY_REVIEW_REQUIRED', '用户投稿请到投稿审核页处理，不能绕过内容检查修改公开正文');
    if ((!id && ctx.method === 'POST') || (id && ['PUT', 'PATCH'].includes(ctx.method))) {
      const body = strictBody(ctx.body, ['value', 'publish', 'expected_revision']);
      if (own(body, 'publish') && typeof body.publish !== 'boolean') bad('publish必须为布尔值');
      const revision = expected(body), current = await catalog.loadCatalog(ctx), nextId = id || uuid();
      const value = validateValue(kind, existing && existing.value, body.value || {}, body.publish, current, ctx.now, nextId);
      if (rows.some((row) => row.id !== nextId && row.value.slug === value.slug)) bad('该slug已被使用');
      if (!id && await ctx.store.count('catalog') >= 4900) fail('CATALOG_LIMIT', '资料覆盖条目已达上限，请先整理', 429);
      return response(await mutate(ctx, revision, async (tx, actor) => {
        const entry = { id: kind + '_' + nextId, kind, value, deleted: false, updated_at: ctx.now };
        await tx.set('catalog', entry.id, entry);
        await audit(tx, ctx, actor, id ? 'catalog_updated' : 'catalog_created', kind, nextId, [...Object.keys(body.value || {}), ...(own(body, 'publish') ? ['published'] : [])]);
        return { id: nextId, value, published: publicState(kind, { value }), deleted: false };
      }), id ? 200 : 201);
    }
    if (id && ctx.method === 'DELETE') {
      const body = strictBody(ctx.body, ['expected_revision']);
      return response(await mutate(ctx, expected(body), async (tx, actor) => {
        await tx.set('catalog', kind + '_' + id, { id: kind + '_' + id, kind, value: existing.value, deleted: true, updated_at: ctx.now });
        await audit(tx, ctx, actor, 'catalog_withdrawn', kind, id, ['deleted']); return { id, deleted: true };
      }));
    }
  }
  throw new ApiError('METHOD_NOT_ALLOWED', '此管理路径或方法暂不支持', 405);
}

module.exports = { handle, cleanupPreview, policyValue, EDITABLE };
