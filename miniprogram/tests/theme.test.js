const test = require('node:test');
const assert = require('node:assert/strict');
const { createThemeStore, withTheme, KEY } = require('../lib/theme');
const { THEMES, FOREST } = require('../lib/themes');
function fixture(stored) {
  const values = new Map(stored ? [[KEY, stored]] : []);
  const platform = { getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, value) };
  const alternate = { ...FOREST, id: 'test-lake', name: 'Test only', tokens: { ...FOREST.tokens, primary: '#123456' }, navigation: { backgroundColor: '#abcdef', frontColor: '#ffffff' } };
  return { values, platform, registry: [...THEMES, alternate] };
}
test('theme selection persists and restores; pending or unknown entries cannot be selected', () => {
  const { values, platform, registry } = fixture();
  const store = createThemeStore(platform, registry);
  assert.equal(store.list().filter(item => item.ready).length, 4);
  for (const id of ['design-4', 'missing']) assert.throws(() => store.select(id), /还未开放/);
  store.select('test-lake');
  assert.deepEqual(values.get(KEY), { version: 1, id: 'test-lake' });
  assert.equal(createThemeStore(platform, registry).current().id, 'test-lake');
  assert.equal(createThemeStore(platform).current().id, 'forest');
});
test('corrupt preferences and unsafe or incomplete theme definitions fall back to forest', () => {
  for (const stored of [{ version: 2, id: 'test-lake' }, { version: 1, id: '../../evil' }, 'test-lake']) {
    const { platform, registry } = fixture(stored);
    assert.equal(createThemeStore(platform, registry).current().id, 'forest');
  }
  const { platform, registry } = fixture();
  registry.push({ ...FOREST, id: 'unsafe', tokens: { ...FOREST.tokens, background: 'url(https://invalid)' } });
  assert.throws(() => createThemeStore(platform, registry).select('unsafe'), /还未开放/);
});
test('failed persistence keeps current theme and surfaces nonpersistent status', () => {
  const { platform, registry } = fixture(); platform.setStorageSync = () => { throw new Error('full'); };
  const store = createThemeStore(platform, registry);
  assert.equal(store.select('test-lake').persisted, false);
  assert.equal(store.current().id, 'test-lake');
});
test('page lifecycle propagates active theme, preserves results and stops hidden/unloaded updates', async () => {
  const { platform, registry } = fixture();
  const store = createThemeStore(platform, registry), bars = [], calls = [];
  global.getApp = () => ({ theme: store });
  global.wx = { setNavigationBarColor: options => bars.push(options.backgroundColor), setBackgroundColor() {} };
  const definition = withTheme({ data: { draft: 'keep' }, onLoad(value) { calls.push(value); return 'loaded'; }, async onShow() { return 'shown'; } });
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  assert.equal(page.onLoad('query'), 'loaded'); assert.equal(await page.onShow(), 'shown');
  store.select('test-lake'); assert.match(page.data.themeStyle, /--hyhq-primary:#123456/); assert.equal(bars.at(-1), '#abcdef');
  assert.equal(page.data.draft, 'keep'); page.onHide(); store.select('forest'); assert.equal(page.data.themeId, 'test-lake');
  await page.onShow(); assert.equal(page.data.themeId, 'forest'); page.onUnload(); store.select('test-lake'); assert.equal(page.data.themeId, 'forest');
  assert.deepEqual(calls, ['query']);
  delete global.getApp; delete global.wx;
});
test('only delivered designs are selectable in the production registry', () => {
  const { platform } = fixture(); const store = createThemeStore(platform);
  assert.equal(store.list().length, 4); assert.deepEqual(store.list().filter(item => item.ready).map(item => item.id), ['forest', 'design-2', 'design-3']);
});

test('custom tab bar updates its theme and releases subscriptions while hidden or detached', () => {
  const { platform, registry } = fixture(); const store = createThemeStore(platform, registry);
  global.getApp = () => ({ theme: store }); global.getCurrentPages = () => [];
  let definition; global.Component = value => { definition = value; };
  const file = require.resolve('../custom-tab-bar/index'); delete require.cache[file]; require(file);
  const tab = { ...definition.methods, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  definition.lifetimes.attached.call(tab); store.select('test-lake'); assert.equal(tab.data.themeId, 'test-lake');
  definition.pageLifetimes.hide.call(tab); store.select('forest'); assert.equal(tab.data.themeId, 'test-lake');
  definition.pageLifetimes.show.call(tab); assert.equal(tab.data.themeId, 'forest');
  definition.lifetimes.detached.call(tab); tab.setData = () => { throw new Error('detached update'); };
  store.select('test-lake');
  delete global.getApp; delete global.getCurrentPages; delete global.Component;
});
