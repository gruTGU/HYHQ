'use strict';
const { ApiError, response, requireUser, sha256, dateCN } = require('./core');
const { loadCatalog, getPublicItem, UUID } = require('./catalog');
const { referenceFor } = require('./map-reference-context');
const references = require('../data/map-reference-points');
const reminders = require('./event-reminders');
const DAY = 86400000;
const NOTICE = '演示活动，非场地方公告；时间和安排用于功能体验，请勿据此前往。微信活动提醒与天气共用一次性订阅次数。';
const bad = () => { throw new ApiError('VALIDATION_ERROR', '活动参数无效', 400); };
const seeds = [
  { key: 'river-weekend', title: '海河周末环境观察', reference: 'reference-riv-001-poi-08e228de658f', kind: 'environment', weekday: 6, description: '演示如何沿河记录可见漂浮物、分类整理环境观察。' },
  { key: 'park-weekend', title: '水上公园自然观察', reference: 'reference-park-079', kind: 'nature', weekday: 0, description: '演示植物观察、照片记录与绿色生活交流流程。' },
  { key: 'beijing-weekend', title: '北京湿地自然观察', reference: 'reference-park-003', kind: 'nature', weekday: 0, description: '演示湿地自然观察与照片记录流程，不代表场地方举办活动。' },
  ...Array.from({ length: 12 }, (_, i) => ({ key: 'flower-month-' + (i + 1), title: (i + 1) + '月花季观察体验', reference: 'reference-park-079', kind: 'flower_season', month: i + 1, day: 1, monthly: true,
    description: '全年花季功能演示排期，非真实花期或展览，不表示当地植物正在开花。' })),
  ...Array.from({ length: 12 }, (_, i) => ({ key: 'flower-beijing-month-' + (i + 1), title: '北京' + (i + 1) + '月花季观察体验', reference: 'reference-park-003', kind: 'flower_season', month: i + 1, day: 1, monthly: true,
    description: '北京全年花季功能演示排期，非真实花期或展览，不表示当地植物正在开花。' })),
];
async function active(ctx, tx = ctx.store) {
  const user = requireUser(ctx), row = await tx.get('users', user.id);
  if (!row || row.is_active !== true || row.deleting) throw new ApiError('AUTH_REQUIRED', '请重新登录', 401);
  return row;
}
async function location(ctx, input = {}) {
  const keys = ['place_id', 'map_reference_id'].filter(key => input[key]);
  if (keys.length > 1) bad();
  if (!keys.length) return null;
  if (keys[0] === 'place_id') {
    if (!UUID.test(input.place_id)) bad();
    const place = await getPublicItem(ctx, 'places', input.place_id);
    if (!place) bad();
    return { place_id: place.id, map_reference_id: '', name: place.name };
  }
  const place = referenceFor(await loadCatalog(ctx), input.map_reference_id);
  if (!place) bad();
  return { place_id: '', map_reference_id: place.id, name: place.name };
}
function catalogue(now) {
  const day = dateCN(now), midnight = Date.parse(day + 'T00:00:00+08:00'), year = Number(day.slice(0, 4)), rows = [];
  for (const seed of seeds) {
    const point = references.locations.find(row => row.id === seed.reference);
    if (!point) continue;
    const dates = [];
    if (seed.month) {
      for (const y of [year, year + 1]) dates.push(`${y}-${String(seed.month).padStart(2, '0')}-${String(seed.day).padStart(2, '0')}`);
    } else {
      const weekday = new Date(midnight + 8 * 3600000).getUTCDay();
      for (let offset = (seed.weekday - weekday + 7) % 7; offset < 29; offset += 7) dates.push(new Date(midnight + offset * DAY + 8 * 3600000).toISOString().slice(0, 10));
    }
    for (const date of dates) {
      const start = Date.parse(date + (seed.monthly ? 'T00:00:00+08:00' : 'T09:00:00+08:00'));
      const end = seed.monthly ? Date.UTC(Number(date.slice(0, 4)), seed.month, 1) - 8 * 3600000 - 1 : start + 2 * 3600000;
      if (end < Date.parse(now) || start > midnight + 366 * DAY) continue;
      rows.push({ id: seed.key + '-' + date, title: seed.title, description: seed.description, kind: seed.kind,
        starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), annual: !!seed.month,
        place_id: null, map_reference_id: point.id, location_name: point.name, region_slug: point.region_slug,
        simulated: true, source: '海晏河清功能演示', notice: NOTICE, is_current: start <= Date.parse(now), status: start <= Date.parse(now) ? 'ongoing' : 'scheduled', calendar_month: seed.month || null });
    }
  }
  return rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
}
function query(ctx, allowed) { const q = ctx.query || new URLSearchParams(); if ([...q.keys()].some(key => !allowed.includes(key) || q.getAll(key).length !== 1)) bad(); return q; }
function body(ctx, fields) { const b = ctx.body || {}; if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(key => !fields.includes(key))) bad(); return b; }
async function subscriptions(ctx) { return ctx.store.list('event_subscriptions', { where: { owner_id: ctx.user.id }, limit: 100, orderBy: [{ field: 'created_at', direction: 'desc' }] }); }
async function handle(ctx) {
  const path = ctx.path.replace(/^\//, '');
  if (!/^(events|event-subscriptions|event-notifications)\//.test(path)) return undefined;
  if (path === 'events/' && ctx.method === 'GET') {
    const q = query(ctx, ['place_id', 'map_reference_id']);
    const target = await location(ctx, Object.fromEntries(q));
    const rows = catalogue(ctx.now).filter(row => !target || target.map_reference_id && row.map_reference_id === target.map_reference_id || target.place_id && row.place_id === target.place_id);
    return response({ items: rows, notice: NOTICE, server_time: ctx.now, nearby_days: 30 });
  }
  query(ctx, []); await active(ctx);
  if (path === 'event-notifications/claim/' && ctx.method === 'POST') {
    const b = body(ctx, ['login']); if (typeof b.login !== 'boolean') bad();
    const near = catalogue(ctx.now).filter(row => Date.parse(row.starts_at) <= Date.parse(ctx.now) + 30 * DAY);
    const result = await ctx.store.transaction(async tx => {
      const user = await active(ctx, tx), today = dateCN(ctx.now);
      if (user.event_notifications_enabled !== true || user.event_popup_day === today) return { should_show: false, items: [] };
      const subscribed = [];
      if (user.event_notifications_enabled === true) for (const event of near) {
        if (await tx.get('event_subscriptions', sha256(user.id + ':' + event.id))) subscribed.push(event);
      }
      const subscribedIds = new Set(subscribed.map(row => row.id));
      const items = subscribed.concat(near.filter(row => !subscribedIds.has(row.id))).slice(0, 3);
      if (!items.length) return { should_show: false, items: [] };
      await tx.update('users', user.id, { event_popup_day: today, record_revision: (user.record_revision || 0) + 1 });
      return { should_show: true, items };
    });
    return response({ ...result, mode: 'in_app', notice: NOTICE });
  }
  if (path === 'event-notifications/') {
    if (ctx.method === 'PATCH') {
      const b = body(ctx, ['enabled']); if (typeof b.enabled !== 'boolean') bad();
      await ctx.store.transaction(async tx => { const user = await active(ctx, tx); await tx.update('users', user.id, { event_notifications_enabled: b.enabled, event_notifications_prompted: true, record_revision: (user.record_revision || 0) + 1 }); });
    } else if (ctx.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', '不支持此操作', 405);
    const user = await active(ctx), subscribed = await subscriptions(ctx), ids = new Set(subscribed.map(row => row.event_id));
    const near = catalogue(ctx.now).filter(row => Date.parse(row.starts_at) <= Date.parse(ctx.now) + 30 * DAY);
    return response({ enabled: user.event_notifications_enabled === true, prompted: user.event_notifications_prompted === true, mode: 'in_app', notice: NOTICE,
      items: user.event_notifications_enabled === true ? near.filter(row => ids.has(row.id)) : [], upcoming: near.slice(0, 3) });
  }
  if (path === 'event-subscriptions/' && ctx.method === 'GET') return response({ items: await Promise.all((await subscriptions(ctx)).map(async row => ({ event_id: row.event_id, created_at: row.created_at, event: row.event, reminder: await reminders.read(ctx, row) }))), ...await reminders.status(ctx) });
  const remove = /^event-subscriptions\/([a-z0-9-]{1,100})\/$/.exec(path);
  if (path === 'event-subscriptions/' && ctx.method === 'POST' || remove && ctx.method === 'DELETE') {
    const b = body(ctx, remove ? [] : ['event_id']), eventId = remove ? remove[1] : b.event_id;
    if (typeof eventId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(eventId)) bad();
    const event = !remove && catalogue(ctx.now).find(row => row.id === eventId);
    if (!remove && !event) throw new ApiError('EVENT_UNAVAILABLE', '活动已结束或不存在，请刷新列表', 409);
    if (!remove) reminders.requireEnabled(ctx);
    const id = sha256(ctx.user.id + ':' + eventId);
    const reminder = await ctx.store.transaction(async tx => {
      const user = await active(ctx, tx), old = await tx.get('event_subscriptions', id), count = Number(user.event_subscription_count) || 0;
      if (!remove && !old && count >= 100) throw new ApiError('STORAGE_QUOTA', '最多订阅100场活动，请先取消旧订阅', 429);
      let reminder;
      if (remove && old) { await reminders.cancel(tx, ctx, old); await tx.remove('event_subscriptions', id); }
      if (!remove) {
        const row = old || { id, owner_id: user.id, event_id: eventId, event, created_at: ctx.now };
        reminder = await reminders.reserve(tx, ctx, row, event);
        await tx.set('event_subscriptions', id, row);
      }
      await tx.update('users', user.id, { event_subscription_count: Math.max(0, count + (remove ? old ? -1 : 0 : old ? 0 : 1)), record_revision: (user.record_revision || 0) + 1 });
      return reminder;
    });
    const status = remove ? null : await reminders.status(ctx);
    return response(remove ? null : { event_id: eventId, mode: 'wechat_once', reminder, subscription_pool: status.subscription_pool,
      notice: ['sent', 'unknown'].includes(reminder.state) ? '本活动已有发送记录，不会重复推送。' : '已预约一次模拟活动微信提醒，已从共享订阅次数预留1次。' }, remove ? 204 : 200);
  }
  throw new ApiError('METHOD_NOT_ALLOWED', '不支持此活动操作', 405);
}
module.exports = { handle, catalogue, location, active, NOTICE };
