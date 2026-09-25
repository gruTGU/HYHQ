const test = require('node:test');
const assert = require('node:assert/strict');
const { searchData } = require('../lib/knowledge-search');
const id = '7b591bbf-33ef-4a79-a709-7c80dcb040ca';
const response = (title = '湿地', page = 1, has_more = false) => ({ data: { count: 1, page, has_more, answer_kind: 'published_excerpts', answer: '原文片段', notice: '仅本站资料', results: [{ id, kind: 'content', title, excerpt: '湿地生态', source: '公开资料', updated_at: '2026-09-24T00:00:00+08:00' }] } });
function setup(handler) {
  const calls = [], links = [];
  global.getApp = () => ({ api: { request: async (path, options) => { calls.push({ path, options }); if (path === 'content-tags/') return { data: { categories: [], plant_labels: [] } }; if (path === 'places/') return { data: [], meta: { next: null } }; return handler(path, options); } } });
  global.wx = { navigateTo: (value) => links.push(value.url), stopPullDownRefresh() {} };
  let definition; global.Page = (value) => { definition = value; };
  const path = require.resolve('../pages/knowledge-search/index'); delete require.cache[path]; require(path);
  const page = { ...definition, data: structuredClone(definition.data) }; page.setData = (patch) => Object.assign(page.data, patch);
  return { page, calls, links };
}
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { resolve, promise }; }

test('validates source shape and rejects arbitrary links/kinds', () => {
  assert.equal(searchData(response()).results[0].kindLabel, '科普手记');
  const bad = response(); bad.data.results[0].kind = 'external'; assert.throws(() => searchData(bad));
});
test('search is public and empty input makes no search request', async () => {
  const { page, calls } = setup(() => response()); await page.onLoad(); await page.search();
  assert.match(page.data.error, /关键词/); assert.equal(calls.some((row) => row.path === 'knowledge-search/'), false);
  page.input({ detail: { value: '  湿地  ' } }); await page.search();
  assert.equal(page.data.results[0].title, '湿地'); assert.equal(calls.at(-1).options.data.q, '湿地');
});
test('later search wins and hidden completion cannot change the page', async () => {
  const pending = [];
  const { page } = setup(() => { const d = deferred(); pending.push(d); return d.promise; }); await page.onLoad();
  page.data.input = '旧词'; const first = page.search(); page.data.input = '新词'; const second = page.search();
  pending[1].resolve(response('新资料')); await second; pending[0].resolve(response('旧资料')); await first;
  assert.equal(page.data.results[0].title, '新资料');
  const last = page.search(); page.onHide(); pending[2].resolve(response('不可见回调')); await last;
  assert.equal(page.data.results.length, 0); assert.equal(page.data.loading, false);
});
test('pagination uses submitted filters and de-duplicates rows; source navigation only for received references', async () => {
  const { page, calls, links } = setup((_, options) => response('湿地', options.data.page, options.data.page === 1)); await page.onLoad(); page.data.input = '湿地'; await page.search();
  page.data.input = '未提交的草稿'; await page.more(); assert.equal(calls.at(-1).options.data.q, '湿地'); assert.equal(page.data.results.length, 1);
  page.open({ currentTarget: { dataset: { key: 'fake' } } }); assert.equal(links.length, 0);
  page.open({ currentTarget: { dataset: { key: 'content:' + id } } }); assert.equal(links[0], '/pages/detail/index?kind=content&id=' + id);
});
test('failed request preserves input and retry; no evidence remains an explicit empty state', async () => {
  let fail = true;
  const { page } = setup(() => { if (fail) throw new Error('连接失败'); return { data: { count: 0, page: 1, has_more: false, results: [], answer_kind: 'no_evidence', answer: '没有匹配资料', notice: '不能据此下结论' } }; });
  await page.onLoad(); page.data.input = '海豚'; await page.search(); assert.equal(page.data.input, '海豚'); assert.match(page.data.error, /连接失败/);
  fail = false; await page.retry(); assert.equal(page.data.count, 0); assert.equal(page.data.answer, '没有匹配资料');
});

test('submitting empty criteria cancels the earlier in-flight search and its answer', async () => {
  const waiting = deferred(); const { page } = setup(() => waiting.promise); await page.onLoad();
  page.data.input = '湿地'; const old = page.search(); page.data.input = ' '; await page.search();
  waiting.resolve(response('旧答案')); await old;
  assert.equal(page.data.results.length, 0); assert.equal(page.data.answer, ''); assert.equal(page.data.loading, false); assert.match(page.data.error, /关键词/);
});
test('queued controls and filter responses cannot write or navigate after unload', async () => {
  const { page, links } = setup(() => response()); await page.onLoad(); page.data.input = '湿地'; await page.search();
  page.onUnload(); page.setData = () => { throw new Error('write after unload'); };
  page.input({ detail: { value: 'late' } }); page.filter({ currentTarget: { dataset: { field: 'placeIndex' } }, detail: { value: 0 } });
  await page.loadFilters(); await page.search(); await page.onPullDownRefresh(); page.onShow(); page.onHide();
  page.open({ currentTarget: { dataset: { key: 'content:' + id } } }); assert.equal(links.length, 0);
});
test('independent filter requests survive a search, and newer filter refresh wins', async () => {
  const { page } = setup(() => response()); await page.onLoad();
  const pending = [];
  global.getApp = () => ({ api: { request: (path) => {
    if (path === 'content-tags/') { const item = deferred(); pending.push(item); return item.promise; }
    if (path === 'places/') return Promise.resolve({ data: [], meta: { next: null } });
    return Promise.resolve(response());
  } } });
  const first = page.loadFilters(); page.data.input = '湿地'; await page.search();
  pending[0].resolve({ data: { categories: [{ value: 'water' }], plant_labels: [] } }); await first;
  assert.equal(page.data.categories[1].value, 'water');
  const older = page.loadFilters(), newer = page.loadFilters();
  pending[2].resolve({ data: { categories: [{ value: 'green' }], plant_labels: [] } }); await newer;
  pending[1].resolve({ data: { categories: [{ value: 'plants' }], plant_labels: [] } }); await older;
  assert.equal(page.data.categories[1].value, 'green');
});
test('filter refresh preserves selected identity instead of silently changing to another index', async () => {
  const { page, calls } = setup(() => response()); await page.onLoad();
  page.setData({ categories: [{ value: '', name: '全部分类' }, { value: 'water', name: '水' }, { value: 'green', name: '绿' }], categoryIndex: 2, places: [{ id: '', name: '全部地点' }, { id, name: '地点' }], placeIndex: 1 });
  global.getApp = () => ({ api: { request: async (path) => path === 'content-tags/' ? { data: { categories: [{ value: 'green' }, { value: 'water' }], plant_labels: [] } } : { data: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '新地点' }, { id, name: '地点' }], meta: { next: null } } } });
  await page.loadFilters(); assert.equal(page.data.categories[page.data.categoryIndex].value, 'green'); assert.equal(page.data.places[page.data.placeIndex].id, id);
  const previous = page.data.placeIndex;
  page.filter({ currentTarget: { dataset: { field: 'placeIndex' } }, detail: { value: -1 } }); assert.equal(page.data.placeIndex, previous);
  page.filter({ currentTarget: { dataset: { field: 'placeIndex' } }, detail: { value: 999 } }); assert.equal(page.data.placeIndex, previous);
});
test('malformed and contradictory evidence cannot be presented as a source-backed answer', () => {
  for (const modify of [
    (data) => { data.answer_kind = 'no_evidence'; },
    (data) => { data.results[0].id = '-'.repeat(36); },
    (data) => { data.results[0].source = null; },
    (data) => { data.page = 0; },
    (data) => { data.results = []; data.has_more = true; },
  ]) { const value = response(); modify(value.data); assert.throws(() => searchData(value)); }
});
