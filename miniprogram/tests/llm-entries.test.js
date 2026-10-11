const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function fixture(name, data) {
  let definition; const navigation = []; const application = { globalData: { region: { id: 'shared-region' } }, session: { token: () => '' } };
  global.getApp = () => application; global.wx = { navigateTo: ({ url }) => navigation.push(url) }; global.Page = (value) => { definition = value; };
  const file = require.resolve('../pages/' + name + '/index'); delete require.cache[file]; require(file);
  const page = { ...definition, _alive: true, _visible: true, _generation: 1, data: { ...structuredClone(definition.data), loading: false, ...data }, setData(patch) { Object.assign(this.data, patch); } };
  return { page, navigation, application };
}
test('guide entry follows region and selected place but ignores hidden page events', () => {
  const { page, navigation } = fixture('explore', { region: { id: 'r1' } });
  page.openAI(); page.data.region = { id: 'r2' }; page.openAI(); page.data.selectedPoint = { id: 'p2' }; page.openAI(); page.onHide(); page.openAI();
  assert.deepEqual(navigation, ['/pages/llm/index?scope=explore&source_type=region&source_id=r1', '/pages/llm/index?scope=explore&source_type=region&source_id=r2', '/pages/llm/index?scope=explore&source_type=place&source_id=p2']);
});
test('learning entry uses its visible region without leaking private search text', () => {
  const { page, navigation } = fixture('learn', { regionId: 'r2', regions: [{ id: '', name: '全部' }, { id: 'r1' }, { id: 'r2' }], place: 'other-place', search: 'private-search', plant_label: 'rose' });
  page.openAI(); page.data.regionId = ''; page.openAI(); page.onHide(); page.openAI();
  assert.deepEqual(navigation, ['/pages/llm/index?scope=learn&source_type=region&source_id=r2', '/pages/llm/index?scope=learn&source_type=region&source_id=r1']);
});
test('retained source handlers use the visible public item and ignore failed or hidden pages', () => {
  for (const kind of ['place', 'content', 'route']) {
    const { page, navigation } = fixture('detail', { kind, item: { id: 'visible-source' } });
    page._id = 'unrelated'; page.openAI(); page.data.error = '资料已撤回'; page.openAI(); page.data.error = ''; page.onHide(); page.openAI();
    assert.deepEqual(navigation, ['/pages/llm/index?scope=' + (kind === 'place' ? 'explore' : 'learn') + '&source_type=' + kind + '&source_id=visible-source']);
  }
});
test('retained measurement source handlers stay scoped and ignore loading or hidden pages', () => {
  const water = fixture('water', { waterBodies: [{ id: 'w1' }, { id: 'w2' }], waterIndex: 1 }); water.page.openAI(); water.page.onHide(); water.page.openAI();
  assert.deepEqual(water.navigation, ['/pages/llm/index?scope=explore&source_type=water&source_id=w2']);
  const data = fixture('data-center', { region: { id: 'r2' }, stations: [{ id: 'old-station' }] }); data.page.openAI(); data.page.data.loading = true; data.page.openAI();
  assert.deepEqual(data.navigation, ['/pages/llm/index?scope=explore&source_type=region&source_id=r2']);
});
test('floating star emits only when visible and clears the tab bar', () => {
  let definition; global.Component = (value) => { definition = value; }; const file = require.resolve('../components/floating-ai/index'); delete require.cache[file]; require(file);
  const events = [], component = { data: { visible: false }, triggerEvent: (name) => events.push(name) };
  definition.methods.open.call(component); component.data.visible = true; definition.methods.open.call(component); assert.deepEqual(events, ['open']); assert.equal(definition.data.releaseEnabled, true);
  const markup = fs.readFileSync(path.join(__dirname, '../components/floating-ai/index.wxml'), 'utf8'); assert.match(markup, /wx:if="{{releaseEnabled && visible}}"/);
  const css = fs.readFileSync(path.join(__dirname, '../components/floating-ai/index.wxss'), 'utf8'); assert.match(css, /84px \+ env\(safe-area-inset-bottom\)/);
});
test('chat and history have no persistent quota/consent controls and successful answers use Markdown', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../pages/llm/index.wxml'), 'utf8'), history = fs.readFileSync(path.join(__dirname, '../pages/llm-history/index.wxml'), 'utf8');
  assert.doesNotMatch(chat + history, /quota|consent|checkbox|五轮|5 轮|剩余额度|使用 1 轮/);
  assert.match(chat, /<markdown-view content="{{item.answer/); assert.match(chat, /{{modelLabel}}/);
  assert.doesNotMatch(chat, /bindtap="createSession"|开启这段对话|先开启对话|与山水对话|自然同行|从眼前的发现/);
  assert.match(chat, /wx:if="{{entryValid && loggedIn && !unavailable}}" class="composer /);
});
