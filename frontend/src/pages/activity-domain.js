export const ACTIVITY_NOTE = "全部活动均为模拟演示，不代表真实举办或政府通知。";
export const ENVIRONMENT_NOTE =
  "模拟演示：仅提交平台管理员私密待办，未发送给政府或环保部门。";

export function activityRows(response) {
  return Array.isArray(response?.data)
    ? response.data
    : response?.data?.items || response?.data?.events || [];
}

export function chinaDay(now = Date.now()) {
  return new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
}

export function eventDates(event) {
  const day = (value) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? chinaDay(timestamp) : "";
  };
  return {
    start: day(event.starts_at || event.start_at || event.start_date),
    end: day(
      event.ends_at ||
        event.end_at ||
        event.end_date ||
        event.starts_at ||
        event.start_at ||
        event.start_date,
    ),
  };
}

export function eventEnded(event, now = Date.now()) {
  const end = event.ends_at || event.end_at || event.end_date;
  return (
    event.status === "ended" ||
    (end &&
      (/^\d{4}-\d{2}-\d{2}$/.test(end)
        ? end < chinaDay(now)
        : Date.parse(end) < now))
  );
}

export function eventInMonth(event, year, month) {
  const { start, end } = eventDates(event);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return false;
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
  return start <= last && end >= first;
}

export function upcomingEvents(events, now = Date.now(), days = 30) {
  const today = chinaDay(now),
    through = chinaDay(Number(now) + days * 86400000);
  return events
    .filter((event) => {
      const { start, end } = eventDates(event);
      return (
        start &&
        end &&
        !eventEnded(event, now) &&
        end >= today &&
        start <= through
      );
    })
    .sort((a, b) => eventDates(a).start.localeCompare(eventDates(b).start));
}

export function eventDateLabel(event) {
  const { start, end } = eventDates(event);
  if (!start) return "时间待公布";
  const label = (day) => day.replace(/-/g, ".");
  return start === end ? label(start) : `${label(start)} — ${label(end)}`;
}

export function eventPlace(event) {
  return (
    event.place_name ||
    event.location_name ||
    event.place?.name ||
    event.location?.name ||
    "地点待确认"
  );
}

export function eventLocationLink(event) {
  if (event.map_reference_id)
    return (
      "/explore?reference_id=" + encodeURIComponent(event.map_reference_id)
    );
  if (event.place_id || event.place?.id)
    return (
      "/detail/place/" + encodeURIComponent(event.place_id || event.place.id)
    );
  return "/explore";
}

export function validEnvironmentDescription(value) {
  const length = [...String(value || "").trim()].length;
  return length >= 5 && length <= 1000;
}
