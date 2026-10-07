'use strict';
// One explicit appointment and one platform consent per delivery. Recipient IDs
// live only in the administrator-only store, never in responses or audit logs.
const { ApiError, response, requireUser, uuid, sha256 } = require('./core');
const weather = require('./weather');
const TEMPLATE_ID = 'd8VSXhq_6KMMjGvEp7CxS-0lL-573ZYbODuXFLW7WtI';
const MINUTE = 60000;
const ACTIVE = new Set(['prepared', 'pending', 'preparing', 'retry', 'sending']);
const CANCELLABLE = new Set(['prepared', 'pending', 'preparing', 'retry']);
function time(ctx) { const n = Date.parse(ctx.now); if (!Number.isFinite(n)) throw new ApiError('SERVER_TIME_INVALID', '服务时间暂不可用', 503); return n; }
function iso(n) { return new Date(n).toISOString(); }
function cnTime(n) { return new Date(n + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function settings(ctx) { return ctx.config && ctx.config.weatherReminders || {}; }
function enabled(ctx) { return settings(ctx).enabled === true && settings(ctx).templateId === TEMPLATE_ID && weather.configured(ctx.config) && typeof (ctx.providers || {}).sendWeatherReminder === 'function'; }
function requireEnabled(ctx) { if (!enabled(ctx)) throw new ApiError('SUBSCRIPTIONS_DISABLED', '天气预约提醒暂未开放', 503); }
function identity(ctx) { requireUser(ctx); if (typeof ctx.wechatOpenId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.wechatOpenId)) throw new ApiError('WECHAT_IDENTITY_REQUIRED', '请通过微信小程序重新登录后预约', 403); return ctx.wechatOpenId; }
function bodyOnly(ctx, fields) { const b = ctx.body; if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join(',') !== [...fields].sort().join(',')) throw new ApiError('VALIDATION_ERROR', '预约参数无效'); return b; }
function lockId(owner, date) { return sha256(owner + ':' + date); }
function present(row) {
  const location = weather.locationFor(row.location);
  return { id: row.id, location: location ? { slug: location.slug, name: location.name } : null, location_name: location && location.name || '',
    state: row.state, scheduled_for: row.scheduled_for, target_date: row.target_date, expires_at: row.expires_at, consent_expires_at: row.consent_expires_at,
    template_id: row.template_id, created_at: row.created_at, updated_at: row.updated_at, can_cancel: CANCELLABLE.has(row.state), reason: row.reason || '' };
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
  const recipient = await tx.get('weather_recipients', row.owner_id); if (!recipient) return;
  const pending = { ...(recipient.pending || {}) }; delete pending[row.id];
  if (Object.keys(pending).length) await tx.set('weather_recipients', row.owner_id, { ...recipient, pending });
  else await tx.remove('weather_recipients', row.owner_id);
}
async function createIntent(ctx) {
  requireEnabled(ctx); identity(ctx);
  const input = bodyOnly(ctx, ['location', 'scheduled_for']), now = time(ctx), location = weather.locationFor(input.location);
  if (!location) throw new ApiError('VALIDATION_ERROR', '请选择支持的天气城市');
  if (typeof input.scheduled_for !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduled_for)) throw new ApiError('VALIDATION_ERROR', '请选择有效预约时间');
  const [year, month, day] = input.scheduled_for.slice(0, 10).split('-').map(Number), calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) throw new ApiError('VALIDATION_ERROR', '请选择有效预约时间');
  const scheduled = Date.parse(input.scheduled_for);
  if (!Number.isFinite(scheduled) || scheduled < now + 5 * MINUTE || scheduled > now + 48 * 60 * MINUTE) throw new ApiError('REMINDER_TIME_INVALID', '预约时间须在 5 分钟后至 48 小时内');
  const target = weather.dayOf(scheduled), key = lockId(ctx.user.id, target);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id);
    const lock = await tx.get('weather_reminder_days', key), previous = lock && await tx.get('weather_reminders', lock.reminder_id);
    if (active(previous, now)) {
      if (previous.location === location.slug && previous.scheduled_for === iso(scheduled)) return previous;
      throw new ApiError('WEATHER_REMINDER_EXISTS', '当天已有天气预约，请先取消后再修改', 409);
    }
    if (previous && expireRow(previous, now)) { await tx.set('weather_reminders', previous.id, previous); await releaseRecipient(tx, previous); }
    if (lock && lock.created_count >= 10) throw new ApiError('REMINDER_RATE_LIMITED', '当天预约修改次数较多，请稍后再试', 429);
    const row = { id: uuid(), owner_id: ctx.user.id, location: location.slug, scheduled_for: iso(scheduled), target_date: target,
      expires_at: iso(scheduled + 30 * MINUTE), consent_expires_at: iso(Math.min(now + 10 * MINUTE, scheduled)), state: 'prepared', template_id: TEMPLATE_ID,
      created_at: iso(now), updated_at: iso(now), reason: '', attempts: 0, weather_attempts: 0 };
    await tx.set('weather_reminders', row.id, row);
    await tx.set('weather_reminder_days', key, { id: key, owner_id: ctx.user.id, target_date: target, reminder_id: row.id, created_count: (lock && lock.created_count || 0) + 1 });
    return row;
  });
  return response(present(row), row.created_at === iso(now) ? 201 : 200);
}
async function confirm(ctx, id, oldRoute) {
  requireEnabled(ctx); const recipient = identity(ctx), input = bodyOnly(ctx, oldRoute ? ['template_id', 'acceptance'] : ['template_id', 'decision']), now = time(ctx);
  const decision = oldRoute ? input.acceptance : input.decision;
  if (input.template_id !== TEMPLATE_ID || !['accept', 'reject', 'ban'].includes(decision)) throw new ApiError('VALIDATION_ERROR', '订阅模板或授权结果无效');
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const row = await owned(tx, ctx, id);
    if (row.template_id !== TEMPLATE_ID) throw new ApiError('TEMPLATE_CHANGED', '预约模板已调整，请重新预约', 409);
    if (row.state !== 'prepared') {
      if (decision === 'accept' && ['pending', 'preparing', 'sending', 'retry', 'sent', 'unknown'].includes(row.state)) return row;
      throw new ApiError('REMINDER_STATE_CHANGED', '预约状态已改变，请刷新查看', 409);
    }
    if (Date.parse(row.consent_expires_at) <= now || Date.parse(row.scheduled_for) <= now) throw new ApiError('REMINDER_CONSENT_EXPIRED', '预约确认已过期，请重新选择时间', 409);
    row.state = decision === 'accept' ? 'pending' : 'cancelled'; row.reason = decision === 'accept' ? '' : 'subscription_not_accepted'; row.updated_at = iso(now);
    if (decision === 'accept') {
      row.accepted_at = iso(now); row.next_attempt_at = row.scheduled_for;
      const binding = await tx.get('weather_recipients', ctx.user.id);
      await tx.set('weather_recipients', ctx.user.id, { id: ctx.user.id, owner_id: ctx.user.id, openid: recipient, updated_at: iso(now), pending: { ...(binding && binding.pending || {}), [row.id]: row.expires_at } });
    }
    await tx.set('weather_reminders', row.id, row); return row;
  });
  return response(present(row));
}
async function cancel(ctx, id) {
  requireUser(ctx); bodyOnly(ctx, []); const now = time(ctx);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const row = await owned(tx, ctx, id);
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
      rows = await ctx.store.list('weather_reminders', { where: { owner_id: ctx.user.id }, orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 30 });
      rows = await Promise.all(rows.map(row => ctx.store.transaction(async tx => {
        const current = await tx.get('weather_reminders', row.id); if (!current || current.owner_id !== ctx.user.id) return null;
        if (expireRow(current, now)) { await tx.set('weather_reminders', current.id, current); await releaseRecipient(tx, current); } return current;
      })));
    }
    const ready = enabled(ctx);
    return response({ enabled: ready, reason: ready ? '' : 'subscriptions_not_configured', template_id: ready ? TEMPLATE_ID : '', mode: 'once',
      notice: '每次预约仅提醒一次；北京时间，通常在预约后 5 分钟内发送。微信是否实际送达以平台结果为准。', items: rows.filter(Boolean).map(present),
      wechat_login: !!ctx.user && typeof ctx.wechatOpenId === 'string', server_time: iso(now), min_lead_minutes: 5, max_ahead_hours: 48 });
  }
  if (ctx.method !== 'POST') return undefined;
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
function message(row, user, recipient) {
  const location = weather.locationFor(row.location);
  return { touser: recipient.openid, templateId: TEMPLATE_ID, page: 'pages/weather/index?location=' + location.slug,
    data: { thing1: { value: short(user.nickname, '海晏河清用户') }, thing2: { value: short(location.name + '天气预约', '天气预约') },
      thing4: { value: '天气预约已到，请留意出行安排' }, time26: { value: cnTime(Date.parse(row.scheduled_for)) }, time9: { value: cnTime(Date.parse(row.expires_at)) } } };
}
async function claim(ctx, id, now) {
  return ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', id); if (!row) return null;
    if (expireRow(row, now)) { await tx.set('weather_reminders', id, row); await releaseRecipient(tx, row); return null; }
    if (!['pending', 'retry', 'preparing'].includes(row.state) || Date.parse(row.scheduled_for) > now || Date.parse(row.next_attempt_at) > now || row.state === 'preparing' && Date.parse(row.lease_until) > now) return null;
    const user = await tx.get('users', row.owner_id), recipient = await tx.get('weather_recipients', row.owner_id);
    if (!user || user.is_active !== true || user.deleting || !recipient || typeof recipient.openid !== 'string' || !recipient.pending || !recipient.pending[row.id] || !row.accepted_at || row.template_id !== TEMPLATE_ID) {
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
async function dispatch(ctx, reservation, now) {
  // This transaction is the cancellation/deletion linearization point. Before
  // it commits cancellation prevents dispatch; afterwards sending cannot retract.
  const outbound = await ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', reservation.id);
    if (!row || row.state !== 'preparing' || row.lease_token !== reservation.lease_token) return null;
    if (expireRow(row, now)) { await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return null; }
    if (Date.parse(row.lease_until) <= now) return null;
    const user = await tx.get('users', row.owner_id), recipient = await tx.get('weather_recipients', row.owner_id);
    if (!user || user.is_active !== true || user.deleting || !recipient || !recipient.pending || !recipient.pending[row.id]) {
      Object.assign(row, { state: 'cancelled', reason: 'account_unavailable', lease_token: null, lease_until: null, updated_at: iso(now) }); await tx.set('weather_reminders', row.id, row); await releaseRecipient(tx, row); return null;
    }
    Object.assign(row, { state: 'sending', attempts: (row.attempts || 0) + 1, lease_until: iso(now + 60 * 1000), updated_at: iso(now) });
    await tx.set('weather_reminders', row.id, row); return { request: message(row, user, recipient), row };
  });
  if (!outbound) return 'cancelled';
  let result, refusal = null, ambiguous = false, timer;
  try {
    result = await Promise.race([Promise.resolve().then(() => ctx.providers.sendWeatherReminder(outbound.request)), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('delivery_timeout'), { ambiguous: true })), 10000); })]);
    const code = result && (result.errCode === undefined ? result.errcode : result.errCode);
    if (code !== 0) { if (Number.isInteger(code) && code !== 0) refusal = code; else ambiguous = true; }
  } catch (error) {
    const code = error && (error.errCode === undefined ? error.errcode : error.errCode);
    if (Number.isInteger(code) && code !== 0 && error.ambiguous !== true) refusal = code; else ambiguous = true;
  } finally { clearTimeout(timer); }
  const state = ambiguous ? 'unknown' : refusal === null ? 'sent' : [-1, 45009].includes(refusal) && outbound.row.attempts < 2 && Date.parse(outbound.row.expires_at) > now + 5 * MINUTE ? 'retry' : 'failed';
  await ctx.store.transaction(async tx => {
    const row = await tx.get('weather_reminders', reservation.id);
    if (!row || row.state !== 'sending' || row.lease_token !== reservation.lease_token) return;
    Object.assign(row, { state, reason: ambiguous ? 'delivery_unconfirmed' : refusal === null ? '' : 'platform_rejected',
      ...(refusal === null ? {} : { platform_error_code: refusal }), next_attempt_at: state === 'retry' ? iso(now + 5 * MINUTE) : null,
      lease_token: null, lease_until: null, updated_at: iso(now), ...(state === 'sent' ? { sent_at: iso(now) } : {}) });
    await tx.set('weather_reminders', row.id, row); if (state !== 'retry') await releaseRecipient(tx, row);
  });
  return state;
}
async function runDueReminders(ctx, { limit = 4 } = {}) {
  if (!enabled(ctx)) return { enabled: false, processed: 0 };
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new ApiError('VALIDATION_ERROR', 'Invalid reminder batch limit');
  const now = time(ctx), started = Date.now(), rows = [], liveNow = () => now + Math.max(0, Date.now() - started);
  // Equality queries plus bounded sorted pages work on the native store; expired
  // rows become terminal so they cannot permanently starve later appointments.
  for (const state of ['sending', 'preparing', 'retry', 'pending']) rows.push(...await ctx.store.list('weather_reminders', { where: { state }, orderBy: [{ field: 'scheduled_for', direction: 'asc' }], limit }));
  const seen = new Set(), output = { enabled: true, processed: 0, sent: 0, deferred: 0, unknown: 0, failed: 0 };
  for (const item of rows.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for))) {
    if (seen.has(item.id)) continue; seen.add(item.id);
    if (output.processed >= limit || Date.now() - started > 25000) break;
    const row = await claim(ctx, item.id, liveNow()); if (!row) continue;
    output.processed++;
    let forecast;
    try { forecast = await weather.component({ ...ctx, now: iso(liveNow()) }, weather.locationFor(row.location), 'daily', ctx.providers.fetchWeather); }
    catch (_) { forecast = null; }
    if (!targetForecast(forecast, row, liveNow())) { await postpone(ctx, row, liveNow(), 'forecast_unavailable'); output.deferred++; continue; }
    const state = await dispatch(ctx, row, liveNow()); if (Object.hasOwn(output, state)) output[state]++;
  }
  return output;
}
async function cleanupReminders(ctx, { limit = 20, alive = () => true } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof alive !== 'function') throw new ApiError('VALIDATION_ERROR', 'Invalid reminder cleanup limit');
  const start = Date.now(), admitted = time(ctx), now = () => admitted + Math.max(0, Date.now() - start);
  const out = { processed: 0, prepared_expired: 0, expired: 0, unknown: 0, reminders_removed: 0, day_locks_removed: 0 };
  const available = () => out.processed < limit && alive();
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
  if (available()) {
    const rows = await ctx.store.list('weather_reminder_days', { orderBy: [{ field: 'target_date', direction: 'asc' }], limit: limit - out.processed });
    for (const candidate of rows) {
      if (!available()) break;
      if (!(candidate.target_date <= weather.dayOf(now() - 90 * 86400000))) break;
      const removed = await ctx.store.transaction(async tx => {
        const lock = await tx.get('weather_reminder_days', candidate.id);
        if (!lock || !(lock.target_date <= weather.dayOf(now() - 90 * 86400000))) return false;
        const row = await tx.get('weather_reminders', lock.reminder_id);
        if (row && ACTIVE.has(row.state)) return false;
        await tx.remove('weather_reminder_days', lock.id); return true;
      });
      if (removed) { out.processed++; out.day_locks_removed++; }
    }
  }
  return out;
}
async function purgeOwnerReminders(ctx, ownerId) {
  // Call only after the account was made inactive. This marker and dispatch's
  // final user read prevent a concurrent worker recreating deliverable records.
  for (const kind of ['weather_reminders', 'weather_reminder_days']) {
    for (;;) {
      const rows = await ctx.store.list(kind, { where: { owner_id: ownerId }, limit: 100 }); if (!rows.length) break;
      for (const row of rows) await ctx.store.remove(kind, row.id);
    }
  }
  await ctx.store.remove('weather_recipients', ownerId);
}
module.exports = { handle, runDueReminders, purgeOwnerReminders, cleanupReminders, TEMPLATE_ID, enabled, targetForecast };
