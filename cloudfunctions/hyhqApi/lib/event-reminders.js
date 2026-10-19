'use strict';
const { ApiError, sha256, dateCN } = require('./core');
const daily = require('./weather-daily');
const DAY = 86400000;
const TIME_RULE = '活动前一天20:00（北京时间）；已过时间且活动未结束则尽快发送一次，通常在5分钟内。';
const ACTIVE = new Set(['pending', 'retry', 'preparing', 'sending']);
function enabled(ctx) { return daily.ready(ctx); }
function requireEnabled(ctx) { if (!enabled(ctx)) throw new ApiError('SUBSCRIPTIONS_DISABLED', '微信活动提醒暂未开放，请稍后重试', 503); daily.identity(ctx); }
function scheduled(event, now) {
  const start = Date.parse(event.starts_at), end = Date.parse(event.ends_at), n = Date.parse(now);
  if (![start, end, n].every(Number.isFinite) || end <= n || start >= end) throw new ApiError('EVENT_UNAVAILABLE', '活动已结束或时间无效，请刷新列表', 409);
  const due = Date.parse(dateCN(event.starts_at) + 'T20:00:00+08:00') - DAY;
  return new Date(Math.max(due, n)).toISOString();
}
function present(row) {
  if (!row) return null;
  return { id: row.reminder_id || row.id, state: row.state, scheduled_for: row.scheduled_for, expires_at: row.expires_at,
    reason: row.reason || '', credit_state: row.credit_state || (row.state === 'sent' ? 'consumed' : row.state === 'unknown' ? 'held' : ''),
    can_cancel: ['pending', 'retry', 'preparing'].includes(row.state), simulated: true };
}
async function status(ctx) {
  return { mode: 'wechat_once', reminder: { enabled: enabled(ctx), template_id: enabled(ctx) ? daily.TEMPLATE_ID : '', mode: 'once', time_rule: TIME_RULE,
    notice: '共享次数是本地估计；微信拒绝后需重新授权。发送结果不确定时不会自动重发，也不会返还次数。',
    wechat_login: !!ctx.user && typeof ctx.wechatOpenId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(ctx.wechatOpenId) },
  subscription_pool: daily.poolPublic(ctx.user ? await ctx.store.get('weather_subscription_pools', ctx.user.id) : null) };
}
async function read(ctx, subscription) {
  if (!subscription.reminder_id) return null;
  const row = await ctx.store.get('weather_reminders', subscription.reminder_id) || await ctx.store.get('event_delivery_receipts', subscription.id);
  return row && row.owner_id === ctx.user.id && row.event_id === subscription.event_id ? present(row) : null;
}
async function reserve(tx, ctx, subscription, event) {
  const n = Date.parse(ctx.now), scheduledFor = scheduled(event, ctx.now), id = sha256('event:' + subscription.id);
  const receipt = await tx.get('event_delivery_receipts', subscription.id);
  if (receipt && receipt.owner_id === ctx.user.id && receipt.event_id === event.id && ['sent', 'unknown'].includes(receipt.state)) {
    subscription.reminder_id = id;
    return present(receipt);
  }
  const old = await tx.get('weather_reminders', id);
  if (old && old.owner_id !== ctx.user.id) throw new ApiError('REMINDER_STATE_CHANGED', '提醒状态已变化，请刷新', 409);
  if (old && (['sent', 'unknown', 'sending'].includes(old.state) || ACTIVE.has(old.state) && await daily.recipient(tx, old))) {
    subscription.reminder_id = id; subscription.reminder_generation = old.event_subscription_generation;
    return present(old);
  }
  if (old && ACTIVE.has(old.state)) {
    Object.assign(old, { state: 'cancelled', reason: 'consent_changed', updated_at: ctx.now, lease_token: null, lease_until: null });
    await tx.set('weather_reminders', id, old); await daily.releaseCredit(tx, old, n);
  }
  const pool = await daily.reserveCredit(tx, ctx.user.id, n);
  if (!pool) throw new ApiError('SUBSCRIPTION_CREDIT_REQUIRED', '微信订阅次数不足或已失效，请主动增加1次后再订阅活动', 409);
  const generation = (old && old.event_subscription_generation || 0) + 1;
  const row = { id, owner_id: ctx.user.id, type: 'event', event_id: event.id, event_subscription_id: subscription.id, event_subscription_generation: generation,
    event: { id: event.id, title: event.title, location_name: event.location_name, starts_at: event.starts_at, ends_at: event.ends_at, simulated: true },
    scheduled_for: scheduledFor, target_date: dateCN(event.starts_at), expires_at: event.ends_at, consent_expires_at: null, accepted_at: ctx.now,
    state: 'pending', template_id: daily.TEMPLATE_ID, created_at: old && old.created_at || ctx.now, updated_at: ctx.now, next_attempt_at: scheduledFor,
    reason: '', attempts: 0, weather_attempts: 0, recurrence: 'once', consent_kind: 'subscription_pool', credit_state: 'reserved', credit_generation: pool.generation };
  await tx.set('weather_reminders', id, row); subscription.reminder_id = id; subscription.reminder_generation = generation;
  return present(row);
}
async function cancel(tx, ctx, subscription) {
  if (!subscription || !subscription.reminder_id) return;
  const row = await tx.get('weather_reminders', subscription.reminder_id);
  if (!row || row.owner_id !== ctx.user.id || row.event_subscription_id !== subscription.id) return;
  if (row.state === 'sending') throw new ApiError('REMINDER_DISPATCHED', '提醒已进入发送阶段，暂时无法撤回，请稍后刷新', 409);
  if (!['pending', 'retry', 'preparing'].includes(row.state)) return;
  Object.assign(row, { state: 'cancelled', reason: 'event_unsubscribed', updated_at: ctx.now, lease_token: null, lease_until: null });
  await tx.set('weather_reminders', row.id, row); await daily.releaseCredit(tx, row, Date.parse(ctx.now));
}
module.exports = { enabled, requireEnabled, scheduled, present, status, read, reserve, cancel, TIME_RULE };
