"use strict";
const { ApiError, requireUser, sha256, uuid } = require("./vendor/lib/core");
const weather = require("./vendor/lib/weather");
const ecology = require("./ecology-reminders.cjs");
const storageId = (user, type) =>
  type === "ecology_simulation" ? user + ":ecology_simulation" : user;
const DAY = 86400000;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const iso = (ms) => new Date(ms).toISOString();
function nextTime(time, now, lastDate = "") {
  let day = weather.dayOf(Date.parse(now));
  let when = Date.parse(day + "T" + time + ":00+08:00");
  if (when <= Date.parse(now) || day <= lastDate) when += DAY;
  return iso(when);
}
function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    enabled: row.enabled === true,
    time: row.time,
    location: row.location,
    location_name: ecology.isSimulation(row)
      ? ecology.data.campus
      : weather.locationFor(row.location)?.name || "",
    type: row.type || "weather",
    scenario: row.scenario || null,
    scenario_name: ecology.isSimulation(row)
      ? ecology.summary(row.scenario).scenario_name
      : null,
    next_scheduled_for: row.next_scheduled_for,
    last_notified_date: row.last_notified_date || null,
    channel: "local_in_app",
  };
}
async function save(ctx) {
  const user = requireUser(ctx),
    body = ctx.body || {},
    target = ecology.requireWeatherSchedule(ecology.normalize(body)),
    id = storageId(user.id, target.type);
  if (
    Object.keys(body).some(
      (k) => !["location", "time", "type", "scenario"].includes(k),
    ) ||
    (target.type === "weather" &&
      !weather.supportedLocationFor(body.location)) ||
    typeof body.time !== "string" ||
    !TIME.test(body.time)
  )
    throw new ApiError(
      "VALIDATION_ERROR",
      "请选择天津或北京，以及有效的每日提醒时间。",
    );
  return ctx.store.transaction(async (tx) => {
    requireUser({ user: await tx.get("users", user.id) });
    const old = await tx.get("web_daily_reminders", id);
    // Retried clicks never postpone an already due subscription or create a duplicate.
    if (
      old?.enabled &&
      old.time === body.time &&
      old.location === (target.type === "weather" ? body.location : null) &&
      (old.type || "weather") === target.type &&
      (old.scenario || null) === target.scenario
    )
      return present(old);
    const row = {
      ...old,
      ...target,
      owner_id: user.id,
      subscription_id: old?.subscription_id || uuid(),
      enabled: true,
      location: target.type === "weather" ? body.location : null,
      time: body.time,
      created_at: old?.created_at || ctx.now,
      updated_at: ctx.now,
      next_scheduled_for: nextTime(
        body.time,
        ctx.now,
        old?.last_notified_date || "",
      ),
    };
    return present(await tx.set("web_daily_reminders", id, row));
  });
}
async function cancel(ctx) {
  const user = requireUser(ctx),
    body = ctx.body || {};
  if (
    Object.keys(body).some((k) => k !== "type") ||
    ![undefined, "weather", "ecology_simulation"].includes(body.type)
  )
    throw new ApiError("VALIDATION_ERROR", "提醒类型无效。");
  const id = storageId(user.id, body.type);
  return ctx.store.transaction(async (tx) => {
    requireUser({ user: await tx.get("users", user.id) });
    const row = await tx.get("web_daily_reminders", id);
    if (!row) return null;
    return present(
      await tx.update("web_daily_reminders", id, {
        enabled: false,
        next_scheduled_for: null,
        updated_at: ctx.now,
      }),
    );
  });
}
async function weatherBody(store, location, date, time, now) {
  // Notifications consume the scheduled weather cache; they never call the provider.
  const cache = await store.get("weather_cache", location + "_daily");
  const view = weather.publicCache(cache, "", Date.parse(now));
  const daily =
    view.status === "fresh" &&
    Array.isArray(view.data?.days) &&
    view.data.days.find(
      (x) =>
        Number.isFinite(Date.parse(x.starts_at)) &&
        weather.dayOf(Date.parse(x.starts_at)) === date &&
        Date.parse(x.ends_at) > Date.parse(now),
    );
  const city = (weather.locationFor(location)?.name || "所选城市").replace(
    /市$/,
    "",
  );
  if (!daily) return city + " · 暂无可用天气缓存";
  const night = time >= "19:30" || time < "06:00";
  const part = night ? daily.nighttime : daily.daytime;
  const condition =
    typeof part?.condition === "string"
      ? part.condition.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "";
  const celsius = ["°C", "℃", "C", "celsius"].includes(daily.temperature_unit);
  const validTemperature = (value) =>
    celsius &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -100 &&
    value <= 100;
  let lo = validTemperature(daily.temperature_min)
    ? Math.trunc(daily.temperature_min)
    : null;
  let hi = validTemperature(daily.temperature_max)
    ? Math.trunc(daily.temperature_max)
    : null;
  if (
    lo !== null &&
    hi !== null &&
    daily.temperature_min > daily.temperature_max
  ) {
    lo = null;
    hi = null;
  }
  const temperature =
    lo !== null && hi !== null
      ? `${lo}～${hi}℃`
      : lo !== null
        ? `最低${lo}℃`
        : hi !== null
          ? `最高${hi}℃`
          : "";
  const label = night && condition ? "夜间" + condition : condition;
  return (
    city +
    " · " +
    ([label, temperature].filter(Boolean).join("，") || "暂无可用天气缓存")
  );
}
function notificationId(subscription, date) {
  const hash = sha256(subscription + ":" + date);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function runDue(store, now) {
  let sent = 0;
  const date = weather.dayOf(Date.parse(now));
  const pending = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const rows = await store.list("web_daily_reminders", {
      where: { enabled: true },
      limit: 100,
      offset,
    });
    pending.push(...rows);
    if (rows.length < 100) break;
  }
  for (const candidate of pending) {
    if (ecology.isSimulation(candidate)) {
      await store.transaction(async (tx) => {
        const row = await tx.get("web_daily_reminders", candidate.id);
        if (row?.enabled && ecology.isSimulation(row))
          await tx.update("web_daily_reminders", row.id, {
            enabled: false,
            next_scheduled_for: null,
            updated_at: now,
            reason: "simulation_moved_to_instant",
          });
      });
      continue;
    }
    if (candidate.next_scheduled_for > now) continue;
    await store.transaction(async (tx) => {
      const row = await tx.get("web_daily_reminders", candidate.id);
      if (!row?.enabled || row.next_scheduled_for > now) return;
      const user = await tx.get("users", row.owner_id);
      if (!user?.is_active) {
        await tx.update("web_daily_reminders", row.id, {
          enabled: false,
          next_scheduled_for: null,
          updated_at: now,
        });
        return;
      }
      const scheduled = date + "T" + row.time + ":00+08:00";
      if (
        row.last_notified_date === date ||
        Date.parse(scheduled) > Date.parse(now)
      ) {
        await tx.update("web_daily_reminders", row.id, {
          next_scheduled_for: nextTime(row.time, now, row.last_notified_date),
          updated_at: now,
        });
        return;
      }
      // A delayed worker emits only today's reminder, never a backlog of missed days.
      const id = notificationId(row.subscription_id, date);
      if (!(await tx.get("web_notifications", id))) {
        await tx.set("web_notifications", id, {
          id,
          owner_id: row.owner_id,
          ...(ecology.isSimulation(row)
            ? ecology.notification(row)
            : {
                title: weather.locationFor(row.location).name + "每日天气",
                body: await weatherBody(tx, row.location, date, row.time, now),
                href: "/weather?location=" + row.location,
                type: "weather",
              }),
          read: false,
          created_at: now,
          scheduled_for: new Date(scheduled).toISOString(),
          channel: "local_in_app",
          recurrence: "daily",
        });
        sent++;
      }
      await tx.update("web_daily_reminders", row.id, {
        last_notified_date: date,
        next_scheduled_for: nextTime(row.time, now, date),
        updated_at: now,
      });
    });
  }
  return { sent };
}
module.exports = { save, cancel, present, runDue, nextTime, weatherBody };
