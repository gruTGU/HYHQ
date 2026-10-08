"use strict";
// Exercise the actual UI payload builders against the strict management API.
// A temporary database is used; provider calls and background timers are disabled.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { build } = require("../frontend/node_modules/esbuild");
const { SQLiteStore } = require("../backend/store.cjs");
const { createServer } = require("../backend/server.cjs");
const { localCloud } = require("../backend/local-storage.cjs");
const { accountRecord } = require("../backend/auth.cjs");
const backendRequire = Module.createRequire(require.resolve("../backend/auth.cjs"));
const { solveChallenge } = backendRequire("altcha-lib");
const { deriveKey } = backendRequire("altcha-lib/algorithms/pbkdf2");
const root = path.resolve(__dirname, "..");
let ui, dir, store, server, base, cookie;
async function request(endpoint, { method = "GET", body } = {}) {
  const response = await fetch(base + "/api/v1/" + endpoint, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  return {
    status: response.status,
    result,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
test.before(async () => {
  const compiled = await build({
    entryPoints: [path.join(root, "frontend/src/pages/AdminPage.jsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["react", "react-router-dom", "lucide-react"],
    logLevel: "silent",
  });
  const filename = path.join(root, "frontend/.admin-ui-contract.cjs");
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputFiles[0].text, filename);
  ui = loaded.exports;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hyhq-admin-ui-"));
  store = new SQLiteStore(path.join(dir, "test.sqlite3"));
  server = createServer({
    store,
    config: {
      appId: "hyhq-local-web",
      sessionSecret: "isolated-test-secret",
      modelRoot: path.join(dir, "models"),
      inferenceEnabled: false,
      llmEnabled: false,
      llmGatewayEnabled: false,
      qweatherEnabled: false,
      qweatherMonthlyLimit: 0,
      management: { enabled: true, adminUserIds: [] },
      community: {
        mode: "official-editorial",
        enabled: false,
        feedbackEnabled: false,
      },
      weatherReminders: { enabled: false },
    },
    cloud: localCloud(path.join(dir, "uploads")),
    timers: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  await accountRecord(
    store,
    {
      username: "ui-contract-admin",
      password: "admin-contract-password",
      nickname: "管理契约验证",
    },
    { admin: true },
  );
  const issued = await request("web/captcha/?purpose=login");
  assert.equal(issued.status, 200);
  const challenge = issued.result;
  const solution = await solveChallenge({ challenge, deriveKey });
  const altcha = Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
  const login = await request("auth/login/", {
    method: "POST",
    body: {
      username: "ui-contract-admin",
      password: "admin-contract-password",
      altcha,
    },
  });
  assert.equal(login.status, 200);
  cookie = login.cookie;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (store) await store.close();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});
test("UI excludes server-only metadata and preserves allowed route nodes", () => {
  const value = ui.catalogPayload("routes", {
    id: "server-only",
    title: "路线",
    region: "region-id",
    slug: "route-test",
    stops: [
      {
        id: "stop-id",
        order: 2,
        note: "观察",
        place: { id: "place-id", name: "public title" },
      },
    ],
    published: true,
    region_name: "服务端字段",
    stop_count: 1,
  });
  assert.equal(value.id, undefined);
  assert.equal(value.published, undefined);
  assert.equal(value.region_name, undefined);
  assert.equal(value.stop_count, undefined);
  assert.deepEqual(value.stops, [
    { id: "stop-id", order: 2, note: "观察", place_id: "place-id" },
  ]);
});
test("all four UI draft templates create and re-save through strict backend fields", async () => {
  const regions = (await request("regions/?page_size=100")).result.data;
  for (const kind of ["contents", "routes", "places", "rivers"]) {
    const value = ui.newCatalogValue(kind, regions);
    value.slug = "ui-contract-" + kind;
    if (["places", "rivers"].includes(kind)) value.name = "验证资料";
    else value.title = "验证资料";
    if (kind === "contents")
      value.body = "这是一份仅在隔离测试数据库内保存的私人管理草稿。";
    let revision = (await request("personal-admin/status/")).result.data
      .revision;
    let r = await request("personal-admin/catalog/" + kind + "/", {
      method: "POST",
      body: {
        expected_revision: revision,
        publish: false,
        value: ui.catalogPayload(kind, value),
      },
    });
    assert.equal(r.status, 201, kind + ": " + JSON.stringify(r.result));
    const id = r.result.data.id;
    r = await request("personal-admin/catalog/" + kind + "/" + id + "/");
    assert.equal(r.status, 200);
    const loaded = r.result.data;
    r = await request("personal-admin/catalog/" + kind + "/" + id + "/", {
      method: "PATCH",
      body: {
        expected_revision: loaded.revision,
        publish: false,
        value: ui.catalogPayload(kind, loaded.value),
      },
    });
    assert.equal(
      r.status,
      200,
      "read/edit/save " + kind + ": " + JSON.stringify(r.result),
    );
    const current = r.result.data.revision;
    r = await request("personal-admin/catalog/" + kind + "/" + id + "/", {
      method: "DELETE",
      body: { expected_revision: current },
    });
    assert.equal(r.status, 200);
  }
});
test("feedback replies and retention changes require current server versions", async () => {
  let r = await request("feedback/", {
    method: "POST",
    body: { body: "本地管理回复验证" },
  });
  assert.equal(r.status, 201);
  const id = r.result.data.id;
  const revision = (await request("personal-admin/status/")).result.data
    .revision;
  r = await request("personal-admin/feedback/" + id + "/resolve/", {
    method: "POST",
    body: { expected_revision: revision, reply: "问题已核实。" },
  });
  assert.equal(r.status, 200);
  r = await request("personal-admin/simulation/retention/");
  const policy = r.result.data;
  r = await request("personal-admin/simulation/retention/", {
    method: "PUT",
    body: {
      retain_days: 120,
      keep_successful: 4,
      expected_revision: policy.revision,
    },
  });
  assert.equal(r.status, 200);
  r = await request("personal-admin/simulation/retention/", {
    method: "PUT",
    body: {
      retain_days: 90,
      keep_successful: 3,
      expected_revision: policy.revision,
    },
  });
  assert.equal(r.status, 409);
  r = await request("personal-admin/simulation/cleanup-preview/");
  assert.equal(r.status, 200);
  assert.equal(typeof r.result.data.fingerprint, "string");
  assert.ok(Array.isArray(r.result.data.candidates));
  r = await request("management/maintenance/");
  assert.equal(r.status, 200);
  assert.equal(r.result.data.policy.max_batch_size, 20);
  r = await request("management/maintenance/", {
    method: "POST",
    body: { kind: "weather_ai_drafts", limit: 1 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.result.data.scanned, 0);
  r = await request("personal-admin/community/status/");
  assert.equal(r.status, 200);
  assert.equal(r.result.data.submissions_enabled, false);
});
