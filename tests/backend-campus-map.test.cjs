"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const original = require("../backend/vendor/data/map-reference-points");
const references = require("../backend/vendor/data/all-map-reference-points");
const campuses = require("../backend/data/campus-map-points.json");
const source = require("../backend/data/sources/jingjin-campus-coordinates-20261008.json");
const importer = require("../backend/scripts/import-campus-points.cjs");
const mapContext = require("../backend/vendor/lib/map-reference-context");
const catalog = require("../backend/vendor/lib/catalog");

test("campus import adds exactly 20 reviewed campuses and preserves every original reference", () => {
  assert.equal(original.locations.length, 211);
  assert.equal(references.locations.length, 231);
  assert.deepEqual(references.locations.slice(0, 211), original.locations);
  assert.equal(campuses.locations.length, 20);
  assert.equal(campuses.locations.filter(row => row.city === "天津").length, 8);
  assert.equal(campuses.locations.filter(row => row.city === "北京").length, 12);
  assert.equal(references.locations.filter(row => row.kind === "campus").length, 21);
  for (const key of ["id", "marker_id", "poi_id"]) {
    const values = references.locations.map(row => row[key]).filter(value => value !== "" && value != null);
    assert.equal(new Set(values).size, values.length, key);
  }
  for (const row of source.locations) {
    const point = campuses.locations.find(item => item.source_record_id === row.id);
    assert.ok(point, row.id);
    assert.equal(point.kind, "campus");
    assert.equal(point.coordinate_system, "GCJ02");
    assert.equal(point.longitude, row.longitude);
    assert.equal(point.latitude, row.latitude);
    assert.equal(point.poi_id, row.poi_id);
    assert.equal(typeof point.poi_id, "string");
    assert.equal(point.region_slug, row.city === "天津市" ? "tianjin-nature" : "beijing-nature");
    assert.equal(point.navigation_verified, false);
    assert.equal(point.coordinate_ground_verified, false);
    assert.equal(point.review_reason, row.review_reason);
    assert.deepEqual(point.evidence_urls, row.evidence_urls);
    assert.deepEqual(point.limitations, row.limitations);
    assert.deepEqual(point.source, row.source);
  }
});

test("re-running and reordering import is idempotent; conflicts cannot overwrite points", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hyhq-campus-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "campuses.json");
  assert.deepEqual(importer.importFile(importer.sourcePath, output), { added: 20, total: 20, changed: true });
  const before = fs.readFileSync(output, "utf8");
  assert.deepEqual(importer.importFile(importer.sourcePath, output), { added: 0, total: 20, changed: false });
  assert.equal(fs.readFileSync(output, "utf8"), before);
  assert.deepEqual(importer.mergeCampusPoints({ ...source, locations: [...source.locations].reverse() }, campuses), campuses);
  const modified = structuredClone(source);
  modified.locations[0].longitude += 0.01;
  assert.throws(() => importer.mergeCampusPoints(modified, campuses), /refusing to overwrite/);
  const conflict = { ...original.locations[0], poi_id: source.locations[0].poi_id };
  assert.throws(() => importer.mergeCampusPoints(source, { locations: [] }, [conflict]), /conflicts with an existing/);
  const numericPoi = structuredClone(source);
  numericPoi.locations[0].poi_id = Number(numericPoi.locations[0].poi_id);
  assert.throws(() => importer.mergeCampusPoints(numericPoi), /string POI IDs/);
  const invalid = structuredClone(source);
  invalid.locations[0].coordinate_system = "WGS84";
  assert.throws(() => importer.mergeCampusPoints(invalid), /Invalid or unreviewed/);
});

test("each campus is selectable in the RAG whitelist and matched ahead of sibling campuses", async () => {
  const ctx = { store: { list: async () => [] }, config: {}, now: "2026-10-08T16:00:00.000Z" };
  const current = await catalog.loadCatalog(ctx);
  for (const point of campuses.locations) {
    assert.equal(mapContext.validReferenceId(point.id), true);
    const row = mapContext.referenceFor(current, point.id);
    assert.ok(row, point.id);
    assert.equal(row.name, point.name);
    assert.equal(row.poi_id, point.poi_id);
    assert.equal(row.review_status, "campus_identity_checked");
    assert.equal(row.coordinate_ground_verified, false);
    assert.equal(row.navigation_verified, false);
    assert.match(row.notice, /不保证为校门/);
    assert.deepEqual(row.evidence_urls, point.evidence_urls);
    assert.deepEqual(mapContext.reviewedMaterialsFor(row), []);
    const pool = mapContext.forRegion(current, row.region);
    assert.equal(mapContext.searchReferences(pool, `${point.university} ${point.campus}在哪里`)[0]?.id, point.id);
    const result = await catalog.getContext(ctx, "map_reference", point.id, { scope: "explore", question: point.name });
    assert.equal(result.context.id, point.id);
    assert.ok(result.citations.some(citation => citation.id === point.id && citation.kind === "map_reference"));
  }
  const tianjin = current.regions.find(row => row.slug === "tianjin-nature");
  const pool = mapContext.forRegion(current, tianjin.id);
  for (const question of ["天工大", "畔湖", "天津工业大学"]) {
    assert.deepEqual(mapContext.searchReferences(pool, question).map(row => row.name), ["天津工业大学"]);
  }
  assert.equal(mapContext.referenceFor(current, "reference-campus-999-poi-123456789abc"), null);
  assert.deepEqual(mapContext.searchReferences(pool, "清华大学北京校区在哪里"), []);
});

test("public map API and city filters expose the same combined reference catalog", async t => {
  const { SQLiteStore } = require("../backend/store.cjs");
  const { createServer } = require("../backend/server.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hyhq-campus-http-"));
  const store = new SQLiteStore(path.join(directory, "test.sqlite3"));
  const server = createServer({ store, config: { sessionSecret: "campus-test-secret", llmEnabled: false }, timers: false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port + "/api/v1/";
  const get = async endpoint => {
    const response = await fetch(base + endpoint);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const all = await get("web/map-points/");
  assert.deepEqual(all.locations, references.locations);
  assert.deepEqual(all.points, all.locations);
  assert.equal((await get("web/config/")).map.points, 231);
  for (const [city, count] of [["tianjin", 8], ["beijing", 12]]) {
    const selected = await get("web/map-points/?region_slug=" + city + "-nature");
    assert.ok(selected.locations.every(row => row.region_slug === city + "-nature"));
    assert.equal(selected.locations.filter(row => row.source_record_id).length, count);
  }
});
