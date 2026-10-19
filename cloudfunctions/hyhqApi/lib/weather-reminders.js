'use strict';
// One explicit appointment and one platform consent per delivery. Recipient IDs
// live only in the administrator-only store, never in responses or audit logs.
const { ApiError, response, requireUser, uuid, sha256 } = require('./core');
const weather = require('./weather');
const simulation = require('./ecology-simulation');
const daily = require('./weather-daily');
const TEMPLATE_ID = 'd8VSXhq_6KMMjGvEp7CxS-0lL-573ZYbODuXFLW7WtI';
const INSTANT_SIMULATION_MESSAGE = '模拟异常：浊度偏高，请复核';
const MINUTE = 60000;
const ACTIVE = new Set(['prepared', 'pending', 'preparing', 'retry', 'sending']);
const CANCELLABLE = new Set(['prepared', 'pending', 'preparing', 'retry']);
function time(ctx) { const n = Date.parse(ctx.now); if (!Number.isFinite(n)) throw new ApiError('SERVER_TIME_INVALID', '服务时间暂不可用', 503); return n; }
function iso(n) { return new Date(n).toISOString(); }
function cnTime(n) { return new Date(n + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function settings(ctx) { return ctx.config && ctx.config.weatherReminders || {}; }
function deliveryEnabled(ctx) { return settings(ctx).enabled === true && settings(ctx).templateId === TEMPLATE_ID && typeof (ctx.providers || {}).sendWeatherReminder === 'function'; }
function enabled(ctx, type = 'weather') { return deliveryEnabled(ctx) && (['ecology_simulation', 'event'].includes(type) || weather.configured(ctx.config)); }
function requireEnabled(ctx, type) { if (!enabled(ctx, type)) throw new ApiError('SUBSCRIPTIONS_DISABLED', '天气预约提醒暂未开放', 503); }
function identity(ctx) { requireUser(ctx); if (typeof ctx.wechatOpenId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.wechatOpenId)) throw new ApiError('WECHAT_IDENTITY_REQUIRED', '请通过微信小程序重新登录后预约', 403); return ctx.wechatOpenId; }
function bodyOnly(ctx, fields) { const b = ctx.body; if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join(',') !== [...fields].sort().join(',')) throw new ApiError('VALIDATION_ERROR', '预约参数无效'); return b; }
function reminderType(row) { return ['ecology_simulation', 'event'].includes(row.type) ? row.type : 'weather'; }
function lockId(owner, date, type = 'weather') { return sha256(owner + ':' + (type === 'ecology_simulation' ? 'ecology_simulation:' : '') + date); }
function present(row) {
  const type = reminderType(row), simulated = type === 'ecology_simulation' ? simulation.preview(row.scenario) : null;
  const location = type === 'event' ? { slug: '', name: row.event && row.event.location_name || '' } : simulated ? { slug: 'demo-campus', name: simulation.CAMPUS } : weather.locationFor(row.location);
  return { id: row.id, type, scenario: simulated ? row.scenario : '', simulation_preview: simulated, ...(row.instant_simulation ? { mode: 'instant_simulation', message_preview: INSTANT_SIMULATION_MESSAGE, notice: '固定教学模拟，不是当前曲线或真实水质异常。' } : {}), location: location ? { slug: location.slug, name: location.name } : null, location_name: location && location.name || '',
    state: row.state, scheduled_for: row.scheduled_for, target_date: row.target_date, expires_at: row.expires_at, consent_expires_at: row.consent_expires_at,
    template_id: row.template_id, recurrence: row.recurrence || 'once', created_at: row.created_at, updated_at: row.updated_at, can_cancel: CANCELLABLE.has(row.state), reason: row.reason || '' };
}
function active(row, now) { return row && ACTIVE.has(row.state) && Date.parse(row.state === 'prepared' ? row.consent_expires_at : row.expires_at) > now; }
async function owner(tx, ownerId) { const user = await tx.get('users', ownerId); if (!user || user.is_active !== true || user.deleting === true) throw new ApiError('NOT_AUTHENTICATED', '账号不可用，请重新登录', 401); return user; }
async function owned(tx, ctx, id) { const row = await tx.get('weather_reminders', id); if (!row || row.owner_id !== ctx.user.id) throw new ApiError('NOT_FOUND', '预约不存在', 404); return row; }
function expireRow(row, now) {
  if (row.state === 'prepared' && Date.parse(row.consent_expires_at) <= now || ['pending', 'retry', 'preparing'].includes(row.state) && Date.parse(row.expires_at) <= now) {
    Object.assign(row, { state: 'expired', reason: 'appointment_expired', updated_at: iso(now), lease_token: null, lease_until: null }); return true;
  }
  if (row.state === 'sending' && Date.parse(row.lease_until) <= now) {
    // The provider could already have accepted the message. Never resend.
    Object.assign(row, { state: 'unknown', reason: 'delivery_unconfirmed', updated_at: iso(now), lease_token: null, lease_until: null }); return true;
  }
  return false;
}
async function releaseRecipient(tx, row) {
  if (row.consent_kind === 'subscription_pool') { await daily.releaseCredit(tx, row, Date.parse(row.updated_at)); return; }
  await daily.manualRefusal(tx, row, Date.parse(row.updated_at));
  const recipient = await tx.get('weather_recipients', row.owner_id); if (!recipient) return;
  const pending = { ...(recipient.pending || {}) }; delete pending[row.id];
  if (Object.keys(pending).length) await tx.set('weather_recipients', row.owner_id, { ...recipient, pending });
  else await tx.remove('weather_recipients', row.owner_id);
}
async function createIntent(ctx) {
  if (!deliveryEnabled(ctx)) requireEnabled(ctx);
  identity(ctx);
  const input = ctx.body;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['location', 'scheduled_for', 'type', 'scenario'].includes(key))) throw new ApiError('VALIDATION_ERROR', '预约参数无效');
  const type = input.type === undefined ? 'weather' : input.type;
  if (!['weather', 'ecology_simulation'].includes(type)) throw new ApiError('VALIDATION_ERROR', '请选择支持的提醒类型');
  if (ctx.config.instantSimulationOnly && type === 'ecology_simulation') throw new ApiError('SIMULATION_MOVED', '模拟异常体验已移至首页生态观察，不再创建定时模拟提醒', 409);
  const simulated = type === 'ecology_simulation' ? simulation.preview(input.scenario) : null;
  if (type === 'ecology_simulation' ? !simulated : input.scenario !== undefined && input.scenario !== '') throw new ApiError('VALIDATION_ERROR', '请选择支持的仿真场景');
  requireEnabled(ctx, type);
  const now = time(ctx), location = type === 'weather' ? weather.locationFor(input.location) : null;
  if (type === 'weather' && !location) throw new ApiError('VALIDATION_ERROR', '请选择支持的天气城市');
  if (typeof input.scheduled_for !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduled_for)) throw new ApiError('VALIDATION_ERROR', '请选择有效预约时间');
  const [year, month, day] = input.scheduled_for.slice(0, 10).split('-').map(Number), calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) throw new ApiError('VALIDATION_ERROR', '请选择有效预约时间');
  const scheduled = Date.parse(input.scheduled_for);
  if (!Number.isFinite(scheduled) || scheduled < now + 5 * MINUTE || scheduled > now + 48 * 60 * MINUTE) throw new ApiError('REMINDER_TIME_INVALID', '预约时间须在 5 分钟后至 48 小时内');
  const target = weather.dayOf(scheduled), key = lockId(ctx.user.id, target, type);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id);
    const lock = await tx.get('weather_reminder_days', key), previous = lock && await tx.get('weather_reminders', lock.reminder_id);
    if (active(previous, now)) {
      if (reminderType(previous) === type && previous.location === (location && location.slug) && (type !== 'ecology_simulation' || previous.scenario === input.scenario) && previous.scheduled_for === iso(scheduled)) return previous;
      throw new ApiError('WEATHER_REMINDER_EXISTS', '当天已有同类型预约，请先取消后再修改', 409);
    }
    if (previous && expireRow(previous, now)) { await tx.set('weather_reminders', previous.id, previous); await releaseRecipient(tx, previous); }
    if (lock && lock.created_count >= 10) throw new ApiError('REMINDER_RATE_LIMITED', '当天预约修改次数较多，请稍后再试', 429);
    const row = { id: uuid(), owner_id: ctx.user.id, type, scenario: simulated ? input.scenario : '', location: location && location.slug, scheduled_for: iso(scheduled), target_date: target,
      expires_at: iso(scheduled + 30 * MINUTE), consent_expires_at: iso(Math.min(now + 10 * MINUTE, scheduled)), state: 'prepared', template_id: TEMPLATE_ID,
      created_at: iso(now), updated_at: iso(now), reason: '', attempts: 0, weather_attempts: 0 };
    await tx.set('weather_reminders', row.id, row);
    await tx.set('weather_reminder_days', key, { id: key, owner_id: ctx.user.id, type, target_date: target, reminder_id: row.id, created_count: (lock && lock.created_count || 0) + 1 });
    return row;
  });
  return response(present(row), row.created_at === iso(now) ? 201 : 200);
}
async function createSimulationIntent(ctx) {
  requireEnabled(ctx, 'ecology_simulation'); identity(ctx); bodyOnly(ctx, []); const now = time(ctx), day = weather.dayOf(now), key = sha256(ctx.user.id + ':instant:' + day);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const lock = await tx.get('weather_simulation_trials', key);
    const old = lock && lock.intent_id && await tx.get('weather_reminders', lock.intent_id);
    if (old && old.state === 'prepared' && Date.parse(old.consent_expires_at) > now) return old;
    if (lock && lock.accepted_count >= 5) throw new ApiError('REMINDER_RATE_LIMITED', '今天的模拟提醒体验次数已用完，请明天再试', 429);
    if (lock && lock.prepared_count >= 100) throw new ApiError('REMINDER_RATE_LIMITED', '今日操作较多，请明天再试', 429);
    const row = { id: uuid(), owner_id: ctx.user.id, type: 'ecology_simulation', scenario: 'rain', instant_simulation: true,
      simulation_trial_key: key, location: null, scheduled_for: iso(now), target_date: day, expires_at: iso(now + 10 * MINUTE), consent_expires_at: iso(now + 10 * MINUTE),
      state: 'prepared', template_id: TEMPLATE_ID, created_at: iso(now), updated_at: iso(now), reason: '', attempts: 0, weather_attempts: 0 };
    await tx.set('weather_reminders', row.id, row);
    await tx.set('weather_simulation_trials', key, { id: key, owner_id: ctx.user.id, target_date: day, intent_id: row.id, prepared_count: (lock && lock.prepared_count || 0) + 1, accepted_count: lock && lock.accepted_count || 0 });
    return row;
  }); return response(present(row));
}
async function confirm(ctx, id, oldRoute, instant = false) {
  if (!deliveryEnabled(ctx)) requireEnabled(ctx); const recipient = identity(ctx), input = bodyOnly(ctx, oldRoute ? ['template_id', 'acceptance'] : ['template_id', 'decision']), now = time(ctx);
  const decision = oldRoute ? input.acceptance : input.decision;
  if (input.template_id !== TEMPLATE_ID || !['accept', 'reject', 'ban'].includes(decision)) throw new ApiError('VALIDATION_ERROR', '订阅模板或授权结果无效');
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const row = await owned(tx, ctx, id);
    if (row.type === 'event') throw new ApiError('VALIDATION_ERROR', '请在活动订阅页面管理此提醒');
    requireEnabled(ctx, reminderType(row));
    if (!!row.instant_simulation !== instant) throw new ApiError('VALIDATION_ERROR', '请使用对应的提醒确认入口');
    if (ctx.config.instantSimulationOnly && reminderType(row) === 'ecology_simulation' && !instant) throw new ApiError('SIMULATION_MOVED', '模拟异常体验已移至首页生态观察', 409);
    if (row.template_id !== TEMPLATE_ID) throw new ApiError('TEMPLATE_CHANGED', '预约模板已调整，请重新预约', 409);
    if (row.state !== 'prepared') {
      if (decision === 'accept' && ['pending', 'preparing', 'sending', 'retry', 'sent', 'unknown', ...(instant ? ['failed', 'expired'] : [])].includes(row.state)) return row;
      if (instant && decision !== 'accept' && row.state === 'cancelled' && row.reason === 'subscription_not_accepted') return row;
      throw new ApiError('REMINDER_STATE_CHANGED', '预约状态已改变，请刷新查看', 409);
    }
    if (Date.parse(row.consent_expires_at) <= now || !instant && Date.parse(row.scheduled_for) <= now) throw new ApiError('REMINDER_CONSENT_EXPIRED', '预约确认已过期，请重新选择时间', 409);
    row.state = decision === 'accept' ? 'pending' : 'cancelled'; row.reason = decision === 'accept' ? '' : 'subscription_not_accepted'; row.updated_at = iso(now);
    if (decision === 'accept') {
      if (instant) {
        const key = sha256(ctx.user.id + ':instant:' + weather.dayOf(now));
        const limit = await tx.get('weather_simulation_trials', key) || { id: key, owner_id: ctx.user.id, target_date: weather.dayOf(now), prepared_count: 0, accepted_count: 0 };
        if (limit.accepted_count >= 5) throw new ApiError('REMINDER_RATE_LIMITED', '今天的模拟提醒体验次数已用完，请明天再试', 429);
        limit.accepted_count++; await tx.set('weather_simulation_trials', key, limit);
        row.scheduled_for = iso(now); row.target_date = weather.dayOf(now); row.expires_at = iso(now + 30 * MINUTE);
      }
      row.accepted_at = iso(now); row.next_attempt_at = row.scheduled_for;
      const binding = await tx.get('weather_recipients', ctx.user.id);
      await tx.set('weather_recipients', ctx.user.id, { id: ctx.user.id, owner_id: ctx.user.id, openid: recipient, updated_at: iso(now), pending: { ...(binding && binding.pending || {}), [row.id]: row.expires_at } });
    }
    await tx.set('weather_reminders', row.id, row); return row;
  });
  if (instant && decision === 'accept') {
    // Run only this owned simulated message. Never drain unrelated weather
    // bookings or fetch QWeather as a side effect of opening this experience.
    const reservation = await claim(ctx, row.id, time(ctx));
    if (reservation) await dispatch(ctx, reservation, time(ctx), INSTANT_SIMULATION_MESSAGE);
    const current = await ctx.store.get('weather_reminders', row.id);
    if (!current || current.owner_id !== ctx.user.id) throw new ApiError('NOT_FOUND', '提醒记录已清理', 404);
    return response(present(current));
  }
  return response(present(row));
}
async function cancel(ctx, id) {
  requireUser(ctx); bodyOnly(ctx, []); const now = time(ctx);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const row = await owned(tx, ctx, id);
    if (row.type === 'event') throw new ApiError('VALIDATION_ERROR', '请在活动订阅页面管理此提醒');
    if (row.state === 'cancelled') return row;
    if (!CANCELLABLE.has(row.state)) throw new ApiError(row.state === 'sending' ? 'REMINDER_ALREADY_SENDING' : 'REMINDER_STATE_CHANGED', row.state === 'sending' ? '提醒已进入发送阶段，无法撤回' : '预约已经结束，请刷新查看', 409);
    Object.assign(row, { state: 'cancelled', reason: 'user_cancelled', updated_at: iso(now), lease_token: null, lease_until: null });
    await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return row;
  });
  return response(present(row));
}
async function handle(ctx) {
  const path = '/' + String(ctx.path || '').replace(/^\/+/, ''); if (!path.startsWith('/weather-data/reminders/')) return undefined;
  if ((ctx.query || new URLSearchParams()).size) throw new ApiError('VALIDATION_ERROR', '预约接口不接受额外查询参数');
  if (ctx.method === 'GET' && path === '/weather-data/reminders/') {
    const now = time(ctx); let rows = [];
    if (ctx.user) {
      if (ctx.config.instantSimulationOnly) await retireLegacySimulation(ctx, { ownerId: ctx.user.id });
      // Activity jobs share delivery infrastructure, not the weather page's
      // history window. Page past them, including legacy weather rows without type.
      for (let offset = 0; offset < 1000 && rows.length < 30; offset += 100) {
        const batch = await ctx.store.list('weather_reminders', { where: { owner_id: ctx.user.id }, orderBy: [{ field: 'created_at', direction: 'desc' }], offset, limit: 100 });
        rows.push(...batch.filter(row => row.type !== 'event').slice(0, 30 - rows.length));
        if (batch.length < 100) break;
      }
      rows = await Promise.all(rows.map(row => ctx.store.transaction(async tx => {
        const current = await tx.get('weather_reminders', row.id); if (!current || current.owner_id !== ctx.user.id) return null;
        if (expireRow(current, now)) { await tx.set('weather_reminders', current.id, current); await releaseRecipient(tx, current); } return current;
      })));
    }
    const ready = enabled(ctx), simulationReady = !ctx.config.instantSimulationOnly && enabled(ctx, 'ecology_simulation');
    return response({ enabled: ready, simulation_enabled: simulationReady, reason: ready ? '' : 'subscriptions_not_configured', template_id: ready || simulationReady ? TEMPLATE_ID : '', mode: 'once_and_daily',
      instant_simulation_enabled: enabled(ctx, 'ecology_simulation'), notice: '每日提醒消耗主动订阅次数，用完后停止；单次预约单独授权。北京时间，通常在预约后 5 分钟内发送。', ...await daily.status(ctx), items: rows.filter(row => row && row.type !== 'event').map(present),
      wechat_login: !!ctx.user && typeof ctx.wechatOpenId === 'string', server_time: iso(now), min_lead_minutes: 5, max_ahead_hours: 48 });
  }
  if (ctx.method !== 'POST') return undefined;
  const scheduled = await daily.handle(ctx, path); if (scheduled !== undefined) return scheduled;
  if (path === '/weather-data/reminders/simulation-intents/') return createSimulationIntent(ctx);
  const simulationConfirmation = path.match(/^\/weather-data\/reminders\/simulation-intents\/([A-Za-z0-9_-]{1,80})\/confirm\/$/);
  if (simulationConfirmation) return confirm(ctx, simulationConfirmation[1], false, true);
  if (path === '/weather-data/reminders/intents/') return createIntent(ctx);
  const confirmation = path.match(/^\/weather-data\/reminders\/intents\/([A-Za-z0-9_-]{1,80})\/confirm\/$/);
  if (confirmation) return confirm(ctx, confirmation[1], false);
  const consent = path.match(/^\/weather-data\/reminders\/([A-Za-z0-9_-]{1,80})\/consent\/$/);
  if (consent) return confirm(ctx, consent[1], true);
  const cancelled = path.match(/^\/weather-data\/reminders\/([A-Za-z0-9_-]{1,80})\/cancel\/$/);
  if (cancelled) return cancel(ctx, cancelled[1]);
  return undefined;
}
function short(value, fallback) { return Array.from(String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim() || fallback).slice(0, 20).join(''); }
function forecastSummary(day, scheduledFor, location) {
  if (!day) return null;
  const clock = new Date(Date.parse(scheduledFor) + 8 * 3600000), minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes();
  const night = minutes >= 19 * 60 + 30 || minutes < 6 * 60, part = night ? day.nighttime : day.daytime;
  const condition = typeof (part || {}).condition === 'string' ? part.condition.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
  const celsius = ['°C', '℃', 'C', 'celsius'].includes(day.temperature_unit);
  const validTemperature = value => celsius && typeof value === 'number' && Number.isFinite(value) && value >= -100 && value <= 100;
  let low = validTemperature(day.temperature_min) ? Math.trunc(day.temperature_min) : null;
  let high = validTemperature(day.temperature_max) ? Math.trunc(day.temperature_max) : null;
  if (low !== null && high !== null && day.temperature_min > day.temperature_max) { low = null; high = null; }
  const temperature = low !== null && high !== null ? `${low}～${high}℃` : low !== null ? `最低${low}℃` : high !== null ? `最高${high}℃` : '';
  if (!condition && !temperature) return null;
  // Preserve temperatures when a long condition must fit WeChat's 20-character thing field.
  const city = location ? String(location.name).replace(/市$/, '') + '：' : '';
  const prefix = city + (night && condition ? '夜间' : ''), suffix = temperature ? (condition ? '，' : '') + temperature : '';
  const budget = 20 - Array.from(prefix + suffix).length, characters = Array.from(condition);
  const label = characters.length > budget ? characters.slice(0, budget - 1).join('') + '…' : condition;
  return prefix + label + suffix;
}
function message(row, user, recipient, summary) {
  if (reminderType(row) === 'event') return { touser: recipient.openid, templateId: TEMPLATE_ID, page: 'pages/events/index',
    data: { thing1: { value: short(user.nickname, '海晏河清用户') }, thing2: { value: short('模拟活动：' + row.event.title, '模拟活动') },
      thing4: { value: summary }, time26: { value: cnTime(Date.parse(row.event.starts_at)) }, time9: { value: cnTime(Date.parse(row.event.ends_at)) } } };
  const isSimulation = reminderType(row) === 'ecology_simulation', location = weather.locationFor(row.location);
  const page = row.instant_simulation ? 'pages/home/index' : isSimulation ? 'pages/weather/index?type=ecology_simulation&scenario=' + row.scenario : 'pages/weather/index?location=' + location.slug;
  return { touser: recipient.openid, templateId: TEMPLATE_ID, page,
    data: { thing1: { value: short(user.nickname, '海晏河清用户') }, thing2: { value: row.instant_simulation ? '生态模拟异常提醒' : isSimulation ? '生态模拟提醒' : short(location.name + '天气预约', '天气预约') },
      thing4: { value: summary }, time26: { value: cnTime(Date.parse(row.scheduled_for)) }, time9: { value: cnTime(Date.parse(row.expires_at)) } } };
}
async function claim(ctx, id, now) {
  return ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', id); if (!row) return null;
    if (expireRow(row, now)) { await tx.set('weather_reminders', id, row); await releaseRecipient(tx, row); return null; }
    if (!['pending', 'retry', 'preparing'].includes(row.state) || Date.parse(row.scheduled_for) > now || Date.parse(row.next_attempt_at) > now || row.state === 'preparing' && Date.parse(row.lease_until) > now) return null;
    const user = await tx.get('users', row.owner_id), pooled = row.consent_kind === 'subscription_pool';
    const recipient = pooled ? await daily.recipient(tx, row) : await tx.get('weather_recipients', row.owner_id);
    if (!user || user.is_active !== true || user.deleting || !recipient || typeof recipient.openid !== 'string' || !pooled && (!recipient.pending || !recipient.pending[row.id]) || !row.accepted_at || row.template_id !== TEMPLATE_ID) {
      Object.assign(row, { state: 'cancelled', reason: 'account_or_consent_unavailable', updated_at: iso(now) }); await tx.set('weather_reminders', id, row); await releaseRecipient(tx, row); return null;
    }
    if ((row.weather_attempts || 0) >= 5) { Object.assign(row, { state: 'failed', reason: 'forecast_unavailable', updated_at: iso(now) }); await tx.set('weather_reminders', id, row); await releaseRecipient(tx, row); return null; }
    Object.assign(row, { state: 'preparing', lease_token: uuid(), lease_until: iso(now + 60 * 1000), weather_attempts: (row.weather_attempts || 0) + 1, updated_at: iso(now) });
    await tx.set('weather_reminders', id, row); return row;
  });
}
async function postpone(ctx, reservation, now, reason) {
  return ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', reservation.id);
    if (!row || row.state !== 'preparing' || row.lease_token !== reservation.lease_token) return;
    if (expireRow(row, now)) { await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return; }
    Object.assign(row, { state: Date.parse(row.expires_at) > now + 5 * MINUTE && row.weather_attempts < 5 ? 'retry' : 'failed', reason,
      next_attempt_at: iso(now + 5 * MINUTE), lease_token: null, lease_until: null, updated_at: iso(now) }); await tx.set('weather_reminders', row.id, row); if (row.state === 'failed') await releaseRecipient(tx, row);
  });
}
function targetForecast(value, row, now) {
  if (!value || value.status !== 'fresh' || value.stale || !(Date.parse(value.fetched_at) <= now) || !(Date.parse(value.expires_at) > now) || !value.data || value.data.schema_version !== 2) return null;
  return (Array.isArray(value.data.days) ? value.data.days : []).find(day => day.date === row.target_date && Date.parse(day.ends_at) > now
    && Number.isFinite(Date.parse(day.starts_at)) && Date.parse(day.ends_at) > Date.parse(day.starts_at));
}
async function dispatch(ctx, reservation, now, summary) {
  // This transaction is the cancellation/deletion linearization point. Before
  // it commits cancellation prevents dispatch; afterwards sending cannot retract.
  const outbound = await ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', reservation.id);
    if (!row || row.state !== 'preparing' || row.lease_token !== reservation.lease_token) return null;
    if (expireRow(row, now)) { await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return null; }
    if (Date.parse(row.lease_until) <= now) return null;
    const user = await tx.get('users', row.owner_id), pooled = row.consent_kind === 'subscription_pool';
    const recipient = pooled ? await daily.recipient(tx, row) : await tx.get('weather_recipients', row.owner_id);
    if (!user || user.is_active !== true || user.deleting || !recipient || !pooled && (!recipient.pending || !recipient.pending[row.id])) {
      Object.assign(row, { state: 'cancelled', reason: 'account_unavailable', lease_token: null, lease_until: null, updated_at: iso(now) }); await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return null;
    }
    Object.assign(row, { state: 'sending', attempts: (row.attempts || 0) + 1, lease_until: iso(now + 60 * 1000), updated_at: iso(now) });
    if (pooled) row.pool_grants_at_dispatch = recipient.total_grants;
    else {
      const pool = await tx.get('weather_subscription_pools', row.owner_id);
      if (pool) { row.pool_generation_at_dispatch = pool.generation; row.pool_grants_at_dispatch = pool.total_grants || 0; }
    }
    await tx.set('weather_reminders', row.id, row); return { request: message(row, user, recipient, summary), row };
  });
  if (!outbound) return 'cancelled';
  let result, refusal = null, ambiguous = false, notDispatched = false, timer;
  try {
    result = await Promise.race([Promise.resolve().then(() => ctx.providers.sendWeatherReminder(outbound.request)), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('delivery_timeout'), { ambiguous: true })), 10000); })]);
    const code = result && (result.errCode === undefined ? result.errcode : result.errCode);
    if (code !== 0) { if (Number.isInteger(code) && code !== 0) refusal = code; else ambiguous = true; }
  } catch (error) {
    const code = error && (error.errCode === undefined ? error.errcode : error.errCode);
    if (error && error.code === 'SUBSCRIPTION_PAYLOAD_INVALID' && error.dispatched === false) notDispatched = true;
    else if (Number.isInteger(code) && code !== 0 && error.ambiguous !== true) refusal = code; else ambiguous = true;
  } finally { clearTimeout(timer); }
  const state = notDispatched ? 'failed' : ambiguous ? 'unknown' : refusal === null ? 'sent' : [-1, 45009].includes(refusal) && outbound.row.attempts < 2 && Date.parse(outbound.row.expires_at) > now + 5 * MINUTE ? 'retry' : 'failed';
  await ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', reservation.id);
    if (!row || row.state !== 'sending' || row.lease_token !== reservation.lease_token) return;
    Object.assign(row, { state, reason: notDispatched ? 'delivery_not_dispatched' : ambiguous ? 'delivery_unconfirmed' : refusal === null ? '' : 'platform_rejected',
      ...(refusal === null ? {} : { platform_error_code: refusal }), next_attempt_at: state === 'retry' ? iso(now + 5 * MINUTE) : null,
      lease_token: null, lease_until: null, updated_at: iso(now), ...(state === 'sent' ? { sent_at: iso(now) } : {}) });
    await tx.set('weather_reminders', row.id, row); if (state !== 'retry') await releaseRecipient(tx, row);
  });
  return state;
}
async function runDueReminders(ctx, { limit = 4 } = {}) {
  if (!deliveryEnabled(ctx)) return { enabled: false, processed: 0 };
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new ApiError('VALIDATION_ERROR', 'Invalid reminder batch limit');
  const now = time(ctx), started = Date.now(), rows = [], liveNow = () => now + Math.max(0, Date.now() - started);
  if (ctx.config.instantSimulationOnly) await retireLegacySimulation(ctx);
  await daily.materialize(ctx, 20);
  // Equality queries plus bounded sorted pages work on the native store; expired
  // rows become terminal so they cannot permanently starve later appointments.
  for (const state of ['sending', 'preparing', 'retry', 'pending']) {
    rows.push(...await ctx.store.list('weather_reminders', { where: { state }, orderBy: [{ field: 'scheduled_for', direction: 'asc' }], limit }));
    // Disabled weather rows cannot occupy the entire query window ahead of
    // independently configured event messages. Preserve the legacy untyped path.
    rows.push(...await ctx.store.list('weather_reminders', { where: { state, type: 'event' }, orderBy: [{ field: 'scheduled_for', direction: 'asc' }], limit }));
  }
  const seen = new Set(), output = { enabled: true, processed: 0, sent: 0, deferred: 0, unknown: 0, failed: 0 };
  for (const item of rows.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))) {
    if (seen.has(item.id)) continue; seen.add(item.id);
    if (output.processed >= limit || Date.now() - started > 25000) break;
    if (ctx.config.instantSimulationOnly && reminderType(item) === 'ecology_simulation' && !item.instant_simulation) continue;
    if (!enabled(ctx, reminderType(item))) continue;
    const row = await claim(ctx, item.id, liveNow()); if (!row) continue;
    output.processed++;
    let summary;
    if (reminderType(row) === 'event') {
      const event = row.event;
      summary = event && event.simulated === true && typeof event.location_name === 'string' && Number.isFinite(Date.parse(event.starts_at))
        && Date.parse(event.ends_at) > liveNow() ? short('模拟地点：' + event.location_name, '模拟活动地点') : null;
    } else if (reminderType(row) === 'ecology_simulation') {
      const sample = simulation.preview(row.scenario); summary = row.instant_simulation ? INSTANT_SIMULATION_MESSAGE : sample && sample.reminder_text;
    } else {
      let forecast;
      try { forecast = await weather.component({ ...ctx, now: iso(liveNow()) }, weather.locationFor(row.location), 'daily', ctx.providers.fetchWeather); }
      catch (_) { forecast = null; }
      summary = forecastSummary(targetForecast(forecast, row, liveNow()), row.scheduled_for, weather.locationFor(row.location));
    }
    if (!summary) { await postpone(ctx, row, liveNow(), 'forecast_unavailable'); output.deferred++; continue; }
    const state = await dispatch(ctx, row, liveNow(), summary); if (Object.hasOwn(output, state)) output[state]++;
  }
  return output;
}
async function retireLegacySimulation(ctx, { limit = 20, ownerId } = {}) {
  let changed = await daily.retireSimulationPlans(ctx, Math.max(1, Math.floor(limit / 2)), ownerId);
  for (const state of ['prepared', 'pending', 'preparing', 'retry']) {
    if (changed >= limit) break;
    const rows = await ctx.store.list('weather_reminders', { where: { type: 'ecology_simulation', state, ...(ownerId ? { owner_id: ownerId } : {}) }, orderBy: [{ field: 'created_at', direction: 'asc' }], limit: limit - changed });
    for (const candidate of rows) {
      if (candidate.instant_simulation) continue;
      changed += await ctx.store.transaction(async tx => {
        const row = await tx.get('weather_reminders', candidate.id);
        if (!row || row.instant_simulation || row.state !== state || ownerId && row.owner_id !== ownerId) return 0;
        Object.assign(row, { state: 'cancelled', reason: 'simulation_changed_to_instant', updated_at: ctx.now, lease_token: null, lease_until: null });
        await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return 1;
      });
    }
  }
  return changed;
}
async function cleanupReminders(ctx, { limit = 20, alive = () => true } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof alive !== 'function') throw new ApiError('VALIDATION_ERROR', 'Invalid reminder cleanup limit');
  const start = Date.now(), admitted = time(ctx), now = () => admitted + Math.max(0, Date.now() - start);
  const out = { processed: 0, prepared_expired: 0, expired: 0, unknown: 0, reminders_removed: 0, day_locks_removed: 0, grants_removed: 0, event_receipts_removed: 0 };
  const available = () => out.processed < limit && alive();
  // Reserve a small bounded share for old subscription receipts as well.
  if (available()) {
    const grants = await ctx.store.list('weather_subscription_grants', { orderBy: [{ field: 'updated_at', direction: 'asc' }], limit: Math.max(1, Math.floor(limit / 5)) });
    for (const candidate of grants) {
      if (!available() || !(Date.parse(candidate.updated_at) <= now() - 30 * 86400000)) break;
      const removed = await ctx.store.transaction(async tx => {
        const row = await tx.get('weather_subscription_grants', candidate.id);
        if (!row || !(Date.parse(row.updated_at) <= now() - 30 * 86400000)) return false;
        // Aggregate credits remain in their pool; purging the old confirmation
        // receipt does not revoke an unused subscription or permit replay.
        await tx.remove('weather_subscription_grants', row.id); return true;
      });
      if (removed) { out.processed++; out.grants_removed++; }
    }
  }
  if (available()) {
    const receipts = await ctx.store.list('event_delivery_receipts', { orderBy: [{ field: 'retain_until', direction: 'asc' }], limit: Math.max(1, Math.floor(limit / 5)) });
    for (const candidate of receipts) {
      if (!available() || !(Date.parse(candidate.retain_until) <= now())) break;
      const removed = await ctx.store.transaction(async tx => {
        const row = await tx.get('event_delivery_receipts', candidate.id);
        if (!row || !(Date.parse(row.retain_until) <= now())) return false;
        await tx.remove('event_delivery_receipts', row.id); return true;
      });
      if (removed) { out.processed++; out.event_receipts_removed++; }
    }
  }
  // A third of the batch is reserved for historical records and day locks so
  // continuous incoming appointments cannot starve retention work indefinitely.
  const expiryAllowance = Math.max(1, Math.floor(limit * 2 / 3));
  for (const state of ['prepared', 'pending', 'retry', 'preparing', 'sending']) {
    if (!available() || out.processed >= expiryAllowance) break;
    const field = state === 'prepared' ? 'consent_expires_at' : state === 'sending' ? 'lease_until' : 'expires_at';
    const rows = await ctx.store.list('weather_reminders', { where: { state }, orderBy: [{ field, direction: 'asc' }], limit: Math.min(limit - out.processed, expiryAllowance - out.processed) });
    for (const candidate of rows) {
      if (!available() || out.processed >= expiryAllowance) break;
      if (!(Date.parse(candidate[field]) <= now())) break;
      const changed = await ctx.store.transaction(async tx => {
        const row = await tx.get('weather_reminders', candidate.id);
        if (!row || row.state !== state || !expireRow(row, now())) return null;
        await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return row.state;
      });
      if (changed) { out.processed++; if (state === 'prepared') out.prepared_expired++; if (changed === 'unknown') out.unknown++; else out.expired++; }
    }
  }
  const historyAllowance = Math.max(out.processed, limit > 1 ? limit - 1 : limit);
  for (const state of ['sent', 'cancelled', 'expired', 'failed', 'unknown']) {
    if (!available() || out.processed >= historyAllowance) break;
    const rows = await ctx.store.list('weather_reminders', { where: { state }, orderBy: [{ field: 'updated_at', direction: 'asc' }], limit: Math.min(limit - out.processed, historyAllowance - out.processed) });
    for (const candidate of rows) {
      if (!available() || out.processed >= historyAllowance) break;
      if (!(Date.parse(candidate.updated_at) <= now() - 30 * 86400000)) break;
      const removed = await ctx.store.transaction(async tx => {
        const row = await tx.get('weather_reminders', candidate.id);
        if (!row || row.state !== state || !(Date.parse(row.updated_at) <= now() - 30 * 86400000)) return false;
        await releaseRecipient(tx, row); await tx.remove('weather_reminders', row.id); return true;
      });
      if (removed) { out.processed++; out.reminders_removed++; }
    }
  }
  for (const kind of ['weather_reminder_days', 'weather_simulation_trials']) {
    if (!available()) break;
    const rows = await ctx.store.list(kind, { orderBy: [{ field: 'target_date', direction: 'asc' }], limit: limit - out.processed });
    for (const candidate of rows) {
      if (!available()) break;
      if (!(candidate.target_date <= weather.dayOf(now() - 90 * 86400000))) break;
      const removed = await ctx.store.transaction(async tx => {
        const lock = await tx.get(kind, candidate.id);
        if (!lock || !(lock.target_date <= weather.dayOf(now() - 90 * 86400000))) return false;
        const reminderId = lock.reminder_id || lock.intent_id;
        const row = reminderId ? await tx.get('weather_reminders', reminderId) : null;
        if (row && ACTIVE.has(row.state)) return false;
        await tx.remove(kind, lock.id); return true;
      });
      if (removed) { out.processed++; out.day_locks_removed++; }
    }
  }
  return out;
}
async function purgeOwnerReminders(ctx, ownerId) {
  // Call only after the account was made inactive. This marker and dispatch's
  // final user read prevent a concurrent worker recreating deliverable records.
  for (const kind of ['weather_reminders', 'event_delivery_receipts', 'weather_reminder_days', 'weather_subscription_grants', 'weather_subscription_pools', 'weather_daily_plans', 'weather_simulation_trials']) {
    for (;;) {
      const rows = await ctx.store.list(kind, { where: { owner_id: ownerId }, limit: 100 }); if (!rows.length) break;
      for (const row of rows) await ctx.store.remove(kind, row.id);
    }
  }
  await ctx.store.remove('weather_recipients', ownerId);
}
module.exports = { handle, runDueReminders, purgeOwnerReminders, cleanupReminders, retireLegacySimulation, TEMPLATE_ID, enabled, targetForecast };
