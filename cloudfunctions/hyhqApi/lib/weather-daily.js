'use strict';
// Only explicit, separately prepared wx.requestSubscribeMessage accept callbacks
// enter this pool. Manual appointments keep their original single-use consent.
const { ApiError, response, requireUser, uuid, sha256 } = require('./core');
const weather = require('./weather');
const simulation = require('./ecology-simulation');
const TEMPLATE_ID = 'd8VSXhq_6KMMjGvEp7CxS-0lL-573ZYbODuXFLW7WtI';
const MINUTE = 60000, DAY = 86400000;
const iso = n => new Date(n).toISOString();
function now(ctx) { const n = Date.parse(ctx.now); if (!Number.isFinite(n)) throw new ApiError('SERVER_TIME_INVALID', '服务时间暂不可用', 503); return n; }
function ready(ctx, type = 'ecology_simulation') { return (ctx.config.weatherReminders || {}).enabled === true && ctx.config.weatherReminders.templateId === TEMPLATE_ID && typeof (ctx.providers || {}).sendWeatherReminder === 'function' && (type === 'ecology_simulation' || weather.configured(ctx.config)); }
function requireReady(ctx, type) { if (!ready(ctx, type)) throw new ApiError('SUBSCRIPTIONS_DISABLED', '提醒暂未开放', 503); }
function identity(ctx) { requireUser(ctx); if (typeof ctx.wechatOpenId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(ctx.wechatOpenId)) throw new ApiError('WECHAT_IDENTITY_REQUIRED', '请通过微信小程序重新登录后订阅', 403); return ctx.wechatOpenId; }
async function owner(tx, id) { const u = await tx.get('users', id); if (!u || u.is_active !== true || u.deleting) throw new ApiError('NOT_AUTHENTICATED', '账号不可用，请重新登录', 401); return u; }
function fields(body, allowed, required = []) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(body, k))) throw new ApiError('VALIDATION_ERROR', '提醒参数无效'); return body; }
const planId = (id, type) => sha256(id + ':' + type);
function typeOf(type) { if (!['weather', 'ecology_simulation'].includes(type)) throw new ApiError('VALIDATION_ERROR', '请选择支持的提醒类型'); return type; }
function poolDefault(id) { return { id, owner_id: id, template_id: TEMPLATE_ID, remaining: 0, reserved: 0, held: 0, consumed: 0, generation: 0, needs_resubscribe: false }; }
function poolPublic(pool) { return { template_id: TEMPLATE_ID, remaining: pool && pool.remaining || 0, reserved: pool && pool.reserved || 0, held: pool && pool.held || 0, needs_resubscribe: !!(pool && pool.needs_resubscribe) }; }
function scheduled(date, clock) { return Date.parse(date + 'T' + clock + ':00+08:00'); }
function nextTime(clock, n, lastDate) { const date = weather.dayOf(n), today = scheduled(date, clock); return iso(today <= n || lastDate && date <= lastDate ? today + DAY : today); }
function planPublic(row) {
  const sim = row.type === 'ecology_simulation', location = sim ? null : weather.locationFor(row.location);
  return { id: row.id, type: row.type, scenario: sim ? row.scenario : '', location: location && { slug: location.slug, name: location.name }, location_name: sim ? simulation.CAMPUS : location && location.name || '',
    time: row.time, enabled: row.enabled, next_scheduled_for: row.enabled ? row.next_scheduled_for : null, last_state: row.last_state || '', last_target_date: row.last_target_date || '' };
}
async function status(ctx) {
  if (!ctx.user) return { subscription_pool: poolPublic(null), daily_plans: [] };
  const pool = await ctx.store.get('weather_subscription_pools', ctx.user.id);
  const plans = await Promise.all(['weather', 'ecology_simulation'].map(t => ctx.store.get('weather_daily_plans', planId(ctx.user.id, t))));
  return { subscription_pool: poolPublic(pool), daily_plans: plans.filter(Boolean).map(planPublic) };
}
async function prepareGrant(ctx) {
  requireReady(ctx); identity(ctx); fields(ctx.body, []); const n = now(ctx);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id);
    const pool = await tx.get('weather_subscription_pools', ctx.user.id) || poolDefault(ctx.user.id);
    const pending = pool.grant_intent && await tx.get('weather_subscription_grants', pool.grant_intent);
    // Repeated preparation cannot mint multiple ready tokens or interrupt a tap.
    if (pending && pending.state === 'prepared' && Date.parse(pending.expires_at) > n) return pending;
    const date = weather.dayOf(n), preparedCount = pool.grant_date === date ? pool.grant_count || 0 : 0;
    if (preparedCount >= 100) throw new ApiError('REMINDER_RATE_LIMITED', '今日订阅操作较多，请明天再试', 429);
    const row = { id: uuid(), owner_id: ctx.user.id, template_id: TEMPLATE_ID, state: 'prepared', expires_at: iso(n + 10 * MINUTE), created_at: iso(n), updated_at: iso(n) };
    await tx.set('weather_subscription_grants', row.id, row);
    await tx.set('weather_subscription_pools', ctx.user.id, { ...pool, grant_intent: row.id, grant_date: date, grant_count: preparedCount + 1, updated_at: iso(n) }); return row;
  });
  return response({ id: row.id, template_id: row.template_id, expires_at: row.expires_at, state: row.state });
}
async function confirmGrant(ctx, id) {
  requireReady(ctx); const openid = identity(ctx), input = fields(ctx.body, ['template_id', 'decision'], ['template_id', 'decision']), n = now(ctx);
  if (input.template_id !== TEMPLATE_ID || !['accept', 'reject', 'ban'].includes(input.decision)) throw new ApiError('VALIDATION_ERROR', '订阅模板或授权结果无效');
  const result = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const row = await tx.get('weather_subscription_grants', id);
    if (!row || row.owner_id !== ctx.user.id) throw new ApiError('NOT_FOUND', '订阅确认不存在', 404);
    const pool = await tx.get('weather_subscription_pools', ctx.user.id) || poolDefault(ctx.user.id);
    if (row.state !== 'prepared') {
      if (row.decision === input.decision) return { id: row.id, state: row.state, subscription_pool: poolPublic(pool) };
      throw new ApiError('REMINDER_STATE_CHANGED', '这次订阅已处理，请重新点击', 409);
    }
    if (Date.parse(row.expires_at) <= n) throw new ApiError('REMINDER_CONSENT_EXPIRED', '订阅确认已过期，请重新点击', 409);
    row.state = input.decision === 'accept' ? 'accepted' : 'rejected'; row.decision = input.decision; row.updated_at = iso(n);
    if (input.decision === 'accept') {
      pool.remaining = (pool.remaining || 0) + 1; pool.total_grants = (pool.total_grants || 0) + 1; pool.needs_resubscribe = false; pool.openid = openid; pool.updated_at = iso(n);
      await tx.set('weather_subscription_pools', pool.id, pool);
    }
    await tx.set('weather_subscription_grants', row.id, row);
    return { id: row.id, state: row.state, subscription_pool: poolPublic(pool) };
  }); return response(result);
}
async function releaseCredit(tx, row, n) {
  if (row.consent_kind !== 'subscription_pool' || row.credit_state !== 'reserved') return;
  if (!['sent', 'unknown', 'cancelled', 'expired', 'failed'].includes(row.state)) return;
  const pool = await tx.get('weather_subscription_pools', row.owner_id);
  if (!pool) { row.credit_state = 'invalid'; await tx.set('weather_reminders', row.id, row); return; }
  const current = row.credit_generation === pool.generation;
  if (current) pool.reserved = Math.max(0, pool.reserved - 1);
  if (row.state === 'sent') { row.credit_state = 'consumed'; pool.consumed = (pool.consumed || 0) + 1; }
  else if (row.state === 'unknown') { row.credit_state = 'held'; pool.held = (pool.held || 0) + 1; }
  else if (row.platform_error_code === 43101) {
    row.credit_state = 'invalid';
    // Do not wipe newer consent accepted while an older request was in flight.
    if (current) invalidate(pool, row.pool_grants_at_dispatch);
  } else { row.credit_state = current ? 'released' : 'invalid'; if (current) pool.remaining++; }
  pool.updated_at = iso(n); await tx.set('weather_subscription_pools', pool.id, pool); await tx.set('weather_reminders', row.id, row);
  const plan = await tx.get('weather_daily_plans', row.daily_plan_id);
  if (plan && plan.current_job_id === row.id) { plan.last_state = row.state; plan.last_reason = row.reason || ''; await tx.set('weather_daily_plans', plan.id, plan); }
}
function invalidate(pool, observedGrants) {
  const newerGrants = Math.max(0, (pool.total_grants || 0) - (observedGrants || 0));
  pool.remaining = Math.min(pool.remaining, newerGrants); pool.reserved = 0; pool.generation++; pool.needs_resubscribe = pool.remaining === 0;
}
async function manualRefusal(tx, row, n) {
  if (row.platform_error_code !== 43101 || !Number.isInteger(row.pool_generation_at_dispatch)) return;
  const pool = await tx.get('weather_subscription_pools', row.owner_id);
  if (!pool || pool.generation !== row.pool_generation_at_dispatch) return;
  invalidate(pool, row.pool_grants_at_dispatch); pool.updated_at = iso(n); await tx.set('weather_subscription_pools', pool.id, pool);
}
async function recipient(tx, row) {
  if (row.consent_kind !== 'subscription_pool') return null;
  const pool = await tx.get('weather_subscription_pools', row.owner_id);
  const plan = await tx.get('weather_daily_plans', row.daily_plan_id);
  if (!pool || !plan || !plan.enabled || plan.generation !== row.daily_plan_generation || row.credit_state !== 'reserved' || row.credit_generation !== pool.generation || pool.needs_resubscribe || typeof pool.openid !== 'string') return null;
  return { openid: pool.openid, total_grants: pool.total_grants || 0 };
}
async function cancelCurrent(tx, plan, n, reason) {
  if (!plan || !plan.current_job_id) return;
  const row = await tx.get('weather_reminders', plan.current_job_id);
  // A dispatch already submitted to WeChat cannot be recalled.
  if (!row || !['pending', 'retry', 'preparing'].includes(row.state)) return;
  Object.assign(row, { state: 'cancelled', reason, updated_at: iso(n), lease_token: null, lease_until: null });
  await tx.set('weather_reminders', row.id, row); await releaseCredit(tx, row, n);
}
async function savePlan(ctx) {
  identity(ctx); const b = fields(ctx.body, ['type', 'location', 'scenario', 'time', 'enabled'], ['type', 'time']), type = typeOf(b.type), n = now(ctx);
  requireReady(ctx, type);
  if (ctx.config.instantSimulationOnly && type === 'ecology_simulation') throw new ApiError('SIMULATION_MOVED', '模拟异常体验已移至首页生态观察，不再创建定时模拟提醒', 409);
  if (b.enabled !== undefined && b.enabled !== true || typeof b.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw new ApiError('VALIDATION_ERROR', '请选择每天提醒时间');
  const location = type === 'weather' ? weather.locationFor(b.location) : null;
  if (type === 'weather' ? !location || b.scenario !== undefined && b.scenario !== '' : !simulation.preview(b.scenario)) throw new ApiError('VALIDATION_ERROR', '请选择有效城市或仿真情景');
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const id = planId(ctx.user.id, type), old = await tx.get('weather_daily_plans', id);
    const scenario = type === 'ecology_simulation' ? b.scenario : '';
    if (old && old.enabled && old.time === b.time && old.location === (location && location.slug) && old.scenario === scenario) return old;
    await cancelCurrent(tx, old, n, 'daily_plan_changed');
    const row = { ...old, id, owner_id: ctx.user.id, type, scenario, location: location && location.slug, time: b.time, enabled: true, generation: (old && old.generation || 0) + 1,
      next_scheduled_for: nextTime(b.time, n, old && old.last_target_date), updated_at: iso(n), created_at: old && old.created_at || iso(n) };
    await tx.set('weather_daily_plans', id, row); return row;
  }); return response(planPublic(row));
}
async function cancelPlan(ctx, type) {
  requireUser(ctx); fields(ctx.body, []); typeOf(type); const n = now(ctx);
  const row = await ctx.store.transaction(async tx => {
    await owner(tx, ctx.user.id); const id = planId(ctx.user.id, type), row = await tx.get('weather_daily_plans', id);
    if (!row) return null;
    await cancelCurrent(tx, row, n, 'daily_plan_cancelled');
    row.enabled = false; row.generation++; row.next_scheduled_for = null; row.updated_at = iso(n); await tx.set('weather_daily_plans', id, row); return row;
  }); return response(row ? planPublic(row) : { type, enabled: false });
}
async function handle(ctx, path) {
  if (ctx.method !== 'POST') return undefined;
  if (path === '/weather-data/reminders/grants/') return prepareGrant(ctx);
  const confirm = /^\/weather-data\/reminders\/grants\/([A-Za-z0-9_-]{1,80})\/confirm\/$/.exec(path);
  if (confirm) return confirmGrant(ctx, confirm[1]);
  if (path === '/weather-data/reminders/daily/') return savePlan(ctx);
  const cancel = /^\/weather-data\/reminders\/daily\/(weather|ecology_simulation)\/cancel\/$/.exec(path);
  if (cancel) return cancelPlan(ctx, cancel[1]);
  return undefined;
}
async function materialize(ctx, limit = 4) {
  const n = now(ctx), date = weather.dayOf(n);
  // An unavailable weather provider must not leave weather rows permanently in
  // front of independent simulated plans in this bounded worker batch.
  const plans = [];
  for (const type of ['weather', 'ecology_simulation']) if (!(ctx.config.instantSimulationOnly && type === 'ecology_simulation') && ready(ctx, type)) plans.push(...await ctx.store.list('weather_daily_plans', { where: { enabled: true, type }, orderBy: [{ field: 'next_scheduled_for', direction: 'asc' }], limit }));
  plans.sort((a, b) => a.next_scheduled_for.localeCompare(b.next_scheduled_for));
  let created = 0;
  for (const candidate of plans) {
    if (Date.parse(candidate.next_scheduled_for) > n) break;
    if (!ready(ctx, candidate.type)) continue;
    created += await ctx.store.transaction(async tx => {
      const p = await tx.get('weather_daily_plans', candidate.id);
      if (!p || !p.enabled || Date.parse(p.next_scheduled_for) > n) return 0;
      const u = await tx.get('users', p.owner_id);
      if (!u || !u.is_active || u.deleting) { p.enabled = false; p.next_scheduled_for = null; await tx.set('weather_daily_plans', p.id, p); return 0; }
      const due = scheduled(date, p.time);
      if (p.last_target_date && date <= p.last_target_date || due > n) { p.next_scheduled_for = nextTime(p.time, n, p.last_target_date); await tx.set('weather_daily_plans', p.id, p); return 0; }
      const pool = await tx.get('weather_subscription_pools', p.owner_id);
      p.last_target_date = date; p.next_scheduled_for = iso(due + DAY); p.updated_at = iso(n);
      if (n >= due + 30 * MINUTE) { p.last_state = 'missed'; await tx.set('weather_daily_plans', p.id, p); return 0; }
      if (!pool || pool.needs_resubscribe || pool.remaining < 1 || !pool.openid) { p.last_state = 'no_credit'; await tx.set('weather_daily_plans', p.id, p); return 0; }
      const id = sha256('daily:' + p.id + ':' + date), existing = await tx.get('weather_reminders', id);
      if (existing) { await tx.set('weather_daily_plans', p.id, p); return 0; }
      pool.remaining--; pool.reserved++; pool.updated_at = iso(n);
      const row = { id, owner_id: p.owner_id, type: p.type, scenario: p.scenario, location: p.location, scheduled_for: iso(due), target_date: date, expires_at: iso(due + 30 * MINUTE),
        consent_expires_at: null, accepted_at: iso(n), state: 'pending', template_id: TEMPLATE_ID, created_at: iso(n), updated_at: iso(n), next_attempt_at: iso(due), reason: '', attempts: 0, weather_attempts: 0,
        recurrence: 'daily', consent_kind: 'subscription_pool', daily_plan_id: p.id, daily_plan_generation: p.generation, credit_state: 'reserved', credit_generation: pool.generation };
      p.last_state = 'queued'; p.current_job_id = id;
      await tx.set('weather_subscription_pools', pool.id, pool); await tx.set('weather_reminders', id, row); await tx.set('weather_daily_plans', p.id, p); return 1;
    });
  } return created;
}
async function retireSimulationPlans(ctx, limit, ownerId) {
  const rows = await ctx.store.list('weather_daily_plans', { where: { enabled: true, type: 'ecology_simulation', ...(ownerId ? { owner_id: ownerId } : {}) }, limit });
  let changed = 0;
  for (const candidate of rows) changed += await ctx.store.transaction(async tx => {
    const row = await tx.get('weather_daily_plans', candidate.id);
    if (!row || !row.enabled || row.type !== 'ecology_simulation' || ownerId && row.owner_id !== ownerId) return 0;
    await cancelCurrent(tx, row, now(ctx), 'simulation_changed_to_instant');
    row.enabled = false; row.generation++; row.next_scheduled_for = null; row.last_state = 'cancelled'; row.last_reason = 'simulation_changed_to_instant'; row.updated_at = ctx.now;
    await tx.set('weather_daily_plans', row.id, row); return 1;
  });
  return changed;
}
module.exports = { handle, status, materialize, recipient, releaseCredit, manualRefusal, poolPublic, nextTime, retireSimulationPlans };
