"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
function loadEnv(filename = path.join(root, ".private", "local.env")) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
function getConfig() {
  loadEnv();
  const config = require("./vendor/lib/config").configFromEnvironment();
  config.appId = "hyhq-local-web";
  config.modelRoot = path.resolve(root, config.modelRoot || ".private/models");
  config.management.enabled = true;
  config.community = {
    mode: "official-editorial",
    enabled: false,
    feedbackEnabled: false,
  };
  config.weatherReminders = { enabled: true };
  config.maintenanceEnabled = true;
  config.qweatherMonthlyLimit = Math.min(config.qweatherMonthlyLimit, 15000);
  config.weatherBackgroundEnabled = process.env.HYHQ_WEATHER_BACKGROUND_ENABLED === "true";
  return config;
}
module.exports = { root, loadEnv, getConfig };
