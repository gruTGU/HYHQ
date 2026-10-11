"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { SQLiteStore } = require("../backend/store.cjs");
const reminders = require("../backend/reminders.cjs");
const daily = require("../backend/daily-reminders.cjs");
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hyhq-daily-"));
  const filename = path.join(dir, "test.db"),
    h = {
      store: new SQLiteStore(filename),
      filename,
      user: { id: "daily-user", is_active: true },
      now: "2026-10-11T23:00:00.000Z",
      query: new URLSearchParams(),
    };
  await h.store.set("users", h.user.id, h.user);
  t.after(async () => {
    await h.store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return h;
}
const call = (h, body, route = "daily/") =>
  reminders.handle({
    ...h,
    method: "POST",
    path: "weather-data/reminders/" + route,
    body,
  });
const subscribe = (h, body = { location: "tianjin", time: "08:00" }) =>
  call(h, body);
async function cache(h, condition = "晴", night = "多云") {
  await h.store.set("weather_cache", "tianjin_daily", {
    kind: "daily",
    location: "tianjin",
    fetched_at: "2026-10-11T23:00:00.000Z",
    expires_at: "2026-10-12T05:00:00.000Z",
    payload: {
      data: {
        schema_version: 2,
        days: [
          {
            starts_at: "2026-10-11T16:00:00.000Z",
            ends_at: "2026-10-12T16:00:00.000Z",
            daytime: { condition },
            nighttime: { condition: night },
            temperature_unit: "°C",
            temperature_min: 16.8,
            temperature_max: 23.9,
          },
        ],
      },
    },
  });
}
test("daily schedule uses Beijing time across midnight and year boundaries", () => {
  assert.equal(
    daily.nextTime("08:00", "2026-10-11T23:00:00.000Z"),
    "2026-10-12T00:00:00.000Z",
  );
  assert.equal(
    daily.nextTime("08:00", "2026-10-12T00:00:00.000Z"),
    "2026-10-13T00:00:00.000Z",
  );
  assert.equal(
    daily.nextTime("00:05", "2026-12-31T16:10:00.000Z"),
    "2027-01-01T16:05:00.000Z",
  );
});
test("daily endpoint validates input, owns its record and retries idempotently", async (t) => {
  const h = await setup(t);
  for (const body of [
    { location: "shanghai", time: "08:00" },
    { location: "tianjin", time: "24:00" },
    { location: "tianjin", time: "8:00" },
    { location: "tianjin", time: "08:00", owner_id: "other" },
  ])
    await assert.rejects(subscribe(h, body), { code: "VALIDATION_ERROR" });
  await assert.rejects(subscribe({ ...h, user: null }), { status: 401 });
  const first = (await subscribe(h)).data.data;
  assert.equal(first.next_scheduled_for, "2026-10-12T00:00:00.000Z");
  h.now = "2026-10-12T00:01:00.000Z";
  const second = (await subscribe(h)).data.data;
  assert.equal(second.next_scheduled_for, first.next_scheduled_for);
  assert.equal(await h.store.count("web_daily_reminders"), 1);
  const visible = await reminders.handle({
    ...h,
    method: "GET",
    path: "weather-data/reminders/",
  });
  assert.equal(visible.data.data.daily.enabled, true);
  assert.equal(visible.data.data.daily.owner_id, undefined);
});
test("concurrent ticks deliver one cache-backed daily notification and survive a restart", async (t) => {
  const h = await setup(t);
  await cache(h);
  await subscribe(h);
  const results = await Promise.all([
    reminders.runDue(h.store, "2026-10-12T00:01:00.000Z"),
    reminders.runDue(h.store, "2026-10-12T00:01:00.000Z"),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.daily_sent, 0),
    1,
  );
  const rows = await h.store.list("web_notifications");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "天津 · 晴，16～23℃");
  assert.match(rows[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(rows[0].channel, "local_in_app");
  await h.store.close();
  h.store = new SQLiteStore(h.filename);
  await reminders.runDue(h.store, "2026-10-12T04:00:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 1);
  await reminders.runDue(h.store, "2026-10-13T00:01:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 2);
  assert.equal(await h.store.count("weather_requests"), 0);
});
test("late restart skips missed days and cancellation/re-enable cannot send twice that day", async (t) => {
  const h = await setup(t);
  await subscribe(h);
  await reminders.runDue(h.store, "2026-10-20T02:00:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 1);
  h.now = "2026-10-20T03:00:00.000Z";
  await call(h, {}, "daily/cancel/");
  await subscribe(h, { location: "beijing", time: "18:00" });
  await reminders.runDue(h.store, "2026-10-20T11:00:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 1);
  await reminders.runDue(h.store, "2026-10-21T11:00:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 2);
});
test("cancelled and inactive accounts receive nothing and other users cannot alter a subscription", async (t) => {
  const h = await setup(t);
  await subscribe(h);
  const other = { ...h, user: { id: "other", is_active: true } };
  await h.store.set("users", "other", other.user);
  await call(other, {}, "daily/cancel/");
  assert.equal(
    (await h.store.get("web_daily_reminders", h.user.id)).enabled,
    true,
  );
  await call(h, {}, "daily/cancel/");
  await reminders.runDue(h.store, "2026-10-12T00:01:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 0);
  await subscribe(h);
  await h.store.update("users", h.user.id, { is_active: false });
  await reminders.runDue(h.store, "2026-10-12T00:01:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 0);
  assert.equal(
    (await h.store.get("web_daily_reminders", h.user.id)).enabled,
    false,
  );
});
test("late worker before today's chosen time waits until that time", async (t) => {
  const h = await setup(t);
  await subscribe(h);
  await reminders.runDue(h.store, "2026-10-20T23:00:00.000Z");
  assert.equal(await h.store.count("web_notifications"), 0);
  assert.equal(
    (await h.store.get("web_daily_reminders", h.user.id)).next_scheduled_for,
    "2026-10-21T00:00:00.000Z",
  );
});
test("weather content never invents stale forecasts and chooses the nighttime forecast", async (t) => {
  const h = await setup(t);
  await cache(h);
  assert.equal(
    await daily.weatherBody(
      h.store,
      "tianjin",
      "2026-10-12",
      "05:00",
      "2026-10-12T00:00:00.000Z",
    ),
    "天津 · 夜间多云，16～23℃",
  );
  assert.match(
    await daily.weatherBody(
      h.store,
      "tianjin",
      "2026-10-12",
      "08:00",
      "2026-10-12T06:00:00.000Z",
    ),
    /暂无可用天气缓存/,
  );
  assert.equal(await h.store.count("weather_requests"), 0);
});

test("processing a full page never skips remaining one-time reservations", async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 101; i++)
    await h.store.set("web_reminders", `pending-${i}`, {
      owner_id: h.user.id,
      location: "tianjin",
      state: "pending",
      scheduled_for: "2026-10-11T00:00:00.000Z",
    });
  const result = await reminders.runDue(h.store, h.now);
  assert.equal(result.sent, 101);
  assert.equal(await h.store.count("web_reminders", { state: "pending" }), 0);
});

test("daily notification temperatures require an explicit Celsius unit and ordered range", async (t) => {
  const h = await setup(t);
  await cache(h);
  const row = await h.store.get("weather_cache", "tianjin_daily");
  const base = row.payload.data.days[0];
  async function summary(patch, time = "08:00") {
    await h.store.set("weather_cache", "tianjin_daily", {
      ...row,
      payload: { data: { schema_version: 2, days: [{ ...base, ...patch }] } },
    });
    return daily.weatherBody(
      h.store,
      "tianjin",
      "2026-10-12",
      time,
      "2026-10-12T00:00:00.000Z",
    );
  }
  for (const temperature_unit of ["C", "℃", "°C", "celsius"])
    assert.equal(await summary({ temperature_unit }), "天津 · 晴，16～23℃");
  for (const temperature_unit of [undefined, null, "F", "°F", "fahrenheit", ""])
    assert.equal(await summary({ temperature_unit }), "天津 · 晴");
  assert.equal(await summary({ temperature_max: null }), "天津 · 晴，最低16℃");
  assert.equal(await summary({ temperature_min: null }), "天津 · 晴，最高23℃");
  assert.equal(
    await summary({ temperature_min: 23.9, temperature_max: 23.1 }),
    "天津 · 晴",
  );
  assert.equal(
    await summary({ temperature_min: "16", temperature_max: "23" }),
    "天津 · 晴",
  );
  assert.equal(
    await summary({ temperature_min: -101, temperature_max: 101 }),
    "天津 · 晴",
  );
  assert.equal(
    await summary({ temperature_min: -4.9, temperature_max: 0 }),
    "天津 · 晴，-4～0℃",
  );
  assert.equal(await summary({}, "19:29"), "天津 · 晴，16～23℃");
  assert.equal(await summary({}, "19:30"), "天津 · 夜间多云，16～23℃");
  assert.equal(await summary({}, "05:59"), "天津 · 夜间多云，16～23℃");
  assert.equal(await summary({}, "06:00"), "天津 · 晴，16～23℃");
  assert.equal(
    await summary({ nighttime: { condition: "小雨" } }, "20:00"),
    "天津 · 夜间小雨，16～23℃",
  );
  assert.equal(await summary({ nighttime: null }, "20:00"), "天津 · 16～23℃");
  assert.equal(
    await summary({ nighttime: null, temperature_unit: null }, "20:00"),
    "天津 · 暂无可用天气缓存",
  );
  assert.equal(await h.store.count("weather_requests"), 0);
});

test("one-time weather reminders use the same concise city forecast as daily messages", async (t) => {
  const h = await setup(t);
  await cache(h);
  const created = (
    await call(
      h,
      { location: "tianjin", scheduled_for: "2026-10-12T00:00:00.000Z" },
      "intents/",
    )
  ).data.data;
  await call(
    h,
    { template_id: "local-in-app-v1", decision: "accept" },
    `intents/${created.id}/confirm/`,
  );
  await reminders.runDue(h.store, "2026-10-12T00:00:00.000Z");
  const notice = await h.store.get("web_notifications", created.id);
  assert.equal(notice.body, "天津 · 晴，16～23℃");
  assert.equal(await h.store.count("weather_requests"), 0);
});
