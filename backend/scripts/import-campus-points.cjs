"use strict";

// Append-only import. Native source IDs are the join key; changing an existing
// record requires a separate reviewed migration rather than silently replacing it.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const sourcePath = path.join(__dirname, "../data/sources/jingjin-campus-coordinates-20261008.json");
const outputPath = path.join(__dirname, "../data/campus-map-points.json");
const base = require("../vendor/data/map-reference-points");
const cities = { "天津市": ["天津", "tianjin-nature"], "北京市": ["北京", "beijing-nature"] };
const sha256 = value => createHash("sha256").update(value).digest("hex");

function validateSource(source) {
  if (source.schema_version !== "hyhq.campus_coordinates.v1" || source.coordinate_system !== "GCJ-02"
    || !Array.isArray(source.locations) || source.count !== source.locations.length)
    throw new Error("Invalid campus source schema or count");
  const ids = new Set(), pois = new Set();
  for (const row of source.locations) {
    if (typeof row.id !== "string" || !/^(tj|bj)_[a-z0-9_]+$/.test(row.id) || ids.has(row.id)
      || typeof row.poi_id !== "string" || !/^\d+$/.test(row.poi_id) || pois.has(row.poi_id))
      throw new Error("Campus source IDs and string POI IDs must be unique");
    if (!cities[row.city] || (row.id.startsWith("tj_") ? row.city !== "天津市" : row.city !== "北京市")
      || row.coordinate_system !== "GCJ-02" || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)
      || row.latitude < 38 || row.latitude > 42 || row.longitude < 114 || row.longitude > 119
      || row.point_type !== "campus_poi_reference" || row.review_status !== "campus_identity_checked"
      || row.navigation_verified !== false || row.coordinate_ground_verified !== false
      || !row.title || !row.university || !row.campus || !row.review_reason || !row.source
      || !Array.isArray(row.evidence_urls) || !row.evidence_urls.length || !Array.isArray(row.limitations))
      throw new Error("Invalid or unreviewed campus record: " + row.id);
    ids.add(row.id); pois.add(row.poi_id);
  }
}

function normalize(row, source, sourceId) {
  const [city, regionSlug] = cities[row.city];
  const hash = sha256(row.id).slice(0, 12);
  return {
    id: "reference-" + sourceId.toLowerCase() + "-poi-" + hash,
    source_id: sourceId, source_ids: [sourceId], source_record_id: row.id,
    // The suffix and record mapping remain stable even when input order changes.
    marker_id: 200000000 + Number(sourceId.split("-")[1]),
    region_slug: regionSlug, name: row.title, title: row.title, kind: "campus",
    university: row.university, campus: row.campus, city, district: row.district,
    latitude: row.latitude, longitude: row.longitude, coordinate_system: "GCJ02",
    address: row.poi_address, poi_title: row.poi_title, poi_category: row.poi_category, poi_id: row.poi_id,
    access_note: source.usage.point_scope, checked_at: source.reviewed_on,
    point_type: row.point_type, provider: "tencent", editorial_status: "reviewed",
    identity_confirmed: true, review_status: row.review_status,
    navigation_verified: false, coordinate_ground_verified: false,
    source_note: "用户提供的腾讯地图校园 POI；校区身份已结合校方资料核对",
    source_entity_names: [...new Set([row.title, row.poi_title, row.university, row.source.query].filter(Boolean))],
    review_reason: row.review_reason, evidence_urls: row.evidence_urls, limitations: row.limitations,
    review_scope: source.usage.review_scope, point_scope: source.usage.point_scope,
    source: row.source,
  };
}

function mergeCampusPoints(source, existing = { locations: [] }, legacy = base.locations) {
  validateSource(source);
  const locations = [...(existing.locations || [])];
  const known = new Map(locations.map(row => [row.source_record_id, row]));
  const all = [...legacy, ...locations];
  const ids = new Set(all.map(row => row.id));
  const pois = new Set(all.map(row => row.poi_id).filter(Boolean));
  const markers = new Set(all.map(row => row.marker_id));
  if (known.size !== locations.length || ids.size !== all.length
    || pois.size !== all.filter(row => row.poi_id).length || markers.size !== all.length)
    throw new Error("Existing map data contains duplicate identities");
  let sequence = locations.reduce((max, row) => Math.max(max, Number(row.source_id.split("-")[1])), 0);
  for (const row of [...source.locations].sort((a, b) => a.id.localeCompare(b.id))) {
    const previous = known.get(row.id);
    if (previous) {
      if (!isDeepStrictEqual(previous, normalize(row, source, previous.source_id)))
        throw new Error("Campus record changed; refusing to overwrite: " + row.id);
      continue;
    }
    if (sequence >= 999) throw new Error("Campus source ID range exhausted");
    const point = normalize(row, source, "CAMPUS-" + String(++sequence).padStart(3, "0"));
    if (ids.has(point.id) || pois.has(point.poi_id) || markers.has(point.marker_id))
      throw new Error("Campus conflicts with an existing map point: " + row.id);
    locations.push(point); ids.add(point.id); pois.add(point.poi_id); markers.add(point.marker_id);
  }
  return { ...existing, schema_version: 1, updated_on: source.reviewed_on,
    source: "京津双一流高校校区坐标（用户提供）", scope_note: source.usage.point_scope,
    locations };
}

function importFile(input = sourcePath, output = outputPath) {
  const raw = fs.readFileSync(input);
  const source = JSON.parse(raw);
  const exists = fs.existsSync(output);
  const previous = exists ? fs.readFileSync(output, "utf8") : "";
  const existing = exists ? JSON.parse(previous) : { locations: [] };
  const merged = mergeCampusPoints(source, existing);
  const record = { source_file: path.basename(input), sha256: sha256(raw),
    upstream_source_sha256: source.source_file_sha256, reviewed_on: source.reviewed_on,
    count: source.count, review_scope: source.usage.review_scope };
  const imports = [...(existing.imports || [])];
  if (!imports.some(item => item.sha256 === record.sha256)) imports.push(record);
  merged.imports = imports;
  const next = JSON.stringify(merged, null, 2) + "\n";
  if (next !== previous) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = output + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, next);
    fs.renameSync(temporary, output);
  }
  return { added: merged.locations.length - existing.locations.length, total: merged.locations.length, changed: next !== previous };
}

if (require.main === module) console.log(JSON.stringify(importFile(process.argv[2], process.argv[3])));
module.exports = { mergeCampusPoints, importFile, sourcePath, outputPath };
