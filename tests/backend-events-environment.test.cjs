"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { SQLiteStore } = require("../backend/store.cjs");
const { uuid, sha256 } = require("../backend/vendor/lib/core");
const events = require("../backend/events.cjs"), reports = require("../backend/environment-reports.cjs");
const accounts = require("../backend/vendor/lib/accounts"), { createBackend } = require("../backend/app.cjs");
const reference = "reference-park-079", place = "b548df45-97ac-4dff-87a6-4b1683f29797";
async function setup(t) {
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  const users = Object.fromEntries(["a", "b", "admin", "guest"].map(id => [id, { id, quota_key: sha256(id), auth_kind: id === "guest" ? "guest" : "local", role: id === "admin" ? "admin" : "user", is_active: true }]));
  for (const user of Object.values(users)) await store.set("users", user.id, user);
  const h = { store, users, now: "2026-10-19T03:00:00.000Z", config: { management: { enabled: true, adminUserIds: ["admin"] }, community: { enabled: false } } };
  h.storage = { readAsset: async () => ({ bytes: Buffer.from("test-thumbnail"), mime_type: "image/jpeg" }), deleteAsset: async (_, id) => store.remove("assets", id) };
  h.ctx = (user = "a") => ({ store, config: h.config, now: h.now, user: users[user] || null, storage: h.storage });
  h.call = (path, method = "GET", body = {}, user = "a") => {
    const url = new URL(path, "https://fixture.invalid/");
    const ctx = { ...h.ctx(user), path: url.pathname.slice(1), method, body, query: url.searchParams };
    return (ctx.path.startsWith("event") && !ctx.path.startsWith("environment") ? events : reports).handle(ctx);
  };
  h.job = async (kind = "recognition", overrides = {}) => {
    const assetId = uuid(), id = uuid();
    await store.create("assets", assetId, { owner_id: "a", purpose: "recognition", thumbnail_file_id: "local:test-thumbnail", expires_at: "2099-01-01T00:00:00Z" });
    await store.create(kind + "_jobs", id, { owner_id: "a", asset_id: assetId, visible: true, status: "succeeded", expires_at: "2099-01-01T00:00:00Z", result: { decision: "recognized", candidates: [{ label: "roses", name: "玫瑰" }] }, detections: [], ...overrides });
    return { task_kind: kind, task_id: id, asset_id: assetId };
  };
  h.report = async (job, extra = {}) => h.call("environment-reports/", "POST", { task_kind: job.task_kind, task_id: job.task_id, description: "照片中可见岸边散落的塑料袋，尚未核实来源。", map_reference_id: reference, ...extra });
  return h;
}
test("public calendar covers all months in both cities and filters each server-trusted location", async t => {
  const h = await setup(t), rows = (await h.call("events/", "GET", {}, null)).data.data.items;
  assert.equal(rows.filter(row => row.annual).length, 24);
  assert.equal(new Set(rows.filter(row => row.annual && row.region_slug === "beijing-nature").map(row => row.id.slice(-5, -3))).size, 12);
  assert.ok(rows.every(row => row.simulated && /模拟|演示/.test(row.notice) && row.location_name));
  assert.ok(rows.some(row => row.status === "ended"));
  assert.ok(rows.some(row => row.status === "ongoing"));
  assert.ok(rows.some(row => row.status === "scheduled"));
  const scoped = (await h.call(`events/?map_reference_id=${reference}&from=2026-10-01&to=2026-10-31`)).data.data.items;
  assert.ok(scoped.length); assert.ok(scoped.every(row => row.map_reference_id === reference));
  const places = (await h.call(`events/?place_id=${place}`)).data.data.items;
  assert.ok(places.length); assert.ok(places.every(row => row.place_id === place));
  for (const query of ["map_reference_id=reference-park-999", `place_id=${place}&map_reference_id=${reference}`, "year=9999", "from=2026-02-30", "year=2026&year=2027", "owner_id=a"]) await assert.rejects(h.call("events/?" + query), { code: "VALIDATION_ERROR" });
});
test("opt-in is persisted, declining stays declined, and atomic daily claims survive simultaneous tabs", async t => {
  const h = await setup(t);
  const fresh = (await h.call("event-notifications/")).data.data;
  assert.equal(fresh.enabled, false); assert.equal(fresh.prompted, false); assert.equal(fresh.should_notify, false);
  await h.call("event-notifications/", "PATCH", { enabled: false });
  let pref = (await h.call("event-notifications/")).data.data;
  assert.equal(pref.prompted, true); assert.equal(pref.enabled, false);
  assert.equal((await h.call("event-notifications/claim/", "POST")).data.data.should_notify, false);
  h.now = "2026-10-20T00:00:00.000Z";
  assert.equal((await h.call("event-notifications/claim/", "POST")).data.data.should_notify, false);
  await h.call("event-notifications/", "PATCH", { enabled: true });
  const claims = await Promise.all(Array.from({ length: 8 }, () => h.call("event-notifications/claim/", "POST")));
  assert.equal(claims.filter(r => r.data.data.should_notify).length, 1);
  assert.ok(claims[0].data.data.daily_events.length > 0);
  h.now = "2026-10-20T15:59:59.000Z";
  assert.equal((await h.call("event-notifications/claim/", "POST")).data.data.should_notify, false);
  h.now = "2026-10-20T16:00:00.000Z";
  assert.equal((await h.call("event-notifications/claim/", "POST")).data.data.should_notify, true);
  assert.equal((await h.call("event-notifications/")).data.data.last_shown_date, "2026-10-21");
  assert.equal((await h.call("event-notifications/", "GET", {}, "b")).data.data.prompted, false);
  await assert.rejects(h.call("event-notifications/", "PATCH", { enabled: true, owner_id: "b" }), { code: "VALIDATION_ERROR" });
});
test("event subscriptions are idempotent, isolated and do not silently enable notifications", async t => {
  const h = await setup(t), row = (await h.call("events/")).data.data.items.find(row => row.is_current);
  await Promise.all([h.call("event-subscriptions/", "POST", { event_id: row.id }), h.call("event-subscriptions/", "POST", { event_id: row.id })]);
  assert.equal(await h.store.count("event_subscriptions"), 1);
  assert.equal((await h.call("event-subscriptions/")).data.data.items[0].event_id, row.id);
  assert.deepEqual((await h.call("event-subscriptions/", "GET", {}, "b")).data.data.items, []);
  assert.equal((await h.call("event-notifications/")).data.data.enabled, false);
  await h.call(`event-subscriptions/${row.id}/`, "DELETE", {}, "b");
  assert.equal(await h.store.count("event_subscriptions"), 1);
  await h.call(`event-subscriptions/${row.id}/`, "DELETE");
  assert.equal(await h.store.count("event_subscriptions"), 0);
  await assert.rejects(h.call("event-subscriptions/", "POST", { event_id: "flower-month-1-2026-01-01" }), { code: "EVENT_UNAVAILABLE" });
  for (const user of [null, "guest"]) for (const route of ["event-subscriptions/", "event-notifications/", "environment-reports/"]) await assert.rejects(h.call(route, "GET", {}, user), error => error.status === 401 || error.status === 403);
});
test("completed owned recognition, valid thumbnail and trusted location are mandatory for private reports", async t => {
  const h = await setup(t), job = await h.job();
  const context = (await h.call(`environment-reports/context/?task_kind=${job.task_kind}&task_id=${job.task_id}`)).data.data;
  assert.match(context.photo_url, new RegExp(job.asset_id)); assert.equal(context.location, null); assert.match(context.observation, /候选/);
  await assert.rejects(h.call("environment-reports/", "POST", { task_kind: job.task_kind, task_id: job.task_id, description: "可见垃圾" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(h.report(job, { location_text: "伪造政府地点" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(h.report(job, { map_reference_id: "reference-park-999" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(h.call(`environment-reports/context/?task_kind=recognition&task_id=${job.task_id}`, "GET", {}, "b"), { code: "NOT_FOUND" });
  const report = (await h.report(job)).data.data;
  assert.equal(report.status, "pending"); assert.equal(report.simulated, true); assert.equal(report.government_sent, false);
  assert.equal(report.location.name, "天津水上公园"); assert.match(report.location.selection_notice, /不代表已核验/);
  assert.equal(report.delivery_mode, "platform_admin_simulation"); assert.match(report.notice, /未向政府/);
  assert.equal(report.owner_id, undefined); assert.equal(report.asset_id, undefined);
  assert.deepEqual((await h.call("environment-reports/", "GET", {}, "b")).data.data, []);
  assert.equal((await h.call("environment-reports/?status=pending")).data.data.length, 1);
  assert.equal((await h.call(`environment-reports/context/?task_kind=recognition&task_id=${job.task_id}`)).data.data.existing_report.id, report.id);
  const missingExpiry = await h.job("recognition", { expires_at: "invalid" });
  await assert.rejects(h.report(missingExpiry), { code: "NOT_FOUND" });
  const failed = await h.job("recognition", { status: "failed" }); await assert.rejects(h.report(failed), { code: "NOT_FOUND" });
  const unclear = await h.job("recognition", { result: { reason: "LOW_IMAGE_QUALITY" } }); await assert.rejects(h.report(unclear), { code: "SOURCE_IMAGE_UNCLEAR" });
});
test("water task location resolves from published water body; model output is never a water quality claim", async t => {
  const h = await setup(t), job = await h.job("assessment", { water_body: { id: "e19dec2a-89ef-4dcb-afbc-e25227ef6ced", name: "客户端伪名" }, detections: [{ class_id: 1 }] });
  const context = (await h.call(`environment-reports/context/?task_kind=assessment&task_id=${job.task_id}`)).data.data;
  assert.equal(context.location.place_id, place); assert.notEqual(context.location.name, "客户端伪名"); assert.match(context.observation, /1 个/); assert.match(context.observation, /不代表污染判定或水质等级/);
  const report = await h.call("environment-reports/", "POST", { task_kind: "assessment", task_id: job.task_id, description: "照片可见漂浮物，待人工核查。" });
  assert.equal(report.data.data.location.place_id, place);
});
test("task kind and task ID require exact strings and cannot bypass low-quality rejection through coercion", async t => {
  const h = await setup(t), job = await h.job("recognition", { result: { decision: "uncertain", reason: "LOW_IMAGE_QUALITY" } });
  for (const task_kind of [["recognition"], { toString: "recognition" }, null, 1, "__proto__", "toString"]) {
    await assert.rejects(h.report(job, { task_kind }), { code: "VALIDATION_ERROR" });
    await assert.rejects(reports.task(h.ctx(), task_kind, job.task_id), { code: "VALIDATION_ERROR" });
  }
  for (const task_id of [[job.task_id], { toString: job.task_id }, null, 1]) {
    await assert.rejects(h.report(job, { task_id }), { code: "VALIDATION_ERROR" });
    await assert.rejects(reports.task(h.ctx(), "recognition", task_id), { code: "VALIDATION_ERROR" });
  }
  await assert.rejects(h.report(job), { code: "SOURCE_IMAGE_UNCLEAR" });
  assert.equal(await h.store.count("environment_reports"), 0);
  assert.equal((await h.store.get("users", "a")).environment_report_day_count, undefined);
});
test("duplicate reports collapse atomically, conflicting replay fails, and delete does not reset daily allowance", async t => {
  const h = await setup(t), job = await h.job();
  const created = await Promise.all([h.report(job), h.report(job)]);
  assert.equal(created[0].data.data.id, created[1].data.data.id);
  assert.deepEqual(created.map(r => r.statusCode).sort(), [200, 201]);
  assert.equal((await h.store.get("users", "a")).environment_report_day_count, 1);
  await assert.rejects(h.report(job, { description: "不同的第二次描述" }), { code: "REPORT_EXISTS" });
  await assert.rejects(h.call(`environment-reports/${created[0].data.data.id}/`, "DELETE", {}, "b"), { code: "NOT_FOUND" });
  await h.call(`environment-reports/${created[0].data.data.id}/`, "DELETE");
  await h.store.update("users", "a", { environment_report_day_count: 10 });
  await assert.rejects(h.report(job), { code: "RATE_LIMITED" });
  h.now = "2026-10-19T16:00:00.000Z";
  assert.equal((await h.report(job)).statusCode, 201);
});
test("only owner or current admin can read report photos; deletion and expiry revoke photo access", async t => {
  const h = await setup(t), job = await h.job(), row = (await h.report(job)).data.data;
  const url = `environment-reports/${row.id}/photo/`;
  assert.equal((await h.call(url)).contentType, "image/jpeg");
  assert.equal((await h.call(url, "GET", {}, "admin")).binary.toString(), "test-thumbnail");
  await assert.rejects(h.call(url, "GET", {}, "b"), { code: "FORBIDDEN" });
  await h.store.update("users", "admin", { role: "user" });
  await assert.rejects(h.call(url, "GET", {}, "admin"), { code: "FORBIDDEN" });
  await h.store.update("recognition_jobs", job.task_id, { status: "deleted", visible: false });
  await assert.rejects(h.call(url), { code: "NOT_FOUND" });
  await h.store.update("recognition_jobs", job.task_id, { status: "succeeded", visible: true });
  await h.store.update("assets", job.asset_id, { expires_at: "2026-10-18T00:00:00Z" });
  await assert.rejects(h.call(url), { code: "NOT_FOUND" });
});
test("storage I/O cannot race report deletion to expose the thumbnail", async t => {
  const h = await setup(t), job = await h.job(), row = (await h.report(job)).data.data;
  h.storage.readAsset = async () => { await h.store.remove("environment_reports", row.id); return { bytes: Buffer.from("test"), mime_type: "image/jpeg" }; };
  await assert.rejects(h.call(`environment-reports/${row.id}/photo/`), { code: "NOT_FOUND" });
});
test("administrator replies share revision control and safe audit, and cannot be silently overwritten", async t => {
  const h = await setup(t), row = (await h.report(await h.job())).data.data;
  await assert.rejects(h.call("personal-admin/environment-reports/", "GET", {}, "b"), { code: "FORBIDDEN" });
  assert.equal((await h.call("personal-admin/environment-reports/?status=pending", "GET", {}, "admin")).data.data.length, 1);
  const route = `personal-admin/environment-reports/${row.id}/resolve/`, body = { reply: "已在平台内记录，请继续观察；本回复不代表政府处置。", expected_revision: 0 };
  await assert.rejects(h.call(route, "POST", body, "a"), { code: "FORBIDDEN" });
  const resolved = (await h.call(route, "POST", body, "admin")).data.data;
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.revision, 1); assert.equal(resolved.government_sent, false);
  await assert.rejects(h.call(route, "POST", body, "admin"), { code: "ADMIN_REVISION_CHANGED" });
  await assert.rejects(h.call(route, "POST", { ...body, expected_revision: 1 }, "admin"), { code: "REPORT_RESOLVED" });
  const audit = await h.store.list("admin_audit"); assert.equal(audit.length, 1); assert.equal(audit[0].action, "environment_report_resolved"); assert.equal(JSON.stringify(audit).includes(body.reply), false);
  assert.equal((await h.call("environment-reports/")).data.data[0].reply, body.reply);
});
test("account purge removes private reports and subscriptions and stale sessions cannot recreate either", async t => {
  const h = await setup(t), row = (await h.report(await h.job())).data.data;
  const event = (await h.call("events/")).data.data.items.find(row => row.is_current);
  await h.call("event-subscriptions/", "POST", { event_id: event.id });
  await accounts.purgeAccount(h.ctx(), h.users.a);
  assert.equal(await h.store.get("environment_reports", row.id), null);
  assert.equal(await h.store.count("event_subscriptions", { owner_id: "a" }), 0);
  await assert.rejects(h.call("event-subscriptions/", "POST", { event_id: event.id }), { code: "AUTH_REQUIRED" });
  await assert.rejects(h.call("environment-reports/"), { code: "AUTH_REQUIRED" });
});
test("real application dispatch exposes new routes behind existing registered-session authentication", async t => {
  const h = await setup(t), token = "a".repeat(64);
  await h.store.set("sessions", sha256(token), { owner_id: "a", identity_key: h.users.a.quota_key, expires_at: "2099-01-01T00:00:00Z" });
  const app = createBackend({ store: h.store, config: h.config, cloud: {} });
  const dispatch = (path, method = "GET", body = {}, loggedIn = true) => app.dispatch({ method, headers: { cookie: loggedIn ? "hyhq_session=" + token : "" } }, { setHeader() {} }, new URL("https://fixture.invalid/api/v1/" + path), body);
  assert.equal((await dispatch("events/", "GET", {}, false)).statusCode, 200);
  await assert.rejects(dispatch("event-notifications/", "GET", {}, false), { code: "NOT_AUTHENTICATED" });
  assert.equal((await dispatch("event-notifications/", "PATCH", { enabled: false })).data.data.prompted, true);
  const source = await h.job();
  assert.equal((await dispatch(`environment-reports/context/?task_kind=recognition&task_id=${source.task_id}`)).data.data.task_id, source.task_id);
  assert.equal((await dispatch("environment-reports/", "POST", { task_kind: "recognition", task_id: source.task_id, description: "照片中的可见情况。", map_reference_id: reference })).statusCode, 201);
});
