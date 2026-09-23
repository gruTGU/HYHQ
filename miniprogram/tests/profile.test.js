const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const user = (id = 'A', extra = {}) => ({ id, nickname: '昵称 ' + id, record_history: true, avatar_url: null, ...extra });
function fixture(api = {}, authenticated = true) {
  let definition;
  const storage = new Map();
  const session = createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) });
  if (authenticated) session.save({ token: 'A-token', user: user(), auth_mode: 'development' });
  const application = { session, api, config: { development: true }, globalData: {} };
  const modals = [], navigation = [], toasts = [], logins = [];
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, showModal: (options) => modals.push(options), showToast: (options) => toasts.push(options.title), navigateTo: (options) => navigation.push(options.url), login: (options) => logins.push(options) };
  global.Page = (value) => { definition = value; };
  const path = require.resolve('../pages/profile/index'); delete require.cache[path]; require(path);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  if (authenticated) { Object.assign(page.data, { loading: false, user: user(), nickname: user().nickname }); page._profileToken = 'A-token'; }
  return { page, application, modals, navigation, toasts, logins };
}
const event = (name, value) => ({ currentTarget: { dataset: { [name]: value } } });

test('a late me response cannot replace the new account user or start its avatar download', async () => {
  const pending = deferred(); let downloads = 0;
  const { page, application } = fixture({ request: () => pending.promise, download: async () => { downloads += 1; return 'private-A.jpg'; } });
  const loading = page.loadUser(); application.session.save({ token: 'B-token', user: user('B') });
  pending.resolve({ data: user('A', { avatar_url: '/private-a/' }) }); await loading;
  assert.equal(application.session.get().user.id, 'B'); assert.equal(page.data.user, null); assert.equal(downloads, 0);
});

test('a late profile PATCH cannot replace a renewed session or its displayed data', async () => {
  const pending = deferred(); const { page, application } = fixture({ request: () => pending.promise });
  const saving = page.update({ nickname: '旧请求改名' }); application.session.save({ token: 'B-token', user: user('B') });
  pending.resolve({ data: user('A', { nickname: '旧请求改名' }) }); await saving;
  assert.equal(application.session.get().user.id, 'B'); assert.equal(page.data.user, null); assert.equal(page.data.busy, false);
});

test('a failed privacy PATCH restores the last confirmed switch value and permits retry', async () => {
  let attempts = 0;
  const { page, application, toasts } = fixture({ request: async (path, options) => {
    assert.equal(path, 'me/'); assert.deepEqual(options.data, { record_history: false });
    if (++attempts === 1) throw new Error('网络暂不可用');
    return { data: user('A', { record_history: false }) };
  } });
  await page.privacyChange({ detail: { value: false } });
  assert.equal(page.data.user.record_history, true); assert.equal(application.session.get().user.record_history, true);
  assert.equal(page.data.busy, false); assert.match(page.data.error, /网络暂不可用/);
  await page.privacyChange({ detail: { value: false } });
  assert.equal(page.data.user.record_history, false); assert.equal(application.session.get().user.record_history, false); assert.ok(toasts.includes('已保存'));
});

test('hidden profile responses never update page state and showing it fetches a fresh user', async () => {
  const pending = deferred(); let meRequests = 0;
  const { page } = fixture({ request: async (path) => path === 'health/' ? { data: { dev_auth_enabled: true } } : (++meRequests === 1 ? pending.promise : { data: user('A', { nickname: '新资料' }) }) });
  const loading = page.loadUser(); page.onHide();
  const setData = page.setData; page.setData = () => { throw new Error('late hidden write'); };
  pending.resolve({ data: user('A', { nickname: '旧资料' }) }); await loading;
  page.setData = setData; await page.onShow(); assert.equal(page.data.user.nickname, '新资料');
});

test('unloading while me or a private avatar downloads prevents any subsequent UI update', async () => {
  for (const stage of ['me', 'avatar']) {
    const pending = deferred();
    const { page } = fixture({ request: async () => stage === 'me' ? pending.promise : { data: user('A', { avatar_url: '/private-a/' }) }, download: () => pending.promise });
    const loading = page.loadUser(); await Promise.resolve(); await Promise.resolve();
    page.onUnload(); page.setData = () => { throw new Error('write after unload'); };
    pending.resolve(stage === 'me' ? { data: user() } : 'private-A.jpg'); await loading;
  }
});

test('an avatar upload cannot PATCH after account change, hide or unload', async () => {
  for (const change of ['account', 'hide', 'unload']) {
    const pending = deferred(); let patches = 0;
    const { page, application } = fixture({ upload: () => pending.promise, request: async () => { patches += 1; return { data: user() }; } });
    const saving = page.chooseAvatar({ detail: { avatarUrl: 'chosen.jpg' } });
    if (change === 'account') application.session.save({ token: 'B-token', user: user('B') });
    if (change === 'hide') page.onHide();
    if (change === 'unload') { page.onUnload(); page.setData = () => { throw new Error('write after unload'); }; }
    pending.resolve({ id: 'uploaded-A' }); await saving; assert.equal(patches, 0);
    if (change === 'account') assert.equal(application.session.get().user.id, 'B');
  }
});

test('a late private avatar download cannot appear under a different account', async () => {
  const pending = deferred();
  const { page, application } = fixture({ request: async () => ({ data: user('A', { avatar_url: '/private-a/' }) }), download: () => pending.promise });
  const loading = page.loadUser(); await Promise.resolve(); await Promise.resolve();
  application.session.save({ token: 'B-token', user: user('B') }); pending.resolve('private-A.jpg'); await loading;
  assert.equal(page.data.avatar, ''); assert.equal(page.data.user, null); assert.equal(application.session.get().user.id, 'B');
});

test('avatar download failure preserves the account and offers a visible retry notice', async () => {
  const { page, application } = fixture({ request: async () => ({ data: user('A', { avatar_url: '/private-a/' }) }), download: async () => { throw new Error('expired'); } });
  await page.loadUser(); assert.equal(page.data.user.id, 'A'); assert.equal(application.session.get().user.id, 'A'); assert.match(page.data.avatarNotice, /刷新/);
});

test('old login API responses cannot overwrite another signed-in account', async () => {
  const pending = deferred(); let calls = 0;
  const { page, application } = fixture({ request: () => { calls += 1; return pending.promise; } }, false);
  Object.assign(page.data, { devAvailable: true });
  const loggingIn = page.login(event('mode', 'dev'));
  application.session.save({ token: 'B-token', user: user('B') });
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.equal(application.session.token(), 'B-token'); assert.equal(calls, 1); assert.equal(page.data.user, null);
});

test('a delayed native wx.login callback cannot start an API login after hide or unload', async () => {
  for (const change of ['hide', 'unload']) {
    let calls = 0;
    const { page, logins } = fixture({ request: async () => { calls += 1; } }, false);
    const loggingIn = page.login(event('mode', 'wechat'));
    if (change === 'hide') page.onHide(); else page.onUnload();
    logins[0].success({ code: 'only-used-if-active' }); await loggingIn; assert.equal(calls, 0);
  }
});

test('hidden login responses never save a session or issue a follow-up me request', async () => {
  const pending = deferred(); let calls = 0;
  const { page, application } = fixture({ request: () => { calls += 1; return pending.promise; } }, false);
  Object.assign(page.data, { devAvailable: true });
  const loggingIn = page.login(event('mode', 'dev')); page.onHide();
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.equal(application.session.token(), ''); assert.equal(calls, 1);
});

test('successful development login validates me and duplicate taps do not send more login requests', async () => {
  const pending = deferred(); const calls = [];
  const { page, application } = fixture({ request: async (path) => { calls.push(path); return path === 'auth/dev/' ? pending.promise : { data: user() }; } }, false);
  Object.assign(page.data, { devAvailable: true });
  const loggingIn = page.login(event('mode', 'dev')); await page.login(event('mode', 'dev'));
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.deepEqual(calls, ['auth/dev/', 'me/']); assert.equal(page.data.user.id, 'A'); assert.equal(application.session.get().auth_mode, 'development');
});

test('login uses the native WeChat action without an extra agreement gate or modal', async () => {
  const calls = [];
  const { page, application, logins, modals, navigation } = fixture({ request: async (path) => {
    calls.push(path);
    return { data: path === 'auth/wechat/' ? { token: 'native-token', user: user() } : user() };
  } }, false);
  assert.equal(Object.hasOwn(page.data, 'agreed'), false);
  page.legal(event('kind', 'terms')); page.legal(event('kind', 'privacy'));
  assert.deepEqual(navigation, ['/pages/legal/index?kind=terms', '/pages/legal/index?kind=privacy']);
  const loggingIn = page.login(event('mode', 'wechat'));
  assert.equal(logins.length, 1);
  assert.equal(calls.length, 0);
  logins[0].success({ code: 'native-action-code' });
  await loggingIn;
  assert.deepEqual(calls, ['auth/wechat/', 'me/']);
  assert.equal(application.session.token(), 'native-token');
  assert.equal(modals.length, 0);
});

test('logout and deletion confirmations stay bound to their original account', async () => {
  for (const method of ['logout', 'deleteAccount']) {
    let mutations = 0;
    const { page, application, modals } = fixture({ request: async () => { mutations += 1; return { data: null }; } });
    page[method](); application.session.save({ token: 'B-token', user: user('B') });
    await modals[0].success({ confirm: true }); assert.equal(mutations, 0); assert.equal(application.session.token(), 'B-token');
  }
});

test('logout and deletion confirmations from hidden or unloaded pages never send requests', async () => {
  for (const method of ['logout', 'deleteAccount']) {
    for (const change of ['hide', 'unload']) {
      let mutations = 0;
      const { page, modals } = fixture({ request: async () => { mutations += 1; } });
      page[method](); if (change === 'hide') page.onHide(); else page.onUnload();
      page.setData = () => { throw new Error('write after hide/unload'); };
      await modals[0].success({ confirm: true }); assert.equal(mutations, 0);
    }
  }
});

test('repeated deletion taps and callbacks make one DELETE and clear only the matching session', async () => {
  const pending = deferred(); const calls = [];
  const { page, application, modals } = fixture({ request: async (path, options) => { calls.push([path, options.method]); return pending.promise; } });
  page.deleteAccount(); page.deleteAccount(); assert.equal(modals.length, 1);
  const deleting = modals[0].success({ confirm: true }); await modals[0].success({ confirm: true });
  pending.resolve({ data: null }); await deleting;
  assert.deepEqual(calls, [['me/', 'DELETE']]); assert.equal(application.session.token(), ''); assert.equal(page.data.user, null); assert.equal(page.data.busy, false);
});

test('an old successful logout response never clears a newly signed-in session', async () => {
  const pending = deferred();
  const { page, application, modals } = fixture({ request: () => pending.promise });
  page.logout(); const loggingOut = modals[0].success({ confirm: true });
  application.session.save({ token: 'B-token', user: user('B') }); pending.resolve({ data: null }); await loggingOut;
  assert.equal(application.session.token(), 'B-token'); assert.equal(page.data.user, null);
});

test('a logout accepted before hiding still clears its original local session without updating the hidden page', async () => {
  const pending = deferred();
  const { page, application, modals } = fixture({ request: () => pending.promise });
  page.logout(); const loggingOut = modals[0].success({ confirm: true }); page.onHide();
  page.setData = () => { throw new Error('hidden update'); };
  pending.resolve({ data: null }); await loggingOut; assert.equal(application.session.token(), '');
});

test('failed and canceled account removal preserve the session and can be retried', async () => {
  let requests = 0;
  const { page, application, modals } = fixture({ request: async () => { requests += 1; throw new Error('网络中断'); } });
  page.deleteAccount(); await modals[0].success({ confirm: false }); assert.equal(requests, 0);
  page.deleteAccount(); await modals[1].success({ confirm: true });
  assert.equal(requests, 1); assert.equal(application.session.token(), 'A-token'); assert.equal(page.data.user.id, 'A'); assert.equal(page.data.busy, false);
  page.deleteAccount(); assert.equal(modals.length, 3);
});

test('returning during an accepted privacy change waits before fetching the latest confirmed setting', async () => {
  const pending = deferred(); let historyEnabled = true; const calls = [];
  const { page } = fixture({ request: async (path, options) => {
    calls.push([path, options && options.method]);
    if (options && options.method === 'PATCH') { await pending.promise; historyEnabled = false; return { data: user('A', { record_history: false }) }; }
    return { data: path === 'health/' ? { dev_auth_enabled: true } : user('A', { record_history: historyEnabled }) };
  } });
  const saving = page.privacyChange({ detail: { value: false } }); page.onHide(); const showing = page.onShow();
  assert.equal(calls.length, 1); pending.resolve(); await saving; await showing;
  assert.equal(page.data.user.record_history, false); assert.equal(calls.length, 3);
});

test('nickname input validation matches the backend limit of 32 Unicode characters', async () => {
  let calls = 0;
  const { page, toasts } = fixture({ request: async (path, options) => { calls += 1; return { data: user('A', { nickname: options.data.nickname }) }; } });
  page.data.nickname = ' '; await page.saveProfile(); page.data.nickname = '名'.repeat(33); await page.saveProfile();
  assert.equal(calls, 0); assert.ok(toasts.some((text) => text.includes('32')));
  page.data.nickname = '名'.repeat(32); await page.saveProfile(); assert.equal(calls, 1);
});

test('feedback and legal pages are available to guests while private records cannot be opened', () => {
  const { page, navigation } = fixture({}, false);
  page.feedback(); page.legal(event('kind', 'privacy')); page.records(event('kind', 'favorites'));
  assert.deepEqual(navigation, ['/pages/feedback/index', '/pages/legal/index?kind=privacy']);
  page.onHide(); page.feedback(); page.legal(event('kind', 'terms')); assert.equal(navigation.length, 2);
});

test('an expired session during PATCH clears displayed private data without leaving the form busy', async () => {
  const { page, application } = fixture();
  application.api.request = async () => { application.session.clear(); throw Object.assign(new Error('登录过期'), { status: 401 }); };
  await page.update({ nickname: '更新' }); assert.equal(page.data.user, null); assert.equal(page.data.avatar, ''); assert.equal(page.data.busy, false);
});

test('pull-to-refresh and repeated actions cannot bypass a privacy change still pending after returning', async () => {
  const pending = deferred(); let historyEnabled = true; const calls = [];
  const { page } = fixture({ request: async (path, options) => {
    calls.push([path, options && options.method]);
    if (options && options.method === 'PATCH') { await pending.promise; historyEnabled = false; return { data: user('A', { record_history: false }) }; }
    return { data: path === 'health/' ? { dev_auth_enabled: true } : user('A', { record_history: historyEnabled }) };
  } });
  const saving = page.privacyChange({ detail: { value: false } }); page.onHide(); const showing = page.onShow();
  await page.onPullDownRefresh(); await page.load(); await page.privacyChange({ detail: { value: true } });
  Object.assign(page.data, { devAvailable: true }); await page.login(event('mode', 'dev'));
  assert.deepEqual(calls, [['me/', 'PATCH']]); assert.equal(page.data.loading, true); assert.equal(page.data.user, null);
  pending.resolve(); await saving; await showing;
  assert.deepEqual(calls, [['me/', 'PATCH'], ['health/', undefined], ['me/', undefined]]);
  assert.equal(page.data.user.record_history, false); assert.equal(page.data.loading, false);
});

test('profile editor opens for the current account, resets abandoned nickname edits, and clears on hide', () => {
  const { page, application } = fixture();
  page.toggleProfileEditor(); assert.equal(page.data.editingProfile, true);
  page.nicknameInput({ detail: { value: '未保存昵称' } }); page.toggleProfileEditor();
  assert.equal(page.data.editingProfile, false); assert.equal(page.data.nickname, '昵称 A');
  page.toggleProfileEditor(); page.onHide(); assert.equal(page.data.editingProfile, false);
  page._visible = true; page.data.user = user(); page._profileToken = 'A-token';
  application.session.save({ token: 'B-token', user: user('B') });
  page.toggleProfileEditor(); assert.equal(page.data.user, null); assert.equal(page.data.editingProfile, false);
});
