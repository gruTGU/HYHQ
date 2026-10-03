'use strict';
// Public data only. A bundled reviewed snapshot works before the first import;
// administrator-only catalog documents override it, including withdrawal tombstones.
const seed = require('../data/catalog.json');
const { ApiError, response, paginate, sha256 } = require('./core');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = { plants: '植物知识', water: '水资源保护', green: '绿色生活', travel: '生态智游' };
const PLANTS = { daisy: '雏菊类花卉', dandelion: '蒲公英类花卉', roses: '蔷薇属花卉', sunflowers: '向日葵类花卉', tulips: '郁金香类花卉' };
const PLACE_KINDS = ['river', 'lake', 'park', 'plant', 'waste', 'trail', 'campus', 'landmark'];
const SIM_NOTICE = '模拟数据，仅用于科普体验，不代表真实监测结果。';
const FIELDS = {
  regions: 'id slug name description is_demo',
  places: 'id slug name kind description region region_name is_demo map_layout x_ratio y_ratio latitude longitude coordinate_system source_note water_body_id',
  maps: 'id region name version image_url image_width image_height attribution points',
  stations: 'id code name kind region region_name place water_body',
  metrics: 'id code name unit station_kind min_value max_value description',
  data_sources: 'id code name kind license attribution original_url',
  observations: 'id station_id station_code station_name metric_code metric_name value unit observed_at ingested_at source_id source_name source_type is_simulated quality_status simulation_run_id',
  simulation_runs: 'id source scenario start end created_at counts generator_version',
  scenarios: 'id code name',
  water_bodies: 'id name kind region region_name is_demo description',
  contents: 'id title slug body summary category place place_summary plant_label source is_demo published_at updated_at',
  routes: 'id slug region region_name title description source is_demo stop_count stops',
};
function bad(message = '请求参数不正确') { throw new ApiError('VALIDATION_ERROR', message, 400); }
function missing(message = '未找到公开资料') { throw new ApiError('NOT_FOUND', message, 404); }
function pick(kind, item) {
  const result = {};
  for (const key of FIELDS[kind].split(' ')) if (Object.prototype.hasOwnProperty.call(item, key)) result[key] = item[key];
  return result;
}
function onlyOnce(query, keys = [...query.keys()]) { for (const key of keys) if (query.getAll(key).length > 1) bad('参数只能提供一次：' + key); }
function integer(query, key, fallback, low, high) {
  const value = query.has(key) ? query.get(key) : String(fallback);
  if (!/^[0-9]{1,7}$/.test(value) || Number(value) < low || Number(value) > high) bad(`${key} 必须为 ${low} 至 ${high} 的整数`);
  return Number(value);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) bad('请提供包含时区的 ISO 8601 时间');
  return Date.parse(value);
}
function sorted(items, ...keys) {
  return [...items].sort((a, b) => {
    for (const value of keys) {
      const descending = value[0] === '-'; const key = descending ? value.slice(1) : value;
      const x = String(a[key] || ''), y = String(b[key] || '');
      if (x !== y) return (x < y ? -1 : 1) * (descending ? -1 : 1);
    }
    return 0;
  });
}
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
const identifier = (rows, value, field = 'slug') => rows.find((row) => row.id === value || row[field] === value);

async function loadCatalog(ctx) {
  if (ctx._publicCatalogPromise) return ctx._publicCatalogPromise;
  ctx._publicCatalogPromise = (async () => {
    const snapshot = ctx.config && ctx.config.catalogSeed || seed;
    if (!snapshot || snapshot.schema_version !== 1 || !snapshot.collections) throw new ApiError('CATALOG_UNAVAILABLE', '公开资料暂不可用', 503);
    const values = {};
    for (const kind of Object.keys(FIELDS)) values[kind] = new Map((snapshot.collections[kind] || []).map((row) => [row.id, row]));
    let offset = 0;
    while (true) {
      const changes = await ctx.store.list('catalog', { limit: 100, offset, orderBy: [{ field: 'id', direction: 'asc' }] });
      for (const change of changes) {
        if (!Object.prototype.hasOwnProperty.call(values, change.kind)) continue;
        const id = change.value && change.value.id || String(change.id || '').slice(change.kind.length + 1);
        if (!UUID.test(id)) continue;
        if (change.deleted === true) values[change.kind].delete(id);
        else if (change.value && typeof change.value === 'object' && !Array.isArray(change.value)) values[change.kind].set(id, change.value);
      }
      offset += changes.length;
      if (changes.length < 100) break;
      if (offset >= 5000) throw new ApiError('CATALOG_LIMIT', '公开资料覆盖条目超过当前版本容量，请联系管理员', 503);
    }
    const raw = Object.fromEntries(Object.entries(values).map(([kind, entries]) => [kind, [...entries.values()]]));
    const regions = raw.regions.filter((row) => row.is_active !== false);
    const regionMap = byId(regions);
    const places = raw.places.filter((row) => row.is_published !== false && regionMap.has(row.region)).map((row) => ({ ...row,
      region_name: regionMap.get(row.region).name, is_demo: Boolean(regionMap.get(row.region).is_demo) }));
    const placeMap = byId(places);
    const water_bodies = raw.water_bodies.filter((row) => {
      const place = placeMap.get(row._place_id); return place && ['river', 'lake'].includes(place.kind);
    }).map((row) => { const place = placeMap.get(row._place_id); return { ...row, name: place.name, kind: place.kind,
      region: place.region, region_name: place.region_name, is_demo: place.is_demo }; });
    const waterMap = byId(water_bodies);
    const waterByPlace = new Map(water_bodies.map((row) => [row._place_id, row.id]));
    for (const place of places) place.water_body_id = waterByPlace.get(place.id) || null;
    const stations = raw.stations.filter((row) => row.is_active !== false && regionMap.has(row.region)
      && (!row.place || placeMap.has(row.place)) && (!row.water_body || waterMap.has(row.water_body)))
      .map((row) => ({ ...row, region_name: regionMap.get(row.region).name }));
    const stationMap = byId(stations);
    const metrics = raw.metrics.filter((row) => row.is_active !== false);
    const metricMap = new Map(metrics.map((row) => [row.code, row]));
    const data_sources = raw.data_sources.filter((row) => row.is_active !== false && ['simulation', 'api', 'dataset', 'manual'].includes(row.kind));
    const sourceMap = byId(data_sources);
    const simulation_runs = raw.simulation_runs.filter((row) => (!row.status || row.status === 'succeeded')
      && row.source && sourceMap.has(row.source.id) && sourceMap.get(row.source.id).kind === 'simulation')
      .map((row) => ({ ...row, source: pick('data_sources', sourceMap.get(row.source.id)) }));
    const runMap = byId(simulation_runs);
    const observations = raw.observations.filter((row) => stationMap.has(row.station_id) && metricMap.has(row.metric_code)
      && sourceMap.has(row.source_id) && (sourceMap.get(row.source_id).kind !== 'simulation'
        || (runMap.has(row.simulation_run_id) && runMap.get(row.simulation_run_id).source.id === row.source_id)))
      .map((row) => ({ ...row, station_code: stationMap.get(row.station_id).code, station_name: stationMap.get(row.station_id).name,
        metric_name: metricMap.get(row.metric_code).name, unit: metricMap.get(row.metric_code).unit,
        source_name: sourceMap.get(row.source_id).name, source_type: sourceMap.get(row.source_id).kind,
        is_simulated: sourceMap.get(row.source_id).kind === 'simulation' }));
    const contents = raw.contents.filter((row) => !row.status || row.status === 'published').map((row) => {
      const place = placeMap.get(row.place); return { ...row, _linked_place: row.place || null, place: place ? place.id : null,
        place_summary: place ? Object.fromEntries(['id', 'slug', 'name', 'kind', 'region', 'region_name', 'is_demo'].map((key) => [key, place[key]])) : null };
    });
    const routes = raw.routes.filter((row) => row.published !== false && regionMap.has(row.region)).map((row) => {
      const stops = (Array.isArray(row.stops) ? row.stops : []).filter((stop) => stop.place && placeMap.has(stop.place.id)
        && placeMap.get(stop.place.id).region === row.region).map((stop) => ({ id: stop.id, order: stop.order, note: stop.note,
          place: pick('places', placeMap.get(stop.place.id)) })).sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
      return { ...row, region_name: regionMap.get(row.region).name, stops, stop_count: stops.length };
    });
    const maps = raw.maps.filter((row) => row.is_active !== false && regionMap.has(row.region)).map((row) => ({ ...row,
      points: places.filter((place) => place.map_layout === row.id && place.region === row.region).map((place) => pick('places', place)) }));
    return { regions, places, maps, stations, metrics, data_sources, observations, simulation_runs, scenarios: raw.scenarios,
      water_bodies, contents, routes };
  })();
  return ctx._publicCatalogPromise;
}

function regionFor(ctx, catalog) {
  const region = identifier(catalog.regions, ctx.query.get('region') || 'demo-campus');
  if (!region) missing('未找到所选区域');
  return region;
}

function provenance(ctx, catalog, rows) {
  const query = ctx.query;
  onlyOnce(query, ['source_type', 'source', 'scenario', 'simulation_run']);
  const type = query.get('source_type') || 'simulation';
  if (!['simulation', 'api', 'dataset', 'manual'].includes(type)) bad('仅支持 api、dataset、simulation、manual 来源');
  let source = query.has('source') ? identifier(catalog.data_sources.filter((row) => row.kind === type), query.get('source'), 'code') : null;
  if (query.has('source') && !source) bad('数据源不存在、未启用或与 source_type 不一致');
  rows = rows.filter((row) => row.source_type === type && (!source || row.source_id === source.id));
  let run = null;
  if (type === 'simulation') {
    if (query.has('simulation_run') && !UUID.test(query.get('simulation_run'))) bad('批次 ID 必须为 UUID');
    let runs = catalog.simulation_runs.filter((candidate) => rows.some((row) => row.simulation_run_id === candidate.id));
    if (query.has('simulation_run')) runs = runs.filter((candidate) => candidate.id === query.get('simulation_run'));
    if (!query.has('simulation_run') || query.has('scenario')) {
      const scenario = query.get('scenario') || 'normal';
      if (!catalog.scenarios.some((row) => row.code === scenario)) bad('模拟场景不存在');
      runs = runs.filter((candidate) => candidate.scenario.code === scenario);
    }
    if (!source && new Set(runs.map((candidate) => candidate.source.id)).size > 1) bad('存在多个匹配来源，请指定 source，避免混合来源');
    run = sorted(runs, '-created_at', '-id')[0] || null;
    if (query.has('simulation_run') && !run) bad('未找到匹配站点、来源和场景的成功批次');
    source = run ? catalog.data_sources.find((row) => row.id === run.source.id) : source;
    rows = run ? rows.filter((row) => row.simulation_run_id === run.id && row.source_id === source.id) : [];
  } else {
    if (query.has('simulation_run') || query.has('scenario')) bad('非模拟来源不接受模拟批次或场景');
    const ids = new Set(rows.map((row) => row.source_id));
    if (!source && ids.size > 1) bad('存在多个来源，请指定 source，避免混合来源');
    if (!source && ids.size) source = catalog.data_sources.find((row) => row.id === [...ids][0]);
  }
  return { rows, source, run, source_type: type, is_simulated: type === 'simulation' };
}

function contentRows(ctx, catalog) {
  const query = ctx.query;
  onlyOnce(query, ['category', 'plant_label', 'place', 'region', 'search']);
  let rows = catalog.contents;
  if (query.get('category')) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, query.get('category'))) bad('无效的科普分类');
    rows = rows.filter((row) => row.category === query.get('category'));
  }
  if (query.get('plant_label')) {
    if (!/^[-a-zA-Z0-9_]{1,50}$/.test(query.get('plant_label'))) bad('植物标签格式无效');
    rows = rows.filter((row) => row.plant_label === query.get('plant_label'));
  }
  if (query.get('place')) {
    const place = identifier(catalog.places, query.get('place'));
    if (!place) missing('未找到公开地点');
    rows = rows.filter((row) => row.place === place.id);
  }
  if (query.get('region')) {
    const region = regionFor(ctx, catalog);
    rows = rows.filter((row) => !row._linked_place || (row.place_summary && row.place_summary.region === region.id));
  }
  const search = (query.get('search') || '').trim().toLowerCase();
  if (search.length > 100) bad('搜索词不能超过 100 个字符');
  if (search) rows = rows.filter((row) => [row.title, row.summary].some((text) => String(text || '').toLowerCase().includes(search)));
  return sorted(rows, '-published_at', '-_created_at', 'id');
}

function series(ctx, catalog) {
  onlyOnce(ctx.query, ['region', 'station', 'metrics', 'source_type', 'source', 'scenario', 'simulation_run', 'hours', 'start', 'end', 'max_points']);
  const region = regionFor(ctx, catalog);
  const station = identifier(catalog.stations.filter((row) => row.region === region.id), ctx.query.get('station'), 'code');
  if (!station) bad('请选择所选区域内的公开监测站');
  let metrics = sorted(catalog.metrics.filter((row) => row.station_kind === station.kind), 'code');
  if (ctx.query.has('metrics')) {
    const codes = ctx.query.get('metrics').split(',');
    if (codes.length < 1 || codes.length > 9 || new Set(codes).size !== codes.length || codes.some((code) => !code)) bad('请提供 1 至 9 个不重复指标代码');
    metrics = metrics.filter((row) => codes.includes(row.code));
    if (metrics.length !== codes.length) bad('指标不存在或不适用于该监测站');
  }
  if (metrics.length > 9) bad('请显式选择最多 9 个指标');
  const selected = provenance(ctx, catalog, catalog.observations.filter((row) => row.station_id === station.id));
  let start, end;
  if (ctx.query.has('start') || ctx.query.has('end')) {
    if (!ctx.query.has('start') || !ctx.query.has('end') || ctx.query.has('hours')) bad('请成对填写 start/end，且不要同时填写 hours');
    start = timestamp(ctx.query.get('start')); end = timestamp(ctx.query.get('end'));
  } else {
    const now = Date.parse(ctx.now);
    const latest = selected.rows.reduce((last, row) => { const time = Date.parse(row.observed_at); return time <= now ? Math.max(last, time) : last; }, 0);
    end = latest ? Math.min(latest + 1000, now) : now;
    start = end - integer(ctx.query, 'hours', 48, 1, 744) * 3600000;
  }
  if (start >= end || end - start > 31 * 86400000) bad('查询时间必须递增，跨度不能超过 31 天');
  const points = integer(ctx.query, 'max_points', 120, 1, 240);
  const bucketSeconds = Math.max(1, Math.ceil((end - start) / 1000 / points));
  const count = Math.ceil((end - start) / 1000 / bucketSeconds);
  const rows = sorted(selected.rows.filter((row) => metrics.some((metric) => row.metric_code === metric.code)
    && Date.parse(row.observed_at) >= start && Date.parse(row.observed_at) < end), 'observed_at', 'id');
  if (rows.length > 50000) bad('所选窗口超过 50000 条原始观测，请缩短时间范围');
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null;
  const output = metrics.map((metric) => {
    const samples = rows.filter((row) => row.metric_code === metric.code);
    const valid = samples.filter((row) => row.quality_status === 'valid' && Number.isFinite(row.value)).map((row) => row.value);
    const buckets = Array.from({ length: count }, () => []);
    for (const sample of samples) buckets[Math.min(count - 1, Math.floor((Date.parse(sample.observed_at) - start) / 1000 / bucketSeconds))].push(sample);
    return { metric: { code: metric.code, name: metric.name, unit: metric.unit },
      latest: samples.length ? Object.fromEntries(['value', 'observed_at', 'quality_status'].map((key) => [key, samples[samples.length - 1][key]])) : null,
      summary: { valid_count: valid.length, missing_count: samples.filter((row) => row.quality_status === 'missing').length,
        suspect_count: samples.filter((row) => row.quality_status === 'suspect').length,
        min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null, mean: mean(valid) },
      points: buckets.map((bucket, index) => {
        const values = bucket.filter((row) => row.quality_status === 'valid' && Number.isFinite(row.value)).map((row) => row.value);
        const missingCount = bucket.filter((row) => row.quality_status === 'missing').length;
        const suspect = bucket.filter((row) => row.quality_status === 'suspect').length;
        const quality = suspect ? 'suspect' : (missingCount || !values.length ? 'missing' : 'valid');
        return { at: new Date(start + index * bucketSeconds * 1000).toISOString(), value: quality === 'valid' ? mean(values) : null,
          min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
          valid_count: values.length, missing_count: missingCount, suspect_count: suspect, quality_status: quality };
      }) };
  });
  return { region: pick('regions', region), station: pick('stations', station), source: selected.source ? pick('data_sources', selected.source) : null,
    source_type: selected.source_type, is_simulated: selected.is_simulated, simulation_run_id: selected.run && selected.run.id,
    status: rows.length ? 'available' : 'unavailable', window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    bucket_seconds: bucketSeconds, series: output,
    notice: (selected.is_simulated ? SIM_NOTICE : '仅展示所选来源的观测，请核对来源与时间。') + '统计仅使用有效值；缺失、可疑和无记录时段保持断线，不作水质评级或官方 AQI。' };
}

function excerpt(text, terms) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  const found = terms.map((term) => text.toLowerCase().indexOf(term.toLowerCase())).filter((index) => index >= 0);
  const start = found.length ? Math.max(0, Math.min(...found) - 55) : 0;
  return (start ? '…' : '') + text.slice(start, start + 360) + (text.length > start + 360 ? '…' : '');
}

function knowledgeSearch(ctx, catalog) {
  const allowed = ['q', 'kind', 'category', 'plant_label', 'place', 'region', 'page', 'page_size'];
  onlyOnce(ctx.query);
  if ([...ctx.query.keys()].some((key) => !allowed.includes(key))) bad('不支持的检索参数');
  const query = Object.fromEntries(['q', 'kind', 'category', 'plant_label', 'place', 'region'].map((key) => [key, (ctx.query.get(key) || '').trim()]));
  query.kind ||= 'all'; query.page = integer(ctx.query, 'page', 1, 1, 1000); query.page_size = integer(ctx.query, 'page_size', 10, 1, 20);
  if (query.q.length > 100 || query.q.split(/\s+/).filter(Boolean).length > 5) bad('最多检索 5 个关键词、100 个字符');
  if (!['all', 'content', 'route', 'place'].includes(query.kind) || (query.category && !Object.prototype.hasOwnProperty.call(CATEGORIES, query.category))
    || (query.plant_label && !/^[-a-zA-Z0-9_]{1,50}$/.test(query.plant_label))) bad('检索分类或标签无效');
  if (!['q', 'category', 'plant_label', 'place', 'region'].some((key) => query[key])) bad('请输入关键词，或选择标签、地点、区域后检索');
  if ((query.category || query.plant_label) && !['all', 'content'].includes(query.kind)) bad('分类和植物标签仅适用于科普手记');
  for (const [key, rows] of [['place', catalog.places], ['region', catalog.regions]]) {
    if (query[key]) { const item = identifier(rows, query[key]); if (!item) bad('未找到公开的地点或区域'); query[key] = item.id; }
  }
  const terms = query.q.split(/\s+/).filter(Boolean);
  const candidates = [];
  for (const [kind, collection] of [['content', catalog.contents], ['route', catalog.routes], ['place', catalog.places]]) {
    if (query.kind !== 'all' && query.kind !== kind) continue;
    if ((query.category || query.plant_label) && kind !== 'content') continue;
    for (const item of collection) {
      if (kind === 'content' && item._linked_place && !item.place) continue;
      const region = kind === 'content' ? item.place_summary && item.place_summary.region : item.region;
      if (query.region && (kind !== 'content' || item._linked_place) && region !== query.region) continue;
      if (query.place && (kind === 'content' ? item.place !== query.place : kind === 'place' ? item.id !== query.place : !item.stops.some((stop) => stop.place.id === query.place))) continue;
      if ((query.category && item.category !== query.category) || (query.plant_label && item.plant_label !== query.plant_label)) continue;
      const title = kind === 'place' ? item.name : item.title;
      const text = kind === 'content' ? item.body : item.description;
      const fields = kind === 'content' ? [title, item.summary, text, item.plant_label, item.place_summary && item.place_summary.name] : [title, text, item.region_name];
      if (!terms.every((term) => fields.some((field) => String(field || '').toLowerCase().includes(term.toLowerCase())))) continue;
      const score = terms.reduce((sum, term) => sum + (String(title).toLowerCase().includes(term.toLowerCase()) ? 4 : 1), 0);
      candidates.push({ score, id: item.id, kind, title, excerpt: excerpt(text || item.summary, terms),
        source: (kind === 'place' ? item.source_note : item.source) || '平台管理员整理，未提供外部来源',
        source_path: `/api/v1/${{ content: 'contents', route: 'routes', place: 'places' }[kind]}/${item.id}/`,
        updated_at: item.updated_at || item._updated_at || null, is_demo: Boolean(item.is_demo),
        region_name: kind === 'content' ? item.place_summary && item.place_summary.region_name || '' : item.region_name,
        category: item.category || '', plant_label: item.plant_label || '' });
    }
  }
  candidates.sort((a, b) => b.score - a.score || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = candidates.length, end = query.page * query.page_size;
  return { query, count, page: query.page, has_more: count > end,
    results: candidates.slice(end - query.page_size, end).map(({ score, ...row }) => row),
    answer_kind: count ? 'published_excerpts' : 'no_evidence',
    answer: count ? `检索到 ${count} 份已发布资料，以下为原文片段，请打开来源核对。` : '没有找到匹配的已发布资料，无法依据本站资料回答。可尝试更短的关键词或减少筛选条件。',
    notice: '这里只检索本站已发布资料，按关键词匹配，不联网搜索，不生成实时天气、水质或安全结论。模拟资料会单独标注。' };
}

async function getPublicItem(ctx, kind, id) {
  if (!Object.prototype.hasOwnProperty.call(FIELDS, kind)) return null;
  const catalog = await loadCatalog(ctx);
  const item = catalog[kind].find((row) => row.id === id);
  return item ? pick(kind, item) : null;
}

function boundedPublicContext(value) {
  const context = structuredClone(value), limit = 6000;
  // Preserve the current page first. Repeated short fields (UUIDs, paths,
  // coordinates) cannot be shrunk by the gateway's long-text clipping alone.
  while (Buffer.byteLength(JSON.stringify(context)) > limit) {
    const field = ['places', 'routes', 'articles', 'measurements', 'stops'].find(key => Array.isArray(context[key]) && context[key].length);
    if (field) {
      context[field].pop();
      context[field === 'stops' ? 'primary_material_truncated' : 'supplemental_material_truncated'] = true;
      continue;
    }
    const candidates = [];
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === 'string' && !['id', 'source', 'source_note', 'source_path'].includes(key) && Buffer.byteLength(child) > 200)
          candidates.push({ node, key, bytes: Buffer.byteLength(child) });
        else if (child && typeof child === 'object') collect(child);
      }
    };
    collect(context); candidates.sort((a, b) => b.bytes - a.bytes);
    const largest = candidates[0];
    if (!largest) throw new ApiError('SOURCE_CONTEXT_TOO_LARGE', '资料结构超过当前解读容量，请选择具体文章或地点', 409);
    largest.node[largest.key] = Buffer.from(largest.node[largest.key]).subarray(0, Math.floor(largest.bytes / 2)).toString('utf8').replace(/\uFFFD$/g, '');
    largest.node[largest.key + '_truncated'] = true; context.primary_material_truncated = true;
  }
  return context;
}

async function getContext(ctx, type, id) {
  // Re-read overrides even in the same invocation, so edits and withdrawal
  // during a provider call invalidate its result.
  delete ctx._publicCatalogPromise;
  const kind = { region: 'regions', place: 'places', content: 'contents', route: 'routes', water: 'water_bodies' }[type];
  const item = kind && await getPublicItem(ctx, kind, id);
  if (!item) throw new ApiError('SOURCE_UNAVAILABLE', '关联资料已删除或下架，请重新选择', 409);
  const title = item.title || item.name;
  const source = item.source || item.source_note || (item.is_demo ? '平台模拟科普资料' : '平台管理员公开资料');
  const context = { ...item, context_kind: type, notice: item.is_demo ? SIM_NOTICE : '仅供已发布资料解读，不代表实时环境监测结果。' };
  const current = await loadCatalog(ctx), regionId = type === 'region' ? id : item.region || item.place_summary && item.place_summary.region || null;
  const region = current.regions.find((row) => row.id === regionId);
  const cite = (kind, row) => ({ kind, id: row.id, title: row.title || row.name,
    source: row.source || row.source_note || (row.is_demo ? '平台模拟科普资料' : '平台管理员公开资料'),
    source_path: kind === 'region' ? '/api/v1/regions/' : `/api/v1/${{ content: 'contents', place: 'places', water: 'water-bodies', route: 'routes' }[kind]}/${row.id}/` });
  const citations = [{ ...cite(type, item), source }];
  if (region && type !== 'region') context.region_info = pick('regions', region);
  const waterPlace = type === 'water' && current.water_bodies.find((row) => row.id === id)._place_id;
  const linkedPlace = type === 'place' ? id : waterPlace || (type === 'content' ? item.place : null);
  const place = linkedPlace && current.places.find((row) => row.id === linkedPlace);
  if (place && type !== 'place') context.place_info = pick('places', place);
  let related = [];
  if (type === 'region') {
    context.places = sorted(current.places.filter((row) => row.region === id), 'name', 'id').slice(0, 6).map((row) => pick('places', row));
    context.routes = sorted(current.routes.filter((row) => row.region === id), 'title', 'id').slice(0, 3).map((row) => ({ id: row.id, title: row.title,
      description: row.description.slice(0, 350), source: row.source, is_demo: row.is_demo, source_path: cite('route', row).source_path }));
    related = current.contents.filter((row) => !row._linked_place || row.place_summary && row.place_summary.region === id).slice(0, 3);
  } else if (['place', 'water'].includes(type)) related = current.contents.filter((row) => row.place === linkedPlace).slice(0, 3);
  else if (type === 'route') related = current.contents.filter((row) => item.stops.some((stop) => stop.place.id === row.place)).slice(0, 2);
  if (related.length) context.articles = related.map((row) => ({ id: row.id, title: row.title, body: String(row.body || '').slice(0, 500),
    body_truncated: String(row.body || '').length > 500, source: row.source, is_demo: row.is_demo, source_path: cite('content', row).source_path }));
  citations.push(...related.map((row) => cite('content', row)));
  if (['region', 'place', 'water'].includes(type)) {
    const stations = current.stations.filter((row) => type === 'region' ? row.region === id
      : type === 'water' ? row.water_body === id : row.place === id || (item.water_body_id && row.water_body === item.water_body_id));
    context.measurements = [];
    for (const station of sorted(stations, 'code').slice(0, 2)) {
      const candidates = current.observations.filter((row) => row.station_id === station.id && Date.parse(row.observed_at) <= Date.parse(ctx.now));
      let selected;
      try { selected = provenance({ query: new URLSearchParams('source_type=simulation') }, current, candidates); }
      catch (error) {
        if (error.code !== 'VALIDATION_ERROR') throw error;
        context.measurements.push({ station: station.name, status: 'ambiguous_source', notice: '来源不唯一，未自动合并指标。' }); continue;
      }
      if (!selected.run) continue;
      const metrics = sorted(current.metrics.filter((row) => row.station_kind === station.kind), 'code').slice(0, 4).flatMap((metric) => {
        const row = [...selected.rows].filter((row) => row.metric_code === metric.code).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || b.id.localeCompare(a.id))[0];
        return row ? [{ metric: metric.name, code: metric.code, unit: metric.unit, value: Number.isFinite(row.value) ? row.value : null,
          quality: row.quality_status, observed_at: row.observed_at }] : [];
      });
      if (metrics.length) context.measurements.push({ station: station.name, station_id: station.id, source: selected.source.name,
        source_kind: 'simulation', is_simulated: true, simulation_run_id: selected.run.id, metrics,
        source_path: `/api/v1/observations/?station=${station.id}&simulation_run=${selected.run.id}`,
        notice: '模拟历史数据，非实时实测；不能判定水质等级、官方 AQI 或饮用安全。' });
    }
  }
  // Hash the server-owned complete selection, including omitted excerpts, so
  // edits during an external call cannot be concealed by the display budget.
  const revision = sha256(JSON.stringify(context)), bounded = boundedPublicContext(context);
  const includedArticles = new Set((bounded.articles || []).map(row => row.id));
  return { context: bounded, title, source_region_id: regionId,
    citations: citations.filter(row => row.kind === type && row.id === id || row.kind !== 'content' || includedArticles.has(row.id)), revision };
}

async function handle(ctx) {
  const route = ctx.path.replace(/^\//, '');
  if (route === 'community/status/' && ctx.method === 'GET') return response({ enabled: false, reason: '评论与举报暂未开放。', max_comment_length: 500 });
  if (route.startsWith('community/')) throw new ApiError('COMMUNITY_DISABLED', '评论与举报暂未开放。', 503);
  if (route === 'narrations/' && ctx.method === 'GET') {
    const keys = [...ctx.query.keys()];
    if (keys.length !== 1 || !['content', 'route'].includes(keys[0]) || !UUID.test(ctx.query.get(keys[0]))) bad('须提供且只提供一个文章或路线 ID');
    return response(null);
  }
  if (route.startsWith('narrations/')) missing('正式授权讲解音频尚未配置');
  const known = ['regions', 'places', 'maps', 'stations', 'metrics', 'data-sources', 'observations', 'observation-series', 'simulation-runs',
    'weather', 'air-quality', 'weather-alerts', 'dashboard', 'water-bodies', 'nearby-water-bodies', 'contents', 'routes', 'content-tags', 'knowledge-search'];
  const match = /^([^/]+)\/(?:([^/]+)\/)?$/.exec(route);
  if (!match || !known.includes(match[1])) return undefined;
  if (ctx.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', '公开资料仅支持读取', 405);
  const name = match[1], id = match[2], catalog = await loadCatalog(ctx), query = ctx.query;
  onlyOnce(query);
  if (id) {
    if (!['places', 'contents', 'routes', 'water-bodies'].includes(name) || !UUID.test(id)) missing();
    const item = await getPublicItem(ctx, name.replace('-', '_'), id);
    if (!item) missing();
    return response(item);
  }
  if (name === 'knowledge-search') return response(knowledgeSearch(ctx, catalog));
  if (name === 'observation-series') return response(series(ctx, catalog));
  if (name === 'contents') return paginate(ctx, contentRows(ctx, catalog).map((row) => pick('contents', row)));
  if (name === 'content-tags') {
    const rows = contentRows(ctx, catalog), categories = [], labels = new Map();
    for (const [value, label] of Object.entries(CATEGORIES)) { const count = rows.filter((row) => row.category === value).length; if (count) categories.push({ value, name: label, count }); }
    for (const row of rows) if (row.plant_label) labels.set(row.plant_label, (labels.get(row.plant_label) || 0) + 1);
    return response({ categories, plant_labels: [...labels.entries()].sort().map(([value, count]) => ({ value, name: PLANTS[value] || value, count })), content_count: rows.length });
  }
  if (name === 'nearby-water-bodies') {
    for (const field of ['latitude', 'lat', 'longitude', 'lng']) if (query.has(field) && !query.get(field).trim()) bad('经纬度不能为空');
    const latitude = Number(query.get('latitude') ?? query.get('lat')), longitude = Number(query.get('longitude') ?? query.get('lng'));
    const coordinates = query.get('coordinate_system');
    if (!(query.has('latitude') || query.has('lat')) || !(query.has('longitude') || query.has('lng')) || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !['GCJ02', 'WGS84'].includes(coordinates)) bad('请提供有效经纬度及 GCJ02 或 WGS84 坐标系');
    let best = null, distance = 2000;
    const rad = Math.PI / 180;
    for (const station of sorted(catalog.stations.filter((row) => row.kind === 'water' && row.place && row.water_body), 'id')) {
      const place = catalog.places.find((row) => row.id === station.place);
      if (!place || place.coordinate_system !== coordinates || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
      const a = Math.sin((place.latitude - latitude) * rad / 2) ** 2 + Math.cos(latitude * rad) * Math.cos(place.latitude * rad) * Math.sin((place.longitude - longitude) * rad / 2) ** 2;
      const meters = 2 * 6371000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
      if (meters < distance) { distance = meters; best = station; }
    }
    const water = best && catalog.water_bodies.find((row) => row.id === best.water_body);
    return response({ match: best && water ? { water_body_id: water.id, water_body_name: water.name, station_id: best.id, distance_m: Math.round(distance), suggestion_only: true } : null });
  }
  const region = ['maps', 'weather', 'air-quality', 'weather-alerts', 'dashboard', 'simulation-runs'].includes(name) || query.get('region') ? regionFor(ctx, catalog) : null;
  if (['weather', 'air-quality', 'weather-alerts', 'dashboard'].includes(name)) {
    if (name === 'weather-alerts') return response({ region: pick('regions', region), source_type: 'simulation', is_simulated: true, status: 'not_connected', observed_at: null, alerts: [], notice: '此为模拟区域摘要，官方气象预警请查看真实天气模块；空列表不代表当前没有真实预警。' });
    if (name !== 'dashboard' && (query.get('source_type') || 'simulation') !== 'simulation') bad('天气及空气摘要仅启用模拟来源');
    const kind = name === 'weather' ? 'weather' : name === 'air-quality' ? 'air' : null;
    const stations = catalog.stations.filter((row) => row.region === region.id && (!kind || row.kind === kind));
    let selected = provenance(ctx, catalog, catalog.observations.filter((row) => stations.some((station) => station.id === row.station_id)));
    if (kind && selected.rows.length) { const code = sorted(selected.rows, 'station_code')[0].station_code; selected.rows = selected.rows.filter((row) => row.station_code === code); }
    const observed = sorted(selected.rows, '-observed_at')[0];
    const rows = observed ? sorted(selected.rows.filter((row) => row.observed_at === observed.observed_at), 'station_code', 'metric_code') : [];
    if (name === 'dashboard') return response({ region: pick('regions', region), source_type: selected.source_type, is_simulated: selected.is_simulated,
      observed_at: observed && observed.observed_at || null, place_count: catalog.places.filter((row) => row.region === region.id).length,
      station_count: stations.length, observation_count: selected.rows.length, latest_observations: rows.map((row) => pick('observations', row)), notice: '按单一来源和模拟批次展示，无综合生态指数及官方水质评级。' });
    const metricValues = Object.fromEntries(rows.map((row) => [row.metric_code, row.value]));
    const station = observed && catalog.stations.find((row) => row.id === observed.station_id);
    return response({ region: pick('regions', region), source_type: 'simulation', is_simulated: true, source: selected.source ? pick('data_sources', selected.source) : null,
      station: station ? pick('stations', station) : null, simulation_run_id: selected.run && selected.run.id, status: rows.length ? 'available' : 'unavailable',
      observed_at: observed && observed.observed_at || null, metrics: rows.map((row) => ({ metric_code: row.metric_code, name: row.metric_name, value: row.value, unit: row.unit, quality_status: row.quality_status })),
      notice: SIM_NOTICE, ...(kind === 'weather' ? { temperature: metricValues.temperature ?? null, humidity: metricValues.humidity ?? null, condition: '模拟天气' }
        : { pm25: metricValues.pm25 ?? null, pm10: metricValues.pm10 ?? null, no2: metricValues.no2 ?? null, aqi: null, aqi_standard: null }) });
  }
  if (name === 'simulation-runs') {
    let stations = catalog.stations.filter((row) => row.region === region.id);
    if (query.has('station')) { const station = identifier(stations, query.get('station'), 'code'); if (!station) bad('所选区域没有此公开监测站'); stations = [station]; }
    let rows = catalog.simulation_runs.map((run) => ({ ...run, counts: catalog.observations.filter((row) => row.simulation_run_id === run.id && stations.some((station) => station.id === row.station_id)).length })).filter((run) => run.counts);
    if (query.has('source')) { const source = identifier(catalog.data_sources.filter((row) => row.kind === 'simulation'), query.get('source'), 'code'); if (!source) bad('模拟来源不存在'); rows = rows.filter((row) => row.source.id === source.id); }
    if (query.has('scenario')) { if (!catalog.scenarios.some((row) => row.code === query.get('scenario'))) bad('模拟场景不存在'); rows = rows.filter((row) => row.scenario.code === query.get('scenario')); }
    return paginate(ctx, sorted(rows, '-created_at', '-id').map((row) => pick('simulation_runs', row)));
  }
  if (name === 'observations') {
    let rows = catalog.observations;
    if (region) rows = rows.filter((row) => catalog.stations.some((station) => station.id === row.station_id && station.region === region.id));
    if (query.get('station')) { const station = identifier(catalog.stations, query.get('station'), 'code'); if (!station) bad('监测站不存在'); rows = rows.filter((row) => row.station_id === station.id); }
    if (query.get('metric')) { const metric = identifier(catalog.metrics, query.get('metric'), 'code'); if (!metric) bad('指标不存在'); rows = rows.filter((row) => row.metric_code === metric.code); }
    rows = provenance(ctx, catalog, rows).rows;
    const latest = sorted(rows, '-observed_at')[0];
    const end = query.has('end') ? timestamp(query.get('end')) : latest ? Date.parse(latest.observed_at) + 1000 : Date.parse(ctx.now);
    const start = query.has('start') ? timestamp(query.get('start')) : end - 48 * 3600000;
    if (start >= end || end - start > 31 * 86400000) bad('查询时间必须递增，且跨度不能超过 31 天');
    rows = sorted(rows.filter((row) => Date.parse(row.observed_at) >= start && Date.parse(row.observed_at) < end), 'observed_at', 'station_code', 'metric_code').slice(0, integer(query, 'limit', 1000, 1, 1000));
    return paginate(ctx, rows.map((row) => pick('observations', row)));
  }
  const key = name.replace('-', '_');
  let rows = catalog[key];
  if (region) rows = rows.filter((row) => row.region === region.id);
  if (['places', 'stations'].includes(name) && query.get('kind')) {
    if (!(name === 'places' ? PLACE_KINDS : ['water', 'weather', 'air']).includes(query.get('kind'))) bad('无效的地点或监测站类型');
    rows = rows.filter((row) => row.kind === query.get('kind'));
  }
  if (name === 'stations') {
    for (const [field, collection] of [['place', catalog.places], ['water_body', catalog.water_bodies]]) if (query.get(field)) {
      const item = identifier(collection, query.get(field)); if (!item) bad('无效的公开地点或水体'); rows = rows.filter((row) => row[field] === item.id);
    }
  }
  rows = name === 'metrics' ? sorted(rows, 'station_kind', 'code') : sorted(rows, name === 'routes' ? 'title' : ['data-sources', 'stations'].includes(name) ? 'code' : 'name', 'id');
  return paginate(ctx, rows.map((row) => pick(key, row)));
}

module.exports = { handle, loadCatalog, getPublicItem, getContext, pick, UUID };
