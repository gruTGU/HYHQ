"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { createChallenge, verifySolution, randomInt } = require("altcha-lib");
const { deriveKey } = require("altcha-lib/algorithms/pbkdf2");
const { ApiError } = require("./vendor/lib/core");
const { consumeRateLimit, ipDigest, securityKey } = require("./request-security.cjs");
const TTL_MS = 5 * 60000;
const PURPOSES = new Set(["register", "login"]);
const rejected = () => new ApiError("CAPTCHA_INVALID", "验证已失效，请重新完成防刷验证", 400);
function clock(ctx) {
  const now = Date.parse(ctx.now);
  if (!Number.isFinite(now)) throw new Error("Invalid server time");
  return now;
}
function challengeId(challenge) {
  return crypto.createHash("sha256").update(challenge.signature).digest("hex");
}
async function cleanupSecurity(ctx, { limit = 50 } = {}) {
  const now = clock(ctx); let removed = 0;
  for (const kind of ["local_captcha", "local_request_gates", "local_auth_gates"]) {
    if (removed >= limit) break;
    const rows = await ctx.store.list(kind, { orderBy: [{ field: "expires_at", direction: "asc" }], limit: Math.min(100, limit - removed) });
    for (const candidate of rows) {
      if (removed >= limit) break;
      if (!Number.isFinite(Date.parse(candidate.expires_at)) || Date.parse(candidate.expires_at) > now) continue;
      removed += await ctx.store.transaction(async tx => {
        const row = await tx.get(kind, candidate.id);
        if (!row || !(Date.parse(row.expires_at) <= now)) return 0;
        await tx.remove(kind, row.id); return 1;
      });
    }
  }
  return { removed };
}
async function handle(ctx, req, res) {
  if (ctx.path !== "web/captcha/") return undefined;
  if (ctx.method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "请重新加载验证", 405);
  const purpose = ctx.query.get("purpose");
  if (!PURPOSES.has(purpose) || [...ctx.query.keys()].length !== 1)
    throw new ApiError("VALIDATION_ERROR", "验证用途无效", 400);
  await consumeRateLimit(ctx, req, { scope: "captcha", limit: 30, windowMs: 15 * 60000 });
  await cleanupSecurity(ctx);
  const now = clock(ctx), expires = now + TTL_MS;
  const challenge = await createChallenge({
    algorithm: "PBKDF2/SHA-256", cost: 1000, counter: randomInt(500, 1500),
    deriveKey, expiresAt: new Date(expires),
    hmacSignatureSecret: securityKey(ctx, "challenge-signature"),
    hmacKeySignatureSecret: securityKey(ctx, "challenge-key"),
    data: { purpose },
  });
  await ctx.store.create("local_captcha", challengeId(challenge), {
    challenge, purpose, ip_digest: ipDigest(ctx, req), created_at: ctx.now,
    expires_at: new Date(expires).toISOString(),
  });
  res.setHeader("Cache-Control", "no-store");
  // ALTCHA expects the raw challenge object, not the business API envelope.
  return { statusCode: 200, data: challenge };
}
async function verifyAndConsume(ctx, req, purpose, encoded) {
  if (!PURPOSES.has(purpose) || typeof encoded !== "string" || !encoded || encoded.length > 8192
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw rejected();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch (_) { throw rejected(); }
  const { challenge, solution } = payload && typeof payload === "object" ? payload : {};
  if (!challenge || typeof challenge.signature !== "string" || !/^[a-f0-9]{64}$/.test(challenge.signature)
      || !solution || !Number.isInteger(solution.counter) || solution.counter < 0 || solution.counter > 0xffffffff
      || typeof solution.derivedKey !== "string" || !/^[a-f0-9]{64}$/i.test(solution.derivedKey)) throw rejected();
  const id = challengeId(challenge), row = await ctx.store.get("local_captcha", id);
  const now = clock(ctx), started = Date.now(), digest = ipDigest(ctx, req);
  if (!row || row.purpose !== purpose || row.ip_digest !== digest || !(Date.parse(row.expires_at) > now)
      || !isDeepStrictEqual(row.challenge, challenge)) throw rejected();
  let verified;
  try {
    verified = await verifySolution({ challenge: row.challenge, solution, deriveKey,
      hmacSignatureSecret: securityKey(ctx, "challenge-signature"),
      hmacKeySignatureSecret: securityKey(ctx, "challenge-key") });
  } catch (_) { throw rejected(); }
  if (verified.verified !== true) throw rejected();
  // A cryptographically valid proof is spent before any password hashing.
  // Failed credentials also need a new proof. The transaction excludes replay
  // between concurrent requests and across process restarts.
  await ctx.store.transaction(async tx => {
    const current = await tx.get("local_captcha", id);
    if (!current || current.purpose !== purpose || current.ip_digest !== digest
        || !(Date.parse(current.expires_at) > now + Math.max(0, Date.now() - started))
        || !isDeepStrictEqual(current.challenge, row.challenge)) throw rejected();
    await tx.remove("local_captcha", id);
  });
}
module.exports = { handle, verifyAndConsume, cleanupSecurity, TTL_MS };
