"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createRequire } = require("node:module");
const backendRequire = createRequire(require.resolve("../backend/auth.cjs"));
const { solveChallenge } = backendRequire("altcha-lib");
const { deriveKey } = backendRequire("altcha-lib/algorithms/pbkdf2");
const { SQLiteStore } = require("../backend/store.cjs");
const captcha = require("../backend/captcha.cjs"), auth = require("../backend/auth.cjs");
const { clientIp, consumeRateLimit } = require("../backend/request-security.cjs");
const agreement = { accepted: true, version: auth.VERSION };
const req = (ip = "198.51.100.20", forwarded) => ({ socket: { remoteAddress: ip }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} });
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hyhq-auth-proof-")), filename = path.join(dir, "test.sqlite3");
  const state = { store: new SQLiteStore(filename), filename, config: { sessionSecret: "local-auth-test-secret-only-2026" } };
  t.after(async () => { await state.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  state.context = (extra = {}) => ({ store: state.store, config: state.config, now: new Date().toISOString(), ...extra });
  state.proof = async (purpose = "login", request = req()) => {
    const headers = {}, ctx = state.context({ path: "web/captcha/", method: "GET", query: new URLSearchParams({ purpose }) });
    const r = await captcha.handle(ctx, request, { setHeader: (key, value) => { headers[key] = value; } });
    assert.equal(r.statusCode, 200); assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(r.data.data, undefined); // Widget requires raw official JSON.
    const solution = await solveChallenge({ challenge: r.data, deriveKey });
    assert.ok(solution);
    return { encoded: encode({ challenge: r.data, solution }), challenge: r.data, solution };
  };
  state.auth = (purpose, body, request = req()) => auth.handle(state.context({ path: `auth/${purpose}/`, method: "POST", body }), request, { setHeader() {} });
  return state;
}
const errorCode = code => error => error.code === code;

test("client IP ignores direct spoofed XFF and trusts only explicitly configured loopback proxy", () => {
  assert.equal(clientIp(req("198.51.100.20", "203.0.113.9"), { HYHQ_TRUST_PROXY: "loopback" }), "198.51.100.20");
  assert.equal(clientIp(req("127.0.0.1", "203.0.113.9"), {}), "127.0.0.1");
  assert.equal(clientIp(req("::ffff:127.0.0.1", "203.0.113.9"), { HYHQ_TRUST_PROXY: "loopback" }), "203.0.113.9");
  assert.equal(clientIp(req("::1", "203.0.113.9, 127.0.0.1"), { HYHQ_TRUST_PROXY: "loopback" }), "::1");
  assert.equal(clientIp(req("::1", "untrusted"), { HYHQ_TRUST_PROXY: "loopback" }), "::1");
  assert.equal(clientIp(req("2001:0db8:0:0:0:0:0:1"), {}), "2001:db8::1");
  assert.equal(clientIp(req("::1", "fe80::1%en0"), { HYHQ_TRUST_PROXY: "loopback" }), "::1");
  assert.equal(clientIp({}, {}), "unknown");
});
test("registration and login reject missing proof without locking an account", async t => {
  const f = await fixture(t);
  for (const purpose of ["register", "login"]) await assert.rejects(f.auth(purpose, { email: "one@example.test", password: "a", agreement }), errorCode("CAPTCHA_INVALID"));
  assert.equal((await f.store.list("users")).length, 0);
  assert.equal((await f.store.list("local_auth_gates")).length, 0);
});
test("real official proof is bound to purpose and request IP, without storing raw IP", async t => {
  const f = await fixture(t), p = await f.proof("register");
  await assert.rejects(captcha.verifyAndConsume(f.context(), req(), "login", p.encoded), errorCode("CAPTCHA_INVALID"));
  await assert.rejects(captcha.verifyAndConsume(f.context(), req("203.0.113.9"), "register", p.encoded), errorCode("CAPTCHA_INVALID"));
  const stored = await f.store.list("local_captcha");
  assert.equal(stored.length, 1); assert.ok(!JSON.stringify(stored).includes("198.51.100.20"));
  await captcha.verifyAndConsume(f.context(), req(), "register", p.encoded);
  assert.equal((await f.store.list("local_captcha")).length, 0);
});
test("expired or tampered proofs are rejected before expensive chosen challenge work", async t => {
  const f = await fixture(t), p = await f.proof();
  await assert.rejects(captcha.verifyAndConsume(f.context({ now: new Date(Date.now() + captcha.TTL_MS + 1000).toISOString() }), req(), "login", p.encoded), errorCode("CAPTCHA_INVALID"));
  const altered = structuredClone(p.challenge); altered.parameters.cost = 1e12;
  await assert.rejects(captcha.verifyAndConsume(f.context(), req(), "login", encode({ challenge: altered, solution: p.solution })), errorCode("CAPTCHA_INVALID"));
  await assert.rejects(captcha.verifyAndConsume(f.context(), req(), "login", encode({ challenge: p.challenge, solution: { ...p.solution, derivedKey: "0".repeat(64) } })), errorCode("CAPTCHA_INVALID"));
  for (const payload of ["{}", "!", "e30=", "a".repeat(9000)]) await assert.rejects(captcha.verifyAndConsume(f.context(), req(), "login", payload), errorCode("CAPTCHA_INVALID"));
  await captcha.verifyAndConsume(f.context(), req(), "login", p.encoded);
});
test("concurrent replay has exactly one winner and remains spent after SQLite reopen", async t => {
  const f = await fixture(t), p = await f.proof();
  await f.store.close(); f.store = new SQLiteStore(f.filename);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => captcha.verifyAndConsume(f.context(), req(), "login", p.encoded)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.ok(results.filter(x => x.status === "rejected").every(x => x.reason.code === "CAPTCHA_INVALID"));
  await f.store.close(); f.store = new SQLiteStore(f.filename);
  await assert.rejects(captcha.verifyAndConsume(f.context(), req(), "login", p.encoded), errorCode("CAPTCHA_INVALID"));
});
test("single-character, space, unicode and NUL passwords register and log in unchanged", async t => {
  const f = await fixture(t); let i = 0;
  for (const password of ["a", " ", "叶", "\u0000", " x "]) {
    const email = `single-${i++}@example.test`;
    const a = await f.proof("register");
    assert.equal((await f.auth("register", { email, password, agreement, altcha: a.encoded })).statusCode, 201);
    const b = await f.proof("login");
    assert.equal((await f.auth("login", { email, password, altcha: b.encoded })).statusCode, 200);
  }
});
test("a wrong password spends its proof and stripping spaces does not authenticate", async t => {
  const f = await fixture(t), email = "space@example.test";
  await f.auth("register", { email, password: " x ", agreement, altcha: (await f.proof("register")).encoded });
  const proof = (await f.proof()).encoded;
  await assert.rejects(f.auth("login", { email, password: "x", altcha: proof }), errorCode("INVALID_CREDENTIALS"));
  await assert.rejects(f.auth("login", { email, password: " x ", altcha: proof }), errorCode("CAPTCHA_INVALID"));
  assert.equal((await f.auth("login", { email, password: " x ", altcha: (await f.proof()).encoded })).statusCode, 200);
});
test("empty and oversized passwords are rejected while agreement is explicit", async t => {
  const f = await fixture(t);
  for (const password of ["", "x".repeat(129), {}, null]) await assert.rejects(f.auth("register", { email: "bounds@example.test", password, agreement }), errorCode("VALIDATION_ERROR"));
  await assert.rejects(f.auth("register", { email: "bounds@example.test", password: "a" }), errorCode("AGREEMENT_REQUIRED"));
  assert.equal((await f.store.list("users")).length, 0);
});
test("persistent atomic IP limits cannot be bypassed by direct forged XFF and recover after window", async t => {
  const f = await fixture(t), policy = { scope: "test", limit: 2, windowMs: 60000 };
  const ctx = f.context();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => consumeRateLimit(ctx, req("198.51.100.20", `203.0.113.${i + 1}`), policy)));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 2);
  await f.store.close(); f.store = new SQLiteStore(f.filename);
  await assert.rejects(consumeRateLimit(f.context(), req(), policy), errorCode("RATE_LIMITED"));
  await consumeRateLimit(f.context({ now: new Date(Date.parse(ctx.now) + 60001).toISOString() }), req(), policy);
  assert.ok(!JSON.stringify(await f.store.list("local_request_gates")).includes("198.51.100.20"));
});
test("challenge issuance is IP limited and expired security rows are removed in bounded batches", async t => {
  const f = await fixture(t), ctx = f.context();
  for (let i = 0; i < 30; i++) await consumeRateLimit(ctx, req(), { scope: "captcha", limit: 30, windowMs: 900000 });
  await assert.rejects(captcha.handle(f.context({ path: "web/captcha/", method: "GET", query: new URLSearchParams({ purpose: "login" }) }), req(), { setHeader() {} }), errorCode("RATE_LIMITED"));
  for (let i = 0; i < 8; i++) await f.store.create("local_captcha", `expired-${i}`, { expires_at: new Date(Date.now() - 1000).toISOString() });
  await f.store.create("users", "untouched", { is_active: true });
  assert.deepEqual(await captcha.cleanupSecurity(f.context(), { limit: 3 }), { removed: 3 });
  assert.equal((await f.store.list("local_captcha")).length, 5);
  assert.ok(await f.store.get("users", "untouched"));
});
