const { time, value } = require('./format');
const OFFSET = 8 * 3600000;
function localDate(input) {
  const stamp = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp + OFFSET);
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
}
function localClock(input) {
  const stamp = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp + OFFSET);
  return String(date.getUTCHours()).padStart(2, '0') + ':' + String(date.getUTCMinutes()).padStart(2, '0');
}
function bookingFields(now = Date.now()) {
  const tomorrow = localDate(now + 86400000);
  return { bookingDate: tomorrow, bookingTime: '08:00', minDate: localDate(now + 5 * 60000), maxDate: localDate(now + 48 * 3600000) };
}
function validateBooking(date, clock, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock || '')) return { error: '请选择完整的预约日期和时间。' };
  const stamp = Date.parse(date + 'T' + clock + ':00+08:00');
  if (!Number.isFinite(stamp) || localDate(stamp) !== date || localClock(stamp) !== clock) return { error: '预约日期或时间无效，请重新选择。' };
  if (stamp < now + 5 * 60000) return { error: '请至少提前 5 分钟预约。' };
  if (stamp > now + 48 * 3600000) return { error: '请选择未来 48 小时内的一次提醒。' };
  return { scheduled_for: new Date(stamp).toISOString() };
}
function aiDraftView(raw, locations, now = Date.now()) {
  if (!raw || raw.timezone !== 'Asia/Shanghai' || typeof raw.scheduled_for !== 'string') return null;
  const location = (Array.isArray(locations) ? locations : []).find((item) => item.slug === raw.location);
  const stamp = Date.parse(raw.scheduled_for);
  if (!location || !Number.isFinite(stamp)) return null;
  const date = localDate(stamp), clock = localClock(stamp), valid = validateBooking(date, clock, now);
  if (valid.error) return null;
  return { location, bookingDate: date, bookingTime: clock, scheduled_for: valid.scheduled_for,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 280) : '' };
}
function number(input) { return typeof input === 'number' && Number.isFinite(input) ? input : null; }
function temperature(input) { const parsed = number(input); return parsed === null ? '—' : String(Math.trunc(parsed)); }
function forecastView(raw, now = Date.now()) {
  const item = raw || {}, data = item.data || {}, expired = item.expires_at && Date.parse(item.expires_at) <= now;
  const stale = item.status === 'stale' || item.stale === true || Boolean(expired);
  const days = (Array.isArray(data.days) ? data.days : []).filter((day) => day && Date.parse(day.ends_at) > now).slice(0, 3).map((day) => {
    const daytime = day.daytime || {}, nighttime = day.nighttime || {};
    const celsius = !day.temperature_unit || ['°C', '℃', 'C'].includes(day.temperature_unit);
    const hints = [];
    if (number(daytime.precipitation_probability_percent) >= 60) hints.push('降水概率较高，出门带伞');
    if (celsius && number(day.temperature_min) !== null && day.temperature_min <= 8) hints.push('早晚偏冷，适当添衣');
    if (celsius && number(day.temperature_max) !== null && day.temperature_max >= 35) hints.push('高温时段注意防晒补水');
    return Object.assign({}, day, {
      date_label: localDate(day.starts_at), condition_label: daytime.condition || '暂无天气描述',
      night_label: nighttime.condition || '暂无天气描述',
      temperature_label: celsius ? temperature(day.temperature_min) + ' ~ ' + temperature(day.temperature_max) + '℃' : value(day.temperature_min) + ' ~ ' + value(day.temperature_max, day.temperature_unit),
      rain_label: value(daytime.precipitation_probability_percent, '%'),
      wind_label: [daytime.wind_direction, daytime.wind_scale ? daytime.wind_scale + '级' : ''].filter(Boolean).join(' ') || '暂无风力数据',
      tips: stale || item.status !== 'fresh' ? [] : hints,
    });
  });
  const credits = Array.from(new Set((Array.isArray(item.attributions) ? item.attributions : []).filter((credit) => typeof credit === 'string' && credit.trim()).map((credit) => credit.trim()))).slice(0, 20);
  const isLink = (credit) => /^https:\/\/[^\s]+$/i.test(credit);
  return { days, available: days.length > 0, stale,
    status_label: stale ? '历史预报 · 更新暂不可用' : item.status === 'fresh' ? '近期更新' : '预报暂不可用',
    fetched_label: item.fetched_at ? time(item.fetched_at) : '',
    attribution: credits.filter((credit) => !isLink(credit)).join('；'),
    attribution_links: credits.filter(isLink).map((url, index) => ({ url, label: index === 0 ? '来源说明' : '来源说明 ' + (index + 1) })),
    source_label: item.source_label || '和风天气',
  };
}
function reminderView(raw) {
  const item = raw || {};
  const labels = { prepared: '待授权', pending: '已预约', preparing: '准备发送', sending: '发送中', retry: '稍后重试', sent: '已发送',
    cancelled: '已取消', expired: '已过期', failed: '未能发送', unknown: '发送结果待核实' };
  return Object.assign({}, item, { location_name: item.location_name || (item.location && item.location.name) || '',
    state_label: labels[item.state] || '待核实', scheduled_label: time(item.scheduled_for),
    expiry_label: item.expires_at ? time(item.expires_at) : '' });
}
module.exports = { forecastView, reminderView, localDate, localClock, bookingFields, validateBooking, aiDraftView };
