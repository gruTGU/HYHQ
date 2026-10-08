const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function timestampMs(timestamp) {
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp !== "string" || !timestamp.trim()) return NaN;
  let value = timestamp.trim();
  // A local wall-clock timestamp from our weather data is Beijing time.
  // An explicit offset (or Z) always takes precedence over this default.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    value = value.replace(" ", "T") + "+08:00";
  }
  return Date.parse(value);
}

/** Stable across browser/server time zones; timestamp numbers are milliseconds. */
export function weatherAppearance(condition, timestamp) {
  const text = typeof condition === "string" ? condition.trim() : "";
  const time = timestampMs(timestamp);
  const beijing = new Date(time + BEIJING_OFFSET_MS);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const night = Number.isFinite(time) && (minutes >= 19 * 60 + 30 || minutes < 6 * 60);

  let icon = "cloud";
  if (/雷/.test(text)) icon = "cloud-lightning";
  else if (/雪/.test(text)) icon = "cloud-snow";
  else if (/雨/.test(text)) icon = night ? "cloud-moon-rain" : "cloud-rain";
  else if (/雾|霾/.test(text)) icon = "cloud-fog";
  else if (/阴/.test(text)) icon = "cloud";
  else if (/云/.test(text)) icon = night ? "cloud-moon" : "cloud-sun";
  else if (/晴/.test(text)) icon = night ? "moon" : "sun";

  const label = !text ? "天气暂不可用" : night ? (text === "晴" ? "晴夜" : `${text} · 夜间`) : text;
  return { night, label, icon };
}
