const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TABS, currentIndex, tabAt, selectTab } = require('../lib/tab-bar');

function fixture(route = 'pages/home/index') {
  const state = { pages: [{ route }], navigation: [], toasts: [] };
  global.getCurrentPages = () => state.pages;
  global.wx = { switchTab: (options) => state.navigation.push(options), showToast: (options) => state.toasts.push(options.title) };
  let definition;
  global.Component = (input) => { definition = input; };
  const filename = require.resolve('../custom-tab-bar/index');
  delete require.cache[filename]; require(filename);
  const bar = { ...definition.methods, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { state, bar, definition };
}
const tap = (index) => ({ currentTarget: { dataset: { index } } });

test('custom tabs match all five registered routes, with a central AI and existing local icons', () => {
  const config = require('../app.json');
  assert.equal(config.tabBar.custom, true);
  assert.deepEqual(TABS.map((tab) => tab.pagePath), config.tabBar.list.map((tab) => tab.pagePath));
  assert.equal(TABS[2].icon, 'ai');
  assert.deepEqual(TABS.map((tab) => tab.label), ['首页', '生态导览', 'AI 识别', '科普智游', '我的']);
  const template = fs.readFileSync(path.resolve(__dirname, '../custom-tab-bar/index.wxml'), 'utf8');
  assert.match(template, /<text class="tab-label">\{\{item\.label\}\}<\/text>/);
  assert.match(template, /<image class="tab-sprite sprite-ai"/);
  assert.match(template, /<image class="tab-sprite sprite-{{item.icon}}"/);
  assert.match(template, /<view class="tab-hit" data-index="{{index}}" catchtap="switchTab"/);
  assert.ok(fs.existsSync(path.resolve(__dirname, '../assets/brand/icons-green.jpg')));
});

function tabStyles() {
  const css = fs.readFileSync(path.resolve(__dirname, '../custom-tab-bar/index.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = {};
  for (const match of css.matchAll(/([^{}]+)\{([^}]+)\}/g)) {
    const declarations = Object.fromEntries(match[2].split(';').map(value => value.trim()).filter(Boolean).map(value => { const colon = value.indexOf(':'); return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()]; }));
    for (const selector of match[1].split(',')) Object.assign(rules[selector.trim()] ||= {}, declarations);
  }
  return rules;
}

test('central circle, full-width label and selected indicator share the screen center across phone widths', () => {
  const rules = tabStyles();
  const bar = rules['.tab-items'], item = rules['.tab-item'], label = rules['.tab-label'];
  assert.equal(item.flex, '1 1 0'); assert.equal(item.width, '0');
  assert.equal(label.left, '0'); assert.equal(label.width, '100%'); assert.equal(label['text-align'], 'center');
  const template = fs.readFileSync(path.resolve(__dirname, '../custom-tab-bar/index.wxml'), 'utf8');
  assert.match(template, /<view wx:if="{{selected === index}}" class="tab-indicator"/);
  for (const screenWidth of [320, 375, 390, 430, 540]) {
    const scale = screenWidth / 750;
    const padding = parseFloat(bar.padding.split(/\s+/)[1]) * scale;
    const itemWidth = (screenWidth - padding * 2) / TABS.length;
    const itemLeft = padding + itemWidth * 2;
    assert.ok(Math.abs(itemLeft + itemWidth / 2 - screenWidth / 2) < 0.001);
    for (const selector of ['.ai-circle', '.tab-indicator']) {
      const style = rules[selector], width = parseFloat(style.width) * scale;
      assert.equal(style.transform, 'translateX(-50%)');
      const center = itemLeft + itemWidth * parseFloat(style.left) / 100 - width / 2 + width / 2;
      assert.ok(Math.abs(center - screenWidth / 2) < 0.001, selector + ' center at ' + screenWidth);
    }
  }
});

test('AI sprite compensates measured artwork whitespace without changing the original green image', () => {
  // Lossless JPEG entropy optimization preserves every decoded pixel and sprite bound.
  const asset = fs.readFileSync(path.resolve(__dirname, '../assets/brand/icons-green.jpg'));
  assert.equal(createHash('sha256').update(asset).digest('hex'), 'ec5d4a9dd21a208093e9d9e79ddc65bd554ab3e2f017160dc4a8f7ca906df32d', 'remeasure visible artwork bounds when replacing the sprite');
  // Measured green pixels in this 1536×1024 source: x=[1082,1445),
  // y=[127,449). Include the scanning corners, not just the camera body.
  const inkCenter = { x: (1082 + 1445) / 2, y: (127 + 449) / 2 };
  const rules = tabStyles(), sprite = rules['.tab-sprite'], ai = rules['.sprite-ai'];
  for (const viewport of [64, 80, 108]) {
    const renderedWidth = viewport * parseFloat(sprite.width) / 100;
    const renderedHeight = viewport * parseFloat(sprite.height) / 100;
    const x = viewport * parseFloat(ai.left) / 100 + inkCenter.x * renderedWidth / 1536;
    const y = viewport * parseFloat(ai.top) / 100 + inkCenter.y * renderedHeight / 1024;
    assert.ok(Math.abs(x - viewport / 2) < 0.001, 'visible AI artwork horizontal center');
    assert.ok(Math.abs(y - viewport / 2) < 0.001, 'visible AI artwork vertical center');
  }
});

test('show and attach derive the selected tab from the actual top page, including external navigation', () => {
  const { state, bar, definition } = fixture('pages/profile/index');
  definition.lifetimes.attached.call(bar);
  assert.equal(bar.data.selected, 4);
  for (const [index, tab] of TABS.entries()) {
    state.pages = [{ route: 'pages/detail/index' }, { route: tab.pagePath }];
    definition.pageLifetimes.show.call(bar);
    assert.equal(bar.data.selected, index);
  }
  assert.equal(currentIndex([{ route: 'pages/water/index' }]), -1);
  assert.equal(currentIndex([]), -1);
});

test('tab switching ignores duplicate taps and retries after a failed native navigation', () => {
  const { state, bar } = fixture();
  bar.switchTab(tap(0));
  assert.equal(state.navigation.length, 0);
  bar.switchTab(tap(2)); bar.switchTab(tap(2));
  assert.equal(state.navigation.length, 1);
  assert.equal(state.navigation[0].url, '/pages/recognize/index');
  state.navigation[0].fail(); state.navigation[0].complete();
  assert.equal(bar.data.selected, 0);
  assert.equal(state.toasts.length, 1);
  bar.switchTab(tap(2));
  assert.equal(state.navigation.length, 2);
  state.pages = [{ route: 'pages/recognize/index' }];
  state.navigation[1].success(); state.navigation[1].complete();
  assert.equal(bar.data.selected, 2);
});

test('malformed indices cannot navigate outside the five tabs', () => {
  const { state, bar } = fixture();
  for (const value of [null, undefined, true, false, '', ' ', -1, 5, 1.5, 'pages/profile/index', '../admin']) {
    assert.equal(tabAt(value), null);
    bar.switchTab(tap(value));
  }
  assert.equal(state.navigation.length, 0);
});

test('detached tab instances cannot handle late navigation callbacks or new taps', () => {
  const { state, bar, definition } = fixture();
  bar.switchTab(tap(4));
  definition.lifetimes.detached.call(bar);
  bar.setData = () => { throw new Error('detached update'); };
  state.navigation[0].fail(); state.navigation[0].success(); state.navigation[0].complete();
  bar.switchTab(tap(1));
  assert.equal(state.navigation.length, 1);
  assert.equal(state.toasts.length, 0);
});

test('every tab page selects its own bar even while getCurrentPages still reports the previous route', async () => {
  const application = { globalData: {}, session: { get: () => null, token: () => '' } };
  global.getApp = () => application;
  for (const [index, tab] of TABS.entries()) {
    const previous = TABS[(index + 1) % TABS.length];
    const { bar, definition } = fixture(previous.pagePath);
    let pageDefinition;
    global.Page = (input) => { pageDefinition = input; };
    const filename = require.resolve('../' + tab.pagePath);
    delete require.cache[filename]; require(filename);
    const page = { ...pageDefinition, data: structuredClone(pageDefinition.data),
      getTabBar: () => bar, setData(patch) { Object.assign(this.data, patch); },
      load: async () => {}, consumePending: () => false };
    definition.pageLifetimes.show.call(bar);
    assert.equal(bar.data.selected, (index + 1) % TABS.length);
    await page.onShow();
    assert.equal(bar.data.selected, index, tab.pagePath);
    // Component show may run after page onShow; a stale route must not undo it.
    definition.pageLifetimes.show.call(bar);
    assert.equal(bar.data.selected, index, tab.pagePath);
  }
});

test('page selection tolerates missing native bars in tests and uses independent instances', () => {
  selectTab({}, 0); selectTab({ getTabBar: () => null }, 1);
  const first = fixture('pages/explore/index').bar;
  const second = fixture('pages/learn/index').bar;
  selectTab({ getTabBar: () => first }, 1);
  selectTab({ getTabBar: () => second }, 3);
  assert.equal(first.data.selected, 1);
  assert.equal(second.data.selected, 3);
});
