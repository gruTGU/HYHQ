"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { randomUUID } = require("node:crypto");
const { SQLiteStore } = require("../backend/store.cjs");
const reminders = require("../backend/reminders.cjs"),
  ecology = require("../backend/ecology-reminders.cjs"),
  daily = require("../backend/daily-reminders.cjs"),
  parser = require("../backend/booking-ai.cjs");
async function setup(t) {
  const store = new SQLiteStore(":memory:"),
    user = { id: "ecology-user", is_active: true };
  await store.set("users", user.id, user);
  t.after(() => store.close());
  return {
    store,
    user,
    now: "2026-10-11T23:00:00.000Z",
    query: new URLSearchParams(),
  };
}
const call = (h, body, path = "intents/") =>
  reminders.handle({
    ...h,
    method: "POST",
    body,
    path: "weather-data/reminders/" + path,
  });
const payload = (extra = {}) => ({
  type: "ecology_simulation",
  scenario: "rain",
  location: "tianjin",
  scheduled_for: "2026-10-12T00:00:00.000Z",
  request_key: randomUUID(),
  ...extra,
});
test("server and frontend previews use the exact ecology-journal teaching samples", async () => {
  const { SCENARIOS } =
    await import("../frontend/src/pages/simulation-domain.js");
  const { simulationPreview } =
    await import("../frontend/src/pages/reminder-domain.js");
  assert.deepEqual(ecology.data.scenarios, SCENARIOS);
  const expected = {
    steady: [],
    rain: ["turbidity"],
    heat: ["temperature", "oxygen"],
    check: ["ph", "turbidity", "oxygen"],
  };
  for (const id of Object.keys(expected)) {
    const s = ecology.summary(id),
      front = simulationPreview(id);
    assert.deepEqual(
      s.metrics.filter((m) => m.triggered).map((m) => m.id),
      expected[id],
    );
    assert.deepEqual(
      s.metrics.map((m) => m.value),
      front.metrics.map((m) => m.value),
    );
    assert.match(s.body, /科普模拟/);
    assert.match(s.body, /非实测/);
  }
  assert.equal(
    ecology.summary("rain").metrics.find((m) => m.id === "turbidity").value,
    46,
  );
  assert.equal(
    ecology.summary("heat").metrics.find((m) => m.id === "oxygen").value,
    5.9,
  );
});
test("instant demonstration is always a concise abnormal notice independent of the selected graph", () => {
  for (const scenario of [undefined, "steady", "rain", "heat", "check"]) {
    const n = ecology.notification({ scenario });
    assert.equal(n.body, "模拟异常：浊度偏高，请复核");
    assert.doesNotMatch(n.body, /平稳|55|4\.1/);
    assert.match(n.title, /非实测/);
    assert.equal(n.simulation, true);
    assert.equal(n.demonstration, "fixed_anomaly_v1");
  }
});
test("instant simulation is transactional, creates no schedules and never reads weather", async (t) => {
  const h = await setup(t),
    p = { request_key: randomUUID() };
  const get = h.store.get.bind(h.store);
  h.store.get = async (kind, id) => {
    assert.notEqual(kind, "weather_cache");
    return get(kind, id);
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call(h, p, "simulation-test/")),
  );
  assert.equal(
    new Set(results.map((r) => r.data.data.notification_id)).size,
    1,
  );
  const rows = await h.store.list("web_notifications");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, h.user.id);
  assert.equal(rows[0].body, "模拟异常：浊度偏高，请复核");
  assert.equal(await h.store.count("web_reminders"), 0);
  assert.equal(await h.store.count("web_daily_reminders"), 0);
  assert.equal(await h.store.count("weather_requests"), 0);
});
test("new simulation schedules are disabled while weather one-time and daily remain available", async (t) => {
  const h = await setup(t);
  await assert.rejects(call(h, payload()), {
    code: "SIMULATION_SCHEDULE_DISABLED",
  });
  await assert.rejects(
    call(
      h,
      { type: "ecology_simulation", scenario: "steady", time: "08:00" },
      "daily/",
    ),
    { code: "SIMULATION_SCHEDULE_DISABLED" },
  );
  await call(h, payload({ type: "weather", scenario: null }));
  await call(
    h,
    { type: "weather", location: "tianjin", time: "08:00" },
    "daily/",
  );
  assert.equal(await h.store.count("web_reminders"), 1);
  assert.equal(
    (await h.store.get("web_daily_reminders", h.user.id)).enabled,
    true,
  );
});
test("legacy pending and prepared simulations are paused and retained without sending or deleting history", async (t) => {
  const h = await setup(t);
  for (const state of ["prepared", "pending", "cancelled", "sent"]) {
    const id = randomUUID();
    await h.store.set("web_reminders", id, {
      id,
      owner_id: h.user.id,
      type: "ecology_simulation",
      scenario: "steady",
      state,
      scheduled_for: "2026-11-01T00:00:00.000Z",
      created_at: h.now,
    });
  }
  await reminders.runDue(h.store, h.now);
  const rows = await h.store.list("web_reminders");
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.state === "paused").length, 2);
  assert.equal(rows.filter((r) => r.state === "sent").length, 1);
  assert.equal(rows.filter((r) => r.state === "cancelled").length, 1);
  assert.equal(await h.store.count("web_notifications"), 0);
  const paused = rows.find((r) => r.state === "paused");
  await assert.rejects(
    call(
      h,
      { template_id: "local-in-app-v1", decision: "accept" },
      `intents/${paused.id}/confirm/`,
    ),
    { code: "SIMULATION_SCHEDULE_DISABLED" },
  );
});
test("instant trials preserve owner isolation, UUID retry safety and five per Beijing day", async (t) => {
  const h = await setup(t),
    p = { request_key: randomUUID() };
  const first = (await call(h, p, "simulation-test/")).data.data;
  for (let n = 0; n < 4; n++)
    await call(h, { request_key: randomUUID() }, "simulation-test/");
  await assert.rejects(
    call(h, { request_key: randomUUID() }, "simulation-test/"),
    { code: "RATE_LIMITED" },
  );
  const replay = (
    await call(
      h,
      { request_key: p.request_key.toUpperCase(), scenario: "steady" },
      "simulation-test/",
    )
  ).data.data;
  assert.equal(replay.notification_id, first.notification_id);
  const other = { ...h, user: { id: "other-user", is_active: true } };
  await h.store.set("users", other.user.id, other.user);
  assert.notEqual(
    (await call(other, p, "simulation-test/")).data.data.notification_id,
    first.notification_id,
  );
  h.now = "2026-10-12T16:00:00.000Z";
  await call(h, { request_key: randomUUID() }, "simulation-test/");
  assert.equal(await h.store.count("web_notifications"), 7);
});
test("instant simulations reject unknown metrics, invalid keys and inactive or missing users", async (t) => {
  const h = await setup(t),
    p = { request_key: randomUUID() };
  await assert.rejects(call({ ...h, user: null }, p, "simulation-test/"), {
    status: 401,
  });
  await assert.rejects(
    call(h, { ...p, temperature: 1000 }, "simulation-test/"),
    { code: "VALIDATION_ERROR" },
  );
  await assert.rejects(
    call(h, { ...p, scenario: "real-river" }, "simulation-test/"),
    { code: "VALIDATION_ERROR" },
  );
  await assert.rejects(call(h, { request_key: "fake" }, "simulation-test/"), {
    code: "VALIDATION_ERROR",
  });
  await h.store.update("users", h.user.id, { is_active: false });
  await assert.rejects(call(h, p, "simulation-test/"), { status: 401 });
  assert.equal(await h.store.count("web_notifications"), 0);
});
test("legacy daily simulation is disabled without delivering backlog or discarding saved preferences", async (t) => {
  const h = await setup(t),
    id = h.user.id + ":ecology_simulation";
  await h.store.set("web_daily_reminders", id, {
    id,
    owner_id: h.user.id,
    type: "ecology_simulation",
    scenario: "steady",
    enabled: true,
    time: "08:00",
    subscription_id: randomUUID(),
    last_notified_date: "2026-10-10",
    next_scheduled_for: "2026-11-01T00:00:00.000Z",
  });
  const get = h.store.get.bind(h.store);
  h.store.get = async (kind, key) => {
    assert.notEqual(kind, "weather_cache");
    return get(kind, key);
  };
  await daily.runDue(h.store, h.now);
  const saved = await h.store.get("web_daily_reminders", id);
  assert.equal(saved.enabled, false);
  assert.equal(saved.time, "08:00");
  assert.equal(saved.last_notified_date, "2026-10-10");
  assert.equal(saved.reason, "simulation_moved_to_instant");
  assert.equal(await h.store.count("web_notifications"), 0);
});
test("AI only proposes weather schedules and redirects simulated requests to instant experience", () => {
  const now = Date.parse("2026-10-11T23:00:00Z"),
    base = {
      needs_clarification: false,
      type: "weather",
      scenario: null,
      location: "tianjin",
      local_date: "2026-10-12",
      local_time: "08:00",
      frequency: "once",
    };
  assert.equal(parser.decode(JSON.stringify(base), now).draft.type, "weather");
  assert.equal(
    parser.decode(JSON.stringify({ ...base, frequency: "daily" }), now).draft
      .time,
    "08:00",
  );
  for (const frequency of ["once", "daily"])
    assert.equal(
      parser.decode(
        JSON.stringify({
          ...base,
          type: "ecology_simulation",
          scenario: "rain",
          frequency,
        }),
        now,
      ).needs_clarification,
      true,
    );
  assert.throws(
    () => parser.decode(JSON.stringify({ ...base, oxygen: 1 }), now),
    { code: "WEATHER_AI_INVALID" },
  );
  assert.match(
    parser.messages("模拟预约", "tianjin", now)[0].content,
    /即时体验/,
  );
});
test("frontend rejects stale simulated AI schedules while accepting weather daily drafts", async () => {
  const { validReminderDraft } =
    await import("../frontend/src/pages/reminder-domain.js");
  const base = {
    type: "weather",
    scenario: null,
    location: "tianjin",
    timezone: "Asia/Shanghai",
    frequency: "daily",
    time: "08:00",
  };
  assert.equal(validReminderDraft(base, ["tianjin"]).time, "08:00");
  assert.equal(
    validReminderDraft(
      { ...base, type: "ecology_simulation", scenario: "rain" },
      ["tianjin"],
    ),
    null,
  );
  assert.equal(
    validReminderDraft({ ...base, time: "24:00" }, ["tianjin"]),
    null,
  );
});
test("weather intent and confirmation/cancellation retries remain idempotent after switching simulation to instant", async (t) => {
  const h = await setup(t),
    p = payload({ type: "weather", scenario: null });
  const r = (await call(h, p)).data.data,
    acceptance = { template_id: "local-in-app-v1", decision: "accept" };
  await call(h, acceptance, `intents/${r.id}/confirm/`);
  await call(h, acceptance, `intents/${r.id}/confirm/`);
  h.now = "2026-10-12T00:01:00.000Z";
  assert.equal((await call(h, p)).data.data.id, r.id);
  await call(h, {}, `${r.id}/cancel/`);
  await call(h, {}, `${r.id}/cancel/`);
  assert.equal(await h.store.count("web_reminders"), 1);
});
