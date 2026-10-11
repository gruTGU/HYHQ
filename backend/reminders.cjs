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
const daily = require("./daily-reminders.cjs");
const ecology = require("./ecology-reminders.cjs");
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
    location_name: ecology.isSimulation(row)
      ? ecology.data.campus
      : weather.locationFor(row.location)?.name || "",
    type: row.type || "weather",
    scenario: row.scenario || null,
    simulation: ecology.isSimulation(row),
    preview: ecology.isSimulation(row) ? ecology.summary(row.scenario) : null,
    can_cancel: ["prepared", "pending"].includes(row.state),
    channel: "local_in_app",
  };
}
async function runDue(store, now = new Date().toISOString()) {
  let sent = 0;
  // Preserve old simulation records, but stop scheduled delivery after the switch to instant demonstrations.
  for (const state of ["prepared", "pending"]) {
    for (let page = 0; page < 100; page++) {
      const legacy = await store.list("web_reminders", {
        where: { state, type: "ecology_simulation" },
        limit: 100,
      });
      for (const item of legacy)
        await store.transaction(async (tx) => {
          const current = await tx.get("web_reminders", item.id);
          if (current && ["prepared", "pending"].includes(current.state))
            await tx.update("web_reminders", item.id, {
              state: "paused",
              reason: "simulation_moved_to_instant",
              updated_at: now,
            });
        });
      if (legacy.length < 100) break;
    }
  }
  for (let round = 0; round < 5; round++) {
    const rows = await store.list("web_reminders", {
      where: { state: "pending" },
      limit: 100,
      orderBy: [{ field: "scheduled_for", direction: "asc" }],
    });
    for (const r of rows) {
      if (r.scheduled_for > now) continue;
      await store.transaction(async (tx) => {
        const row = await tx.get("web_reminders", r.id);
        if (!row || row.state !== "pending" || row.scheduled_for > now) return;
        if (ecology.isSimulation(row)) {
          await tx.update("web_reminders", row.id, {
            state: "paused",
            reason: "simulation_moved_to_instant",
            updated_at: now,
          });
          return;
        }
        if (row.expires_at && row.expires_at <= now) {
          await tx.update("web_reminders", row.id, {
            state: "expired",
            updated_at: now,
          });
          return;
        }
        const user = await tx.get("users", row.owner_id);
        if (!user || !user.is_active) {
          await tx.remove("web_reminders", row.id);
          return;
        }
        await tx.set("web_notifications", row.id, {
          id: row.id,
          owner_id: row.owner_id,
          ...(ecology.isSimulation(row)
            ? ecology.notification(row)
            : {
                title: weather.locationFor(row.location).name + "天气预约",
                body: await daily.weatherBody(
                  tx,
                  row.location,
                  row.target_date ||
                    weather.dayOf(Date.parse(row.scheduled_for)),
                  new Date(Date.parse(row.scheduled_for) + 8 * 3600000)
                    .toISOString()
                    .slice(11, 16),
                  now,
                ),
                href: "/weather?location=" + row.location,
                type: "weather",
              }),
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
    if (rows.length < 100 || rows[0].scheduled_for > now) break;
  }
  const recurring = await daily.runDue(store, now);
  return { sent: sent + recurring.sent, daily_sent: recurring.sent };
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
      mode: "once_and_daily",
      simulation: {
        enabled: true,
        mode: "instant_anomaly",
        campus: ecology.data.campus,
        notice: ecology.data.notice,
      },
      daily_simulation: ctx.user
        ? daily.present(
            await ctx.store.get(
              "web_daily_reminders",
              ctx.user.id + ":ecology_simulation",
            ),
          )
        : null,
      daily: ctx.user
        ? daily.present(await ctx.store.get("web_daily_reminders", ctx.user.id))
        : null,
      channel: "local_in_app",
      notice:
        "支持单次和每日站内提醒，在本站通知中心查看；服务需运行，不发送微信或系统通知。",
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
  if (ctx.path === "weather-data/reminders/simulation-test/")
    return response(await ecology.tryNotification(ctx));
  if (ctx.path === "weather-data/reminders/daily/")
    return response(await daily.save(ctx));
  if (ctx.path === "weather-data/reminders/daily/cancel/")
    return response(await daily.cancel(ctx));
  if (ctx.path === "weather-data/reminders/interpret/") {
    const b = ctx.body,
      target = ecology.requireWeatherSchedule(ecology.normalize(b));
    if (
      Object.keys(b).some(
        (k) =>
          !["text", "location", "request_key", "type", "scenario"].includes(k),
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
    const parser = require("./booking-ai.cjs"),
      text = b.text.trim();
    const out = await require("./vendor/lib/llm-structured").run(ctx, {
      requestKey: b.request_key,
      fingerprint: sha256(JSON.stringify([text, b.location, target])),
      messages: parser.messages(text, b.location, Date.parse(ctx.now), target),
      decode: parser.decode,
    });
    if (out.draft?.type === "ecology_simulation")
      return response({
        draft: null,
        needs_clarification: true,
        message: "模拟异常提醒请到首页生态观察直接体验。",
      });
    if (
      out.draft &&
      out.draft.frequency !== "daily" &&
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
    if (
      Object.keys(ctx.body).some(
        (k) =>
          ![
            "location",
            "scheduled_for",
            "request_key",
            "type",
            "scenario",
          ].includes(k),
      )
    )
      throw new ApiError(
        "VALIDATION_ERROR",
        "预约仅接受类型、情景、地点和时间，不能自定义模拟指标。",
      );
    const { location, scheduled_for, request_key } = ctx.body,
      target = ecology.requireWeatherSchedule(ecology.normalize(ctx.body)),
      place = weather.supportedLocationFor(location),
      requestId =
        request_key === undefined
          ? null
          : sha256(user.id + ":" + ecology.requestKey(request_key)),
      fingerprint = sha256(
        JSON.stringify([
          target,
          target.type === "weather" ? location : null,
          scheduled_for,
        ]),
      ),
      when = Date.parse(scheduled_for),
      now = Date.parse(ctx.now);
    if ((target.type === "weather" && !place) || !Number.isFinite(when))
      throw new ApiError(
        "REMINDER_TIME_INVALID",
        "选择支持城市与 5 分钟后至 48 小时内的时间",
      );
    const day = weather.dayOf(when),
      key = sha256(
        user.id +
          ":" +
          day +
          (target.type === "ecology_simulation" ? ":ecology_simulation" : ""),
      );
    const row = await ctx.store.transaction(async (tx) => {
      requireUser({ user: await tx.get("users", user.id) });
      if (requestId) {
        const replay = await tx.get("web_reminder_requests", requestId);
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw new ApiError(
              "IDEMPOTENCY_CONFLICT",
              "请求标识已用于其他预约。",
              409,
            );
          const existing = await tx.get("web_reminders", replay.reminder_id);
          if (existing && existing.owner_id === user.id) return existing;
          throw new ApiError(
            "REMINDER_STATE_CHANGED",
            "原预约已清理，请重新预约。",
            409,
          );
        }
      }
      if (when < now + 5 * 60000 || when > now + 48 * 3600000)
        throw new ApiError(
          "REMINDER_TIME_INVALID",
          "选择支持城市与 5 分钟后至 48 小时内的时间",
        );
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
        ...target,
        location: target.type === "weather" ? location : null,
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
      if (requestId)
        await tx.set("web_reminder_requests", requestId, {
          owner_id: user.id,
          reminder_id: row.id,
          fingerprint,
          created_at: ctx.now,
        });
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
      if (row.state === "cancelled") return row;
      if (!["pending", "prepared"].includes(row.state))
        throw new ApiError("REMINDER_STATE_CHANGED", "当前预约不能取消", 409);
      return tx.update("web_reminders", row.id, {
        state: "cancelled",
        updated_at: ctx.now,
      });
    }
    ecology.requireWeatherSchedule(row);
    const decision = ctx.body.decision || ctx.body.acceptance;
    if (
      ctx.body.template_id !== "local-in-app-v1" ||
      !["accept", "reject", "ban"].includes(decision)
    )
      throw new ApiError("VALIDATION_ERROR", "预约确认参数无效");
    if (
      (row.state === "pending" && decision === "accept") ||
      (row.state === "cancelled" && decision !== "accept")
    )
      return row;
    if (row.state !== "prepared" || row.consent_expires_at <= ctx.now)
      throw new ApiError(
        "REMINDER_STATE_CHANGED",
        "预约状态已变更，请重新预约",
        409,
      );
    return tx.update("web_reminders", row.id, {
      state: decision === "accept" ? "pending" : "cancelled",
      updated_at: ctx.now,
    });
  });
  return response(present(row));
}
module.exports = { handle, runDue };
