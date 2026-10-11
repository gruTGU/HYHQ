const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const policy = require('../lib/release-policy');

test('restored edition packages chat and history and exposes the floating icon only on guide and learning tabs', () => {
  const app = require('../app.json'), config = require('../project.config.json');
  const excluded = new Set(config.packOptions.ignore.map(item => item.value));
  for (const page of ['pages/llm', 'pages/llm-history']) { assert.ok(app.pages.includes(page + '/index')); assert.equal(excluded.has(page), false); }
  assert.equal(excluded.has('components/floating-ai'), false);
  for (const page of app.pages) {
    const markup = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    if (['pages/explore/index', 'pages/learn/index'].includes(page)) assert.match(markup, /<floating-ai/);
    else assert.doesNotMatch(markup, /<floating-ai/);
  }
  assert.match(fs.readFileSync(path.join(root, 'pages/weather/index.wxml'), 'utf8'), /bindtap="interpretReminder"/);
});

test('public question sources retain scoped URLs while recognition interpretation stays off', () => {
  assert.equal(policy.generativeQAEnabled, true); assert.equal(policy.naturalLanguageReminderEnabled, true);
  assert.equal(policy.recognitionInterpretationEnabled, false);
  const { entryUrl } = require('../lib/llm');
  for (const [scope, kind] of [['explore','region'], ['explore','place'], ['learn','region'], ['learn','content'], ['learn','route']]) {
    assert.match(entryUrl(scope, kind, 'published-id'), new RegExp('scope=' + scope + '&source_type=' + kind));
  }
  assert.equal(entryUrl('home', 'region', 'published-id'), '');
  assert.equal(entryUrl('learn', 'place', 'published-id'), '');
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
