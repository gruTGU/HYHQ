export const CATEGORY_NAMES = {
  plants: "植物知识",
  water: "水资源保护",
  green: "绿色生活",
  travel: "生态智游",
};
export const PLANT_NAMES = {
  daisy: "雏菊类花卉",
  dandelion: "蒲公英类花卉",
  roses: "蔷薇属花卉",
  sunflowers: "向日葵类花卉",
  tulips: "郁金香类花卉",
};
export const SOURCE_NAMES = {
  simulation: "模拟数据",
  dataset: "历史数据",
  api: "接口数据",
  manual: "管理员整理",
};
export const TYPES = [
  { value: "", name: "全部地点" },
  { value: "water", name: "河湖" },
  { value: "park", name: "公园" },
  { value: "campus", name: "校园" },
  { value: "walk", name: "步道地标" },
];
export const KINDS = [
  { id: "water", name: "河湖水环境" },
  { id: "air", name: "空气指标" },
  { id: "weather", name: "温湿度" },
];
export const RANGES = [
  { id: 6, name: "6 小时窗口" },
  { id: 24, name: "24 小时窗口" },
  { id: 48, name: "48 小时窗口" },
  { id: 168, name: "7 天窗口" },
];
export const cityName = (region) =>
  ({ "tianjin-nature": "天津", "beijing-nature": "北京" })[region?.slug] ||
  region?.name ||
  "区域";
export const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(Number(value.toFixed(3)))
    : "—";
export const formatTime = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(typeof value === "number" ? value : Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
export const coordinates = (p) =>
  p &&
  typeof p.latitude === "number" &&
  Number.isFinite(p.latitude) &&
  Math.abs(p.latitude) <= 90 &&
  typeof p.longitude === "number" &&
  Number.isFinite(p.longitude) &&
  Math.abs(p.longitude) <= 180;
export const navigable = (p) =>
  !!p &&
  p.is_demo === false &&
  p.is_published === true &&
  p.coordinates_verified === true &&
  String(p.coordinate_system).toUpperCase() === "GCJ02" &&
  coordinates(p);
export const matchesType = (p, type) =>
  !type ||
  (
    {
      water: ["river", "lake"],
      park: ["park"],
      campus: ["campus", "plant", "waste"],
      walk: ["trail", "landmark"],
    }[type] || []
  ).includes(p.kind);
export const safeUrl = (value) =>
  typeof value === "string" && /^https?:\/\//i.test(value) ? value : "";
export function apiPagePath(value, endpoint) {
  if (typeof value !== "string" || /[\\\s#]/.test(value))
    throw new Error("列表分页地址无效，请刷新重试。");
  const url = new URL(value, "https://hyhq.invalid/api/v1/");
  const path = url.pathname.replace(/^\/api\/v1\//, "").replace(/^\//, "");
  if (path !== endpoint) throw new Error("列表分页地址无效，请刷新重试。");
  return path + url.search;
}
function pageIdentity(path, endpoint) {
  const normalized = apiPagePath(path, endpoint),
    url = new URL(normalized, "https://hyhq.invalid/api/v1/");
  if (!url.searchParams.has("page")) url.searchParams.set("page", "1");
  if (!url.searchParams.has("page_size"))
    url.searchParams.set("page_size", "20");
  url.searchParams.sort();
  return endpoint + "?" + url.searchParams.toString();
}
export function pageResponse(
  response,
  requestedPath,
  endpoint,
  seen = new Set(),
) {
  if (!Array.isArray(response?.data))
    throw new Error("列表返回格式不正确，请稍后重试。");
  const raw = response.meta?.next;
  if (raw !== null && raw !== undefined && typeof raw !== "string")
    throw new Error("列表分页格式不正确，请刷新后重试。");
  const key = pageIdentity(requestedPath, endpoint),
    next = raw ? apiPagePath(raw, endpoint) : "";
  if (
    seen.has(key) ||
    (next &&
      (pageIdentity(next, endpoint) === key ||
        seen.has(pageIdentity(next, endpoint))))
  )
    throw new Error("列表分页重复，请刷新后重试。");
  return { key, items: response.data, next };
}
export async function loadAll(api, path, data = {}, signal) {
  let next = path,
    first = true;
  const seen = new Set(),
    items = [];
  while (next) {
    if (seen.size >= 20)
      throw new Error("目录较大或分页异常，请缩小筛选范围后重试。");
    const current = apiPagePath(next, path),
      query = first ? { page_size: 100, ...data } : undefined;
    const requested =
      current +
      (query
        ? (current.includes("?") ? "&" : "?") +
          new URLSearchParams(query).toString()
        : "");
    const response = await api(current, { data: query, signal });
    const page = pageResponse(response, requested, path, seen);
    seen.add(page.key);
    items.push(...page.items);
    next = page.next;
    first = false;
  }
  return [...new Map(items.map((i) => [i.id, i])).values()];
}

export function publicStops(route) {
  const ids = new Set();
  return (Array.isArray(route?.stops) ? route.stops : [])
    .filter((s) => {
      if (
        !s?.id ||
        !s.place?.id ||
        !Number.isSafeInteger(s.order) ||
        s.order < 0 ||
        ids.has(s.id)
      )
        return false;
      ids.add(s.id);
      return true;
    })
    .sort(
      (a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)),
    )
    .map((s, i) => ({ ...s, position: i + 1 }));
}
export function rangeQuery(run, hours) {
  const end = run ? Date.parse(run.end) : Date.now(),
    runStart = run ? Date.parse(run.start) : NaN;
  if (
    !Number.isFinite(end) ||
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > 744
  )
    throw new Error("时间范围无效，请重新选择。");
  const start = Math.max(
    end - hours * 3600000,
    Number.isFinite(runStart) ? runStart : -Infinity,
  );
  if (start >= end) throw new Error("批次时间无效，请重新选择。");
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}
export const validPoint = (p) =>
  !!p &&
  p.quality_status === "valid" &&
  typeof p.value === "number" &&
  Number.isFinite(p.value) &&
  Number.isFinite(Date.parse(p.at));
export function chartGeometry(points, window, width = 900, height = 280) {
  const list = Array.isArray(points) && points.length <= 240 ? points : [],
    good = list.filter(validPoint);
  if (!good.length) return null;
  let start = Date.parse(window?.start),
    end = Date.parse(window?.end);
  const times = list.map((p) => Date.parse(p.at)).filter(Number.isFinite);
  if (!Number.isFinite(start)) start = Math.min(...times);
  if (!Number.isFinite(end)) end = Math.max(...times);
  if (end <= start) end = start + 3600000;
  let min = Math.min(...good.map((p) => p.value)),
    max = Math.max(...good.map((p) => p.value));
  const padding =
    max === min ? Math.max(Math.abs(max) * 0.05, 0.1) : (max - min) * 0.1;
  min -= padding;
  max += padding;
  const plot = { left: 55, right: width - 18, top: 25, bottom: height - 35 },
    segments = [];
  let segment = [];
  for (const p of list) {
    const at = Date.parse(p.at);
    if (!validPoint(p) || at < start || at > end) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push({
      x: plot.left + ((at - start) / (end - start)) * (plot.right - plot.left),
      y:
        plot.bottom -
        ((p.value - min) / (max - min)) * (plot.bottom - plot.top),
      point: p,
    });
  }
  if (segment.length) segments.push(segment);
  return { segments, min, max, start, end, plot, width, height };
}
// GCJ-02 catalogue coordinates are inverted before display on the WGS-84 OSM map.
function offset(lat, lng) {
  const x = lng - 105,
    y = lat - 35,
    pi = Math.PI;
  let dLat =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  dLat += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  dLat += ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3;
  dLat +=
    ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  let dLng =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  dLng += ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3;
  dLng +=
    ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
  const rad = (lat / 180) * pi,
    magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2,
    sqrt = Math.sqrt(magic);
  return [
    (dLat * 180) /
      (((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrt)) * pi),
    (dLng * 180) / ((6378245 / sqrt) * Math.cos(rad) * pi),
  ];
}
export function gcjToWgs(lat, lng) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271)
    return [lat, lng];
  let a = lat,
    b = lng;
  for (let i = 0; i < 4; i++) {
    const [dLat, dLng] = offset(a, b);
    a -= a + dLat - lat;
    b -= b + dLng - lng;
  }
  return [a, b];
}
