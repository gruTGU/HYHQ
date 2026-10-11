import data from "../../../shared/ecology-simulation.json" with { type: "json" };
import { validBookingDraft } from "./weather-domain.js";
export const SIMULATION_DATA = data;
export function simulationPreview(scenario) {
  const item = data.scenarios.find((s) => s.id === scenario);
  if (!item) return null;
  const metrics = data.rules.map((rule) => {
    const value = item.series[rule.metric][data.sample_index];
    const triggered =
      rule.operator === "above"
        ? value > rule.threshold
        : rule.operator === "below"
          ? value < rule.threshold
          : rule.operator === "at_least"
            ? value >= rule.threshold
            : value < rule.min || value > rule.max;
    const threshold =
      rule.operator === "outside"
        ? `低于 ${rule.min} 或高于 ${rule.max}`
        : `${rule.operator === "above" ? "高于" : rule.operator === "below" ? "低于" : "达到或高于"} ${rule.threshold}`;
    return { ...rule, value, triggered, threshold };
  });
  return { ...item, metrics, triggered: metrics.some((m) => m.triggered) };
}
export function validReminderDraft(raw, cities, now = Date.now()) {
  if (!raw || raw.timezone !== "Asia/Shanghai") return null;
  const type = raw.type || "weather",
    scenario = raw.scenario || null;
  if (
    type !== "weather" ||
    (type === "ecology_simulation" && !simulationPreview(scenario)) ||
    (type === "weather" && scenario)
  )
    return null;
  if (!cities.includes(raw.location)) return null;
  if (raw.frequency === "daily")
    return typeof raw.time === "string" &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time)
      ? {
          type,
          scenario,
          location: raw.location,
          frequency: "daily",
          time: raw.time,
        }
      : null;
  if (raw.frequency && raw.frequency !== "once") return null;
  const once = validBookingDraft(raw, cities, now);
  return once ? { ...once, type, scenario, frequency: "once" } : null;
}
