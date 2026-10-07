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

async function loadRegions(application) {
  const regions = await loadAll(application.api, 'regions/');
  const selected = application.globalData.region;
  let index = selected ? regions.findIndex((region) => region.id === selected.id) : -1;
  if (index < 0) index = regions.findIndex((region) => region.slug === 'demo-campus');
  const regionIndex = Math.max(index, 0);
  // Callers commit the selection only after checking their own request generation.
  return { regions, regionIndex, region: regions[regionIndex] || null };
}

function selectRegion(application, region) {
  application.globalData.region = region || null;
}

module.exports = { loadAll, loadRegions, selectRegion };
