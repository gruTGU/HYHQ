"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { consumeRateLimit } = require("./request-security.cjs");
const { verifyAndConsume } = require("./captcha.cjs");
const {
  ApiError,
  response,
  requireUser,
  uuid,
  sha256,
} = require("./vendor/lib/core");
const scrypt = promisify(crypto.scrypt),
  VERSION = "2026-10-07",
  TTL = 7 * 86400000;
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.@+-]{2,99}$/;
function identifier(body) {
  const v = body.email ?? body.username;
  if (typeof v !== "string" || !USERNAME.test(v.trim()))
    throw new ApiError(
      "VALIDATION_ERROR",
      "账号须为 3 至 100 位字母、数字或邮箱",
    );
  return v.trim().toLowerCase();
}
function checkPassword(v) {
  if (
    typeof v !== "string" ||
    v.length < 1 ||
    v.length > 128 ||
    Buffer.byteLength(v) > 512
  )
    throw new ApiError("VALIDATION_ERROR", "密码须为 1 至 128 个字符");
}
async function passwordHash(
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  return {
    salt,
    hash: (
      await scrypt(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      })
    ).toString("hex"),
  };
}
function publicUser(user) {
  return {
    ...require("./vendor/lib/accounts").publicUser(user),
    auth_kind: "local",
    email: user.email || user.username || "",
    username: user.username || "",
    role: user.role === "admin" ? "admin" : "user",
  };
}
function cookie(token, expire = false) {
  const secure = /^(?:1|true|yes)$/i.test(process.env.HYHQ_COOKIE_SECURE || "");
  return `hyhq_session=${expire ? "" : token}; Path=/api/; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Max-Age=${expire ? 0 : TTL / 1000}`;
}
async function authenticate(ctx, header = "") {
  const pieces = String(header)
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("hyhq_session="));
  if (!pieces.length) return;
  if (pieces.length !== 1)
    throw new ApiError("AUTH_REQUIRED", "登录已过期，请重新登录", 401);
  const token = pieces[0].slice(13);
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new ApiError("AUTH_REQUIRED", "登录已过期，请重新登录", 401);
  const tokenHash = sha256(token),
    session = await ctx.store.get("sessions", tokenHash);
  if (
    !session ||
    !Number.isFinite(Date.parse(session.expires_at)) ||
    Date.parse(session.expires_at) <= Date.parse(ctx.now)
  )
    throw new ApiError("AUTH_REQUIRED", "登录已过期，请重新登录", 401);
  const user = await ctx.store.get("users", session.owner_id);
  if (
    !user ||
    user.is_active !== true ||
    session.identity_key !== user.quota_key
  )
    throw new ApiError("AUTH_REQUIRED", "账号不可用，请重新登录", 401);
  ctx.user = user;
  ctx.identityKey = user.quota_key;
  ctx.session = { ...session, token_hash: tokenHash };
}
async function accountRecord(
  store,
  body,
  { admin = false, now = new Date().toISOString() } = {},
) {
  const username = identifier(body);
  checkPassword(body.password);
  const credentials = await passwordHash(body.password),
    id = uuid(),
    quota = sha256("local:" + username),
    nickname = String(body.nickname || "").trim();
  if (nickname.length > 32 || /[\x00-\x1f]/.test(nickname))
    throw new ApiError("VALIDATION_ERROR", "昵称须不超过 32 个字符");
  return store.transaction(async (tx) => {
    if (await tx.get("local_accounts", quota))
      throw new ApiError("ACCOUNT_EXISTS", "该账号已存在", 409);
    const user = {
      id,
      username,
      email: username.includes("@") ? username : "",
      nickname,
      quota_key: quota,
      auth_kind: "local",
      role: admin ? "admin" : "user",
      is_active: true,
      avatar_id: null,
      record_history: true,
      record_revision: 0,
      created_at: now,
      agreement_acceptance: admin
        ? null
        : { version: VERSION, accepted_at: now },
    };
    await tx.create("users", id, user);
    await tx.create("local_accounts", quota, {
      id: quota,
      owner_id: id,
      ...credentials,
      created_at: now,
    });
    await tx.create("identities", quota, { id: quota, owner_id: id });
    return user;
  });
}
async function handle(ctx, req, res) {
  if (!ctx.path.startsWith("auth/")) return;
  if (ctx.method !== "POST")
    throw new ApiError("METHOD_NOT_ALLOWED", "不支持此操作", 405);
  if (ctx.path === "auth/logout/") {
    if (ctx.session) await ctx.store.remove("sessions", ctx.session.token_hash);
    res.setHeader("Set-Cookie", cookie("", true));
    return response(null, 204);
  }
  if (!["auth/login/", "auth/register/"].includes(ctx.path))
    throw new ApiError("NOT_FOUND", "本地网页使用账号与密码登录", 404);
  await consumeRateLimit(ctx, req, { scope: "auth", limit: 30, windowMs: 15 * 60000 });
  const username = identifier(ctx.body),
    gateId = sha256("auth:" + username),
    now = Date.parse(ctx.now);
  checkPassword(ctx.body.password);
  if (ctx.path === "auth/register/") {
    const a = ctx.body.agreement;
    if (!a || a.accepted !== true || a.version !== VERSION)
      throw new ApiError("AGREEMENT_REQUIRED", "请阅读并勾选同意用户协议与隐私说明");
  }
  await verifyAndConsume(ctx, req, ctx.path === "auth/register/" ? "register" : "login", ctx.body.altcha);
  await ctx.store.transaction(async (tx) => {
    const gate = await tx.get("local_auth_gates", gateId);
    const recent =
      gate && Array.isArray(gate.recent)
        ? gate.recent.filter((t) => t > now - 15 * 60000)
        : [];
    if (recent.length >= 12)
      throw new ApiError("RATE_LIMITED", "登录尝试较多，请十五分钟后重试", 429);
    recent.push(now);
    await tx.set("local_auth_gates", gateId, { recent, expires_at: new Date(now + 15 * 60000).toISOString() });
  });
  let user;
  if (ctx.path === "auth/register/") {
    user = await accountRecord(ctx.store, ctx.body, { now: ctx.now });
  } else {
    const row = await ctx.store.get(
      "local_accounts",
      sha256("local:" + username),
    );
    const checked = await passwordHash(
      ctx.body.password,
      row ? row.salt : "00000000000000000000000000000000",
    );
    if (
      !row ||
      !crypto.timingSafeEqual(
        Buffer.from(checked.hash, "hex"),
        Buffer.from(row.hash, "hex"),
      )
    )
      throw new ApiError("INVALID_CREDENTIALS", "账号或密码不正确", 401);
    user = await ctx.store.get("users", row.owner_id);
    if (!user || user.is_active !== true)
      throw new ApiError("INVALID_CREDENTIALS", "账号或密码不正确", 401);
  }
  const token = crypto.randomBytes(32).toString("hex"),
    id = sha256(token),
    expires = new Date(now + TTL).toISOString();
  await ctx.store.transaction(async (tx) => {
    const current = await tx.get("users", user.id);
    requireUser({ user: current });
    if (ctx.body.agreement) {
      if (
        ctx.body.agreement.accepted !== true ||
        ctx.body.agreement.version !== VERSION
      )
        throw new ApiError(
          "AGREEMENT_REQUIRED",
          "请确认当前用户协议与隐私说明",
        );
      await tx.update("users", user.id, {
        agreement_acceptance: { version: VERSION, accepted_at: ctx.now },
      });
    }
    await tx.set("sessions", id, {
      id,
      owner_id: user.id,
      identity_key: user.quota_key,
      created_at: ctx.now,
      expires_at: expires,
    });
    await tx.remove("local_auth_gates", gateId);
  });
  res.setHeader("Set-Cookie", cookie(token));
  return response(
    { user: publicUser(user), expires_at: expires },
    ctx.path === "auth/register/" ? 201 : 200,
  );
}
module.exports = {
  VERSION,
  authenticate,
  handle,
  accountRecord,
  publicUser,
  cookie,
};
