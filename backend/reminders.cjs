"use strict";
const {
  ApiError,
  response,
  requireUser,
  uuid,
  paginate,
  sha256,
} = require("./vendor/lib/core");
const weather = require("./vendor/lib/weather");
function present(row) {
  return {
    ...Object.fromEntries(
      [
        "id",
        "state",
        "scheduled_for",
        "target_date",
        "expires_at",
        "consent_expires_at",
        "template_id",
        "created_at",
        "updated_at",
        "reason",
      ].map((k) => [k, row[k]]),
    ),
    location: weather.locationFor(row.location),
    location_name: weather.locationFor(row.location)?.name || "",
    can_cancel: ["prepared", "pending"].includes(row.state),
    channel: "local_in_app",
  };
}
async function runDue(store, now = new Date().toISOString()) {
  let sent = 0;
  for (let offset = 0; offset < 500; offset += 100) {
    const rows = await store.list("web_reminders", {
      where: { state: "pending" },
      limit: 100,
      offset,
    });
    for (const r of rows) {
      if (r.scheduled_for > now) continue;
      await store.transaction(async (tx) => {
        const row = await tx.get("web_reminders", r.id);
        if (!row || row.state !== "pending" || row.scheduled_for > now) return;
        const user = await tx.get("users", row.owner_id);
        if (!user || !user.is_active) {
          await tx.remove("web_reminders", row.id);
          return;
        }
        await tx.set("web_notifications", row.id, {
          id: row.id,
          owner_id: row.owner_id,
          title: weather.locationFor(row.location).name + "天气预约",
          body: "预约时间已到。打开天气页查看最新天气、空气与预警信息。",
          href: "/weather?location=" + row.location,
          read: false,
          created_at: now,
          scheduled_for: row.scheduled_for,
          channel: "local_in_app",
        });
        await tx.update("web_reminders", row.id, {
          state: "sent",
          reason: "local_notification_created",
          updated_at: now,
        });
        sent++;
      });
    }
    if (rows.length < 100) break;
  }
  return { sent };
}
async function handle(ctx) {
  if (ctx.path === "web/notifications/" && ctx.method === "GET") {
    requireUser(ctx);
    const read = ctx.query.get("read");
    if (read !== null && !["true", "false"].includes(read))
      throw new ApiError("VALIDATION_ERROR", "通知筛选参数无效");
    await runDue(ctx.store, ctx.now);
    const rows = await ctx.store.list("web_notifications", {
      where: {
        owner_id: ctx.user.id,
        ...(read === null ? {} : { read: read === "true" }),
      },
      orderBy: [{ field: "created_at", direction: "desc" }],
      limit: 100,
    });
    return paginate(
      ctx,
      rows.map(({ owner_id, ...x }) => x),
    );
  }
  let m = /^web\/notifications\/([a-f0-9-]{36})\/(?:read\/)?$/.exec(ctx.path);
  if (m && ["PATCH", "POST", "DELETE"].includes(ctx.method)) {
    requireUser(ctx);
    const row = await ctx.store.get("web_notifications", m[1]);
    if (!row || row.owner_id !== ctx.user.id)
      throw new ApiError("NOT_FOUND", "通知不存在", 404);
    if (ctx.method === "DELETE") {
      await ctx.store.remove("web_notifications", row.id);
      return response(null, 204);
    }
    await ctx.store.update("web_notifications", row.id, { read: true });
    return response({ id: row.id, read: true });
  }
  if (!ctx.path.startsWith("weather-data/reminders/")) return;
  if (ctx.method === "GET" && ctx.path === "weather-data/reminders/") {
    await runDue(ctx.store, ctx.now);
    const rows = ctx.user
      ? await ctx.store.list("web_reminders", {
          where: { owner_id: ctx.user.id },
          orderBy: [{ field: "created_at", direction: "desc" }],
          limit: 100,
        })
      : [];
    return response({
      enabled: true,
      reason: "",
      template_id: "local-in-app-v1",
      mode: "once",
      channel: "local_in_app",
      notice:
        "仅在本机网页提供一次站内提醒；服务需运行，离线期间的到期提醒在下次启动后生成。",
      items: rows.map(present),
      wechat_login: false,
      local_login: !!ctx.user,
      server_time: ctx.now,
      min_lead_minutes: 5,
      max_ahead_hours: 48,
    });
  }
  const user = requireUser(ctx);
  if (ctx.method !== "POST")
    throw new ApiError("METHOD_NOT_ALLOWED", "不支持此操作", 405);
  if (ctx.path === "weather-data/reminders/interpret/") {
    const b = ctx.body;
    if (
      Object.keys(b).some(
        (k) => !["text", "location", "request_key"].includes(k),
      ) ||
      typeof b.text !== "string" ||
      !b.text.trim() ||
      [...b.text.trim()].length > 500 ||
      !weather.supportedLocationFor(b.location) ||
      typeof b.request_key !== "string" ||
      !/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(b.request_key) ||
      [...ctx.query.keys()].length
    )
      throw new ApiError(
        "VALIDATION_ERROR",
        "请输入不超过 500 字的预约需求，并选择支持的城市",
      );
    const parser = require("./vendor/lib/weather-booking-ai"),
      text = b.text.trim();
    const out = await require("./vendor/lib/llm-structured").run(ctx, {
      requestKey: b.request_key,
      fingerprint: sha256(JSON.stringify([text, b.location])),
      messages: parser.messages(text, b.location, Date.parse(ctx.now)),
      decode: parser.decode,
    });
    if (
      out.draft &&
      Date.parse(out.draft.scheduled_for) < Date.parse(ctx.now) + 5 * 60000
    )
      return response({
        draft: null,
        needs_clarification: true,
        message: "草稿时间已过期，请重新描述预约时间。",
      });
    return response(out);
  }
  if (ctx.path === "weather-data/reminders/intents/") {
    const { location, scheduled_for } = ctx.body,
      place = weather.supportedLocationFor(location),
      when = Date.parse(scheduled_for),
      now = Date.parse(ctx.now);
    if (
      !place ||
      !Number.isFinite(when) ||
      when < now + 5 * 60000 ||
      when > now + 48 * 3600000
    )
      throw new ApiError(
        "REMINDER_TIME_INVALID",
        "选择支持城市与 5 分钟后至 48 小时内的时间",
      );
    const day = weather.dayOf(when),
      key = sha256(user.id + ":" + day);
    const row = await ctx.store.transaction(async (tx) => {
      const lock = await tx.get("web_reminder_days", key),
        old = lock && (await tx.get("web_reminders", lock.reminder_id));
      if (
        old &&
        ["prepared", "pending"].includes(old.state) &&
        old.expires_at > ctx.now
      )
        throw new ApiError(
          "WEATHER_REMINDER_EXISTS",
          "当天已有预约，请先取消后修改",
          409,
        );
      if (lock && lock.count >= 10)
        throw new ApiError("RATE_LIMITED", "当天预约修改次数已达上限", 429);
      const row = {
        id: uuid(),
        owner_id: user.id,
        location,
        scheduled_for: new Date(when).toISOString(),
        target_date: day,
        expires_at: new Date(when + 86400000).toISOString(),
        consent_expires_at: new Date(now + 10 * 60000).toISOString(),
        state: "prepared",
        template_id: "local-in-app-v1",
        created_at: ctx.now,
        updated_at: ctx.now,
        reason: "",
      };
      requireUser({ user: await tx.get("users", user.id) });
      await tx.set("web_reminders", row.id, row);
      await tx.set("web_reminder_days", key, {
        owner_id: user.id,
        reminder_id: row.id,
        count: (lock?.count || 0) + 1,
      });
      return row;
    });
    return response(present(row), 201);
  }
  m =
    /^weather-data\/reminders\/(?:intents\/)?([a-f0-9-]{36})\/(confirm|consent|cancel)\/$/.exec(
      ctx.path,
    );
  if (!m) throw new ApiError("NOT_FOUND", "预约接口不存在", 404);
  const row = await ctx.store.transaction(async (tx) => {
    const row = await tx.get("web_reminders", m[1]);
    if (!row || row.owner_id !== user.id)
      throw new ApiError("NOT_FOUND", "预约不存在", 404);
    requireUser({ user: await tx.get("users", user.id) });
    if (m[2] === "cancel") {
      if (!["pending", "prepared"].includes(row.state))
        throw new ApiError("REMINDER_STATE_CHANGED", "当前预约不能取消", 409);
      return tx.update("web_reminders", row.id, {
        state: "cancelled",
        updated_at: ctx.now,
      });
    }
    if (row.state !== "prepared" || row.consent_expires_at <= ctx.now)
      throw new ApiError(
        "REMINDER_STATE_CHANGED",
        "预约状态已变更，请重新预约",
        409,
      );
    const decision = ctx.body.decision || ctx.body.acceptance;
    if (
      ctx.body.template_id !== "local-in-app-v1" ||
      !["accept", "reject", "ban"].includes(decision)
    )
      throw new ApiError("VALIDATION_ERROR", "预约确认参数无效");
    return tx.update("web_reminders", row.id, {
      state: decision === "accept" ? "pending" : "cancelled",
      updated_at: ctx.now,
    });
  });
  return response(present(row));
}
module.exports = { handle, runDue };
