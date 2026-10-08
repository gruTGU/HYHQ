"use strict";
// IP addresses identify only a daily allowance. Random cookie owners identify
// private data; neither a browser-supplied owner nor an IP can select that data.
const crypto = require("node:crypto");
const { ApiError, response, sha256, uuid, dateCN } = require("./vendor/lib/core");
const DAY = 86400000, TTL = 7 * DAY, LIMIT = 5;
const COOKIE = "hyhq_guest";
function allowed(ctx) {
  const p = String(ctx.path || "").replace(/^\/+/, ""), m = ctx.method;
  return p === "web/guest-session/" && ["GET", "POST"].includes(m)
    || p === "web/uploads/" && m === "POST"
    || /^uploads\/[a-f0-9-]{36}\/content\/$/.test(p) && m === "GET"
    || /^(recognition|assessment)-jobs\/(?:[a-f0-9-]{36}\/)?$/.test(p) && ["GET", "POST", "DELETE"].includes(m)
    || p === "llm/status/" && m === "GET"
    || p === "llm/sessions/" && ["GET", "POST"].includes(m)
    || /^llm\/sessions\/[a-f0-9-]{36}\/$/.test(p) && ["GET", "DELETE"].includes(m)
    || /^llm\/sessions\/[a-f0-9-]{36}\/turns\/$/.test(p) && ["GET", "POST"].includes(m)
    || /^llm\/turns\/[a-f0-9-]{36}\/$/.test(p) && m === "GET";
}
function cookie(token, expire = false) {
  const secure = /^(1|true|yes)$/i.test(process.env.HYHQ_COOKIE_SECURE || "");
  return `${COOKIE}=${expire ? "" : token}; Path=/api/; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Max-Age=${expire ? 0 : TTL / 1000}`;
}
function setCookie(res, value) {
  const previous = res.getHeader && res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
}
function bucketFor(ctx, req) {
  const secret = ctx.config.guestHmacSecret || ctx.config.sessionSecret;
  if (typeof secret !== "string" || secret.length < 16)
    throw new ApiError("GUEST_CONFIG_INVALID", "游客服务尚未配置完成", 503);
  const ip = require("./request-security.cjs").clientIp(req);
  if (!ip || ip === "unknown") throw new ApiError("GUEST_ADDRESS_UNAVAILABLE", "暂时无法确认游客额度，请稍后重试", 503);
  return crypto.createHmac("sha256", secret).update("hyhq-guest-quota-v1\0" + ip).digest("hex");
}
function tokenFrom(header) {
  const tokens = String(header || "").split(";").map(x => x.trim()).filter(x => x.startsWith(COOKIE + "="));
  return tokens.length === 1 && /^[a-f0-9]{64}$/.test(tokens[0].slice(COOKIE.length + 1)) ? tokens[0].slice(COOKIE.length + 1) : null;
}
async function attach(ctx, req, res, { create = false } = {}) {
  if (ctx.user || !allowed(ctx)) return false;
  if (ctx.path === "web/uploads/" && ctx.body.purpose !== "recognition")
    throw new ApiError("NOT_AUTHENTICATED", "头像及其他私人资料需要登录", 401);
  let token = tokenFrom(req.headers.cookie), session = token && await ctx.store.get("guest_sessions", sha256(token));
  let user = session && await ctx.store.get("users", session.owner_id);
  const now = Date.parse(ctx.now);
  if (!session || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= now || !user || user.is_active !== true || user.auth_kind !== "guest") {
    if (!create) return false;
    const bucket = bucketFor(ctx, req); // Fail closed before creating any state.
    await require('./request-security.cjs').consumeRateLimit(ctx, req, { scope: 'guest_start', limit: 30, windowMs: 15 * 60000 });
    token = crypto.randomBytes(32).toString("hex");
    user = { id: uuid(), auth_kind: "guest", role: "guest", nickname: "游客", is_active: true,
      quota_key: sha256("guest-owner:" + token), avatar_id: null, record_history: false,
      record_revision: 0, created_at: ctx.now, expires_at: new Date(now + TTL).toISOString() };
    session = { owner_id: user.id, created_at: ctx.now, expires_at: user.expires_at };
    await ctx.store.transaction(async tx => {
      await tx.create("users", user.id, user);
      await tx.create("guest_sessions", sha256(token), session);
    });
    setCookie(res, cookie(token));
    ctx.guest = { bucket_key: bucket, expires_at: session.expires_at };
  } else ctx.guest = { bucket_key: bucketFor(ctx, req), expires_at: session.expires_at };
  ctx.user = user;
  ctx.identityKey = user.quota_key;
  return true;
}
function quotaIdentity(ctx, user = ctx.user) {
  if (user && user.auth_kind === "guest") {
    if (!ctx.guest || !/^[a-f0-9]{64}$/.test(ctx.guest.bucket_key || ""))
      throw new ApiError("NOT_AUTHENTICATED", "游客会话已失效，请重新进入", 401);
    return ctx.guest.bucket_key;
  }
  return user && (user.quota_key || user.id);
}
function daySummary(row, day) {
  const used = row && row.succeeded || 0, reserved = row && row.reserved || 0;
  return { date: day, limit: LIMIT, used, reserved, remaining: Math.max(0, LIMIT - used - reserved),
    reset_at: new Date(Date.parse(day + "T00:00:00+08:00") + DAY).toISOString() };
}
async function quotas(ctx) {
  const day = dateCN(ctx.now), identity = quotaIdentity(ctx), llm = require("./vendor/lib/llm");
  const recognition = daySummary(await ctx.store.get("guest_inference_days", sha256(identity + ":recognition:" + day)), day);
  const ai = {};
  for (const scope of ["home", "explore", "learn", "recognition"])
    ai[scope] = daySummary(await ctx.store.get("llm_quotas", llm.quotaId(identity, scope, day)), day);
  return { recognition, ai, reset_timezone: "Asia/Shanghai", shared_by: "public_ip" };
}
async function handle(ctx, req, res) {
  if (ctx.path !== "web/guest-session/" || !["POST", "GET"].includes(ctx.method)) return;
  if (!ctx.user) await attach(ctx, req, res, { create: ctx.method === "POST" });
  if (!ctx.user) throw new ApiError("NOT_AUTHENTICATED", "请先开始游客体验", 401);
  if (ctx.user.auth_kind !== "guest") return response({ id: ctx.user.id, auth_kind: "local" });
  return response({ id: ctx.user.id, auth_kind: "guest", expires_at: ctx.guest.expires_at, quotas: await quotas(ctx) });
}
async function reserveRecognition(tx, ctx, job) {
  if (ctx.user.auth_kind !== "guest") return;
  const day = dateCN(ctx.now), id = sha256(quotaIdentity(ctx) + ":recognition:" + day);
  const row = await tx.get("guest_inference_days", id) || { day, succeeded: 0, reserved: 0 };
  if (![row.succeeded, row.reserved].every(x => Number.isInteger(x) && x >= 0))
    throw new ApiError("GUEST_QUOTA_INVALID", "游客额度状态异常", 503);
  if (row.succeeded + row.reserved >= LIMIT)
    throw new ApiError("GUEST_RECOGNITION_LIMIT", "同一公网 IP 今日的花卉和河道识别共 5 次已用完，北京时间零点重置", 429);
  job.guest_quota_id = id;
  job.guest_quota_state = "reserved";
  await tx.set("guest_inference_days", id, { ...row, reserved: row.reserved + 1 });
}
async function settleRecognition(tx, job, success) {
  if (!job.guest_quota_id || job.guest_quota_state !== "reserved") return;
  const row = await tx.get("guest_inference_days", job.guest_quota_id);
  if (!row || !Number.isInteger(row.reserved) || row.reserved < 1)
    throw new ApiError("GUEST_QUOTA_INVALID", "游客额度状态异常", 503);
  await tx.set("guest_inference_days", job.guest_quota_id, { ...row,
    reserved: row.reserved - 1, succeeded: row.succeeded + (success ? 1 : 0) });
  job.guest_quota_state = success ? "succeeded" : "released";
}
async function cleanup(ctx, limit = 10) {
  // Small scheduled batches remove expired temporary owners/private records.
  // Shared IP quotas and provider ledgers deliberately survive cookie deletion.
  const rows = await ctx.store.list('guest_sessions', { limit: Math.min(20, Math.max(1, limit)), orderBy: [{ field: 'expires_at', direction: 'asc' }] });
  let removed = 0;
  for (const row of rows) {
    if (Date.parse(row.expires_at) > Date.parse(ctx.now)) continue;
    const user = await ctx.store.get('users', row.owner_id);
    if (user && user.auth_kind === 'guest') {
      await ctx.store.transaction(async tx => {
        await tx.update('users', user.id, { is_active: false, deleting: true });
        for (const kind of ['recognition_jobs', 'assessment_jobs']) {
          for (let offset = 0;; offset += 100) {
            const jobs = await tx.list(kind, { where: { owner_id: user.id }, limit: 100, offset });
            for (const job of jobs) { await settleRecognition(tx, job, false); await tx.set(kind, job.id, job); }
            if (jobs.length < 100) break;
          }
        }
      });
      await require('./vendor/lib/accounts').purgeAccount(ctx, user);
    }
    await ctx.store.remove('guest_sessions', row.id); removed++;
  }
  return { removed };
}
module.exports = { allowed, attach, handle, cookie, bucketFor, quotaIdentity, quotas, reserveRecognition, settleRecognition, cleanup, LIMIT };
