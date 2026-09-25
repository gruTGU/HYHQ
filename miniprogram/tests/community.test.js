const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const community = require('../lib/community');
const TARGET = '11111111-1111-4111-8111-111111111111', ONE = '22222222-2222-4222-8222-222222222222', TWO = '33333333-3333-4333-8333-333333333333';
const row = (id = ONE, extra = {}) => Object.assign({ id, body: '生态观察', status: 'pending', is_owner: true, author: '我', created_at: '2026-09-23T01:00:00Z' }, extra);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const input = (value) => ({ detail: { value } });
const event = (id) => ({ currentTarget: { dataset: id ? { id } : {} } });
function setup(handler, options = {}) {
  const storage = new Map(), calls = [], modals = [], links = [];
  const session = createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) });
  if (!options.guest) session.save({ token: 'a', user: { id: 'user-a' } });
  const application = { session, api: { request: async (path, request) => {
    calls.push({ path, request });
    if (handler) { const result = await handler(path, request); if (result !== undefined) return result; }
    if (path === 'community/status/') return { data: { enabled: true } };
    if (request && request.method === 'POST') return { data: row(TWO, { body: request.data.body || '' }) };
    if (request && request.method === 'DELETE') return { data: null };
    return { data: [row()] };
  } } };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, switchTab: (o) => links.push(o.url), navigateTo: (o) => links.push(o.url), showModal: (o) => modals.push(o) };
  let definition; global.Page = (value) => { definition = value; };
  const path = require.resolve('../pages/comments/index'); delete require.cache[path]; require(path);
  const instance = { ...definition, data: structuredClone(definition.data) }; instance.setData = (value) => Object.assign(instance.data, value);
  instance.onLoad(options.route || { kind: 'content', id: TARGET });
  return { instance, application, calls, modals, links };
}

test('target and pagination reject invalid types, cross-target endpoints and repeated parameters', () => {
  assert.equal(community.target({ kind: 'script', id: TARGET }), null);
  const context = community.target({ kind: 'content', id: TARGET });
  const next = `https://example.test/api/v1/community/comments/?kind=content&target_id=${TARGET}&page=2`;
  assert.match(community.pagePath(next, 'target', context), /^community\/comments\/\?/);
  for (const path of ['community/reports/', `community/comments/?kind=content&target_id=${TWO}`, `community/comments/?kind=content&kind=place&target_id=${TARGET}`, 'https://host/unknown/']) assert.throws(() => community.pagePath(path, 'target', context));
  assert.ok(community.UUID.test(community.requestId()));
});
test('disabled service requests only status and never allows posting or reveals entry UI', async () => {
  const { instance, calls } = setup(() => ({ data: { enabled: false } })); await instance.onShow();
  instance.inputBody(input('不得提交')); await instance.submit(); instance.openReport(event()); await instance.submitReport();
  assert.equal(calls.length, 1); assert.equal(instance.data.enabled, false); assert.equal(instance.data.body, ''); assert.deepEqual(instance.data.records, []);
});
test('unknown or failed service state disables publishing even after a prior successful status', async () => {
  let fail = false; const { instance } = setup((path) => { if (path === 'community/status/' && fail) throw new Error('离线'); });
  await instance.onShow(); assert.equal(instance.data.enabled, true); fail = true; await instance.load(); assert.equal(instance.data.enabled, false); assert.match(instance.data.listError, /离线/);
});
test('guest can view approved list without automatic login or consent popup', async () => {
  const { instance, calls, links, modals } = setup(undefined, { guest: true }); await instance.onShow();
  assert.equal(instance.data.loggedIn, false); assert.equal(calls.length, 2); assert.equal(modals.length, 0);
  instance.inputBody(input('游客')); await instance.submit(); assert.equal(calls.length, 2);
  instance.login(); assert.deepEqual(links, ['/pages/profile/index']);
});
test('invalid target never requests APIs and private modes require voluntary login', async () => {
  const invalid = setup(undefined, { route: { kind: 'content', id: 'invalid' } }); await invalid.instance.onShow(); assert.equal(invalid.calls.length, 0);
  const guest = setup(undefined, { guest: true, route: { mode: 'mine' } }); await guest.instance.onShow(); assert.equal(guest.calls.length, 0);
});
test('comment submission sends only context, body and stable idempotency UUID; blank/long text rejected', async () => {
  const { instance, calls } = setup(); await instance.onShow();
  instance.inputBody(input(' ')); await instance.submit(); instance.inputBody(input('字'.repeat(501))); await instance.submit();
  assert.equal(calls.filter((c) => c.request && c.request.method).length, 0);
  instance.inputBody(input('  新的生态观察\n')); await instance.submit();
  const sent = calls.find((c) => c.request && c.request.method === 'POST').request.data;
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'kind', 'request_id', 'target_id']); assert.equal(sent.body, '新的生态观察'); assert.ok(community.UUID.test(sent.request_id));
  assert.equal(instance.data.body, ''); assert.equal(instance.data.busy, false); assert.match(instance.data.notice, /审核/);
});
test('duplicate submit is suppressed, failed request retains draft and retry idempotency key', async () => {
  const waiting = deferred(); let fail = true;
  const { instance, calls } = setup((path, request) => { if (request && request.method === 'POST' && fail) return waiting.promise; });
  await instance.onShow(); instance.inputBody(input('保留草稿')); const sending = instance.submit(); await instance.submit();
  assert.equal(calls.filter((c) => c.request && c.request.method === 'POST').length, 1);
  waiting.reject(new Error('网络错误')); await sending; assert.equal(instance.data.body, '保留草稿'); assert.match(instance.data.actionError, /刷新记录/); fail = false;
  await instance.submit(); const sent = calls.filter((c) => c.request && c.request.method === 'POST'); assert.equal(sent[0].request.data.request_id, sent[1].request.data.request_id);
});
test('confirmed comment survives failed list refresh and rejected text is never described as public', async () => {
  let saved = false;
  const { instance } = setup((path, request) => {
    if (request && request.method === 'POST') { saved = true; return { data: row(TWO, { status: 'rejected' }) }; }
    if (saved && path !== 'community/status/') throw new Error('刷新失败');
  });
  await instance.onShow(); instance.inputBody(input('新的评论')); await instance.submit();
  assert.equal(instance.data.records[0].id, TWO); assert.match(instance.data.notice, /未通过/); assert.equal(instance.data.body, ''); assert.equal(instance.data.busy, false);
});
test('pagination loads all records, deduplicates and rejects target changes', async () => {
  const next = `community/comments/?kind=content&target_id=${TARGET}&page=2`;
  const { instance } = setup((path) => { if (path === 'community/comments/') return { data: [row()], meta: { next } }; if (path.includes('page=2')) return { data: [row(), row(TWO)] }; });
  await instance.onShow(); await instance.more(); assert.deepEqual(instance.data.records.map((r) => r.id), [ONE, TWO]);
  const invalid = setup((path) => path === 'community/comments/' ? { data: [row()], meta: { next: `community/comments/?kind=place&target_id=${TARGET}&page=2` } } : undefined);
  await invalid.instance.onShow(); assert.match(invalid.instance.data.listError, /对象不一致/); assert.deepEqual(invalid.instance.data.records, []);
});
test('late old-account list cannot overwrite new-account private content', async () => {
  const waiting = deferred(); let wait = false;
  const { instance, application } = setup((path) => { if (path !== 'community/status/') { if (wait && application.session.token() === 'a') return waiting.promise; return { data: [row(application.session.token() === 'a' ? ONE : TWO)] }; } });
  await instance.onShow(); wait = true; const old = instance.load(); await Promise.resolve(); await Promise.resolve();
  application.session.save({ token: 'b', user: { id: 'user-b' } }); await instance.load(); waiting.resolve({ data: [row()] }); await old;
  assert.equal(instance.data.records[0].id, TWO);
});
test('token change during a mutation clears personal draft and cannot show old-account success', async () => {
  const waiting = deferred(); const { instance, application } = setup((path, request) => request && request.method === 'POST' ? waiting.promise : undefined);
  await instance.onShow(); instance.inputBody(input('旧账号草稿')); const sending = instance.submit();
  application.session.save({ token: 'b', user: { id: 'user-b' } }); waiting.resolve({ data: row(TWO) }); await sending;
  assert.deepEqual(instance.data.records, []); assert.equal(instance.data.body, ''); assert.equal(instance.data.notice, '');
});
test('hide/unload clears private records and queued events or old response cannot update destroyed page', async () => {
  const waiting = deferred(); const { instance, calls } = setup(() => waiting.promise); const loading = instance.onShow(); instance.onHide(); instance.onUnload();
  instance.setData = () => { throw new Error('write after unload'); };
  await instance.submit(); await instance.load(); await instance.more(); instance.inputBody(input('late')); instance.remove(event(ONE)); instance.openReport(event()); instance.closeReport();
  waiting.resolve({ data: { enabled: true } }); await loading; assert.equal(calls.length, 1);
});
test('expired session clears current private data without clearing a newer token', async () => {
  let expired = false; const { instance, application } = setup((path) => { if (expired && path !== 'community/status/') throw Object.assign(new Error('过期'), { status: 401 }); });
  await instance.onShow(); expired = true; await instance.load(); assert.equal(application.session.token(), ''); assert.deepEqual(instance.data.records, []); assert.equal(instance.data.loggedIn, false);
});
test('deletion requires owner plus confirmation, cancels safely and ignores repeated callback', async () => {
  let deleted = false; const { instance, calls, modals } = setup((path, request) => { if (request && request.method === 'DELETE') { deleted = true; return { data: null }; } if (deleted && path !== 'community/status/') return { data: [] }; });
  await instance.onShow(); instance.remove(event(TWO)); assert.equal(modals.length, 0);
  instance.remove(event(ONE)); instance.remove(event(ONE)); assert.equal(modals.length, 1);
  await modals[0].success({ confirm: true }); await modals[0].success({ confirm: true });
  assert.equal(calls.filter((c) => c.request && c.request.method === 'DELETE').length, 1); assert.deepEqual(instance.data.records, []);
});
test('stale deletion confirmation after account switch, hide or refresh does not delete', async () => {
  for (const reason of ['account', 'hide', 'refresh']) {
    const { instance, application, modals, calls } = setup(); await instance.onShow(); instance.remove(event(ONE));
    if (reason === 'account') application.session.save({ token: 'b', user: { id: 'user-b' } });
    if (reason === 'hide') instance.onHide();
    if (reason === 'refresh') await instance.load();
    await modals[0].success({ confirm: true }); assert.equal(calls.filter((c) => c.request && c.request.method === 'DELETE').length, 0, reason);
  }
});
test('owner can remove old records in personal list after feature closes', async () => {
  const { instance, modals } = setup((path) => path === 'community/status/' ? { data: { enabled: false } } : undefined, { route: { mode: 'mine' } });
  await instance.onShow(); assert.equal(instance.data.records.length, 1); instance.remove(event(ONE)); assert.equal(modals.length, 1);
});
test('reports can target published others comments or current content only and report body stays private', async () => {
  const { instance, calls } = setup((path) => path === 'community/comments/' ? { data: [row(ONE, { is_owner: false, status: 'approved' }), row(TWO)] } : undefined);
  await instance.onShow(); instance.openReport(event(TWO)); assert.equal(instance.data.reportTarget, null);
  instance.openReport(event(ONE)); assert.deepEqual(instance.data.reportTarget, { kind: 'comment', target_id: ONE });
  instance.selectReason(input('2')); instance.inputReport(input('请核实隐私信息')); await instance.submitReport();
  const sent = calls.find((c) => c.path === 'community/reports/' && c.request && c.request.method === 'POST').request.data;
  assert.equal(sent.reason, 'privacy'); assert.equal(sent.kind, 'comment'); assert.equal(instance.data.reportTarget, null); assert.equal(instance.data.reportDetail, '');
});
test('failed report preserves reason and draft; closure is respected on API rejection', async () => {
  let closed = false; const { instance } = setup((path, request) => {
    if (path === 'community/reports/' && request && request.method === 'POST') throw Object.assign(new Error(closed ? '已关闭' : '离线'), { code: closed ? 'COMMUNITY_DISABLED' : 'NETWORK_ERROR' });
  });
  await instance.onShow(); instance.openReport(event()); instance.inputReport(input('举报草稿')); await instance.submitReport(); assert.equal(instance.data.reportDetail, '举报草稿'); assert.ok(instance.data.reportTarget);
  closed = true; await instance.submitReport(); assert.equal(instance.data.enabled, false); assert.equal(instance.data.reportTarget, null); assert.deepEqual(instance.data.records, []);
});
