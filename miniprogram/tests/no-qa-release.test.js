const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const policy = require('../lib/release-policy');

test('this release cannot register or package question pages, but preserves their source', () => {
  const app = require('../app.json'), config = require('../project.config.json');
  const excluded = new Set(config.packOptions.ignore.filter((item) => item.type === 'folder').map((item) => item.value));
  for (const page of ['pages/llm', 'pages/llm-history']) {
    assert.equal(app.pages.some((route) => route.startsWith(page + '/')), false);
    assert.equal((app.subpackages || app.subPackages || []).some((group) =>
      group.pages.some((route) => (group.root + '/' + route).startsWith(page + '/'))), false);
    assert.ok(excluded.has(page), page + ' must not enter the upload package');
    for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, page, 'index.' + extension)));
  }
  assert.ok(excluded.has('components/floating-ai'));
  assert.ok(app.pages.includes('pages/recognize/index'));
  assert.ok(app.pages.includes('pages/assessment/index'));
  assert.ok(app.pages.includes('pages/weather/index'));
});

test('all reachable pages and components omit question and natural-language booking controls', () => {
  const app = require('../app.json'), visited = new Set();
  function visit(entry) {
    if (visited.has(entry)) return;
    visited.add(entry);
    const config = JSON.parse(fs.readFileSync(path.join(root, entry + '.json'), 'utf8'));
    const markup = fs.readFileSync(path.join(root, entry + '.wxml'), 'utf8');
    assert.doesNotMatch(markup, /<floating-ai|\b(?:bindtap|bindopen)="(?:openAI|openImageAI|aiHistory|interpretReminder)"|\bbindinput="inputAiText"/, entry);
    for (const [name, target] of Object.entries(config.usingComponents || {})) {
      assert.notEqual(name, 'floating-ai', entry);
      visit(target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(entry), target)));
    }
  }
  for (const entry of app.pages) visit(entry);
  for (const entry of Object.values(app.usingComponents || {})) visit(entry.replace(/^\//, ''));
  visit('custom-tab-bar/index');
  for (const entry of ['pages/recognize/index', 'pages/assessment/index', 'components/river-observer/index', 'pages/weather/index']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, entry + '.wxml'), 'utf8'), /DeepSeek|问问\s*AI|AI\s*看图|生成预约草稿|用一句话安排/, entry);
  }
  const weather = fs.readFileSync(path.join(root, 'pages/weather/index.wxml'), 'utf8');
  assert.match(weather, /bindchange="changeBookingDate"/);
  assert.match(weather, /bindchange="changeBookingTime"/);
  assert.match(weather, /bindtap="prepareReminder"/);
  assert.match(weather, /bindtap="authorizeReminder"/);
});

test('fixed release policy disables URL construction even for valid public question sources', () => {
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.generativeQAEnabled, false);
  assert.equal(policy.naturalLanguageReminderEnabled, false);
  const { publicSource, entryUrl } = require('../lib/llm');
  for (const [scope, kind] of [['explore', 'region'], ['explore', 'place'], ['explore', 'water'], ['learn', 'region'], ['learn', 'content'], ['learn', 'route']]) {
    assert.equal(publicSource(scope, kind, 'published-id'), true);
    assert.equal(entryUrl(scope, kind, 'published-id'), '');
  }
});

test('embedded river observation also blocks retained question handlers without touching detection', () => {
  let definition;
  const previous = global.Component;
  try {
    global.Component = (value) => { definition = value; };
    const file = require.resolve('../components/river-observer/index');
    delete require.cache[file]; require(file);
  } finally { global.Component = previous; }
  const calls = [];
  global.wx = { navigateTo: (value) => calls.push(value) };
  global.getApp = () => ({ session: { token: () => 'current' }, api: { request: () => calls.push('network') } });
  const component = { data: { busy: false, task: { id: 'task', status: 'succeeded', asset_id: 'original', expires_at: '2099-01-01T00:00:00Z' } }, _visible: true, _sessionToken: 'current' };
  definition.methods.openAI.call(component);
  definition.methods.openImageAI.call(component);
  assert.deepEqual(calls, []);
  assert.equal(typeof definition.methods.submit, 'function');
});
