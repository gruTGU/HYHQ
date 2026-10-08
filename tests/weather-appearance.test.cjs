const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const moduleUrl = pathToFileURL(path.resolve(__dirname, "../frontend/src/pages/weather-appearance.js")).href;
const appearance = import(moduleUrl);

test("weather appearance uses the exact Beijing evening and morning boundaries", async () => {
  const { weatherAppearance } = await appearance;
  for (const [time, expected] of [
    ["2026-10-08T19:29:59+08:00", false],
    ["2026-10-08T19:30:00+08:00", true],
    ["2026-10-09T05:59:59+08:00", true],
    ["2026-10-09T06:00:00+08:00", false],
  ]) {
    assert.equal(weatherAppearance("晴", time).night, expected, time);
  }
});

test("equivalent timestamps give the same Beijing result regardless of their offset", async () => {
  const { weatherAppearance } = await appearance;
  const expected = { night: true, label: "晴夜", icon: "moon" };
  for (const time of [
    "2026-10-08T19:30:00+08:00",
    "2026-10-08T11:30:00Z",
    "2026-10-08T04:30:00-07:00",
    "2026-10-08T20:30:00+09:00",
    "2026-10-08 19:30",
    "2026-10-08T19:30:00",
    Date.parse("2026-10-08T11:30:00Z"),
    new Date("2026-10-08T11:30:00Z"),
  ]) assert.deepEqual(weatherAppearance("晴", time), expected);
});

test("weather appearance preserves weather type while giving clear nighttime labels", async () => {
  const { weatherAppearance } = await appearance;
  for (const [condition, daytimeIcon, nighttimeIcon] of [
    ["晴", "sun", "moon"],
    ["多云", "cloud-sun", "cloud-moon"],
    ["晴间多云", "cloud-sun", "cloud-moon"],
    ["阴", "cloud", "cloud"],
    ["小雨", "cloud-rain", "cloud-moon-rain"],
    ["雨夹雪", "cloud-snow", "cloud-snow"],
    ["小雪", "cloud-snow", "cloud-snow"],
    ["雷阵雨", "cloud-lightning", "cloud-lightning"],
    ["雾", "cloud-fog", "cloud-fog"],
    ["霾", "cloud-fog", "cloud-fog"],
  ]) {
    assert.deepEqual(weatherAppearance(condition, "2026-10-08T12:00:00+08:00"), {
      night: false, label: condition, icon: daytimeIcon,
    });
    assert.deepEqual(weatherAppearance(condition, "2026-10-08T22:00:00+08:00"), {
      night: true, label: condition === "晴" ? "晴夜" : `${condition} · 夜间`, icon: nighttimeIcon,
    });
  }
});

test("missing weather and invalid time do not fabricate a condition or depend on the current clock", async () => {
  const { weatherAppearance } = await appearance;
  for (const condition of [undefined, null, "", "   "]) {
    assert.deepEqual(weatherAppearance(condition, "2026-10-08T22:00:00+08:00"), {
      night: true, label: "天气暂不可用", icon: "cloud",
    });
  }
  for (const timestamp of [undefined, null, "", "not-a-date", NaN, Infinity, new Date(NaN)]) {
    assert.deepEqual(weatherAppearance("晴", timestamp), { night: false, label: "晴", icon: "sun" });
  }
});
