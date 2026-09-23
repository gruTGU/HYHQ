/** Static artwork coordinates are image-relative; they are never latitude/longitude. */
const DEMO_IMAGE = '/assets/maps/demo-campus-v1.png';
const GROUPS = { water: ['river', 'lake'], park: ['park'], campus: ['campus', 'plant', 'waste'], walk: ['trail', 'landmark'] };

function dimensions(layout) {
  const width = layout && layout.image_width;
  const height = layout && layout.image_height;
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 8192 && height <= 8192 ? { width, height } : null;
}
function imageResource(layout, region) {
  if (!layout) return { src: '', notice: '当前区域尚未配置静态导览图，可先浏览下方地点。' };
  if (!region || layout.region !== region.id) return { src: '', notice: '底图不属于当前区域，可先浏览下方地点。' };
  if (!dimensions(layout)) return { src: '', notice: '底图尺寸配置无效，可先浏览下方地点。' };
  const src = layout.image_url;
  if (!src) return { src: '', notice: '此版本尚未配置底图，可先浏览下方地点。' };
  if (src === DEMO_IMAGE && region && region.slug === 'demo-campus' && region.is_demo === true && layout.region === region.id && layout.version === 1 && layout.image_width === 1000 && layout.image_height === 700) return { src, notice: '' };
  // Local resources must be explicitly registered. Never swap in a demo image for another map.
  if (typeof src === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[^\s\\<>]*$/i.test(src)) return { src, notice: '' };
  return { src: '', notice: '当前底图地址尚未受支持，请管理员配置 HTTPS 图片或已登记的本地底图。地点列表仍可使用。' };
}
function matchesType(point, type) { return !type || (GROUPS[type] || []).includes(point.kind); }
function mapPoints(layout, region) {
  if (!layout || !layout.id || !region || layout.region !== region.id || !Array.isArray(layout.points)) return [];
  const seen = new Set();
  return layout.points.filter((point) => {
    if (!point || !point.id || seen.has(point.id) || point.map_layout !== layout.id || point.region !== region.id) return false;
    if (![point.x_ratio, point.y_ratio].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return false;
    seen.add(point.id);
    return true;
  });
}
function geometry(layout, availableWidth, zoom) {
  const size = dimensions(layout);
  if (!size || !Number.isFinite(availableWidth) || availableWidth <= 0) return null;
  const scale = Number.isFinite(zoom) ? Math.max(1, Math.min(3, zoom)) : 1;
  const width = availableWidth;
  const height = width * size.height / size.width;
  // The viewport always has the same aspect ratio as the image. No contain/cover letterbox offset.
  return { viewportWidth: width, viewportHeight: height, mapWidth: width * scale, mapHeight: height * scale, zoom: scale };
}
function projection(point, metrics) { return { x: point.x_ratio * metrics.mapWidth, y: point.y_ratio * metrics.mapHeight }; }
function clampPan(x, y, metrics) {
  return { x: Math.max(metrics.viewportWidth - metrics.mapWidth, Math.min(0, Number.isFinite(x) ? x : 0)), y: Math.max(metrics.viewportHeight - metrics.mapHeight, Math.min(0, Number.isFinite(y) ? y : 0)) };
}
function zoomPan(oldMetrics, nextMetrics, oldX, oldY) {
  if (!oldMetrics) return { x: 0, y: 0 };
  const ratio = nextMetrics.mapWidth / oldMetrics.mapWidth;
  return clampPan(nextMetrics.viewportWidth / 2 - (oldMetrics.viewportWidth / 2 - oldX) * ratio, nextMetrics.viewportHeight / 2 - (oldMetrics.viewportHeight / 2 - oldY) * ratio, nextMetrics);
}
module.exports = { DEMO_IMAGE, dimensions, imageResource, matchesType, mapPoints, geometry, projection, clampPan, zoomPan };
