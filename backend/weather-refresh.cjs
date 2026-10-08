"use strict";
// Internal worker only: there is no HTTP route or client trigger for refresh.
// Eight fixed task documents survive restarts; missed past hours are not replayed.
const weather = require('./vendor/lib/weather');
const { uuid } = require('./vendor/lib/core');
const HOUR = 3600000, LEASE = 60000, RETRY = 10 * 60000;
const KINDS = ['weather', 'air', 'alerts', 'daily'];
function period(kind) { return kind === 'daily' ? 6 * HOUR : HOUR; }
async function runBatch(ctx, { limit = 4, fetchWeather = ctx.providers && ctx.providers.fetchWeather } = {}) {
  if (ctx.config.weatherBackgroundEnabled !== true) return { enabled: false, reason: 'background_disabled', processed: 0, requests: 0 };
  if (!weather.configured(ctx.config)) return { enabled: false, reason: 'not_configured', processed: 0, requests: 0 };
  const base = Date.parse(ctx.now), started = Date.now(), clock = () => base + Math.max(0, Date.now() - started);
  if (!Number.isFinite(base)) throw new Error('Invalid weather worker time');
  const cap = Math.max(1, Math.min(4, Number.isInteger(limit) ? limit : 4)), token = uuid();
  const admitted = await ctx.store.transaction(async tx => {
    const state = await tx.get('weather_refresh_state', 'background');
    if (state && Date.parse(state.lease_until) > clock()) return false;
    await tx.set('weather_refresh_state', 'background', { ...state, lease_token: token,
      lease_until: new Date(clock() + LEASE).toISOString(), last_started_at: new Date(clock()).toISOString() });
    return true;
  });
  if (!admitted) return { enabled: true, reason: 'worker_busy', processed: 0, requests: 0 };
  const result = { enabled: true, reason: '', processed: 0, requests: 0, uncertain: 0, succeeded: 0, deferred: 0 };
  try {
    // Tianjin is deliberately first. Four tasks per tick finish it before Beijing.
    for (const location of weather.PUBLIC_LOCATIONS) for (const kind of KINDS) {
      if (result.processed >= cap || clock() - base >= 25000) return result;
      const now = clock(), span = period(kind), slot = Math.floor((now + 8 * HOUR) / span), slotStart = slot * span - 8 * HOUR;
      const id = `${location.slug}_${kind}`;
      const claim = await ctx.store.transaction(async tx => {
        const current = await tx.get('weather_refresh_jobs', id);
        if (current && current.slot === slot && (current.status === 'done' || current.attempts >= 2 || Date.parse(current.retry_at) > now || Date.parse(current.lease_until) > now)) return null;
        const cache = await tx.get('weather_cache', id);
        const view = weather.publicCache(cache, '', now);
        if (cache && Date.parse(cache.fetched_at) >= slotStart && ['fresh', 'empty'].includes(view.status)) {
          await tx.set('weather_refresh_jobs', id, { id, slot, location: location.slug, kind, status: 'done', attempts: 0, completed_at: new Date(now).toISOString() });
          return null;
        }
        const task = { id, slot, location: location.slug, kind, status: 'running',
          attempts: (current && current.slot === slot ? current.attempts || 0 : 0) + 1,
          lease_token: token, lease_until: new Date(now + LEASE).toISOString(), started_at: new Date(now).toISOString(), retry_at: null };
        await tx.set('weather_refresh_jobs', id, task); return task;
      });
      if (!claim) continue;
      result.processed++;
      let view, failure;
      try {
        view = await weather.component({ ...ctx, now: new Date(clock()).toISOString() }, location, kind, fetchWeather, { forceRefresh: true });
      } catch (error) { failure = error; }
      const attempted = !view || view.refresh_attempted === true;
      if (view && view.refresh_attempted === true) result.requests++;
      if (failure) result.uncertain++;
      const completed = !failure && ['fresh', 'empty'].includes(view.status) && Date.parse(view.fetched_at) >= slotStart;
      if (completed) result.succeeded++; else result.deferred++;
      await ctx.store.transaction(async tx => {
        const current = await tx.get('weather_refresh_jobs', id);
        if (!current || current.slot !== slot || current.lease_token !== token) return;
        const cache = await tx.get('weather_cache', id), gate = await tx.get('weather_gate', 'budget');
        const retry = Math.max(clock() + RETRY, Date.parse(cache && cache.retry_at) || 0, Date.parse(gate && gate.blocked_until) || 0);
        await tx.set('weather_refresh_jobs', id, { ...current, status: completed ? 'done' : 'retry',
          attempts: Math.max(0, current.attempts - (attempted ? 0 : 1)),
          reason: failure ? 'refresh_failed' : view.reason || '', lease_token: null, lease_until: null,
          completed_at: new Date(clock()).toISOString(), retry_at: completed ? null : new Date(retry).toISOString() });
      });
      if (view && ['budget_exhausted', 'upstream_rate_limited', 'upstream_access_denied', 'rate_limited'].includes(view.reason)) {
        result.reason = view.reason; return result;
      }
    }
    return result;
  } finally {
    await ctx.store.transaction(async tx => {
      const state = await tx.get('weather_refresh_state', 'background');
      if (state && state.lease_token === token) await tx.set('weather_refresh_state', 'background', { ...state,
        lease_token: null, lease_until: null, last_finished_at: new Date(clock()).toISOString(), last_result: result });
    });
  }
}
module.exports = { runBatch, KINDS, period };
