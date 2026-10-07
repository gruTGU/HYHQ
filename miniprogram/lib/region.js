const DEFAULT_REGION_SLUG = 'tianjin-nature';
function cityRegion(region) {
  const names = { 'tianjin-nature': '天津', 'beijing-nature': '北京' };
  return names[region.slug] ? Object.assign({}, region, { name: names[region.slug] }) : region;
}
function isDemoRegion(region) { return !!region && (region.is_demo === true || region.slug === 'demo-campus'); }

/** Public catalogues are paged; never present a truncated first page as the whole list. */
async function loadAll(api, path, params, options) {
  let next = path;
  let first = true;
  const seen = new Set();
  const result = [];
  while (next) {
    if (seen.has(next) || seen.size >= 20) throw new Error('目录较大或分页异常，请缩小筛选范围后重试。');
    seen.add(next);
    const response = await api.request(next, first ? Object.assign({}, options, { data: Object.assign({ page_size: 100 }, params || {}) }) : options);
    if (!response || !Array.isArray(response.data)) throw new Error('目录返回格式不正确，请稍后重试。');
    result.push(...response.data);
    next = response.meta && response.meta.next || null;
    first = false;
  }
  return result;
}

async function loadRegions(application, options = {}) {
  let regions = (await loadAll(application.api, 'regions/')).map(cityRegion);
  // Keep the standalone legacy demonstration backend usable; the real-city guide has no demo option.
  if (options.realGuide && ((application.config && application.config.transport === 'cloud-function') || regions.some(region => region.real_map && !isDemoRegion(region)))) regions = regions.filter(region => !isDemoRegion(region));
  const selected = application.globalData.region;
  let index = selected ? regions.findIndex((region) => region.id === selected.id) : -1;
  // Home loads before the guide after a restart, so the default belongs here.
  if (index < 0) index = regions.findIndex((region) => region.slug === DEFAULT_REGION_SLUG);
  if (index < 0) index = regions.findIndex((region) => region.slug === 'demo-campus');
  const regionIndex = Math.max(index, 0);
  // Callers commit the selection only after checking their own request generation.
  return { regions, regionIndex, region: regions[regionIndex] || null };
}

function selectRegion(application, region) {
  application.globalData.region = region || null;
}

module.exports = { loadAll, loadRegions, selectRegion, DEFAULT_REGION_SLUG, isDemoRegion, cityRegion };
