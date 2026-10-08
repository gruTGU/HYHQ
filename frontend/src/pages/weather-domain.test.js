import test from "node:test";
import assert from "node:assert/strict";
import {
  weatherSection,
  currentAlerts,
  validDailyDays,
  summaryView,
  refreshDeadline,
  createWeatherCache,
  validBookingDraft,
  validateWeatherResponse,
  nearestWeatherCity,
} from "./weather-domain.js";
const NOW = Date.parse("2026-10-08T02:00:00Z");
const iso = (n) => new Date(n).toISOString();
const slot = (data, expires = NOW + 3600000) => ({
  status: "fresh",
  stale: false,
  fetched_at: iso(NOW - 60000),
  expires_at: iso(expires),
  observed_at: iso(NOW - 60000),
  data,
});
const row = (date = "2026-10-08", overrides = {}) => ({
  date,
  starts_at: date + "T00:00:00+08:00",
  ends_at: date + "T23:59:59+08:00",
  temperature_min: 0,
  temperature_max: 20,
  temperature_unit: "°C",
  daytime: {},
  nighttime: {},
  ...overrides,
});
const summary = (city = "tianjin", expires = NOW + 3600000) => ({
  location: { slug: city, name: city },
  weather: slot({ temperature: 20, temperature_unit: "°C" }, expires),
  air: slot({ aqi: 30 }, expires),
  alerts: {
    ...slot({ items: [], zero_result: true }, expires),
    status: "empty",
  },
  daily: slot({ days: [row(), row("2026-10-09")] }, expires),
});

test("elapsed source expiry turns displayed fresh weather and air into stale data", () => {
  assert.equal(
    weatherSection(slot({ temperature: 20 }), NOW, "weather").status,
    "fresh",
  );
  assert.equal(
    weatherSection(slot({ temperature: 20 }), NOW + 3600000, "weather").status,
    "stale",
  );
  assert.equal(
    weatherSection(
      { ...slot({ aqi: 5 }), observed_at: iso(NOW - 4 * 3600000) },
      NOW,
      "air",
    ).status,
    "stale",
  );
  assert.equal(
    weatherSection(
      { ...slot({ temperature: 20 }), fetched_at: iso(NOW + 1) },
      NOW,
      "weather",
    ).data,
    null,
  );
});
test("expired, future-effective and cancellation alerts do not remain active", () => {
  const raw = slot({
    items: [
      { id: "active", expires_at: iso(NOW + 120000) },
      { id: "expired", expires_at: iso(NOW) },
      {
        id: "future",
        effective_at: iso(NOW + 1000),
        expires_at: iso(NOW + 120000),
      },
      { id: "cancel", message_type: "Cancel", expires_at: iso(NOW + 120000) },
    ],
  });
  assert.deepEqual(
    currentAlerts(raw, NOW).map((x) => x.id),
    ["active"],
  );
  assert.deepEqual(currentAlerts(raw, NOW + 120000), []);
  assert.equal(
    refreshDeadline(
      {
        location: { slug: "tianjin" },
        weather: slot({}),
        air: slot({}),
        alerts: raw,
        daily: slot({}),
      },
      NOW,
    ),
    NOW + 120000,
  );
});
test("forecast removes ended and malformed days and never turns wrong units or inverted ranges into Celsius", () => {
  const raw = slot({
    days: [
      row("2026-10-07"),
      row("2026-10-08", { temperature_unit: "°F" }),
      row("2026-10-09", { temperature_min: 30, temperature_max: 20 }),
      row("2026-10-10", { starts_at: "invalid" }),
    ],
  });
  const days = validDailyDays(raw, NOW);
  assert.deepEqual(
    days.map((x) => x.date),
    ["2026-10-08", "2026-10-09"],
  );
  assert.equal(days[0].temperature_min, null);
  assert.equal(days[1].temperature_max, null);
  assert.equal(
    validDailyDays(slot({ days: [row()] }), NOW)[0].temperature_min,
    0,
  );
});
test("summary extrema disappear at expiry and honor explicit unavailable today", () => {
  const raw = summary();
  assert.equal(summaryView(raw, NOW).today.temperature_min, 0);
  assert.equal(summaryView(raw, NOW + 3600000).today, undefined);
  raw.daily.data.today = null;
  assert.equal(summaryView(raw, NOW).today, undefined);
  assert.ok(summaryView(raw, NOW).tomorrow);
});
test("cache hits never extend original source expiry, and storage failure does not discard a valid response", async () => {
  let time = NOW,
    calls = 0;
  const cache = createWeatherCache({
    now: () => time,
    scope: "test",
    storage: {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    },
    fetcher: async () => {
      calls++;
      return summary("tianjin", NOW + 120000);
    },
  });
  await cache.request("summary", "tianjin");
  assert.equal(calls, 1);
  time += 60000;
  await cache.request("summary", "tianjin");
  assert.equal(calls, 1);
  assert.equal(cache.read("summary", "tianjin").refreshAt, NOW + 120000);
  time += 60000;
  await cache.request("summary", "tianjin");
  assert.equal(calls, 2);
});
test("failure backoff is isolated per city and endpoint, with explicit retry available", async () => {
  const counts = {};
  const cache = createWeatherCache({
    now: () => NOW,
    fetcher: async (mode, city) => {
      const k = mode + city;
      counts[k] = (counts[k] || 0) + 1;
      if (city === "tianjin" && mode === "summary") throw new Error("offline");
      return mode === "forecast"
        ? { location: { slug: city }, forecast: slot({ days: [row()] }) }
        : summary(city);
    },
  });
  await assert.rejects(cache.request("summary", "tianjin"));
  await assert.rejects(cache.request("summary", "tianjin"));
  assert.equal(counts.summarytianjin, 1);
  await cache.request("summary", "beijing");
  await cache.request("forecast", "tianjin");
  assert.equal(counts.summarybeijing, 1);
  assert.equal(counts.forecasttianjin, 1);
  await assert.rejects(cache.request("summary", "tianjin", { force: true }));
  assert.equal(counts.summarytianjin, 2);
});
test("cached responses and AI booking drafts cannot silently change the selected place or timezone", () => {
  assert.throws(() => validateWeatherResponse(summary("beijing"), "tianjin"));
  const draft = {
    location: "tianjin",
    timezone: "Asia/Shanghai",
    scheduled_for: iso(NOW + 3600000),
  };
  assert.ok(validBookingDraft(draft, ["tianjin"], NOW));
  assert.equal(
    validBookingDraft({ ...draft, timezone: "UTC" }, ["tianjin"], NOW),
    null,
  );
  assert.equal(
    validBookingDraft(
      { ...draft, scheduled_for: iso(NOW + 1000) },
      ["tianjin"],
      NOW,
    ),
    null,
  );
  assert.equal(validBookingDraft(draft, ["beijing"], NOW), null);
});

test("weather geolocation never claims a distant unsupported city as nearby", () => {
  const cities = [
    ["tianjin", "天津", 39.09, 117.2],
    ["beijing", "北京", 39.9, 116.41],
  ];
  assert.equal(
    nearestWeatherCity(
      { latitude: 39.1, longitude: 117.19, accuracy: 1000 },
      cities,
    )?.[0],
    "tianjin",
  );
  assert.equal(
    nearestWeatherCity(
      { latitude: 51.5, longitude: -0.12, accuracy: 100 },
      cities,
    ),
    null,
  );
  assert.equal(
    nearestWeatherCity(
      { latitude: 39.1, longitude: 117.19, accuracy: 60000 },
      cities,
    ),
    null,
  );
});
