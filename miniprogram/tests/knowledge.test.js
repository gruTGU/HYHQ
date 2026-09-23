const test = require('node:test');
const assert = require('node:assert/strict');
const { contentView, routeView, choices } = require('../lib/knowledge');
const regions = [{ id: 'a', slug: 'demo-campus', name: '示范校园' }, { id: 'b', name: '另一区域' }];
const tags = { categories: [{ value: 'plants', name: '植物知识', count: 2 }, { value: 'water', name: '水资源保护', count: 1 }], plant_labels: [{ value: 'daisy', name: '雏菊类花卉', count: 1 }, { value: 'custom-grass', name: 'custom-grass', count: 1 }] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(handler, globalData = {}) {
  const calls = [], application = { globalData, api: { request: async (path, options) => {
    calls.push({ path, options });
    if (handler) { const custom = await handler(path, options); if (custom !== undefined) return custom; }
    if (path === 'regions/') return { data: regions };
    if (path === 'content-tags/') return { data: tags };
    if (path === 'contents/') return { data: [{ id: 'article', title: '认识雏菊', category: 'plants', plant_label: 'daisy', source: '校园植物手册', is_demo: true }] };
    if (path === 'routes/') return { data: [{ id: 'route', name: '河湖漫步', stop_count: 2, region_name: '示范校园', source: '管理员设计' }] };
    throw new Error('Unexpected path ' + path);
  } } };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, navigateTo() {}, getLocation() { throw new Error('public browsing requested location'); }, showModal() { throw new Error('public browsing requested login'); } };
  let definition; global.Page = (input) => { definition = input; };
  const path = require.resolve('../pages/learn/index'); delete require.cache[path]; require(path);
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return { instance, application, calls };
}
const change = (value) => ({ detail: { value } });

test('all-route shortcut removes campus filter while preserving shared region and active tab', async () => {
  const { instance, calls, application } = setup(undefined, { region: regions[0] });
  await instance.onLoad();
  instance.changeTab({ currentTarget: { dataset: { tab: 'routes' } } });
  await instance.allRoutes();
  assert.equal(instance.data.regionId, '');
  assert.equal(instance.data.tab, 'routes');
  assert.equal(application.globalData.region.id, 'a');
  assert.deepEqual(calls.filter((item) => item.path === 'routes/').at(-1).options.data, { page_size: 20 });
  instance.onHide(); await instance.onShow();
  assert.equal(instance.data.regionId, '');
});

test('public knowledge shows Chinese categories, plant labels, source and visible route counts', async () => {
  const { instance, calls } = setup(); await instance.onLoad();
  assert.equal(instance.data.contents[0].category_name, '植物知识');
  assert.equal(instance.data.contents[0].plant_name, '雏菊类花卉');
  assert.equal(instance.data.contents[0].source, '校园植物手册');
  assert.equal(instance.data.routes[0].public_stop_count, 2);
  assert.deepEqual(calls.find((item) => item.path === 'contents/').options.data, { page_size: 20 });
  assert.equal(instance.data.regions[0].name, '全部区域');
});
test('specific region includes no artificial place condition, while all-region mode preserves shared selection', async () => {
  const { instance, calls, application } = setup(undefined, { region: regions[0] }); await instance.onLoad();
  assert.deepEqual(calls.find((item) => item.path === 'contents/').options.data, { page_size: 20, region: 'a' });
  await instance.changeRegion(change(0));
  assert.equal(instance.data.regionId, ''); assert.equal(application.globalData.region.id, 'a');
  assert.deepEqual(calls.filter((item) => item.path === 'contents/').at(-1).options.data, { page_size: 20 });
  instance.onHide(); await instance.onShow(); assert.equal(instance.data.regionId, '');
});
test('category, plant, search and linked-place filters compose, and reset clears only content filters', async () => {
  const { instance, calls } = setup(undefined, { pendingKnowledgeFilter: { region: 'a', place: 'pond', plant_label: 'daisy' } });
  await instance.onLoad(); await instance.changeCategory(change(1));
  instance.inputSearch(change('  保护  ')); await instance.searchContents();
  assert.deepEqual(calls.filter((item) => item.path === 'contents/').at(-1).options.data, { page_size: 20, region: 'a', category: 'plants', plant_label: 'daisy', place: 'pond', search: '保护' });
  await instance.clearPlace(); assert.equal(instance.data.place, ''); assert.equal(instance.data.search, '保护');
  await instance.resetFilters(); assert.deepEqual(calls.filter((item) => item.path === 'contents/').at(-1).options.data, { page_size: 20, region: 'a' });
});
test('pending plant filter replaces stale filters and missing region explicitly means all regions', async () => {
  const { instance, application, calls } = setup(undefined, { region: regions[0] }); await instance.onLoad();
  await instance.changeCategory(change(2)); instance.inputSearch(change('old')); await instance.searchContents(); instance.data.place = 'old-place';
  instance.onHide(); application.globalData.pendingKnowledgeFilter = { tab: 'contents', plant_label: 'daisy' }; await instance.onShow();
  assert.equal(application.globalData.pendingKnowledgeFilter, undefined);
  assert.equal(instance.data.regionId, ''); assert.equal(instance.data.category, ''); assert.equal(instance.data.place, ''); assert.equal(instance.data.searchInput, '');
  assert.equal(instance.data.plantLabels[instance.data.plantIndex].value, 'daisy');
  assert.deepEqual(calls.filter((item) => item.path === 'contents/').at(-1).options.data, { page_size: 20, plant_label: 'daisy' });
});
test('route return filter clears stale article filters and only sends region to routes', async () => {
  const { instance, application, calls } = setup(); await instance.onLoad();
  instance.onHide(); application.globalData.pendingKnowledgeFilter = { tab: 'routes', region: 'b' }; await instance.onShow();
  assert.equal(instance.data.tab, 'routes'); assert.equal(instance.data.regionId, 'b');
  assert.deepEqual(calls.filter((item) => item.path === 'routes/').at(-1).options.data, { page_size: 20, region: 'b' });
});
test('returning from another page adopts its changed shared region and clears linked-place filter', async () => {
  const { instance, application } = setup(undefined, { region: regions[0], pendingKnowledgeFilter: { region: 'a', place: 'pond' } }); await instance.onLoad();
  instance.onHide(); application.globalData.region = regions[1]; await instance.onShow();
  assert.equal(instance.data.regionId, 'b'); assert.equal(instance.data.regionIndex, 2); assert.equal(instance.data.place, '');
});
test('a failed content list or tag directory leaves independent routes browsable', async () => {
  const { instance } = setup(async (path) => {
    if (path === 'contents/') throw new Error('科普不可用');
    if (path === 'content-tags/') throw new Error('标签不可用');
  });
  await instance.onLoad(); assert.equal(instance.data.contentsError, '科普不可用'); assert.equal(instance.data.tagsError, '标签不可用');
  assert.equal(instance.data.routes[0].id, 'route'); assert.equal(instance.data.routesError, '');
});
test('route failure never hides successful content and retry only reloads its failed list', async () => {
  let fail = true;
  const { instance, calls } = setup(async (path) => { if (path === 'routes/' && fail) throw new Error('路线不可用'); });
  await instance.onLoad(); assert.equal(instance.data.contents.length, 1); assert.equal(instance.data.routesError, '路线不可用');
  const before = calls.filter((item) => item.path === 'contents/').length;
  fail = false; await instance.retryRoutes();
  assert.equal(instance.data.routes.length, 1); assert.equal(calls.filter((item) => item.path === 'contents/').length, before);
});
test('pagination exposes all pages beyond twenty entries and deduplicates overlapping records', async () => {
  const rows = Array.from({ length: 47 }, (_, index) => ({ id: 'article-' + index }));
  const { instance, calls } = setup(async (path) => {
    if (path === 'contents/') return { data: rows.slice(0, 20), meta: { next: '/api/v1/contents/?page=2' } };
    if (path.endsWith('page=2')) return { data: rows.slice(19, 40), meta: { next: '/api/v1/contents/?page=3' } };
    if (path.endsWith('page=3')) return { data: rows.slice(40), meta: { next: null } };
  });
  await instance.onLoad(); await instance.moreContents(); await instance.onReachBottom();
  assert.equal(instance.data.contents.length, 47); assert.equal(instance.data.contentsNext, '');
  assert.equal(calls.find((item) => item.path.endsWith('page=2')).options, undefined);
});
test('failed later page preserves existing rows and retry appends without losing the query', async () => {
  let fail = true;
  const { instance } = setup(async (path) => {
    if (path === 'contents/') return { data: [{ id: 'one' }], meta: { next: '/api/v1/contents/?page=2&category=plants' } };
    if (path.includes('page=2')) { if (fail) throw new Error('加载更多失败'); return { data: [{ id: 'two' }], meta: { next: null } }; }
  });
  await instance.onLoad(); await instance.moreContents(); assert.deepEqual(instance.data.contents.map((item) => item.id), ['one']);
  assert.equal(instance.data.contentsError, ''); assert.equal(instance.data.contentsMoreError, '加载更多失败');
  fail = false; await instance.moreContents(); assert.deepEqual(instance.data.contents.map((item) => item.id), ['one', 'two']);
});
test('duplicate load-more taps issue one request and obsolete pagination cannot pollute a new filter', async () => {
  const pending = deferred(); let secondCalls = 0;
  const { instance } = setup(async (path, options) => {
    if (path === 'contents/') return options.data.category ? { data: [{ id: 'filtered' }] } : { data: [{ id: 'old' }], meta: { next: '/api/v1/contents/?page=2' } };
    if (path.includes('page=2')) { secondCalls += 1; return pending.promise; }
  });
  await instance.onLoad(); const more = instance.moreContents(); await instance.moreContents();
  await instance.changeCategory(change(1)); pending.resolve({ data: [{ id: 'old-second-page' }] }); await more;
  assert.equal(secondCalls, 1); assert.deepEqual(instance.data.contents.map((item) => item.id), ['filtered']); assert.equal(instance.data.contentsNext, '');
});
test('rapid content filters accept only the latest response and keep route request count stable', async () => {
  const pending = deferred();
  const { instance, calls } = setup(async (path, options) => {
    if (path === 'contents/' && options.data.category === 'plants') return pending.promise;
    if (path === 'contents/' && options.data.category === 'water') return { data: [{ id: 'water' }] };
  });
  await instance.onLoad(); const old = instance.changeCategory(change(1)); await instance.changeCategory(change(2));
  pending.resolve({ data: [{ id: 'plants' }] }); await old;
  assert.equal(instance.data.contents[0].id, 'water'); assert.equal(calls.filter((item) => item.path === 'routes/').length, 1);
});
test('region switches discard old catalogue and content responses without overriding the selected global region', async () => {
  const oldList = deferred(), oldTags = deferred();
  const { instance, application } = setup(async (path, options) => {
    if (options && options.data.region === 'a' && path === 'contents/') return oldList.promise;
    if (options && options.data.region === 'a' && path === 'content-tags/') return oldTags.promise;
    if (path === 'contents/') return { data: [{ id: options.data.region || 'all' }] };
  });
  await instance.onLoad(); const old = instance.changeRegion(change(1)); await instance.changeRegion(change(2));
  oldList.resolve({ data: [{ id: 'old-a' }] }); oldTags.resolve({ data: { categories: [{ value: 'obsolete' }], plant_labels: [] } }); await old;
  assert.equal(instance.data.contents[0].id, 'b'); assert.equal(application.globalData.region.id, 'b'); assert.equal(instance.data.categories.some((item) => item.value === 'obsolete'), false);
});
test('late responses after hide or unload never mutate state; hidden controls cause no requests', async () => {
  const pending = deferred();
  const { instance, calls } = setup(async (path) => path === 'contents/' ? pending.promise : undefined);
  const loading = instance.onLoad(); instance.onHide();
  instance.setData = () => { throw new Error('late state write'); };
  const count = calls.length;
  await instance.load(); await instance.retryContents(); await instance.changeRegion(change(0)); await instance.changeCategory(change(0)); await instance.changePlant(change(0));
  instance.inputSearch(change('late')); await instance.searchContents(); await instance.clearPlace(); await instance.resetFilters();
  instance.changeTab({ currentTarget: { dataset: { tab: 'routes' } } });
  instance.onUnload(); pending.resolve({ data: [{ id: 'late' }] }); await loading;
  assert.equal(calls.length, count);
});
test('malformed or cyclic page links stop visibly while preserving earlier pages', async () => {
  const { instance } = setup(async (path) => {
    if (path === 'contents/') return { data: [{ id: 'one' }], meta: { next: '/api/v1/contents/?page=2' } };
    if (path.includes('page=2')) return { data: [{ id: 'two' }], meta: { next: 'contents/' } };
  });
  await instance.onLoad(); await instance.moreContents();
  assert.match(instance.data.contentsMoreError, /分页异常/); assert.deepEqual(instance.data.contents.map((item) => item.id), ['one']);
});
test('empty lists are successful empty states and malformed list data is an explicit error', async () => {
  const { instance } = setup(async (path) => path === 'contents/' ? { data: [] } : path === 'routes/' ? { data: {} } : undefined);
  await instance.onLoad(); assert.equal(instance.data.contentsError, ''); assert.deepEqual(instance.data.contents, []); assert.match(instance.data.routesError, /返回格式/);
});
test('only visible content and route records can trigger supported detail links', async () => {
  const { instance } = setup(); await instance.onLoad(); const urls = []; global.wx.navigateTo = ({ url }) => urls.push(url);
  const open = (kind, id) => instance.open({ currentTarget: { dataset: { kind, id } } });
  open('content', 'article'); open('route', 'route'); open('place', 'article'); open('content', 'missing'); instance.onHide(); open('route', 'route');
  assert.deepEqual(urls, ['/pages/detail/index?kind=content&id=article', '/pages/detail/index?kind=route&id=route']);
});
test('known labels are Chinese while administrator-defined tags and unknown stop counts remain honest', () => {
  assert.equal(contentView({ plant_label: 'custom-grass' }).plant_name, 'custom-grass');
  assert.equal(routeView({ stop_count: 0 }).public_stop_count, 0); assert.equal(routeView({}).public_stop_count, null);
  assert.deepEqual(choices([], 'plant', 'daisy').map((item) => item.name), ['全部植物标签', '雏菊类花卉']);
});

test('five model and seed label codes all have Chinese display names', () => {
  for (const [code, name] of [['daisy', '雏菊类花卉'], ['dandelion', '蒲公英类花卉'], ['roses', '蔷薇属花卉'], ['sunflowers', '向日葵类花卉'], ['tulips', '郁金香类花卉']]) {
    assert.equal(contentView({ plant_label: code }).plant_name, name);
  }
});

test('deep-link selections stay visible even when the region and tag catalogues fail', async () => {
  const { instance } = setup(async (path) => { if (['regions/', 'content-tags/'].includes(path)) throw new Error('目录不可用'); }, { pendingKnowledgeFilter: { region: 'a', plant_label: 'roses' } });
  await instance.onLoad();
  assert.equal(instance.data.regions[instance.data.regionIndex].id, 'a');
  assert.equal(instance.data.plantLabels[instance.data.plantIndex].name, '蔷薇属花卉');
  assert.equal(instance.data.contents.length, 1);
});
