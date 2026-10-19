"use strict";
const { ApiError, response, dateCN } = require("./vendor/lib/core");
const { UUID, loadCatalog } = require("./vendor/lib/catalog");
const { deterministicId } = require("./vendor/lib/activity");
const { active, location, query } = require("./events.cjs");
const management = require("./vendor/lib/management");
const KINDS = { recognition: "recognition_jobs", assessment: "assessment_jobs" };
const NOTICE = "模拟环境反馈，仅进入本平台管理员的私密工作队列，未向政府部门或外部机构发送。照片与描述仅为用户观察，花卉分类和漂浮物候选框不能鉴定水质或污染。";
const missing = () => { throw new ApiError("NOT_FOUND", "记录不存在、已删除或已过期", 404); };
const bad = message => { throw new ApiError("VALIDATION_ERROR", message || "环境反馈参数无效", 400); };
function text(value, length) {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > length || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) bad(`请填写1至${length}字的可见情况描述`);
  return value.trim();
}
function strict(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) bad();
  return value;
}
async function adminActor(ctx, tx = ctx.store) {
  const user = await active(ctx, tx);
  if (user.role !== "admin") throw new ApiError("FORBIDDEN", "仅管理员可查看或回复环境反馈", 403);
  await management.authorize(ctx, tx);
  return user;
}
async function task(ctx, kind, id, tx = ctx.store, ownerId = ctx.user.id) {
  if (typeof kind !== "string" || !Object.hasOwn(KINDS, kind) || typeof id !== "string" || !UUID.test(id)) bad();
  const row = await tx.get(KINDS[kind], id), now = Date.parse(ctx.now);
  if (!row || row.owner_id !== ownerId || row.visible === false || row.status !== "succeeded" || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) missing();
  if ((kind === "recognition" ? row.result?.reason : row.reason) === "LOW_IMAGE_QUALITY") throw new ApiError("SOURCE_IMAGE_UNCLEAR", "原图质量不足，请重新拍摄并完成识别后反馈", 409);
  const asset = await tx.get("assets", row.asset_id);
  if (!asset || asset.owner_id !== ownerId || asset.purpose !== "recognition" || asset.deleted || asset.deleting || asset.status === "deleted" || !asset.thumbnail_file_id || !Number.isFinite(Date.parse(asset.expires_at)) || Date.parse(asset.expires_at) <= now) missing();
  return { row, asset };
}
function summary(row, kind) {
  if (kind === "recognition") {
    const top = row.result && Array.isArray(row.result.candidates) && row.result.candidates[0];
    return row.result?.decision === "recognized" && top ? "花卉模型候选：" + String(top.name || top.label || "未知类别").slice(0, 80) + "；分类结果不能说明环境或水质状况。" : "花卉模型未能确认类别；请仅描述照片中可见情况。";
  }
  return "河道图片候选框：" + (Array.isArray(row.detections) ? row.detections.length : 0) + " 个，需人工核对；不代表污染判定或水质等级。";
}
function present(row) {
  return Object.fromEntries(["id", "task_kind", "task_id", "description", "location", "observation", "simulated", "delivery_mode", "status", "reply", "created_at", "resolved_at"].map(key => [key, row[key] ?? null]).concat([
    ["notice", NOTICE], ["government_sent", false], ["photo_url", "/api/v1/environment-reports/" + row.id + "/photo/"], ["photo_notice", "仅共享原识别记录的缩略图引用；删除原识别记录或图片到期后不再可见。"],
  ]));
}
async function taskLocation(ctx, row) {
  if (row.place_id || row.map_reference_id) return location(ctx, row);
  if (!row.water_body?.id) return null;
  const data = await loadCatalog(ctx), water = data.water_bodies.find(item => item.id === row.water_body.id);
  const place = water && data.places.find(item => item.id === water._place_id || item.water_body_id === water.id);
  return place ? location(ctx, { place_id: place.id }) : null;
}
async function readPhoto(ctx, id) {
  if (!UUID.test(id)) missing();
  const viewer = await active(ctx), report = await ctx.store.get("environment_reports", id); if (!report) missing();
  if (report.owner_id !== viewer.id) await adminActor(ctx);
  const owner = await ctx.store.get("users", report.owner_id); if (!owner || owner.is_active !== true || owner.deleting) missing();
  const { row } = await task(ctx, report.task_kind, report.task_id, ctx.store, owner.id);
  if (row.asset_id !== report.asset_id) missing();
  const result = await ctx.storage.readAsset(owner, row.asset_id, { variant: "thumbnail" });
  // Recheck all authority after storage I/O, including deletion racing downloads.
  const fresh = await ctx.store.get("environment_reports", id);
  if (!fresh || fresh.owner_id !== report.owner_id || fresh.asset_id !== report.asset_id) missing();
  if (report.owner_id !== viewer.id) await adminActor(ctx); else await active(ctx);
  const freshOwner = await ctx.store.get("users", report.owner_id); if (!freshOwner || freshOwner.is_active !== true || freshOwner.deleting) missing();
  await task(ctx, report.task_kind, report.task_id, ctx.store, owner.id);
  return { statusCode: 200, binary: result.bytes, contentType: result.mime_type };
}
async function handle(ctx) {
  const path = ctx.path.replace(/^\//, ""), admin = path.startsWith("personal-admin/environment-reports/");
  if (!admin && !path.startsWith("environment-reports/")) return undefined;
  await active(ctx); if (admin) await adminActor(ctx);
  if (path === "environment-reports/context/" && ctx.method === "GET") {
    const q = query(ctx, ["task_kind", "task_id"]), kind = q.get("task_kind"), id = q.get("task_id");
    const { row, asset } = await task(ctx, kind, id), target = await taskLocation(ctx, row);
    const existing = await ctx.store.get("environment_reports", deterministicId("environment:" + ctx.user.id + ":" + kind + ":" + id));
    return response({ task_kind: kind, task_id: id, observation: summary(row, kind), photo_url: "/api/v1/uploads/" + asset.id + "/content/?variant=thumbnail",
      location_hint: target?.name || "", location: target, notice: NOTICE, existing_report: existing ? present(existing) : null });
  }
  if ((path === "environment-reports/" || path === "personal-admin/environment-reports/") && ctx.method === "GET") {
    const q = query(ctx, ["page", "page_size", "status"]), where = admin ? {} : { owner_id: ctx.user.id };
    if (q.has("status")) { if (!["pending", "resolved"].includes(q.get("status"))) bad(); where.status = q.get("status"); }
    return management.listPage(ctx, "environment_reports", where, present);
  }
  query(ctx, []);
  const photo = /^environment-reports\/([^/]+)\/photo\/$/.exec(path);
  if (photo && ctx.method === "GET") return readPhoto(ctx, photo[1]);
  if (path === "environment-reports/" && ctx.method === "POST") {
    const b = strict(ctx.body, ["task_kind", "task_id", "description", "place_id", "map_reference_id"]), description = text(b.description, 1000);
    if (typeof b.task_kind !== "string" || !Object.hasOwn(KINDS, b.task_kind) || typeof b.task_id !== "string" || !UUID.test(b.task_id)) bad();
    const id = deterministicId("environment:" + ctx.user.id + ":" + b.task_kind + ":" + b.task_id);
    const outcome = await ctx.store.transaction(async tx => {
      const owner = await active(ctx, tx), source = await task(ctx, b.task_kind, b.task_id, tx);
      const freshCtx = { ...ctx, store: tx, _publicCatalogPromise: null };
      const target = await location(freshCtx, b) || await taskLocation(freshCtx, source.row);
      if (!target) bad("请选择目录中的具体地点后提交，照片位置不会自动推断");
      const old = await tx.get("environment_reports", id);
      if (old) {
        if (old.description !== description || old.location.place_id !== target.place_id || old.location.map_reference_id !== target.map_reference_id) throw new ApiError("REPORT_EXISTS", "此识别记录已提交反馈，请查看已有记录", 409);
        return { row: old, created: false };
      }
      const day = dateCN(ctx.now), dailyCount = owner.environment_report_day === day ? Number(owner.environment_report_day_count) || 0 : 0;
      if (dailyCount >= 10) throw new ApiError("RATE_LIMITED", "今日环境反馈已达10条，请明天再试", 429);
      if (await tx.count("environment_reports", { owner_id: owner.id }) >= 100) throw new ApiError("STORAGE_QUOTA", "环境反馈最多保留100条，请先删除旧记录", 429);
      const row = { id, owner_id: owner.id, task_kind: b.task_kind, task_id: source.row.id, asset_id: source.asset.id, description,
        location: target, observation: summary(source.row, b.task_kind), simulated: true, delivery_mode: "platform_admin_simulation", government_sent: false,
        status: "pending", reply: "", created_at: ctx.now, resolved_at: null };
      await tx.create("environment_reports", id, row);
      await tx.update("users", owner.id, { environment_report_day: day, environment_report_day_count: dailyCount + 1, record_revision: (owner.record_revision || 0) + 1 });
      return { row, created: true };
    });
    return response(present(outcome.row), outcome.created ? 201 : 200);
  }
  const remove = /^environment-reports\/([^/]+)\/$/.exec(path);
  if (remove && ctx.method === "DELETE") {
    strict(ctx.body || {}, []); if (!UUID.test(remove[1])) missing();
    await ctx.store.transaction(async tx => {
      const user = await active(ctx, tx), row = await tx.get("environment_reports", remove[1]); if (!row || row.owner_id !== user.id) missing();
      await tx.remove("environment_reports", row.id);
      await tx.update("users", user.id, { record_revision: (user.record_revision || 0) + 1 });
    }); return response(null, 204);
  }
  const resolve = /^personal-admin\/environment-reports\/([^/]+)\/resolve\/$/.exec(path);
  if (resolve && ctx.method === "POST") {
    if (!UUID.test(resolve[1])) missing();
    const b = strict(ctx.body, ["reply", "expected_revision"]), reply = text(b.reply, 1000);
    if (!Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0) bad();
    const result = await management.mutate(ctx, b.expected_revision, async (tx, actor) => {
      await adminActor(ctx, tx);
      const row = await tx.get("environment_reports", resolve[1]); if (!row) missing();
      const owner = await tx.get("users", row.owner_id); if (!owner || owner.is_active !== true || owner.deleting) missing();
      if (row.status !== "pending") throw new ApiError("REPORT_RESOLVED", "此反馈已经回复，请刷新查看", 409);
      const patch = { reply, status: "resolved", resolved_at: ctx.now }; await tx.update("environment_reports", row.id, patch);
      await management.audit(tx, ctx, actor, "environment_report_resolved", "environment_reports", row.id, ["reply", "status", "resolved_at"]);
      return present({ ...row, ...patch });
    }); return response(result);
  }
  throw new ApiError("METHOD_NOT_ALLOWED", "不支持此环境反馈操作", 405);
}
module.exports = { handle, readPhoto, NOTICE, task };
