const HOUR = 3600000,
  RETRY = 300000,
  RETAIN = 24 * HOUR,
  MAX_BYTES = 256 * 1024;
const plain = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x) => typeof x === "number" && Number.isFinite(x);
export const chinaDate = (stamp) =>
  new Date(stamp + 8 * HOUR).toISOString().slice(0, 10);
export const celsius = (unit) =>
  ["°C", "℃", "C", "celsius"].includes(unit || "°C");
export function weatherSection(raw, now = Date.now(), kind = "weather") {
  const item = plain(raw) ? raw : {},
    data = plain(item.data) ? item.data : null;
  let status = ["fresh", "empty", "stale", "unavailable"].includes(item.status)
    ? item.status
    : "unavailable";
  const fetched = Date.parse(item.fetched_at),
    expires = Date.parse(item.expires_at),
    observed = Date.parse(item.observed_at);
  if (status !== "unavailable") {
    if (
      !Number.isFinite(fetched) ||
      !Number.isFinite(expires) ||
      fetched > now ||
      expires <= fetched
    )
      status = "unavailable";
    else if (item.stale === true || expires <= now) status = "stale";
    if (["weather", "air"].includes(kind) && status !== "unavailable") {
      if (
        item.observed_at &&
        (!Number.isFinite(observed) || observed > now + 600000)
      )
        status = "unavailable";
      else if (
        (Number.isFinite(observed) && observed <= now - 3 * HOUR) ||
        fetched <= now - 3 * HOUR
      )
        status = "stale";
    }
  }
  return {
    ...item,
    status,
    stale: status === "stale",
    available: !!data && status !== "unavailable",
    data: status === "unavailable" ? null : data,
  };
}
export function validDailyDays(raw, now = Date.now()) {
  const section = weatherSection(raw, now, "daily");
  if (!section.available) return [];
  const seen = new Set();
  return (Array.isArray(section.data.days) ? section.data.days : [])
    .filter((row) => {
      if (!plain(row)) return false;
      const start = Date.parse(row.starts_at),
        end = Date.parse(row.ends_at);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= now ||
        end <= start
      )
        return false;
      const date = chinaDate(start);
      if ((row.date && row.date !== date) || seen.has(date)) return false;
      seen.add(date);
      return true;
    })
    .slice(0, 3)
    .map((row) => {
      const validUnit =
          typeof row.temperature_unit === "string" &&
          !!row.temperature_unit &&
          celsius(row.temperature_unit),
        invalidRange =
          finite(row.temperature_min) &&
          finite(row.temperature_max) &&
          row.temperature_min > row.temperature_max;
      return {
        ...row,
        date: chinaDate(Date.parse(row.starts_at)),
        temperature_min:
          validUnit && !invalidRange && finite(row.temperature_min)
            ? row.temperature_min
            : null,
        temperature_max:
          validUnit && !invalidRange && finite(row.temperature_max)
            ? row.temperature_max
            : null,
        daytime: plain(row.daytime) ? row.daytime : {},
        nighttime: plain(row.nighttime) ? row.nighttime : {},
      };
    });
}
export function currentAlerts(raw, now = Date.now()) {
  const slot = weatherSection(raw, now, "alerts");
  if (!slot.available) return [];
  return (Array.isArray(slot.data.items) ? slot.data.items : []).filter(
    (item) => {
      if (
        !plain(item) ||
        [
          "cancel",
          "cancelled",
          "canceled",
          "cancellation",
          "取消",
          "已取消",
          "解除",
          "已解除",
          "撤销",
        ].includes(
          String(item.message_type || "")
            .trim()
            .toLowerCase(),
        )
      )
        return false;
      const end = Date.parse(item.expires_at),
        effective = Date.parse(item.effective_at),
        issued = Date.parse(item.issued_at);
      return (
        Number.isFinite(end) &&
        end > now &&
        (!item.effective_at ||
          (Number.isFinite(effective) && effective <= now)) &&
        (!item.issued_at || (Number.isFinite(issued) && issued <= now))
      );
    },
  );
}
export function summaryView(raw, now = Date.now()) {
  const weather = weatherSection(raw?.weather, now, "weather"),
    air = weatherSection(raw?.air, now, "air"),
    alerts = weatherSection(raw?.alerts, now, "alerts"),
    daily = weatherSection(raw?.daily, now, "daily");
  const days = daily.status === "fresh" ? validDailyDays(raw?.daily, now) : [];
  const hasExplicitToday =
    plain(raw?.daily?.data) &&
    Object.prototype.hasOwnProperty.call(raw.daily.data, "today");
  const todayRows = hasExplicitToday
    ? daily.status === "fresh" && raw.daily.data.today
      ? validDailyDays(
          { ...raw.daily, data: { days: [raw.daily.data.today] } },
          now,
        )
      : []
    : days;
  const today = todayRows.find(
      (d) => d.date === chinaDate(now) && Date.parse(d.starts_at) <= now,
    ),
    tomorrow = days.find(
      (d) =>
        d.date === chinaDate(now + 24 * HOUR) && Date.parse(d.starts_at) > now,
    );
  return {
    weather,
    air,
    alerts,
    daily,
    today,
    tomorrow,
    currentAlerts: currentAlerts(raw?.alerts, now),
  };
}
export function validateWeatherResponse(raw, city, mode = "summary") {
  if (!plain(raw) || raw.location?.slug !== city)
    throw new Error("天气地点返回不一致，请重新选择城市。");
  const keys =
    mode === "forecast" ? ["forecast"] : ["weather", "air", "alerts", "daily"];
  if (
    (mode === "summary" && !plain(raw.weather)) ||
    (mode === "forecast" && !plain(raw.forecast))
  )
    throw new Error("天气资料格式不正确，请稍后重试。");
  for (const key of keys) {
    const slot = raw[key];
    if (slot == null) continue;
    if (!plain(slot) || (slot.data != null && !plain(slot.data)))
      throw new Error("天气资料格式不正确，请稍后重试。");
    const arrayKey =
      key === "alerts"
        ? "items"
        : key === "air"
          ? "pollutants"
          : ["daily", "forecast"].includes(key)
            ? "days"
            : null;
    if (
      arrayKey &&
      slot.data?.[arrayKey] !== undefined &&
      (!Array.isArray(slot.data[arrayKey]) ||
        slot.data[arrayKey].length > 100 ||
        slot.data[arrayKey].some((row) => !plain(row)))
    )
      throw new Error("天气资料格式不正确，请稍后重试。");
  }
  if (JSON.stringify(raw).length * 2 > MAX_BYTES)
    throw new Error("天气资料过大，请稍后重试。");
  return raw;
}
export function refreshDeadline(raw, writtenAt, mode = "summary") {
  let deadline = writtenAt + HOUR;
  const keys =
    mode === "forecast" ? ["forecast"] : ["weather", "air", "alerts", "daily"];
  for (const key of keys) {
    const slot = weatherSection(
        raw?.[key],
        writtenAt,
        key === "forecast" ? "daily" : key,
      ),
      fetched = Date.parse(slot.fetched_at),
      expires = Date.parse(slot.expires_at);
    if (
      !["fresh", "empty"].includes(slot.status) ||
      !Number.isFinite(fetched) ||
      !Number.isFinite(expires)
    ) {
      deadline = Math.min(deadline, writtenAt + RETRY);
      continue;
    }
    deadline = Math.min(deadline, expires, fetched + HOUR);
    if (key === "alerts")
      for (const item of currentAlerts(slot, writtenAt))
        deadline = Math.min(deadline, Date.parse(item.expires_at));
    if (key === "daily" || key === "forecast") {
      deadline = Math.min(
        deadline,
        Date.parse(chinaDate(writtenAt) + "T00:00:00+08:00") + 24 * HOUR,
      );
      for (const row of validDailyDays(slot, writtenAt)) {
        const end = Date.parse(row.ends_at);
        if (end > writtenAt) deadline = Math.min(deadline, end);
      }
    }
  }
  return Math.max(writtenAt + 1000, deadline);
}
export function createWeatherCache({
  fetcher,
  storage,
  scope = "",
  now = Date.now,
} = {}) {
  const memory = new Map(),
    requests = new Map(),
    failures = new Map();
  const key = (mode, city) =>
    "hyhq.weather.v2." + encodeURIComponent(scope) + "." + mode + "." + city;
  function read(mode, city) {
    const id = key(mode, city);
    let saved = memory.get(id);
    if (!saved)
      try {
        saved = JSON.parse(storage?.getItem(id) || "null");
      } catch {}
    if (
      !saved ||
      !Number.isFinite(saved.writtenAt) ||
      saved.writtenAt > now() ||
      saved.writtenAt <= now() - RETAIN
    )
      return null;
    try {
      validateWeatherResponse(saved.data, city, mode);
    } catch {
      return null;
    }
    const refreshAt = Math.min(
      Number.isFinite(saved.refreshAt) ? saved.refreshAt : -Infinity,
      refreshDeadline(saved.data, saved.writtenAt, mode),
    );
    memory.set(id, saved);
    return { data: saved.data, refreshAt, fresh: refreshAt > now() };
  }
  async function request(mode, city, { force = false } = {}) {
    const id = key(mode, city);
    if (requests.has(id)) return requests.get(id);
    const saved = read(mode, city);
    if (!force && saved?.fresh) return saved.data;
    const failed = failures.get(id);
    if (!force && failed?.until > now()) throw failed.error;
    const task = Promise.resolve()
      .then(() => fetcher(mode, city))
      .then((raw) => {
        const data = validateWeatherResponse(raw, city, mode),
          writtenAt = now(),
          saved = {
            data,
            writtenAt,
            refreshAt: refreshDeadline(data, writtenAt, mode),
          };
        memory.set(id, saved);
        failures.delete(id);
        try {
          storage?.setItem(id, JSON.stringify(saved));
        } catch {}
        return data;
      })
      .catch((error) => {
        failures.set(id, { error, until: now() + RETRY });
        throw error;
      })
      .finally(() => {
        if (requests.get(id) === task) requests.delete(id);
      });
    requests.set(id, task);
    return task;
  }
  return { read, request };
}
export function validBookingDraft(raw, cities, now = Date.now()) {
  if (
    !plain(raw) ||
    raw.timezone !== "Asia/Shanghai" ||
    typeof raw.scheduled_for !== "string" ||
    !cities.includes(raw.location)
  )
    return null;
  const at = Date.parse(raw.scheduled_for);
  if (!Number.isFinite(at) || at < now + 300000 || at > now + 48 * HOUR)
    return null;
  return { location: raw.location, scheduled_for: new Date(at).toISOString() };
}
export function nearestWeatherCity(point, cities, maxDistanceKm = 100) {
  if (
    !finite(point?.latitude) ||
    !finite(point?.longitude) ||
    Math.abs(point.latitude) > 90 ||
    Math.abs(point.longitude) > 180 ||
    (point.accuracy !== undefined &&
      (!finite(point.accuracy) || point.accuracy < 0 || point.accuracy > 50000))
  )
    return null;
  const rad = (n) => (n * Math.PI) / 180;
  let nearest = null,
    best = maxDistanceKm;
  for (const city of cities) {
    const a = rad(city[2] - point.latitude),
      b = rad(city[3] - point.longitude),
      n =
        Math.sin(a / 2) ** 2 +
        Math.cos(rad(point.latitude)) *
          Math.cos(rad(city[2])) *
          Math.sin(b / 2) ** 2;
    const distance =
      6371 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, n))));
    if (distance <= best) {
      nearest = city;
      best = distance;
    }
  }
  return nearest;
}
