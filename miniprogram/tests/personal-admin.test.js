const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { MemoryStore } = require('../../cloud-native/tests/memory-store');
const management = require('../../cloudfunctions/hyhqApi/lib/management');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-03T12:00:00Z';
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
async function fixture(handler) {
  const storage = new Map(), store = new MemoryStore(), calls = [], modals = [];
  const user = { id: uid(1), is_active: true, record_revision: 0 };
  await store.set('users', user.id, user);
  const serverConfig = { management: { enabled: true, adminUserIds: [user.id] } };
  const session = createSession({ getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) });
  session.save({ token: 'account-a', user });
  const application = { session, config: { transport: 'cloud-function' }, api: { request: async (path, options = {}) => {
    calls.push({ path, options, token: session.token() });
    if (handler) { const result = await handler(path, options, application); if (result !== undefined) return result; }
    if (path === 'management/maintenance/') return options.method === 'POST' ? { data: { scanned: 8, removed: 3, failed: 0 } }
      : { data: { policy: { original_hours: 24, recognition_thumbnail_days: 30, accounting_days: 90, max_batch_size: 20, automatic_schedule_enabled: false }, kinds: ['assets', 'sessions'], recent: [], running: false } };
    const url = new URL(path.replace(/^\/api\/v1\//, ''), 'https://local.invalid/');
    const result = await management.handle({ path: url.pathname.slice(1), method: options.method || 'GET', body: options.data, query: url.searchParams, user: (session.get() || {}).user, store, now, config: serverConfig });
    if (!result) throw new Error('unhandled ' + path); return result.data;
  } } };
  global.getApp = () => application; global.wx = { showModal: options => modals.push(options) };
  let definition; global.Page = value => { definition = value; };
  const file = require.resolve('../pages/personal-admin/index'); delete require.cache[file]; require(file);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = patch => { for (const [key, value] of Object.entries(patch)) { const bits = key.split('.'); let target = page.data; for (const bit of bits.slice(0, -1)) target = target[bit]; target[bits.at(-1)] = value; } };
  return { page, application, store, serverConfig, user, calls, modals };
}

test('administrator overview renders Chinese metric cards from actual native statistics', async () => {
  const app = await fixture(); await app.page.onShow();
  assert.equal(app.page.data.allowed, true); assert.equal(app.page.data.metricGroups.length, 4);
  assert.equal(app.page.data.metricGroups[0].items.find(row => row.label === '公开科普').value, 38);
  assert.match(app.page.data.countingNote, /不是供应商结算/); assert.match(app.page.data.asOf, /UTC\+8/);
  assert.equal('summary' in app.page.data, false);
});

test('management disabled, guest and non-cloud builds show no private data or list requests', async () => {
  for (const reason of ['disabled', 'guest', 'transport']) {
    const app = await fixture();
    if (reason === 'disabled') app.serverConfig.management.enabled = false;
    if (reason === 'guest') app.application.session.clear();
    if (reason === 'transport') app.application.config.transport = 'http';
    await app.page.onShow(); assert.equal(app.page.data.allowed, false); assert.deepEqual(app.page.data.rows, []); assert.equal(app.page.data.busy, false);
    assert.ok(app.page.data.error); assert.equal(app.calls.some(call => call.path === 'personal-admin/stats/'), false);
  }
});

test('withdrawn management permission clears previously loaded metrics, drafts and maintenance previews', async () => {
  const app = await fixture(); await app.page.onShow(); app.page.data.editor = { body: '私密编辑草稿' }; app.page.data.cleanup = { fingerprint: 'old' };
  app.serverConfig.management.enabled = false; await app.page.load();
  assert.equal(app.page.data.allowed, false); assert.equal(app.page.data.editor, null); assert.equal(app.page.data.cleanup, null); assert.deepEqual(app.page.data.metricGroups, []);
});

test('switching identity while status is pending never requests or displays the old administrator statistics', async () => {
  const pending = deferred();
  const app = await fixture(path => path === 'personal-admin/status/' ? pending.promise : undefined);
  const loading = app.page.onShow(); app.application.session.save({ token: 'account-b', user: { id: uid(2), is_active: true } });
  pending.resolve({ data: { enabled: true, revision: 0 } }); await loading;
  assert.equal(app.calls.length, 1); assert.equal(app.page.data.allowed, false); assert.equal(app.page.data.busy, false); assert.match(app.page.data.error, /登录状态/);
});

test('old-account late response cannot overwrite a newly loaded account or keep busy stuck after hide', async () => {
  const pending = deferred(); let held = true;
  const app = await fixture((path, _, application) => path === 'personal-admin/stats/' && application.session.token() === 'account-a' && held ? pending.promise : undefined);
  const old = app.page.onShow(); await new Promise(setImmediate); app.page.onHide();
  const userB = { ...app.user, id: uid(2) }; await app.store.set('users', userB.id, userB); app.serverConfig.management.adminUserIds.push(userB.id);
  app.application.session.save({ token: 'account-b', user: userB }); held = false; await app.page.onShow();
  const newMetrics = structuredClone(app.page.data.metricGroups);
  pending.resolve({ data: { users_active: 999999, public_catalog: {} } }); await old;
  assert.deepEqual(app.page.data.metricGroups, newMetrics); assert.equal(app.page.data.allowed, true); assert.equal(app.page.data.busy, false);
});

test('route editing sends description rather than unsupported summary and persists with the native handler', async () => {
  const app = await fixture(); await app.page.onShow(); await app.page.tab(event('tab', 'routes'));
  const id = app.page.data.rows[0].id; await app.page.edit(event('id', id));
  app.page.field({ currentTarget: { dataset: { field: 'summary' } }, detail: { value: '修改后的漫步路线说明' } });
  await app.page.save();
  const request = app.calls.find(call => call.options.method === 'PATCH');
  assert.equal(request.options.data.value.description, '修改后的漫步路线说明'); assert.equal('summary' in request.options.data.value, false);
  assert.equal((await app.store.get('catalog', 'routes_' + id)).value.description, '修改后的漫步路线说明');
  assert.equal(app.page.data.error, '');
});

test('concurrent administrator revision changes reject a stale save without overwriting its draft or retrying', async () => {
  const app = await fixture(); await app.page.onShow(); await app.page.tab(event('tab', 'contents'));
  await app.page.edit(event('id', app.page.data.rows[0].id)); app.page.data.editor.body = '保留我的未保存正文';
  await app.store.set('admin_config', 'catalog_revision', { id: 'catalog_revision', revision: 1 });
  await app.page.save(); assert.match(app.page.data.error, /管理内容已更新/); assert.equal(app.page.data.editor.body, '保留我的未保存正文');
  assert.equal(await app.store.count('catalog'), 0); assert.equal(app.calls.filter(call => call.options.method === 'PATCH').length, 1);
});

test('feedback list shows the actual body and publishes trimmed administrative replies through the server', async () => {
  const app = await fixture(); await app.store.set('feedback', uid(7), { id: uid(7), owner_id: uid(9), body: '路线入口不明显', status: 'pending', reply: '', created_at: now });
  await app.page.onShow(); await app.page.tab(event('tab', 'feedback'));
  assert.equal(app.page.data.rows[0].body, '路线入口不明显'); assert.equal(app.page.data.rows[0].title_label, '用户反馈');
  const replying = app.page.resolveFeedback(event('id', uid(7))); app.modals[0].success({ confirm: true, content: '  已调整入口  ' }); await replying;
  assert.equal(app.page.data.rows[0].reply, '已调整入口'); assert.equal(app.page.data.rows[0].status_label, '已处理');
});

test('duplicate and stale withdrawal confirmations cannot issue repeated or cross-account writes', async () => {
  const app = await fixture(); await app.page.onShow(); await app.page.tab(event('tab', 'contents')); await app.page.edit(event('id', app.page.data.rows[0].id));
  const first = app.page.withdraw(); const duplicate = app.page.withdraw(); assert.equal(app.modals.length, 1);
  app.page.onHide(); app.application.session.save({ token: 'account-b', user: { id: uid(2), is_active: true } });
  app.modals[0].success({ confirm: true }); await first; await duplicate;
  assert.equal(app.calls.some(call => call.options.method === 'DELETE'), false); assert.equal(app.page.data.editor, null);
});

test('maintenance uses bounded server contracts and only shows timer execution as verified from its response', async () => {
  const app = await fixture(); await app.page.onShow(); await app.page.tab(event('tab', 'maintenance'));
  assert.equal(app.page.data.maintenance.policy_cards[0].value, '24 小时'); assert.equal(app.page.data.maintenance.policy.automatic_schedule_enabled, false);
  app.page.maintenanceLimit({ detail: { value: '21' } }); await app.page.runMaintenance(); assert.equal(app.modals.length, 0);
  app.page.maintenanceLimit({ detail: { value: '10' } }); app.page.maintenanceKind({ detail: { value: 1 } });
  const running = app.page.runMaintenance(); app.modals[0].success({ confirm: true }); await running;
  const call = app.calls.find(row => row.path === 'management/maintenance/' && row.options.method === 'POST');
  assert.deepEqual(call.options.data, { kind: 'assets', limit: 10 }); assert.match(app.page.data.notice, /检查 8 条，清理 3 条，失败 0 条/);
});

test('retention editor enforces bounds and successful policy edits invalidate existing previews', async () => {
  const app = await fixture(); await app.page.onShow(); await app.page.tab(event('tab', 'maintenance'));
  app.page.data.retention.retain_days = '29'; await app.page.saveRetention(); assert.match(app.page.data.error, /30至3650/);
  app.page.data.retention.retain_days = '60'; app.page.data.retention.keep_successful = '2'; app.page.data.cleanup = { fingerprint: 'old' };
  await app.page.saveRetention(); assert.equal(app.page.data.retention.retain_days, 60); assert.equal(app.page.data.revision, 1); assert.equal(app.page.data.cleanup, null);
  assert.equal((await app.store.get('admin_config', 'simulation_retention')).keep_successful, 2);
});

test('hidden and unloaded pages clear all sensitive state and ignore late UI operations', async () => {
  const app = await fixture(); await app.page.onShow(); app.page.data.editor = { body: 'private' }; app.page.onUnload();
  assert.equal(app.page.data.editor, null); assert.deepEqual(app.page.data.metricGroups, []);
  const before = app.calls.length; app.page.setData = () => { throw new Error('write after unload'); };
  await app.page.load(); await app.page.save(); await app.page.more(); await app.page.runMaintenance(); await app.page.previewCleanup();
  assert.equal(app.calls.length, before);
});
