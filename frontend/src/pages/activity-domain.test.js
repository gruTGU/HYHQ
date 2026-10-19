import test from "node:test";
import assert from "node:assert/strict";
import {
  chinaDay,
  eventDates,
  eventEnded,
  eventInMonth,
  upcomingEvents,
  eventLocationLink,
  validEnvironmentDescription,
} from "./activity-domain.js";

test("activity dates use the Shanghai day at the UTC boundary", () => {
  assert.equal(chinaDay(Date.parse("2026-10-18T16:01:00Z")), "2026-10-19");
});
test("calendar includes events across month and year boundaries", () => {
  const event = { start_date: "2026-12-25", end_date: "2027-01-08" };
  assert.equal(eventInMonth(event, 2026, 12), true);
  assert.equal(eventInMonth(event, 2027, 1), true);
  assert.equal(eventInMonth(event, 2027, 2), false);
  assert.equal(eventInMonth({}, 2026, 1), false);
});
test("UTC event times are displayed in Shanghai and same-day expired activities are excluded", () => {
  const event = {
    starts_at: "2026-09-30T16:00:00Z",
    ends_at: "2026-10-19T01:00:00Z",
  };
  assert.deepEqual(eventDates(event), {
    start: "2026-10-01",
    end: "2026-10-19",
  });
  assert.equal(eventInMonth(event, 2026, 9), false);
  assert.equal(eventEnded(event, Date.parse("2026-10-19T02:00:00Z")), true);
  assert.deepEqual(
    upcomingEvents([event], Date.parse("2026-10-19T02:00:00Z")),
    [],
  );
});
test("nearby activities include ongoing events and exclude expired or distant events", () => {
  const events = [
    { id: "past", start_date: "2026-10-01", end_date: "2026-10-18" },
    { id: "ongoing", start_date: "2026-10-01", end_date: "2026-10-20" },
    { id: "next", start_date: "2026-11-01", end_date: "2026-11-02" },
    { id: "later", start_date: "2026-12-01", end_date: "2026-12-02" },
  ];
  assert.deepEqual(
    upcomingEvents(events, Date.parse("2026-10-19T02:00:00Z")).map((e) => e.id),
    ["ongoing", "next"],
  );
});
test("map links encode IDs and feedback requires an actual observation", () => {
  assert.equal(
    eventLocationLink({ map_reference_id: "a&b" }),
    "/explore?reference_id=a%26b",
  );
  assert.equal(validEnvironmentDescription("   "), false);
  assert.equal(validEnvironmentDescription("看见河岸有垃圾"), true);
  assert.equal(validEnvironmentDescription("字".repeat(1001)), false);
});
