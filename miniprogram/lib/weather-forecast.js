const { time, value } = require('./format');
function localDate(input) {
  const stamp = Date.parse(input);
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp + 8 * 3600000);
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
}
function forecastView(raw, now = Date.now()) {
  const item = raw || {}, data = item.data || {}, stale = item.status === 'stale';
  const days = (Array.isArray(data.days) ? data.days : []).filter((day) => day && Date.parse(day.ends_at) > now).slice(0, 3).map((day) => {
    const daytime = day.daytime || {}, nighttime = day.nighttime || {};
    return Object.assign({}, day, {
      date_label: localDate(day.starts_at), condition_label: daytime.condition || '暂无天气描述',
      night_label: nighttime.condition || '暂无天气描述',
      temperature_label: value(day.temperature_min) + ' ~ ' + value(day.temperature_max, day.temperature_unit || '°C'),
      rain_label: value(daytime.precipitation_probability_percent, '%'),
    });
  });
  return { days, available: days.length > 0, stale,
    status_label: stale ? '历史预报 · 更新暂不可用' : item.status === 'fresh' ? '近期更新' : '预报暂不可用',
    fetched_label: item.fetched_at ? time(item.fetched_at) : '',
    attribution: (Array.isArray(item.attributions) ? item.attributions : []).join('；'),
    source_label: item.source_label || '和风天气',
  };
}
function reminderView(item) {
  const labels = { prepared: '待授权', pending: '已安排', sending: '发送中', retry: '稍后重试', sent: '已发送',
    cancelled: '已取消', expired: '已过期', failed: '未能发送', unknown: '发送结果待核实' };
  return Object.assign({}, item, { state_label: labels[item.state] || '待核实', scheduled_label: time(item.scheduled_for) });
}
module.exports = { forecastView, reminderView, localDate };
