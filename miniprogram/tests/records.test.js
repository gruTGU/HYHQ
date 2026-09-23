const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(request) {
  let definition;
  const storage = new Map();
  const session = createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) });
  session.save({ token: 'A-token', user: { id: 'A' } });
  const application = { session, api: { request }, globalData: {} };
  const modals = [], navigation = [], toasts = [];
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, setNavigationBarTitle() {}, showModal: (options) => modals.push(options), showToast: (options) => toasts.push(options.title), navigateTo: (options) => navigation.push(options.url), switchTab: (options) => navigation.push(options.url) };
  global.Page = (value) => { definition = value; };
  const path = require.resolve('../pages/records/index'); delete require.cache[path]; require(path);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad({ kind: 'favorites' });
  return { page, application, modals, navigation, toasts };
}
const record = (id, place = { id: 'place-' + id, name: '地点 ' + id }) => ({ id, place, place_id: 'place-' + id, content: null, created_at: '2026-09-20T00:00:00Z' });
const envelope = (records, next = null) => ({ data: records, meta: { next, count: records.length, page: 1, page_size: 20 } });
const click = (id) => ({ currentTarget: { dataset: { id } } });

test('record pages use the API pagination URL, deduplicate shifting pages and keep zero extra requests', async () => {
  const calls = [];
  const { page } = fixture(async (path) => { calls.push(path); return calls.length === 1 ? envelope([record('a')], 'http://127.0.0.1:18203/api/v1/favorites/?page=2') : envelope([record('a'), record('b')]); });
  await page.onShow(); await page.more(); await page.more();
  assert.deepEqual(calls, ['favorites/', 'http://127.0.0.1:18203/api/v1/favorites/?page=2']);
  assert.deepEqual(page.data.records.map((item) => item.id), ['a', 'b']);
});

test('returning from detail refreshes a removed favorite and hidden pages clear private records', async () => {
  let calls = 0;
  const { page } = fixture(async () => envelope(++calls === 1 ? [record('a')] : []));
  await page.onShow(); page.onHide(); assert.deepEqual(page.data.records, []);
  await page.onShow(); assert.deepEqual(page.data.records, []); assert.equal(calls, 2);
});

test('the response from before hiding cannot replace the refreshed page or clear its loading state', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const { page } = fixture(() => ++calls === 1 ? old.promise : fresh.promise);
  const first = page.onShow(); page.onHide(); const second = page.onShow();
  old.resolve(envelope([record('old')])); await first;
  assert.equal(page.data.loading, true); assert.deepEqual(page.data.records, []);
  fresh.resolve(envelope([record('new')])); await second;
  assert.deepEqual(page.data.records.map((item) => item.id), ['new']);
});

test('deletion invalidates an in-flight page and refreshes the list without resurrecting a deleted record', async () => {
  const oldPage = deferred(); let calls = 0;
  const { page, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') return { data: null };
    calls += 1;
    if (calls === 1) return envelope([record('a')], '/api/v1/favorites/?page=2');
    if (calls === 2) return oldPage.promise;
    return envelope([record('b')]);
  });
  await page.onShow(); const loading = page.more();
  page.remove(click('a')); await modals[0].success({ confirm: true });
  oldPage.resolve(envelope([record('a'), record('old-page')])); await loading;
  assert.deepEqual(page.data.records.map((item) => item.id), ['b']);
  assert.equal(page.data.busy, false); assert.equal(page.data.loadingMore, false);
});

test('repeated delete taps and duplicate confirmation callbacks create only one delete request', async () => {
  const deletion = deferred(); let deletes = 0;
  const { page, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') { deletes += 1; return deletion.promise; }
    return envelope(deletes ? [] : [record('a')]);
  });
  await page.onShow(); page.remove(click('a')); page.remove(click('a'));
  assert.equal(modals.length, 1);
  const deleting = modals[0].success({ confirm: true });
  await modals[0].success({ confirm: true }); page.remove(click('a'));
  assert.equal(deletes, 1); assert.equal(modals.length, 1);
  deletion.resolve({ data: null }); await deleting; assert.deepEqual(page.data.records, []);
});

test('canceling deletion sends no mutation and allows a later confirmation', async () => {
  let calls = 0; const { page, modals } = fixture(async () => { calls += 1; return envelope([record('a')]); });
  await page.onShow(); page.remove(click('a')); await modals[0].success({ confirm: false });
  page.remove(click('a')); assert.equal(modals.length, 2); assert.equal(calls, 1);
});

test('a failed delete keeps the record and permits retry, while an already-deleted 404 is successful', async () => {
  let deletes = 0;
  const { page, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') { deletes += 1; throw Object.assign(new Error(deletes === 1 ? '连接失败' : '记录不存在'), { status: deletes === 1 ? 0 : 404 }); }
    return envelope(deletes === 2 ? [] : [record('a')]);
  });
  await page.onShow(); page.remove(click('a')); await modals[0].success({ confirm: true });
  assert.equal(page.data.records.length, 1); assert.match(page.data.error, /连接失败/); assert.equal(page.data.busy, false);
  page.remove(click('a')); await modals[1].success({ confirm: true }); assert.deepEqual(page.data.records, []);
});

test('a successful deletion remains removed when the subsequent refresh fails', async () => {
  let deleted = false;
  const { page, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') { deleted = true; return { data: null }; }
    if (deleted) throw new Error('刷新失败');
    return envelope([record('a'), record('b')]);
  });
  await page.onShow(); page.remove(click('a')); await modals[0].success({ confirm: true });
  assert.deepEqual(page.data.records.map((item) => item.id), ['b']); assert.match(page.data.error, /刷新失败/);
});

test('an old-account response and a failed reload never show private records in the new account', async () => {
  const pending = deferred(); let calls = 0;
  const { page, application } = fixture(() => ++calls === 1 ? pending.promise : Promise.reject(new Error('网络失败')));
  const loading = page.onShow(); application.session.save({ token: 'B-token', user: { id: 'B' } });
  pending.resolve(envelope([record('private-A')])); await loading;
  assert.deepEqual(page.data.records, []); assert.match(page.data.error, /登录状态已变化/);
  page._recordsToken = 'A-token'; page.data.records = [record('cached-A')];
  await page.load(); assert.deepEqual(page.data.records, []);
});

test('confirmations from a hidden page, unloaded page or previous account cannot delete a record', async () => {
  for (const change of ['hide', 'unload', 'account']) {
    let deletes = 0;
    const { page, application, modals } = fixture(async (path, options) => { if (options && options.method === 'DELETE') deletes += 1; return envelope([record('a')]); });
    await page.onShow(); page.remove(click('a'));
    if (change === 'hide') page.onHide();
    if (change === 'unload') { page.onUnload(); page.setData = () => { throw new Error('write after unload'); }; }
    if (change === 'account') application.session.save({ token: 'B-token', user: { id: 'B' } });
    await modals[0].success({ confirm: true }); assert.equal(deletes, 0);
  }
});

test('a delete response from an old account cannot refresh or overwrite the new account', async () => {
  const pending = deferred(); let reads = 0;
  const { page, application, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') return pending.promise;
    reads += 1; return envelope([record('a')]);
  });
  await page.onShow(); page.remove(click('a')); const deleting = modals[0].success({ confirm: true });
  application.session.save({ token: 'B-token', user: { id: 'B' } });
  pending.resolve({ data: null }); await deleting;
  assert.equal(reads, 1); assert.deepEqual(page.data.records, []); assert.equal(page.data.busy, false);
});

test('unpublished targets keep a removable placeholder but cannot navigate', async () => {
  const { page, navigation, toasts } = fixture(async () => envelope([record('hidden', null), { id: 'content', place: null, place_id: null, content: { id: 'article', title: '文章' }, content_id: 'article' }]));
  await page.onShow(); page.open(click('hidden'));
  assert.equal(page.data.records[0].unavailable, true); assert.match(page.data.records[0].title, /下架/);
  assert.equal(navigation.length, 0); assert.match(toasts[0], /暂不可用/);
  page.open(click('content')); assert.equal(navigation[0], '/pages/detail/index?kind=content&id=article');
});

test('both task record types open their existing result pages only for a current owned list item', async () => {
  for (const kind of ['recognition-jobs', 'assessment-jobs']) {
    const { page, navigation, application } = fixture(async () => envelope([{ id: 'job-1', status: 'queued', created_at: '2026-09-20T00:00:00Z' }]));
    page.data.kind = kind; await page.onShow(); page.open(click('unknown')); assert.equal(navigation.length, 0);
    page.open(click('job-1')); assert.equal(navigation.length, 1);
    if (kind === 'recognition-jobs') assert.equal(application.globalData.recognitionJobId, 'job-1');
    else assert.equal(navigation[0], '/pages/assessment/index?jobId=job-1');
    application.session.clear(); page.open(click('job-1')); assert.equal(navigation.length, 1); assert.deepEqual(page.data.records, []);
  }
});

test('malformed list data, cross-resource pages and repeated pagination fail visibly without appending', async () => {
  for (const response of [{ data: {} }, envelope([record('x')], '/api/v1/me/?page=2'), envelope([record('x')], 'favorites/')]) {
    const { page } = fixture(async () => response); await page.onShow();
    assert.ok(page.data.error); assert.deepEqual(page.data.records, []); assert.equal(page.data.loading, false);
  }
});

test('a failed next-page request preserves the current page and retry uses the same URL', async () => {
  let calls = 0;
  const { page } = fixture(async () => {
    calls += 1;
    if (calls === 1) return envelope([record('a')], '/api/v1/favorites/?page=2');
    if (calls === 2) throw new Error('暂时断网');
    return envelope([record('b')]);
  });
  await page.onShow(); await page.more();
  assert.deepEqual(page.data.records.map((item) => item.id), ['a']); assert.ok(page.data.next);
  await page.more(); assert.deepEqual(page.data.records.map((item) => item.id), ['a', 'b']);
});

test('returning while an accepted deletion is still pending waits before reloading its records', async () => {
  const pending = deferred(); let deleted = false, reads = 0;
  const { page, modals } = fixture(async (path, options) => {
    if (options && options.method === 'DELETE') { await pending.promise; deleted = true; return { data: null }; }
    reads += 1; return envelope(deleted ? [] : [record('a')]);
  });
  await page.onShow(); page.remove(click('a')); const deleting = modals[0].success({ confirm: true });
  page.onHide(); const showing = page.onShow();
  assert.equal(reads, 1); assert.equal(page.data.loading, true);
  pending.resolve(); await deleting; await showing;
  assert.equal(reads, 2); assert.deepEqual(page.data.records, []);
});

test('pull-to-refresh, more and another delete cannot bypass a pending deletion after returning', async () => {
  const pending = deferred(); let deleted = false; const calls = [];
  const { page, modals } = fixture(async (path, options) => {
    calls.push([path, options && options.method]);
    if (options && options.method === 'DELETE') { await pending.promise; deleted = true; return { data: null }; }
    return envelope(deleted ? [] : [record('a')], deleted ? null : '/api/v1/favorites/?page=2');
  });
  await page.onShow(); page.remove(click('a')); const deleting = modals[0].success({ confirm: true });
  page.onHide(); const showing = page.onShow();
  await page.onPullDownRefresh(); await page.load(); await page.more(); page.remove(click('a'));
  assert.deepEqual(calls, [['favorites/', undefined], ['favorites/a/', 'DELETE']]); assert.equal(modals.length, 1);
  assert.equal(page.data.loading, true); assert.deepEqual(page.data.records, []);
  pending.resolve(); await deleting; await showing;
  assert.equal(calls.length, 3); assert.deepEqual(page.data.records, []); assert.equal(page.data.loading, false);
});

test('empty records provide working destinations and a new recognition does not reopen an older task', async () => {
  const paths = { favorites: '/pages/explore/index', histories: '/pages/explore/index', visits: '/pages/explore/index', 'recognition-jobs': '/pages/recognize/index', 'assessment-jobs': '/pages/assessment/index' };
  for (const [kind, path] of Object.entries(paths)) {
    const { page, navigation, application } = fixture(async () => envelope([]));
    page.onLoad({ kind }); await page.onShow();
    assert.ok(page.data.emptyState.heading); assert.ok(page.data.emptyState.action);
    application.globalData.recognitionJobId = 'old-job';
    page.discover(); assert.deepEqual(navigation, [path]);
    if (kind === 'recognition-jobs') assert.equal(application.globalData.recognitionJobId, '');
    page.onHide(); page.discover(); assert.equal(navigation.length, 1);
  }
  const { page, navigation } = fixture(async () => envelope([]));
  await page.onShow(); page.discover({ currentTarget: { dataset: { destination: 'learn' } } });
  assert.deepEqual(navigation, ['/pages/learn/index']);
});
