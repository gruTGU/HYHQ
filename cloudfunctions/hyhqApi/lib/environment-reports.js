'use strict';
const { ApiError, response, requireUser, sha256, dateCN } = require('./core');
const { UUID } = require('./catalog');
const { deterministicId } = require('./activity');
const { active, location } = require('./events');
const management = require('./management');
const KINDS = { recognition: 'recognition_jobs', assessment: 'assessment_jobs' };
const NOTICE = '模拟环境上报，仅进入本平台管理员工作队列，未发送政府部门或外部机构。照片是用户观察，识别结果不是污染或水质鉴定。';
const missing = () => { throw new ApiError('NOT_FOUND', '记录不存在、已删除或已过期', 404); };
const bad = message => { throw new ApiError('VALIDATION_ERROR', message || '环境反馈参数无效', 400); };
function text(value, length, required = true) { if (typeof value !== 'string' || (required && !value.trim()) || Array.from(value.trim()).length > length) bad(); return value.trim(); }
function strict(value, fields) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) bad(); return value; }
async function task(ctx, kind, id, tx = ctx.store, ownerId = requireUser(ctx).id) {
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, kind) || typeof id !== 'string' || !UUID.test(id)) bad();
  const row = await tx.get(KINDS[kind], id);
  if (!row || row.owner_id !== ownerId || row.visible === false || row.status !== 'succeeded' || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(ctx.now)) missing();
  if (row.reason === 'LOW_IMAGE_QUALITY' || row.result && row.result.reason === 'LOW_IMAGE_QUALITY') throw new ApiError('PHOTO_UNSUITABLE', '照片质量不足，请重新上传清晰图片后反馈。', 409);
  const asset = await tx.get('assets', row.asset_id);
  if (!asset || asset.owner_id !== ownerId || asset.purpose !== 'recognition' || asset.deleted || asset.deleting || asset.status === 'deleted' || !asset.thumbnail_file_id || !Number.isFinite(Date.parse(asset.expires_at)) || Date.parse(asset.expires_at) <= Date.parse(ctx.now)) missing();
  return { row, asset };
}
function summary(row, kind) {
  if (kind === 'recognition') { const top = row.result && Array.isArray(row.result.candidates) && row.result.candidates[0]; return top ? '花卉模型候选：' + String(top.name || top.label || '未知类别').slice(0, 80) : '花卉识别未能确认类别'; }
  return '河道图片候选框：' + (Array.isArray(row.detections) ? row.detections.length : 0) + ' 个；需人工核对。';
}
function present(row) {
  return Object.fromEntries(['id', 'task_kind', 'task_id', 'description', 'location', 'observation', 'simulated', 'delivery_mode', 'status', 'reply', 'created_at', 'resolved_at'].map(key => [key, row[key] ?? null]).concat([
    ['notice', NOTICE], ['photo_url', '/api/v1/environment-reports/' + row.id + '/photo/'], ['photo_notice', '仅共享原识别记录的缩略图引用；删除识别记录或图片到期后不再可见。'],
  ]));
}
async function readPhoto(ctx, id) {
  if (!UUID.test(id)) missing();
  const viewer = await active(ctx), report = await ctx.store.get('environment_reports', id); if (!report) missing();
  if (report.owner_id !== viewer.id) await management.authorize(ctx);
  const owner = await ctx.store.get('users', report.owner_id); if (!owner || !owner.is_active || owner.deleting) missing();
  const { row } = await task(ctx, report.task_kind, report.task_id, ctx.store, owner.id);
  if (row.asset_id !== report.asset_id) missing();
  const result = await ctx.storage.readAsset(owner, row.asset_id, { variant: 'thumbnail' });
  // Recheck report visibility and administrator authority after storage I/O.
  if (!await ctx.store.get('environment_reports', id)) missing();
  if (report.owner_id !== viewer.id) await management.authorize(ctx); else await active(ctx);
  await task(ctx, report.task_kind, report.task_id, ctx.store, owner.id);
  return result;
}
async function handle(ctx) {
  const path = ctx.path.replace(/^\//, ''), admin = path.startsWith('personal-admin/environment-reports/');
  if (!admin && !path.startsWith('environment-reports/')) return undefined;
  await active(ctx); if (admin) await management.authorize(ctx);
  if (path === 'environment-reports/context/' && ctx.method === 'GET') {
    const q = ctx.query || new URLSearchParams();
    if ([...q.keys()].some(key => !['task_kind', 'task_id'].includes(key) || q.getAll(key).length !== 1)) bad();
    const kind = q.get('task_kind'), id = q.get('task_id'), { row, asset } = await task(ctx, kind, id);
    const existing = await ctx.store.get('environment_reports', deterministicId('environment:' + ctx.user.id + ':' + kind + ':' + id));
    return response({ task_kind: kind, task_id: id, observation: summary(row, kind), photo_url: '/api/v1/uploads/' + asset.id + '/content/?variant=thumbnail',
      location_hint: row.water_body && row.water_body.name || '', notice: NOTICE, existing_report: existing ? present(existing) : null });
  }
  if ((path === 'environment-reports/' || path === 'personal-admin/environment-reports/') && ctx.method === 'GET') {
    if ([...(ctx.query || new URLSearchParams()).keys()].some(key => !['page', 'page_size'].includes(key))) bad();
    return management.listPage(ctx, 'environment_reports', admin ? {} : { owner_id: ctx.user.id }, present);
  }
  if (path === 'environment-reports/' && ctx.method === 'POST') {
    if ((ctx.query || new URLSearchParams()).size) bad();
    const b = strict(ctx.body, ['task_kind', 'task_id', 'description', 'location_text', 'place_id', 'map_reference_id']);
    const description = text(b.description, 1000), target = await location(ctx, b), locationText = target ? target.name : text(b.location_text, 120);
    const reportLocation = target || { name: locationText, place_id: '', map_reference_id: '', user_supplied: true };
    const fingerprint = sha256(JSON.stringify({ task_kind: b.task_kind, task_id: b.task_id, description, location: reportLocation }));
    const id = deterministicId('environment:' + ctx.user.id + ':' + b.task_kind + ':' + b.task_id);
    const row = await ctx.store.transaction(async tx => {
      const owner = await active(ctx, tx), source = await task(ctx, b.task_kind, b.task_id, tx), old = await tx.get('environment_reports', id);
      if (old) { if (old.fingerprint !== fingerprint) throw new ApiError('REPORT_ALREADY_EXISTS', '这张识别照片已有不同内容的反馈，请先查看现有记录；不会覆盖或重复创建。', 409); return old; }
      const day = dateCN(ctx.now), dailyCount = owner.environment_report_day === day ? Number(owner.environment_report_daily_count) || 0 : 0;
      if (dailyCount >= 10) throw new ApiError('ENVIRONMENT_REPORT_LIMIT', '今日模拟环境反馈次数已用完，请明天再试。', 429);
      if ((Number(owner.environment_report_count) || 0) >= 100) throw new ApiError('STORAGE_QUOTA', '环境反馈最多保留100条，请先删除旧记录', 429);
      const row = { id, owner_id: owner.id, task_kind: b.task_kind, task_id: source.row.id, asset_id: source.asset.id, description,
        location: reportLocation, fingerprint, observation: summary(source.row, b.task_kind),
        simulated: true, delivery_mode: 'platform_admin_simulation', status: 'pending', reply: '', created_at: ctx.now, resolved_at: null };
      await tx.create('environment_reports', id, row);
      await tx.update('users', owner.id, { environment_report_day: day, environment_report_daily_count: dailyCount + 1, environment_report_count: (Number(owner.environment_report_count) || 0) + 1, record_revision: (owner.record_revision || 0) + 1 });
      return row;
    }); return response(present(row), 201);
  }
  const remove = /^environment-reports\/([^/]+)\/$/.exec(path);
  if (remove && ctx.method === 'DELETE') {
    if (!UUID.test(remove[1])) missing();
    await ctx.store.transaction(async tx => {
      const user = await active(ctx, tx), row = await tx.get('environment_reports', remove[1]); if (!row || row.owner_id !== user.id) missing();
      await tx.remove('environment_reports', row.id);
      await tx.update('users', user.id, { environment_report_count: Math.max(0, (Number(user.environment_report_count) || 0) - 1), record_revision: (user.record_revision || 0) + 1 });
    }); return response(null, 204);
  }
  const resolve = /^personal-admin\/environment-reports\/([^/]+)\/resolve\/$/.exec(path);
  if (resolve && ctx.method === 'POST') {
    if (!UUID.test(resolve[1])) missing();
    const b = strict(ctx.body, ['reply', 'expected_revision']), reply = text(b.reply, 1000);
    if (!Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0) bad();
    const result = await management.mutate(ctx, b.expected_revision, async (tx, actor) => {
      const row = await tx.get('environment_reports', resolve[1]); if (!row) missing();
      if (row.status === 'resolved' && row.reply === reply) throw new ApiError('REPLY_UNCHANGED', '此答复已保存，无需重复处理。', 409);
      const patch = { reply, status: 'resolved', resolved_at: ctx.now }; await tx.update('environment_reports', row.id, patch);
      await management.audit(tx, ctx, actor, 'environment_report_resolved', 'environment_reports', row.id, ['reply', 'status', 'resolved_at']);
      return present({ ...row, ...patch });
    }); return response(result);
  }
  throw new ApiError('METHOD_NOT_ALLOWED', '不支持此环境反馈操作', 405);
}
module.exports = { handle, readPhoto, NOTICE, task };
