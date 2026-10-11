"use strict";
const { ApiError, requireUser, sha256, uuid } = require("./vendor/lib/core");
const { dayOf } = require("./vendor/lib/weather");
const data = require("../shared/ecology-simulation.json");
const isSimulation = (row) => row?.type === "ecology_simulation";
const validScenario = (scenario) =>
  data.scenarios.some((s) => s.id === scenario);
function normalize(body) {
  const type = body.type === undefined ? "weather" : body.type;
  if (!["weather", "ecology_simulation"].includes(type))
    throw new ApiError("VALIDATION_ERROR", "提醒类型无效。");
  if (type === "weather") {
    if (body.scenario !== undefined && body.scenario !== null)
      throw new ApiError("VALIDATION_ERROR", "天气提醒不需要模拟情景。");
    return { type, scenario: null };
  }
  if (!validScenario(body.scenario))
    throw new ApiError("VALIDATION_ERROR", "请选择支持的模拟情景。");
  return { type, scenario: body.scenario };
}
function requireWeatherSchedule(target) {
  if (isSimulation(target))
    throw new ApiError(
      "SIMULATION_SCHEDULE_DISABLED",
      "模拟提醒已改为立即体验，请到首页生态观察发送。",
      409,
    );
  return target;
}
function summary(scenario) {
  const selected = data.scenarios.find((s) => s.id === scenario);
  if (!selected) throw new ApiError("VALIDATION_ERROR", "模拟情景无效。");
  const metrics = data.rules.map((rule) => {
    const value = selected.series[rule.metric][data.sample_index];
    const triggered =
      rule.operator === "above"
        ? value > rule.threshold
        : rule.operator === "below"
          ? value < rule.threshold
          : rule.operator === "at_least"
            ? value >= rule.threshold
            : value < rule.min || value > rule.max;
    return {
      id: rule.metric,
      label: rule.label,
      unit: rule.unit,
      value,
      triggered,
    };
  });
  const warnings = metrics.filter((m) => m.triggered);
  return {
    type: "ecology_simulation",
    scenario,
    scenario_name: selected.name,
    location_name: data.campus,
    sample_time: data.sample_time,
    notice: data.notice,
    metrics,
    triggered: warnings.length > 0,
    body:
      `科普模拟 · ${selected.name}：` +
      (warnings.length
        ? warnings.map((m) => `${m.label}${m.value}${m.unit}`).join("、") +
          "，达到教学预警阈值。"
        : "当前示例指标平稳，未达到教学预警阈值。") +
      "非实测数据。",
  };
}
function notification() {
  return {
    title: "生态观察 · 科普模拟（非实测）",
    body: "模拟异常：浊度偏高，请复核",
    href: "/#ecology-observation",
    type: "ecology_simulation",
    scenario: "check",
    simulation: true,
    demonstration: "fixed_anomaly_v1",
  };
}
function requestKey(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new ApiError("VALIDATION_ERROR", "请求标识无效。");
  return value.toLowerCase();
}
async function tryNotification(ctx) {
  const user = requireUser(ctx),
    b = ctx.body || {};
  if (
    Object.keys(b).some((k) => !["scenario", "request_key"].includes(k)) ||
    (b.scenario !== undefined && !validScenario(b.scenario))
  )
    throw new ApiError("VALIDATION_ERROR", "请选择有效的模拟情景。");
  const key = requestKey(b.request_key),
    id = sha256(user.id + ":" + key),
    day = dayOf(Date.parse(ctx.now)),
    gateId = sha256(user.id + ":" + day);
  return ctx.store.transaction(async (tx) => {
    requireUser({ user: await tx.get("users", user.id) });
    const old = await tx.get("web_simulation_trials", id);
    if (old) {
      return {
        notification_id: old.notification_id,
        simulation: true,
        replayed: true,
      };
    }
    const gate = await tx.get("web_simulation_limits", gateId);
    if ((gate?.count || 0) >= 5)
      throw new ApiError(
        "RATE_LIMITED",
        "今天的模拟提醒体验已达上限，请明天再试。",
        429,
      );
    const notification_id = uuid();
    await tx.set("web_notifications", notification_id, {
      id: notification_id,
      owner_id: user.id,
      ...notification(),
      read: false,
      created_at: ctx.now,
      scheduled_for: ctx.now,
      channel: "local_in_app",
      recurrence: "simulation_preview",
    });
    await tx.set("web_simulation_trials", id, {
      owner_id: user.id,
      notification_id,
      scenario: "check",
      demonstration: "fixed_anomaly_v1",
      created_at: ctx.now,
    });
    await tx.set("web_simulation_limits", gateId, {
      owner_id: user.id,
      day,
      count: (gate?.count || 0) + 1,
    });
    return { notification_id, simulation: true, replayed: false };
  });
}
module.exports = {
  data,
  isSimulation,
  validScenario,
  normalize,
  requireWeatherSchedule,
  summary,
  notification,
  requestKey,
  tryNotification,
};
