'use strict';

// Both public map routes and the RAG whitelist consume this exact catalog.
// Keep the original reference bundle intact; campus imports are append-only.
const original = require('./map-reference-points');
const campuses = require('../../data/campus-map-points.json');
const locations = [...original.locations, ...campuses.locations];
for (const key of ['id', 'marker_id', 'poi_id']) {
  const values = locations.map(row => row[key]).filter(value => value !== '' && value != null);
  if (new Set(values).size !== values.length) throw new Error('Duplicate map point ' + key);
}

module.exports = { ...original,
  updated_on: [original.updated_on, campuses.updated_on].sort().at(-1),
  provenance: { ...original.provenance, campus_imports: campuses.imports },
  locations,
};
