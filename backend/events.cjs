"use strict";
const { ApiError, response, requireUser, sha256, dateCN } = require("./vendor/lib/core");
const { loadCatalog, UUID } = require("./vendor/lib/catalog");
const { referenceFor } = require("./vendor/lib/map-reference-context");
const DAY = 86400000;
const NOTICE = "模拟活动日历，非场地方公告；日期和安排仅用于功能体验，不代表真实举办或现场花期，请勿据此前往。订阅仅用于站内提醒，不发送微信或政府消息。";
const bad = (message = "活动参数无效") => { throw new ApiError("VALIDATION_ERROR", message, 400); };
const SEEDS = [
  { key: "river-weekend", title: "海河周末环境观察体验", map_reference_id: "reference-riv-001-poi-08e228de658f", kind: "environment", weekday: 6, description: "模拟沿河记录肉眼可见情况的流程；不组织真实线下活动，不作水质判断。" },
  { key: "park-weekend", title: "水上公园自然观察体验", map_reference_id: "reference-park-079", kind: "nature", weekday: 0, description: "模拟植物观察、照片记录和绿色生活交流，不代表场地方安排。" },
  { key: "campus-weekend", title: "示范校园河道观察体验", place_id: "b548df45-97ac-4dff-87a6-4b1683f29797", kind: "environment", weekday: 6, description: "示范地点的模拟观察流程，不代表真实河道状况。" },
  { key: "beijing-weekend", title: "北京湿地自然观察体验", map_reference_id: "reference-park-003", kind: "nature", weekday: 0, description: "马家湾湿地公园的模拟观察流程，不代表场地方真实安排。" },
  ...Array.from({ length: 12 }, (_, index) => ({ key: `flower-month-${index + 1}`, title: `${index + 1}月花季观察体验`, map_reference_id: "reference-park-079", kind: "flower_season", month: index + 1, description: "全年花季日历的模拟安排：练习花卉识别和记录。此月份仅为演示排期，不代表当地实际花期、盛花状态或展览举办。" })),
  ...Array.from({ length: 12 }, (_, index) => ({ key: `flower-beijing-month-${index + 1}`, title: `北京${index + 1}月花季观察体验`, map_reference_id: "reference-park-003", kind: "flower_season", month: index + 1, description: "北京花季日历的模拟排期，不代表当地实际花期、现场花况或真实展览。" })),
];
function query(ctx, allowed) {
  const q = ctx.query || new URLSearchParams();
  if ([...q.keys()].some(key => !allowed.includes(key) || q.getAll(key).length !== 1)) bad();
  return q;
}
function body(ctx, fields) {
  const b = ctx.body || {};
  if (typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(key => !fields.includes(key))) bad();
  return b;
}
async function active(ctx, tx = ctx.store) {
  const user = requireUser(ctx), row = await tx.get("users", user.id);
  if (!row || row.is_active !== true || row.deleting || row.quota_key !== user.quota_key) throw new ApiError("AUTH_REQUIRED", "请重新登录", 401);
  if (row.auth_kind === "guest") throw new ApiError("REGISTRATION_REQUIRED", "请登录后设置活动提醒或提交环境反馈", 403);
  return row;
}
async function location(ctx, input = {}) {
  const keys = ["place_id", "map_reference_id"].filter(key => input[key] !== undefined && input[key] !== null && input[key] !== "");
  if (keys.length > 1) bad("请选择一个有效地点");
  if (!keys.length) return null;
  const data = await loadCatalog(ctx);
  const place = keys[0] === "place_id"
    ? UUID.test(input.place_id) && data.places.find(row => row.id === input.place_id)
    : referenceFor(data, input.map_reference_id);
  if (!place) bad("地点不存在或已撤下，请重新选择");
  return { place_id: keys[0] === "place_id" ? place.id : null, map_reference_id: keys[0] === "map_reference_id" ? place.id : null,
    name: place.name, region_slug: place.region_slug || data.regions.find(row => row.id === place.region)?.slug || "", source: "server_catalog", selection_notice: "用户选择的目录地点；不代表已核验照片拍摄位置。" };
}
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
async function catalogue(ctx, year = Number(dateCN(ctx.now).slice(0, 4))) {
  const rows = [], now = Date.parse(ctx.now);
  for (const seed of SEEDS) {
    let point;
    try { point = await location(ctx, seed); } catch (error) { if (error.code === "VALIDATION_ERROR") continue; throw error; }
    const dates = [];
    if (seed.month) dates.push(`${year}-${String(seed.month).padStart(2, "0")}-01`);
    else {
      const start = Date.UTC(year, 0, 1), first = (seed.weekday - new Date(start).getUTCDay() + 7) % 7;
      for (let stamp = start + first * DAY; new Date(stamp).getUTCFullYear() === year; stamp += 7 * DAY) dates.push(new Date(stamp).toISOString().slice(0, 10));
    }
    for (const date of dates) {
      const start = Date.parse(date + (seed.month ? "T00:00:00+08:00" : "T09:00:00+08:00"));
      const end = seed.month ? Date.UTC(year, seed.month, 1) - 8 * 3600000 - 1 : start + 2 * 3600000;
      rows.push({ id: seed.key + "-" + date, title: seed.title, description: seed.description, kind: seed.kind,
        starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), annual: Boolean(seed.month),
        place_id: point.place_id, map_reference_id: point.map_reference_id, location_name: point.name, region_slug: point.region_slug,
        simulated: true, source: "海晏河清功能演示", notice: NOTICE, status: end < now ? "ended" : start <= now ? "ongoing" : "scheduled", is_current: start <= now && end >= now });
    }
  }
  return rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
}
async function nearby(ctx) {
  const year = Number(dateCN(ctx.now).slice(0, 4)), now = Date.parse(ctx.now);
  const rows = await catalogue(ctx, year);
  if (new Date(now + 30 * DAY).getUTCFullYear() > year) rows.push(...await catalogue(ctx, year + 1));
  return rows.filter(row => Date.parse(row.ends_at) >= now && Date.parse(row.starts_at) <= now + 30 * DAY)
    .sort((a, b) => Number(b.is_current) - Number(a.is_current) || a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
}
async function subscriptions(ctx, tx = ctx.store) {
  return tx.list("event_subscriptions", { where: { owner_id: ctx.user.id }, limit: 100, orderBy: [{ field: "created_at", direction: "desc" }] });
}
async function notificationView(ctx, user, rows, tx = ctx.store) {
  const ids = new Set((await subscriptions(ctx, tx)).map(row => row.event_id));
  return { enabled: user.event_notifications_enabled === true, prompted: typeof user.event_notifications_enabled === "boolean", mode: "in_app", notice: NOTICE,
    items: user.event_notifications_enabled === true ? rows.filter(row => ids.has(row.id)) : [], upcoming: rows.slice(0, 6),
    daily_events: user.event_notifications_enabled === true ? rows.slice(0, 6) : [], last_shown_date: user.event_notifications_last_shown_date || null,
    should_notify: user.event_notifications_enabled === true && rows.length > 0 && user.event_notifications_last_shown_date !== dateCN(ctx.now) };
}
async function writeRate(ctx, tx, user) {
  const minute = ctx.now.slice(0, 16), count = user.event_write_minute === minute ? user.event_write_count || 0 : 0;
  if (count >= 60) throw new ApiError("RATE_LIMITED", "操作较频繁，请稍后再试", 429);
  await tx.update("users", user.id, { event_write_minute: minute, event_write_count: count + 1, record_revision: (user.record_revision || 0) + 1 });
}
async function handle(ctx) {
  const path = ctx.path.replace(/^\//, "");
  if (!/^(events|event-subscriptions|event-notifications)\//.test(path)) return undefined;
  if (path === "events/" && ctx.method === "GET") {
    const q = query(ctx, ["place_id", "map_reference_id", "year", "from", "to"]), currentYear = Number(dateCN(ctx.now).slice(0, 4));
    const year = q.has("year") ? Number(q.get("year")) : currentYear;
    if (q.has("year") && !/^\d{4}$/.test(q.get("year")) || !Number.isInteger(year) || year < currentYear - 1 || year > currentYear + 2) bad("年份超出模拟日历范围");
    for (const key of ["from", "to"]) if (q.has(key) && !validDate(q.get(key))) bad("日期格式须为 YYYY-MM-DD");
    if (q.has("from") && q.has("to") && q.get("from") > q.get("to")) bad("起始日期不能晚于结束日期");
    const target = await location(ctx, Object.fromEntries(q));
    const rows = (await catalogue(ctx, year)).filter(row => (!target || target.map_reference_id && row.map_reference_id === target.map_reference_id || target.place_id && row.place_id === target.place_id)
      && (!q.has("from") || dateCN(row.ends_at) >= q.get("from")) && (!q.has("to") || dateCN(row.starts_at) <= q.get("to")));
    return response({ items: rows, notice: NOTICE, server_time: ctx.now, nearby_days: 30, year });
  }
  query(ctx, []); await active(ctx);
  if (path === "event-notifications/" || path === "event-notifications/claim/") {
    const rows = await nearby(ctx);
    if (path.endsWith("/claim/")) {
      if (ctx.method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", "不支持此操作", 405);
      body(ctx, []);
      const result = await ctx.store.transaction(async tx => {
        const user = await active(ctx, tx), view = await notificationView(ctx, user, rows, tx);
        if (view.should_notify) {
          view.last_shown_date = dateCN(ctx.now);
          await tx.update("users", user.id, { event_notifications_last_shown_date: view.last_shown_date, record_revision: (user.record_revision || 0) + 1 });
        }
        return view;
      });
      return response(result);
    }
    if (ctx.method === "PATCH") {
      const b = body(ctx, ["enabled"]); if (typeof b.enabled !== "boolean") bad();
      await ctx.store.transaction(async tx => { const user = await active(ctx, tx); await writeRate(ctx, tx, user); await tx.update("users", user.id, { event_notifications_enabled: b.enabled }); });
    } else if (ctx.method !== "GET") throw new ApiError("METHOD_NOT_ALLOWED", "不支持此操作", 405);
    return response(await notificationView(ctx, await active(ctx), rows));
  }
  if (path === "event-subscriptions/" && ctx.method === "GET") return response({ items: (await subscriptions(ctx)).map(row => ({ event_id: row.event_id, created_at: row.created_at, event: row.event })), mode: "in_app", notice: NOTICE });
  const remove = /^event-subscriptions\/([a-z0-9-]{1,100})\/$/.exec(path);
  if (path === "event-subscriptions/" && ctx.method === "POST" || remove && ctx.method === "DELETE") {
    const b = body(ctx, remove ? [] : ["event_id"]), eventId = remove ? remove[1] : b.event_id;
    if (typeof eventId !== "string" || !/^[a-z0-9-]{1,100}$/.test(eventId)) bad();
    const date = eventId.slice(-10), year = Number(date.slice(0, 4));
    const event = !remove && validDate(date) && (await catalogue(ctx, year)).find(row => row.id === eventId && row.status !== "ended");
    if (!remove && (!event || Date.parse(event.starts_at) > Date.parse(ctx.now) + 3 * 366 * DAY)) throw new ApiError("EVENT_UNAVAILABLE", "活动已结束或不存在，请刷新列表", 409);
    const id = sha256(ctx.user.id + ":" + eventId);
    await ctx.store.transaction(async tx => {
      const user = await active(ctx, tx), old = await tx.get("event_subscriptions", id);
      await writeRate(ctx, tx, user);
      if (!remove && !old && await tx.count("event_subscriptions", { owner_id: user.id }) >= 100) throw new ApiError("STORAGE_QUOTA", "最多订阅100场活动，请先取消旧订阅", 429);
      if (remove && old) await tx.remove("event_subscriptions", id);
      if (!remove && !old) await tx.create("event_subscriptions", id, { id, owner_id: user.id, event_id: eventId, event, created_at: ctx.now });
    });
    return response(remove ? null : { event_id: eventId, mode: "in_app", notice: "已订阅站内活动；可在偏好设置中主动开启登录提醒。" }, remove ? 204 : 200);
  }
  throw new ApiError("METHOD_NOT_ALLOWED", "不支持此活动操作", 405);
}
module.exports = { handle, catalogue, location, active, NOTICE, query };
