'use strict';
// Only explicit, reviewed GCJ-02 coordinates may become a navigable map overlay.
const coordinate = point => !!point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
  && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180;
const source = value => typeof value === 'string' && /^https:\/\/[^\s\\<>]+$/i.test(value);
const checked = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function verifiedPoint(row) {
  return row.coordinates_verified === true && row.coordinate_system === 'GCJ02' && coordinate(row)
    && source(row.source_url) && checked(row.checked_at);
}
function verifiedRiver(row) {
  return row.geometry_verified === true && row.coordinate_system === 'GCJ02' && source(row.source_url) && checked(row.checked_at)
    && Array.isArray(row.path) && row.path.length >= 2 && row.path.length <= 200 && row.path.every(coordinate);
}
module.exports = { coordinate, source, checked, verifiedPoint, verifiedRiver };
