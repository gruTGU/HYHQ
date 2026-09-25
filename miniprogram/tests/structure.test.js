const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }

test('all JSON parses and every registered native page/component has its four source files', () => {
  for (const file of files(root).filter((file) => file.endsWith('.json'))) JSON.parse(fs.readFileSync(file, 'utf8'));
  const app = require('../app.json');
  assert.equal(app.tabBar.list.length, 5);
  const components = files(root).filter((file) => file.endsWith('.json')).flatMap((file) => Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).usingComponents || {}).map((value) => path.relative(root, value.startsWith('/') ? path.join(root, value) : path.resolve(path.dirname(file), value))));
  for (const entry of [...app.pages, ...components]) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${entry}.${extension}`)), `${entry}.${extension} exists`);
  }
  for (const tab of app.tabBar.list) assert.ok(app.pages.includes(tab.pagePath));
});

test('JavaScript parses without any transpiler and fresh checkout configuration loads', () => {
  for (const file of files(root).filter((file) => file.endsWith('.js'))) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  const config = require('../config/index');
  assert.equal(typeof config.baseURL, 'string');
  assert.match(config.baseURL, /^https?:\/\//);
  assert.equal(require('../project.config.json').setting.urlCheck, true);
});

test('WXML conditional branches bind expressions instead of truthy literal strings', () => {
  for (const file of files(root).filter((file) => file.endsWith('.wxml'))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\bwx:(?:if|elif)="([^"]*)"/g)) {
      assert.match(match[1], /^{{[\s\S]+}}$/, `${file}: ${match[0]} must bind its condition; a nonempty literal is always true`);
    }
  }
});

test('WXML uses known native/custom tags with balanced nesting and bound handlers', () => {
  const native = new Set(['view', 'text', 'button', 'input', 'textarea', 'image', 'block', 'picker', 'scroll-view', 'checkbox', 'checkbox-group', 'label', 'switch', 'movable-area', 'movable-view', 'canvas', 'rich-text']);
  const globals = Object.keys(require('../app.json').usingComponents || {});
  for (const file of files(root).filter((file) => file.endsWith('.wxml'))) {
    const content = fs.readFileSync(file, 'utf8');
    const local = Object.keys(JSON.parse(fs.readFileSync(file.replace(/\.wxml$/, '.json'), 'utf8')).usingComponents || {});
    const allowed = new Set([...native, ...globals, ...local]);
    const javascript = file.replace(/\.wxml$/, '.js');
    let definition;
    const previousPage = global.Page, previousComponent = global.Component;
    try {
      global.Page = (value) => { definition = value; };
      global.Component = (value) => { definition = value; };
      delete require.cache[require.resolve(javascript)];
      require(javascript);
    } finally { global.Page = previousPage; global.Component = previousComponent; }
    assert.ok(definition, `${file}: page/component registers`);
    const handlers = definition.methods || definition;
    const tags = content.replace(/{{[\s\S]*?}}/g, 'expression').match(/<[^>]+>/g) || [];
    const stack = [];
    for (const tag of tags) {
      const match = tag.match(/^<(\/?)([\w-]+)/);
      if (!match) continue;
      assert.ok(allowed.has(match[2]), `${file}: ${match[2]} is a native or registered component`);
      if (match[1]) assert.equal(stack.pop(), match[2], `${file}: nesting matches`);
      else if (!tag.endsWith('/>')) stack.push(match[2]);
    }
    assert.equal(stack.length, 0, `${file}: all tags close`);
    for (const match of content.matchAll(/\b(?:bind|catch):?\w+="([A-Za-z]\w*)"/g)) {
      assert.equal(typeof handlers[match[1]], 'function', `${file}: handler ${match[1]} exists`);
    }
  }
});
