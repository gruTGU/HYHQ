"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ecology = require("../backend/ecology-reminders.cjs");
const actions = () => import("../frontend/src/lib/notification-actions.js");

test("actual and previously stored simulation notices have no navigation action", async () => {
  const { notificationWeatherHref, isSimulationNotification } = await actions();
  const generated = ecology.notification();
  for (const row of [
    generated,
    { ...generated, href: "/weather" },
    { type: "ecology_simulation", href: "/weather?location=tianjin" },
    { simulation: true, href: "/weather" },
    { recurrence: "simulation_preview", href: "/weather" },
  ]) {
    assert.equal(isSimulationNotification(row), true);
    assert.equal(notificationWeatherHref(row), null);
  }
});

test("weather notices keep their city link and old untyped weather records remain usable", async () => {
  const { notificationWeatherHref } = await actions();
  assert.equal(
    notificationWeatherHref({
      type: "weather",
      href: "/weather?location=tianjin",
    }),
    "/weather?location=tianjin",
  );
  assert.equal(
    notificationWeatherHref({ href: "/weather?location=beijing" }),
    "/weather?location=beijing",
  );
  assert.equal(notificationWeatherHref({ type: "weather" }), "/weather");
});

test("unknown notifications do not default to weather and text cannot select actions", async () => {
  const { notificationWeatherHref } = await actions();
  for (const row of [
    undefined,
    {},
    { title: "天气预约", body: "天津天气" },
    { type: "message", href: "/weather?location=tianjin" },
    { href: "https://example.com/weather" },
    { href: "/weather?location=tianjin&next=https://example.com" },
  ])
    assert.equal(notificationWeatherHref(row), null);
  assert.equal(
    notificationWeatherHref({
      type: "weather",
      title: "生态观察",
      href: "javascript:alert(1)",
    }),
    "/weather",
  );
});
