const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function styles(relative, seen = new Set()) {
  const file = path.resolve(root, relative);
  assert.equal(file.startsWith(root + path.sep), true);
  if (seen.has(file)) return '';
  seen.add(file);
  return fs.readFileSync(file, 'utf8').replace(/@import\s+["']([^"']+)["'];/g, (_, target) => styles(path.relative(root, path.resolve(path.dirname(file), target)), seen));
}

test('isolated river component imports only class selectors supported by the native component renderer', () => {
  // The standalone WXSS compiler accepts element selectors; the component
  // renderer rejects them at runtime, so inspect every imported selector too.
  const css = styles('components/river-observer/index.wxss').replace(/\/\*[\s\S]*?\*\//g, '');
  let checked = 0;
  for (const match of css.matchAll(/([^{};]+)\{/g)) {
    const head = match[1].trim();
    if (head.startsWith('@') || /^(?:from|to|\d+%)$/.test(head)) continue;
    for (const selector of head.split(',')) {
      const tokens = selector.trim().replace(/::?[a-z-]+/g, '').split(/[\s>+~]+/).filter(Boolean);
      assert.ok(tokens.length > 0);
      for (const token of tokens) assert.match(token, /^\.[a-zA-Z_-][\w-]*$/, 'unsupported component selector: ' + selector);
      checked++;
    }
  }
  assert.ok(checked > 50, 'check imported base and observation styles, not just the wrapper');
});

test('river nodes and buttons retain class-based sizing, disabled and button resets', () => {
  const template = fs.readFileSync(path.join(root, 'components/river-observer/index.wxml'), 'utf8');
  for (const match of template.matchAll(/<(view|text|button)\b([^>]*)>/g)) {
    const [, tag, attrs] = match;
    const classes = /\bclass="([^"]+)"/.exec(attrs);
    assert.ok(classes && classes[1].includes('observation-node'), tag + ' needs its box-sizing class');
    if (tag === 'button') {
      assert.ok(classes[1].includes('observation-button'));
      const disabled = /\bdisabled="{{(.*?)}}"/.exec(attrs);
      if (disabled) assert.ok(classes[1].includes('{{(' + disabled[1] + ") ? 'observation-disabled' : ''}}"));
    }
  }
  for (const name of ['pages/assessment/index.wxml', 'components/river-observer/index.wxml']) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    assert.equal((html.match(/class="[^"]*\bflow-step-line\b/g) || []).length, 2);
    assert.equal((html.match(/class="[^"]*\brule-score-unit\b/g) || []).length, 1);
    assert.equal((html.match(/class="[^"]*\bobservation-metric\b/g) || []).length, 2);
  }
});
