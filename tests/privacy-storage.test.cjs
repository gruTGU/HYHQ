"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url"),
  path = require("node:path");
let nonce = 0;
async function setup({
  failWrite = false,
  failRemove = [],
  initial = {},
} = {}) {
  const rows = new Map(Object.entries(initial)),
    writes = [],
    removes = [],
    events = [];
  global.localStorage = {
    getItem: (key) => rows.get(key) ?? null,
    setItem(key, value) {
      writes.push(key);
      if (failWrite === true || failWrite === key)
        throw Error("storage unavailable");
      rows.set(key, String(value));
    },
    removeItem(key) {
      removes.push(key);
      if (failRemove.includes(key)) throw Error("removal unavailable");
      rows.delete(key);
    },
  };
  global.window = { dispatchEvent: (event) => events.push(event) };
  const privacy = await import(
    pathToFileURL(path.resolve(__dirname, "../frontend/src/lib/privacy.js"))
      .href +
      "?test=" +
      ++nonce
  );
  return { ...privacy, rows, writes, removes, events };
}
const key = "hyhq.privacy.v1",
  allow = JSON.stringify({ version: 1, preferences: true }),
  preferenceKeys = ["hyhq.theme", "hyhq.region", "hyhq.weather.city"];
test.after(() => {
  delete global.localStorage;
  delete global.window;
});
test("denying preferences remains effective when choice persistence fails", async () => {
  const p = await setup({
    failWrite: key,
    initial: {
      [key]: allow,
      "hyhq.theme": "design-3",
      "hyhq.region": "beijing",
      "hyhq.weather.city": "beijing",
    },
  });
  assert.equal(p.privacyChoice().preferences, true);
  const choice = p.savePrivacyChoice(false);
  assert.equal(choice.preferences, false);
  assert.equal(p.privacyChoice().preferences, false);
  for (const name of preferenceKeys) assert.equal(p.rows.has(name), false);
  assert.equal(
    p.rows.has(key),
    false,
    "stale persisted allow is removed when writing fails",
  );
  p.preferenceStorage.setItem("hyhq.region", "tianjin");
  assert.equal(p.preferenceStorage.getItem("hyhq.region"), "tianjin");
  assert.equal(p.rows.has("hyhq.region"), false);
  assert.equal(p.events.at(-1).detail.preferences, false);
});
test("failed removals are independent and cannot reactivate previous consent", async () => {
  const p = await setup({
    failWrite: true,
    failRemove: [key, "hyhq.theme"],
    initial: {
      [key]: allow,
      "hyhq.theme": "design-3",
      "hyhq.region": "beijing",
      "hyhq.weather.city": "beijing",
    },
  });
  p.savePrivacyChoice(false);
  assert.equal(p.privacyChoice().preferences, false);
  assert.equal(p.rows.has("hyhq.region"), false);
  assert.equal(p.rows.has("hyhq.weather.city"), false);
  assert.equal(
    p.preferenceStorage.getItem("hyhq.theme"),
    null,
    "an undeletable value is not used after refusal",
  );
  const n = p.writes.length;
  p.preferenceStorage.setItem("hyhq.theme", "forest");
  assert.equal(p.writes.length, n);
  assert.ok(preferenceKeys.every((name) => p.removes.includes(name)));
});
test("preferences are ephemeral by default and only persisted after explicit allowance", async () => {
  const p = await setup();
  p.preferenceStorage.setItem("hyhq.theme", "design-2");
  assert.equal(p.rows.has("hyhq.theme"), false);
  p.savePrivacyChoice(true);
  assert.equal(p.rows.get("hyhq.theme"), "design-2");
  assert.equal(p.privacyChoice().preferences, true);
  p.preferenceStorage.setItem("hyhq.region", "tianjin");
  assert.equal(p.rows.get("hyhq.region"), "tianjin");
  p.savePrivacyChoice(false);
  assert.equal(p.rows.has("hyhq.theme"), false);
  assert.equal(p.rows.has("hyhq.region"), false);
  assert.equal(
    p.preferenceStorage.getItem("hyhq.region"),
    "tianjin",
    "current session stays usable",
  );
});
test("a later successful choice supersedes a failed persistence fallback", async () => {
  const p = await setup({ failWrite: true });
  p.savePrivacyChoice(false);
  assert.equal(p.privacyChoice().preferences, false);
  global.localStorage.setItem = (k, v) => p.rows.set(k, v);
  p.savePrivacyChoice(true);
  assert.equal(p.privacyChoice().preferences, true);
  p.rows.set(key, JSON.stringify({ version: 1, preferences: false }));
  assert.equal(
    p.privacyChoice().preferences,
    false,
    "reads changes from other browser tabs after persistence recovers",
  );
});
