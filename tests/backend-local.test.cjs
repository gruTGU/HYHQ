"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { SQLiteStore } = require("../backend/store.cjs"),
  { createServer } = require("../backend/server.cjs"),
  { localCloud } = require("../backend/local-storage.cjs"),
  { accountRecord } = require("../backend/auth.cjs");
const sharp = require("../backend/node_modules/sharp");
const backendRequire = require("node:module").createRequire(require.resolve("../backend/auth.cjs"));
const { solveChallenge } = backendRequire("altcha-lib");
const { deriveKey } = backendRequire("altcha-lib/algorithms/pbkdf2");
let dir, store, server, base, cookie1, cookie2, adminCookie;
const agreement = { accepted: true, version: "2026-10-07" };
async function request(p, { method = "GET", body, cookie, headers = {} } = {}) {
  // Only local test fixtures solve a real official challenge. Production has no bypass.
  if (["auth/register/", "auth/login/"].includes(p) && body && !body.altcha) {
    const challengeResponse = await request("web/captcha/?purpose=" + (p === "auth/register/" ? "register" : "login"));
    assert.equal(challengeResponse.status, 200);
    const challenge = challengeResponse.data;
    const solution = await solveChallenge({ challenge, deriveKey });
    body = { ...body, altcha: Buffer.from(JSON.stringify({ challenge, solution })).toString("base64") };
  }
  const res = await fetch(base + "/api/v1/" + p, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data,
    cookie: res.headers.get("set-cookie")?.split(";")[0],
    headers: res.headers,
    text,
  };
}
test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hyhq-backend-test-"));
  store = new SQLiteStore(path.join(dir, "test.sqlite3"));
  const config = {
    appId: "hyhq-local-web",
    sessionSecret: "test-local-secret",
    modelRoot: path.join(dir, "models"),
    inferenceEnabled: false,
    llmEnabled: false,
    llmGatewayEnabled: false,
    qweatherEnabled: false,
    qweatherMonthlyLimit: 0,
    management: { enabled: true, adminUserIds: [] },
    community: { mode: "official-editorial", enabled: false },
    weatherReminders: { enabled: true },
  };
  server = createServer({
    store,
    config,
    cloud: localCloud(path.join(dir, "uploads")),
    timers: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});
test("SQLite rolls back, serializes concurrent writers, and persists across reopen", async () => {
  await store.set("test", "counter", { n: 0 });
  await Promise.all(
    Array.from({ length: 25 }, () =>
      store.transaction(async (tx) => {
        const row = await tx.get("test", "counter");
        await new Promise((r) => setTimeout(r, 1));
        await tx.update("test", "counter", { n: row.n + 1 });
      }),
    ),
  );
  assert.equal((await store.get("test", "counter")).n, 25);
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.set("test", "bad", { x: 1 });
      throw Error("abort");
    }),
  );
  assert.equal(await store.get("test", "bad"), null);
  await store.set("test", "nested", { active: { one: 1 } });
  await store.update("test", "nested", { active: {} });
  assert.deepEqual((await store.get("test", "nested")).active, {});
  const copy = new SQLiteStore(path.join(dir, "test.sqlite3"));
  assert.equal((await copy.get("test", "counter")).n, 25);
  await copy.close();
});
test("registration requires explicit agreement; account role and token are server controlled", async () => {
  let r = await request("auth/register/", {
    method: "POST",
    body: { email: "one@example.test", password: "long-pass-123" },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, "AGREEMENT_REQUIRED");
  r = await request("auth/register/", {
    method: "POST",
    body: {
      email: "one@example.test",
      password: "long-pass-123",
      agreement,
      role: "admin",
      OPENID: "forged",
    },
  });
  assert.equal(r.status, 201);
  cookie1 = r.cookie;
  assert.equal(r.data.data.user.role, "user");
  assert.equal(r.data.data.token, undefined);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
  const dbuser = await store.get("users", r.data.data.user.id);
  assert.equal(dbuser.password, undefined);
  const credential = await store.get("local_accounts", dbuser.quota_key);
  assert.notEqual(credential.hash, "long-pass-123");
  assert.equal(credential.hash.length, 128);
  r = await request("auth/register/", {
    method: "POST",
    body: { email: "two@example.test", password: "other-pass-123", agreement },
  });
  cookie2 = r.cookie;
  assert.equal(r.status, 201);
});
test("local login, account update, and private feedback isolation", async () => {
  let r = await request("auth/login/", {
    method: "POST",
    body: { email: "one@example.test", password: "wrong-password" },
  });
  assert.equal(r.status, 401);
  r = await request("auth/login/", {
    method: "POST",
    body: { email: "one@example.test", password: "long-pass-123" },
  });
  assert.equal(r.status, 200);
  cookie1 = r.cookie;
  r = await request("me/", {
    cookie: cookie1,
    method: "PATCH",
    body: { nickname: "本地测试" },
  });
  assert.equal(r.data.data.nickname, "本地测试");
  assert.equal(r.data.data.auth_kind, "local");
  r = await request("feedback/", {
    cookie: cookie1,
    method: "POST",
    body: { body: "仅本人可以编辑的反馈" },
  });
  assert.equal(r.status, 201);
  const id = r.data.data.id;
  r = await request("feedback/" + id + "/", {
    cookie: cookie2,
    method: "PATCH",
    body: { body: "越权修改" },
  });
  assert.equal(r.status, 404);
  r = await request("feedback/" + id + "/", {
    cookie: cookie1,
    method: "PATCH",
    body: { body: "已编辑的反馈" },
  });
  assert.equal(r.data.data.body, "已编辑的反馈");
  r = await request("feedback/", { cookie: cookie2 });
  assert.deepEqual(r.data.data, []);
  r = await request("personal-admin/stats/", { cookie: cookie1 });
  assert.equal(r.status, 403);
});
test("real image decoder rejects invalid files; owned normalized assets cannot be read by other accounts", async () => {
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#337744" },
  })
    .png()
    .toBuffer();
  let r = await request("web/uploads/", {
    cookie: cookie1,
    method: "POST",
    body: {
      name: "../unsafe.png",
      content_type: "image/png",
      purpose: "recognition",
      data: image.toString("base64"),
    },
  });
  assert.equal(r.status, 201);
  const id = r.data.data.id;
  assert.equal(r.data.data.width, 20);
  const asset = await store.get("assets", id);
  assert.match(asset.original_file_id, /^hyhq-private\//);
  let raw = await fetch(
    base + "/api/v1/uploads/" + id + "/content/?variant=thumbnail",
    { headers: { Cookie: cookie1 } },
  );
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/jpeg");
  r = await request("uploads/" + id + "/content/", { cookie: cookie2 });
  assert.equal(r.status, 404);
  r = await request("uploads/" + id + "/content/");
  assert.equal(r.status, 401);
  r = await request("web/uploads/", {
    cookie: cookie1,
    method: "POST",
    body: {
      content_type: "image/png",
      purpose: "recognition",
      data: Buffer.from("not a PNG").toString("base64"),
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, "INVALID_IMAGE");
});
test("available local ONNX artifacts execute through authenticated upload and job APIs", async (t) => {
  const modelRoot = path.resolve(__dirname, "../.private/models");
  try {
    await fs.access(path.join(modelRoot, "flowers-efficientnet-b0-v1.onnx"));
    await fs.access(path.join(modelRoot, "river-eco-yolov8n-v1.onnx"));
  } catch (_) {
    t.skip("Private model artifacts are not present in this portable checkout");
    return;
  }
  const config = server.backend.config;
  config.inferenceEnabled = true;
  config.modelRoot = modelRoot;
  try {
    for (const [route, file] of [
      ["recognition-jobs", "themes/editorial/entry-flower.jpg"],
      ["assessment-jobs", "examples/river-annotations.jpg"],
    ]) {
      const image = await fs.readFile(
        path.resolve(__dirname, "../frontend/public/assets", file),
      );
      let r = await request("web/uploads/", {
        cookie: cookie1,
        method: "POST",
        body: {
          content_type: "image/jpeg",
          purpose: "recognition",
          data: image.toString("base64"),
        },
      });
      assert.equal(r.status, 201);
      const assetId = r.data.data.id;
      r = await request(route + "/", {
        cookie: cookie1,
        method: "POST",
        body: { asset_id: assetId },
      });
      assert.equal(r.status, 201);
      const id = r.data.data.id;
      r = await request(route + "/" + id + "/", { cookie: cookie1 });
      assert.equal(r.status, 200);
      assert.equal(r.data.data.status, "succeeded");
      assert.equal(typeof r.data.data.duration_ms, "number");
      r = await request(route + "/" + id + "/", { cookie: cookie2 });
      assert.equal(r.status, 404);
    }
  } finally {
    config.inferenceEnabled = false;
  }
});
test("deleting a recognition source erases linked chat text while preserving quota accounting", async () => {
  const config = server.backend.config;
  const previous = {
    llmEnabled: config.llmEnabled,
    llmGatewayEnabled: config.llmGatewayEnabled,
    deepseekApiKey: config.deepseekApiKey,
  };
  Object.assign(config, {
    llmEnabled: true,
    llmGatewayEnabled: true,
    deepseekApiKey: "offline-test-credential-never-dispatched",
  });
  try {
    const me = (await request("me/", { cookie: cookie1 })).data.data;
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: "#336633" },
    })
      .png()
      .toBuffer();
    const upload = await request("web/uploads/", {
      cookie: cookie1,
      method: "POST",
      body: {
        content_type: "image/png",
        purpose: "recognition",
        data: bytes.toString("base64"),
      },
    });
    const assetId = upload.data.data.id,
      jobId = crypto.randomUUID();
    // Seed a completed source so this privacy test does not need model weights.
    await store.set("recognition_jobs", jobId, {
      id: jobId,
      owner_id: me.id,
      asset_id: assetId,
      kind: "recognition",
      status: "succeeded",
      visible: true,
      result: { candidates: [] },
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: new Date().toISOString(),
    });
    await store.set("asset_usage", assetId, {
      owner_id: me.id,
      kind: "recognition",
      job_id: jobId,
      deleted: false,
    });
    let result = await request("llm/sessions/", {
      cookie: cookie1,
      method: "POST",
      body: {
        scope: "recognition",
        recognition_job_id: jobId,
        include_image: false,
        consent_version: "deepseek-v1",
      },
    });
    assert.equal(result.status, 201);
    const sessionId = result.data.data.id;
    result = await request("llm/sessions/" + sessionId + "/turns/", {
      cookie: cookie1,
      method: "POST",
      body: {
        question: "等待处理的私密测试问题",
        request_id: crypto.randomUUID(),
      },
    });
    assert.equal(result.status, 201);
    const turnId = result.data.data.id,
      turn = await store.get("llm_turns", turnId),
      ledger = await store.get("llm_ledger", turn.ledger_id);
    const before = await store.get("llm_days", ledger.day);
    assert.ok(before.reserved_tokens > 0);
    const article = (await request("contents/?page_size=1")).data.data[0];
    const unrelated = await request("llm/sessions/", {
      cookie: cookie1,
      method: "POST",
      body: { scope: "learn", source_type: "content", source_id: article.id },
    });
    assert.equal(unrelated.status, 201);
    result = await request("recognition-jobs/" + jobId + "/", {
      cookie: cookie2,
      method: "DELETE",
      body: {},
    });
    assert.equal(result.status, 404);
    assert.ok(await store.get("llm_turns", turnId));
    result = await request("recognition-jobs/" + jobId + "/", {
      cookie: cookie1,
      method: "DELETE",
      body: {},
    });
    assert.equal(result.status, 204);
    assert.equal(await store.get("llm_turns", turnId), null);
    const tombstone = await store.get("llm_sessions", sessionId);
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.source_id, undefined);
    assert.equal(await store.get("assets", assetId), null);
    assert.equal(
      (await store.get("llm_sessions", unrelated.data.data.id)).deleted,
      false,
    );
    const retained = await store.get("llm_ledger", turn.ledger_id),
      after = await store.get("llm_days", ledger.day);
    assert.equal(retained.status, "failed");
    assert.equal(retained.error_code, "SESSION_DELETED");
    assert.equal(after.attempts, before.attempts);
    assert.equal(after.accounted_tokens, before.accounted_tokens);
    assert.equal(after.reserved_tokens, 0);
    result = await request("recognition-jobs/" + jobId + "/", {
      cookie: cookie1,
      method: "DELETE",
      body: {},
    });
    assert.equal(result.status, 204);
    assert.deepEqual(await store.get("llm_days", ledger.day), after);
  } finally {
    Object.assign(config, previous);
  }
});
test("drafts persist while public comments are closed", async () => {
  let r = await request("community/status/");
  assert.equal(r.data.data.comments_enabled, false);
  r = await request("community/submissions/", {
    cookie: cookie1,
    method: "POST",
    body: {
      title: "私人草稿",
      body: "这段文字仅保存到本机私人草稿",
      category: "water",
      source: "观察笔记",
      request_id: crypto.randomUUID(),
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.data.status, "draft");
  const id = r.data.data.id;
  r = await request("community/submissions/" + id + "/", { cookie: cookie2 });
  assert.equal(r.status, 404);
});
test("local reminders create exactly one real owned notification after server restart or delay", async () => {
  const scheduled = new Date(Date.now() + 10 * 60000).toISOString();
  let r = await request("weather-data/reminders/intents/", {
    cookie: cookie1,
    method: "POST",
    body: { location: "tianjin", scheduled_for: scheduled },
  });
  assert.equal(r.status, 201);
  const id = r.data.data.id;
  assert.equal(r.data.data.template_id, "local-in-app-v1");
  r = await request("weather-data/reminders/intents/" + id + "/confirm/", {
    cookie: cookie1,
    method: "POST",
    body: { template_id: "local-in-app-v1", decision: "accept" },
  });
  assert.equal(r.data.data.state, "pending");
  const { runDue } = require("../backend/reminders.cjs");
  await runDue(store, new Date(Date.now() + 11 * 60000).toISOString());
  await runDue(store, new Date(Date.now() + 12 * 60000).toISOString());
  assert.equal(await store.count("web_notifications"), 1);
  r = await request("web/notifications/", { cookie: cookie2 });
  assert.equal(r.data.data.length, 0);
  r = await request("web/notifications/", { cookie: cookie1 });
  assert.equal(r.data.data.length, 1);
  assert.equal(r.data.data[0].channel, "local_in_app");
});
test("admin content changes persist in catalog overrides and audit with optimistic revision", async () => {
  await accountRecord(
    store,
    {
      username: "test-admin",
      password: "safe-admin-password",
      nickname: "管理员",
    },
    { admin: true },
  );
  let r = await request("auth/login/", {
    method: "POST",
    body: { username: "test-admin", password: "safe-admin-password" },
  });
  adminCookie = r.cookie;
  r = await request("personal-admin/status/", { cookie: adminCookie });
  assert.equal(r.data.data.enabled, true);
  const revision = r.data.data.revision;
  r = await request("personal-admin/catalog/contents/", {
    cookie: adminCookie,
    method: "POST",
    body: {
      expected_revision: revision,
      publish: false,
      value: {
        title: "测试科普",
        slug: "backend-test-article",
        body: "这是管理员创建并保存在本地资料库的测试内容。",
        summary: "本地测试",
        category: "water",
        source: "本地测试",
        is_demo: true,
      },
    },
  });
  assert.equal(r.status, 201);
  const id = r.data.data.id;
  r = await request("personal-admin/catalog/contents/" + id + "/", {
    cookie: adminCookie,
  });
  assert.equal(r.data.data.value.title, "测试科普");
  const current = r.data.data.revision;
  r = await request("personal-admin/catalog/contents/" + id + "/", {
    cookie: adminCookie,
    method: "PATCH",
    body: { expected_revision: revision, value: { title: "旧版本修改" } },
  });
  assert.equal(r.status, 409);
  r = await request("personal-admin/catalog/contents/" + id + "/", {
    cookie: adminCookie,
    method: "DELETE",
    body: { expected_revision: current },
  });
  assert.equal(r.status, 200);
  assert.ok((await store.count("admin_audit")) >= 2);
});
test("CSRF, rebinding, oversize bodies, and false client identities are rejected", async () => {
  const publicPage = await fetch(base + "/");
  assert.equal(
    publicPage.headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  const privatePolicy = await request("me/", { cookie: cookie1 });
  assert.equal(privatePolicy.headers.get("referrer-policy"), "same-origin");
  let r = await request("feedback/", {
    method: "POST",
    body: { body: "cross site" },
    cookie: cookie1,
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(r.status, 403);
  r = await request("me/", {
    headers: {
      OPENID: "aaaaaaaaaaaaaaaa",
      Authorization: "Bearer " + "a".repeat(64),
    },
  });
  assert.equal(r.status, 401);
  const badHost = await new Promise((resolve, reject) => {
    const req = require("node:http").get(
      base + "/api/v1/health/",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(badHost, 403);
  r = await request("feedback/", {
    method: "POST",
    cookie: cookie1,
    body: { body: "a".repeat(400100) },
  });
  assert.equal(r.status, 413);
});
test("logout revokes session and deleting account removes private records and credentials", async () => {
  let r = await request("auth/logout/", {
    cookie: cookie2,
    method: "POST",
    body: {},
  });
  assert.equal(r.status, 204);
  r = await request("me/", { cookie: cookie2 });
  assert.equal(r.status, 401);
  r = await request("regions/", { cookie: cookie2 });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  r = await request("me/", { cookie: cookie1, method: "DELETE", body: {} });
  assert.equal(r.status, 204);
  r = await request("auth/login/", {
    method: "POST",
    body: { email: "one@example.test", password: "long-pass-123" },
  });
  assert.equal(r.status, 401);
  assert.equal(await store.count("web_notifications"), 0);
  assert.equal(await store.count("assets"), 0);
});
