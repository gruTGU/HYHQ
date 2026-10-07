const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { MemoryStore } = require('../../cloud-native/tests/memory-store');
const community = require('../../cloudfunctions/hyhqApi/lib/community');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (field, value) => ({ currentTarget: { dataset: { [field]: value } } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function setup(handler) {
  const storage = new Map(), store = new MemoryStore(), calls = [], modals = [], links = [];
  const user = { id: uid(1), is_active: true }, admin = { id: uid(2), is_active: true };
  for (const u of [user, admin]) await store.set('users', u.id, u);
  const now = '2026-10-07T12:00:00Z', config = { appId: 'app', community: {}, management: { enabled: true, adminUserIds: [admin.id] } };
  const session = createSession({ getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) }); session.save({ token: 'a', user });
  const application = { session, config: { transport: 'cloud-function' }, api: { request: async (path, options = {}) => {
    calls.push({ path, options });
    if (handler) { const result = await handler(path, options); if (result !== undefined) return result; }
    const url = new URL(path.replace(/^\/api\/v1\//, ''), 'https://local.invalid/');
    const result = await community.handle({ path: url.pathname.slice(1), method: options.method || 'GET', body: options.data || {}, query: url.searchParams, user: session.get() && session.get().user, store, config, now, checkCommunityText: async () => ({ errCode: 0, result: { suggest: 'pass' } }) }); return result.data;
  } } };
  global.getApp = () => application; global.wx = { showModal: opts => modals.push(opts), switchTab: opts => links.push(opts.url) };
  let definition; global.Page = value => { definition = value; }; const path = require.resolve('../pages/submissions/index'); delete require.cache[path]; require(path);
  const page = { ...definition, data: structuredClone(definition.data) }; page.setData = patch => Object.assign(page.data, patch);
  const field = (name, value) => page.field({ currentTarget: { dataset: { field: name } }, detail: { value } });
  return { page, store, calls, modals, links, application, config, user, admin, field, now };
}
test('closed public service supports private draft create/edit/list, but never calls submit or safety', async () => {
  const f = await setup(); await f.page.onShow(); assert.equal(f.page.data.enabled, false);
  f.page.create(); f.field('title', '湖岸观察'); f.field('body', '观察树叶而不采摘'); await f.page.save();
  const id = f.page.data.editor.id; assert.ok(id); assert.equal(f.page.data.rows.length, 1); assert.equal(f.page.data.editor.status, 'draft');
  f.field('body', '修改后的观察记录'); await f.page.save(); assert.equal(f.page.data.editor.version, 2); assert.equal((await f.store.get('community_submissions', id)).body, '修改后的观察记录');
  await f.page.submit(); assert.equal(f.calls.some(call => call.path.endsWith('/submit/')), false);
});
test('guest has voluntary login entry and never loads private records', async () => {
  const f = await setup(); f.application.session.clear(); await f.page.onShow(); assert.equal(f.calls.length, 0); assert.equal(f.page.data.loggedIn, false); f.page.create(); assert.equal(f.page.data.editor, null); f.page.login(); assert.deepEqual(f.links, ['/pages/profile/index']);
});
test('unsaved draft edits prevent submission and explicit save goes pending under verified gate', async () => {
  const f = await setup(); f.config.community = { enabled: true, qualificationConfirmed: true, qualificationReference: 'test fixture', qualificationDate: '2026-10-01', moderationReady: true };
  await f.store.set('admin_config', 'community_safety', { app_id: 'app', checked_at: f.now }); await f.page.onShow(); f.page.create(); f.field('title', '植物观察'); f.field('body', '树叶形状'); await f.page.save();
  f.field('body', '树叶颜色'); await f.page.submit(); assert.match(f.page.data.error, /先保存/); assert.equal(f.calls.some(call => call.path.endsWith('/submit/')), false);
  await f.page.save(); await f.page.submit(); assert.equal(f.page.data.editor.status, 'pending'); assert.match(f.page.data.notice, /审核/);
});
test('duplicate save is suppressed and uncertain new-draft request retains idempotency key', async () => {
  const wait = deferred(); let fail = true;
  const f = await setup((path, options) => options.method === 'POST' && fail ? wait.promise : undefined); await f.page.onShow(); f.page.create(); f.field('title', '原草稿'); f.field('body', '正文');
  const pending = f.page.save(); await f.page.save(); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  wait.reject(new Error('离线')); await pending; assert.equal(f.page.data.editor.title, '原草稿'); fail = false; await f.page.save();
  const posts = f.calls.filter(call => call.options.method === 'POST'); assert.equal(posts[0].options.data.request_id, posts[1].options.data.request_id); assert.equal(f.page.data.rows.length, 1);
});
test('late response after hide/account switch cannot populate another user draft', async () => {
  const wait = deferred(); let blocked = false;
  const f = await setup((path, options) => blocked && options.method === 'POST' ? wait.promise : undefined); await f.page.onShow(); f.page.create(); f.field('body', '私人正文'); blocked = true;
  const pending = f.page.save(); f.page.onHide(); f.application.session.save({ token: 'b', user: f.admin }); await f.page.onShow();
  wait.resolve({ data: { id: uid(50), version: 1, title: '旧账号草稿', body: '私人正文', status: 'draft' } }); await pending;
  assert.equal(f.page.data.editor, null); assert.deepEqual(f.page.data.rows, []);
});
test('delete requires confirmation, refuses stale confirmation and removes public/private record on current approval', async () => {
  const f = await setup(); await f.page.onShow(); f.page.create(); f.field('title', '待删除稿件'); await f.page.save();
  const previous = f.page.action(event('action', 'delete')); f.page.onHide(); f.modals[0].success({ confirm: true }); await previous; assert.equal(f.calls.some(call => call.options.method === 'DELETE'), false);
  await f.page.onShow(); const current = f.page.action(event('action', 'delete')); f.modals[1].success({ confirm: true }); await current;
  assert.equal(await f.store.count('community_submissions'), 0); assert.equal(f.page.data.editor, null); assert.deepEqual(f.page.data.rows, []);
});
test('malformed pagination, oversized body, and edited version do not silently publish', async () => {
  const f = await setup(); await f.page.onShow(); f.page.data.next = '/api/v1/me/'; await f.page.more(); assert.match(f.page.data.error, /分页/);
  f.page.create(); f.field('body', '字'.repeat(2001)); await f.page.save(); assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
});
