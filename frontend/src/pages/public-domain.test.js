import test from "node:test";
import assert from "node:assert/strict";
import {
  chartGeometry,
  gcjToWgs,
  navigable,
  rangeQuery,
  publicStops,
  apiPagePath,
  numeric,
  formatTime,
  pageResponse,
  loadAll,
} from "./public-domain.js";

test("missing and suspect buckets break chart segments while a real zero remains visible", () => {
  const points = [
    { at: "2026-01-01T00:00:00Z", value: 0, quality_status: "valid" },
    { at: "2026-01-01T01:00:00Z", value: null, quality_status: "missing" },
    { at: "2026-01-01T02:00:00Z", value: 2, quality_status: "valid" },
    { at: "2026-01-01T03:00:00Z", value: 500, quality_status: "suspect" },
    { at: "2026-01-01T04:00:00Z", value: 4, quality_status: "valid" },
  ];
  const plot = chartGeometry(points, {
    start: "2026-01-01T00:00:00Z",
    end: "2026-01-01T05:00:00Z",
  });
  assert.equal(plot.segments.length, 3);
  assert.equal(plot.segments[0][0].point.value, 0);
  assert.ok(plot.max < 5);
  assert.equal(numeric(null), "—");
  assert.equal(numeric(0), "0");
  assert.notEqual(formatTime(Date.parse(points[0].at)), "—");
});
test("simulation window follows selected batch and clips its start", () => {
  assert.deepEqual(
    rangeQuery(
      { start: "2026-01-01T00:00:00Z", end: "2026-01-01T12:00:00Z" },
      48,
    ),
    { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T12:00:00.000Z" },
  );
  assert.throws(() =>
    rangeQuery({ start: "2026-01-02", end: "2026-01-01" }, 48),
  );
});
test("public place navigation requires reviewed coordinates and publication", () => {
  const p = {
    is_demo: false,
    is_published: true,
    coordinates_verified: true,
    coordinate_system: "GCJ02",
    latitude: 39.9,
    longitude: 116.4,
  };
  assert.equal(navigable(p), true);
  assert.equal(navigable({ ...p, coordinates_verified: false }), false);
  assert.equal(navigable({ ...p, is_demo: true }), false);
  assert.equal(navigable({ ...p, is_published: false }), false);
  assert.equal(navigable({ ...p, latitude: null }), false);
});
test("GCJ coordinates convert to WGS for OSM without moving foreign coordinates", () => {
  const p = gcjToWgs(39.916527, 116.397128);
  assert.ok(p[0] > 39.914 && p[0] < 39.916);
  assert.ok(p[1] > 116.39 && p[1] < 116.392);
  assert.deepEqual(gcjToWgs(51.5, -0.12), [51.5, -0.12]);
});
test("route only browses uniquely identified published response stops in explicit order", () => {
  const stops = publicStops({
    stops: [
      { id: "b", order: 2, place: { id: "pb" } },
      { id: "a", order: 1, place: { id: "pa" } },
      { id: "a", order: 0, place: { id: "pa" } },
      { id: "missing", order: 3 },
      { id: "invalid", order: -1, place: { id: "pc" } },
    ],
  });
  assert.deepEqual(
    stops.map((s) => [s.id, s.position]),
    [
      ["a", 1],
      ["b", 2],
    ],
  );
});
test("pagination cannot leave the current endpoint", () => {
  assert.equal(
    apiPagePath("https://legacy.example/api/v1/contents/?page=2", "contents/"),
    "contents/?page=2",
  );
  assert.throws(() => apiPagePath("/api/v1/favorites/", "contents/"));
  assert.throws(() => apiPagePath("contents/?page=2#fragment", "contents/"));
});

test("strict page metadata rejects repeat pages even when query order or explicit page=1 differs", () => {
  assert.throws(() =>
    pageResponse(
      {
        data: [],
        meta: {
          next: "/api/v1/contents/?page=1&region=tianjin-nature&page_size=20",
        },
      },
      "contents/?page_size=20&region=tianjin-nature",
      "contents/",
    ),
  );
  for (const next of [false, 2, {}, []])
    assert.throws(() =>
      pageResponse({ data: [], meta: { next } }, "contents/", "contents/"),
    );
  assert.equal(
    pageResponse({ data: [], meta: { next: null } }, "contents/", "contents/")
      .next,
    "",
  );
});
test("loadAll follows actual backend next metadata preserving filters and requested page size", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { paginate } = require("../../../backend/vendor/lib/core.js");
  const source = Array.from({ length: 205 }, (_, i) => ({ id: "item-" + i })),
    requests = [];
  const rows = await loadAll(
    async (path, options = {}) => {
      const url = new URL(path, "https://test.invalid/api/v1/");
      for (const [k, v] of Object.entries(options.data || {}))
        url.searchParams.set(k, String(v));
      requests.push(url);
      return paginate({ path: "contents/", query: url.searchParams }, source)
        .data;
    },
    "contents/",
    { region: "tianjin-nature", category: "water" },
  );
  assert.equal(rows.length, 205);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((u) => u.searchParams.get("page") || "1"),
    ["1", "2", "3"],
  );
  for (const u of requests) {
    assert.equal(u.searchParams.get("page_size"), "100");
    assert.equal(u.searchParams.get("region"), "tianjin-nature");
    assert.equal(u.searchParams.get("category"), "water");
  }
});
