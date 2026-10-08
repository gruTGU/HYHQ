"use strict";
const crypto = require("node:crypto");
const net = require("node:net");
const { ApiError } = require("./vendor/lib/core");

function normalizedIp(value) {
  if (typeof value !== "string" || value.length > 128) return "";
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (ip.includes("%") || !net.isIP(ip)) return "";
  return net.isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}
function clientIp(req, env = process.env) {
  const peer = normalizedIp(req && req.socket && req.socket.remoteAddress);
  const loopback = peer === "::1" || /^127\./.test(peer);
  // The sole supported proxy contract is a local reverse proxy that REPLACES
  // X-Forwarded-For with its direct client IP. Never interpret a client chain.
  if (env.HYHQ_TRUST_PROXY === "loopback" && loopback) {
    const forwarded = req.headers && req.headers["x-forwarded-for"];
    const trusted = normalizedIp(forwarded);
    if (trusted) return trusted;
  }
  return peer || "unknown";
}
function securityKey(ctx, domain) {
  const secret = ctx.config && (ctx.config.captchaSecret || ctx.config.sessionSecret);
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 16)
    throw new ApiError("SECURITY_UNAVAILABLE", "验证服务暂不可用，请稍后重试", 503);
  return crypto.createHmac("sha256", secret).update("hyhq-web-security-v1:" + domain).digest("hex");
}
function ipDigest(ctx, req) {
  return crypto.createHmac("sha256", securityKey(ctx, "ip"))
    .update(clientIp(req)).digest("hex");
}
async function consumeRateLimit(ctx, req, { scope, limit, windowMs }) {
  if (!/^[a-z_-]{1,40}$/.test(scope) || !Number.isInteger(limit) || limit < 1
      || limit > 1000 || !Number.isInteger(windowMs) || windowMs < 1000)
    throw new Error("Invalid rate limit policy");
  const now = Date.parse(ctx.now);
  if (!Number.isFinite(now)) throw new Error("Invalid server time");
  const id = crypto.createHash("sha256").update(scope + ":" + ipDigest(ctx, req)).digest("hex");
  await ctx.store.transaction(async tx => {
    const previous = await tx.get("local_request_gates", id);
    const recent = previous && Array.isArray(previous.recent)
      ? previous.recent.filter(t => Number.isFinite(t) && t > now - windowMs && t <= now) : [];
    if (recent.length >= limit)
      throw new ApiError("RATE_LIMITED", "请求较多，请稍后重试", 429);
    recent.push(now);
    await tx.set("local_request_gates", id, { recent, expires_at: new Date(now + windowMs).toISOString() });
  });
}
module.exports = { clientIp, consumeRateLimit, ipDigest, securityKey };
