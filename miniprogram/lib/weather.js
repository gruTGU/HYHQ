const { time, value } = require('./format');
const OBSERVATION_MAX_AGE = 3 * 3600000;
const cancelledMessage = value => ['cancel', 'cancelled', 'canceled', 'cancellation', '取消', '已取消', '解除', '已解除', '撤销'].includes(String(value || '').trim().toLowerCase());
const chinaDate = stamp => new Date(stamp + 8 * 3600000).toISOString().slice(0, 10);
const celsius = unit => ['°C', '℃', 'C', 'celsius'].includes(unit || '°C');
function temperature(input, unit) {
  if (typeof input !== 'number' || !Number.isFinite(input) || !celsius(unit)) return '—';
  return String(Math.trunc(input)) + '℃';
}
function credits(values) {
  const links = [], notes = [], urls = new Set(), texts = new Set();
  const note = text => { const trimmed = text.trim(); if (trimmed && !/^(?:QWeather|和风天气|和风天气\s*QWeather)$/i.test(trimmed) && !texts.has(trimmed)) { texts.add(trimmed); notes.push(trimmed); } };
  for (const input of values) {
    if (typeof input !== 'string') continue;
    // Keep every non-URL attribution fragment intact. URLs become compact,
    // explicit source buttons carrying the original address, never rich HTML.
    const matches = input.match(/https?:\/\/[^\s<>"'，。；、（）]+/g) || [];
    if (!matches.length) { note(input); continue; }
    let remainder = input;
    for (const url of matches) {
      remainder = remainder.replace(url, '');
      if (!urls.has(url)) { urls.add(url); links.push({ id: String(links.length), url, label: '数据来源' + (links.length ? ' ' + (links.length + 1) : '') }); }
    }
    note(remainder);
  }
  return { links, notes };
}
function section(raw, now, kind) {
  const item = raw || {};
  let status = item.status || 'unavailable';
  if (item.stale === true && status !== 'unavailable') status = 'stale';
  if (['fresh', 'empty'].includes(status)) {
    const expires = Date.parse(item.expires_at), fetched = Date.parse(item.fetched_at), observed = Date.parse(item.observed_at);
    const invalid = item.expires_at && !Number.isFinite(expires) || item.fetched_at && (!Number.isFinite(fetched) || fetched > now)
      || Number.isFinite(expires) && Number.isFinite(fetched) && expires <= fetched;
    if (invalid) status = 'unavailable';
    else if (Number.isFinite(expires) && expires <= now) status = 'stale';
    if (['weather', 'air'].includes(kind) && status !== 'unavailable') {
      if (item.observed_at && (!Number.isFinite(observed) || observed > now + 600000)) status = 'unavailable';
      else if (Number.isFinite(observed) && observed <= now - OBSERVATION_MAX_AGE || Number.isFinite(fetched) && fetched <= now - OBSERVATION_MAX_AGE) status = 'stale';
    }
  }
  const attributions = Array.isArray(item.attributions) ? item.attributions : [], sources = item.refer && Array.isArray(item.refer.sources) ? item.refer.sources : [];
  const attribution = credits([...attributions, ...sources]);
  return Object.assign({}, item, {
    status, available: Boolean(item.data) && status !== 'unavailable', stale: status === 'stale',
    status_label: status === 'stale' ? '历史缓存 · 更新暂不可用' : status === 'unavailable' ? '暂不可用' : ['fresh', 'empty'].includes(status) ? '近期更新' : '状态待确认',
    fetched_label: item.fetched_at ? time(item.fetched_at) : '',
    expires_label: item.expires_at ? time(item.expires_at) : '',
    attribution: attributions.join('；'), sources: sources.join('；'),
    source_notes: attribution.notes, attribution_links: attribution.links,
  });
}
function dailyView(raw, now) {
  const daily = section(raw, now, 'daily'), data = daily.data || {};
  const days = Array.isArray(data.days) ? data.days : [];
  const todayRows = Object.prototype.hasOwnProperty.call(data, 'today') ? [data.today] : days;
  const expires = Date.parse(daily.expires_at);
  const usable = daily.status === 'fresh' && Number.isFinite(expires) && expires > now;
  const findDay = (rows, date, future) => usable && rows.find(day => {
    if (!day) return false;
    const start = Date.parse(day.starts_at), end = Date.parse(day.ends_at);
    return Number.isFinite(start) && Number.isFinite(end) && end > now && end > start
      && (future ? start > now : start <= now) && chinaDate(start) === date && (!day.date || day.date === date);
  });
  const range = row => {
    const unitOk = row && typeof row.temperature_unit === 'string' && row.temperature_unit.trim() !== '' && celsius(row.temperature_unit);
    let min = unitOk && typeof row.temperature_min === 'number' && Number.isFinite(row.temperature_min), max = unitOk && typeof row.temperature_max === 'number' && Number.isFinite(row.temperature_max);
    if (min && max && row.temperature_min > row.temperature_max) { min = false; max = false; }
    return { available: Boolean(min || max), min_available: Boolean(min), max_available: Boolean(max),
      min_label: min ? temperature(row.temperature_min, row.temperature_unit) : '', max_label: max ? temperature(row.temperature_max, row.temperature_unit) : '' };
  };
  const today = range(findDay(todayRows, chinaDate(now), false));
  // Reuse the existing three-day response; this view never fetches weather.
  const tomorrow = range(findDay(days, chinaDate(now + 86400000), true));
  return { ...daily, today_available: today.available, min_available: today.min_available, max_available: today.max_available,
    min_label: today.min_label, max_label: today.max_label,
    tomorrow_available: tomorrow.available, tomorrow_min_available: tomorrow.min_available, tomorrow_max_available: tomorrow.max_available,
    tomorrow_min_label: tomorrow.min_label, tomorrow_max_label: tomorrow.max_label };
}

function weatherView(summary, now = Date.now()) {
  summary = summary || {};
  const weather = section(summary.weather, now, 'weather'), air = section(summary.air, now, 'air'), alerts = section(summary.alerts, now, 'alerts'), daily = dailyView(summary.daily, now);
  const w = weather.data || {}, a = air.data || {};
  weather.temp_label = temperature(w.temperature, w.temperature_unit);
  weather.humidity_label = value(w.humidity_percent, '%');
  weather.condition_label = w.condition || '天气情况暂无';
  air.aqi_label = value(a.aqi_display === undefined || a.aqi_display === '' ? a.aqi : a.aqi_display);
  air.pollutants = (a.pollutants || []).map(item => Object.assign({}, item, { value_label: value(item.value, item.unit ? ' ' + item.unit : '') }));
  alerts.items = ((alerts.data || {}).items || []).map(item => Object.assign({}, item, {
    issued_label: time(item.issued_at), effective_label: time(item.effective_at), expires_label: time(item.expires_at),
    message_label: cancelledMessage(item.message_type) ? '已取消' : ({ update: '更新公告', alert: '预警公告' })[String(item.message_type || '').toLowerCase()] || item.message_type || '预警公告',
  }));
  alerts.current_items = alerts.items.filter(item => {
    if (cancelledMessage(item.message_type)) return false;
    const expires = Date.parse(item.expires_at), effective = Date.parse(item.effective_at), issued = Date.parse(item.issued_at);
    return (!item.expires_at || Number.isFinite(expires) && expires > now) && (!item.effective_at || Number.isFinite(effective) && effective <= now) && (!item.issued_at || Number.isFinite(issued) && issued <= now);
  });
  alerts.current_count = alerts.current_items.length;
  if (['fresh', 'empty'].includes(alerts.status) && alerts.items.length && !alerts.current_count) {
    const allEnded = alerts.items.every(item => Number.isFinite(Date.parse(item.expires_at)) && Date.parse(item.expires_at) <= now);
    alerts.status = allEnded ? 'stale' : 'unknown'; alerts.stale = allEnded;
    alerts.status_label = allEnded ? '历史公告 · 当前预警待确认' : '预警状态待确认';
  }
  alerts.empty = alerts.status === 'empty' && !alerts.items.length && Boolean(alerts.data && alerts.data.zero_result);
  const attribution = credits([weather, air, daily].flatMap(item => [...(Array.isArray(item.attributions) ? item.attributions : []), ...(item.refer && Array.isArray(item.refer.sources) ? item.refer.sources : [])]));
  return { weather, air, alerts, daily, source_notes: attribution.notes, attribution_links: attribution.links };
}
module.exports = { weatherView };
