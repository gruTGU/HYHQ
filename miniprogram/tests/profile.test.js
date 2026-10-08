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

test('normal navigation keeps the verified account visible during departure without retaining permission to act', async () => {
  const pending = deferred(); const calls = [];
  const { page, navigation } = fixture({ request: async (path) => {
    calls.push(path); return path === 'me/' ? pending.promise : { data: { dev_auth_enabled: true } };
  } });
  page.data.avatar = 'confirmed-avatar.jpg';
  page.records(event('kind', 'favorites')); page.onHide();
  assert.deepEqual(navigation, ['/pages/records/index?kind=favorites']);
  assert.equal(page.data.user.id, 'A'); assert.equal(page.data.loading, false);
  assert.equal(page.data.avatar, 'confirmed-avatar.jpg');
  assert.equal(page._profileToken, '');
  page.records(event('kind', 'histories')); await page.update({ nickname: 'hidden edit' });
  assert.equal(navigation.length, 1); assert.deepEqual(calls, []);
  const returning = page.onShow();
  assert.equal(page.data.loading, true); assert.equal(page.data.user, null);
  pending.resolve({ data: user('A', { nickname: '重新确认的昵称' }) }); await returning;
  assert.equal(page.data.user.nickname, '重新确认的昵称');
  assert.equal(page._profileToken, 'A-token'); assert.deepEqual(calls, ['health/', 'me/']);
});

test('logout while away clears the departure snapshot before waiting for a health response', async () => {
  const health = deferred(), calls = [];
  const { page, application } = fixture({ request: path => { calls.push(path); return health.promise; } });
  page.onHide(); application.session.clear();
  const returning = page.onShow();
  assert.equal(page.data.user, null); assert.equal(page.data.avatar, ''); assert.equal(page.data.loading, true);
  assert.deepEqual(calls, ['health/']);
  health.resolve({ data: { dev_auth_enabled: true } }); await returning;
  assert.equal(page.data.user, null); assert.equal(page.data.loading, false);
});

test('account changes and expiry never preserve an old account as a departure snapshot', () => {
  for (const change of ['account', 'expiry']) {
    const { page, application } = fixture();
    if (change === 'account') application.session.save({ token: 'B-token', user: user('B') });
    else application.session.save({ ...application.session.get(), expires_at: new Date(Date.now() - 1000).toISOString() });
    page.onHide();
    assert.equal(page.data.user, null); assert.equal(page.data.loading, true);
    assert.equal(page.data.avatar, ''); assert.equal(page._profileToken, '');
  }
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
  Object.assign(page.data, { devAvailable: true, agreed: true });
  const loggingIn = page.login(event('mode', 'dev'));
  application.session.save({ token: 'B-token', user: user('B') });
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.equal(application.session.token(), 'B-token'); assert.equal(calls, 1); assert.equal(page.data.user, null);
});

test('a delayed native wx.login callback cannot start an API login after hide or unload', async () => {
  for (const change of ['hide', 'unload']) {
    let calls = 0;
    const { page, logins } = fixture({ request: async () => { calls += 1; } }, false);
    page.data.agreed = true;
    const loggingIn = page.login(event('mode', 'wechat'));
    if (change === 'hide') page.onHide(); else page.onUnload();
    logins[0].success({ code: 'only-used-if-active' }); await loggingIn; assert.equal(calls, 0);
  }
});

test('hidden login responses never save a session or issue a follow-up me request', async () => {
  const pending = deferred(); let calls = 0;
  const { page, application } = fixture({ request: () => { calls += 1; return pending.promise; } }, false);
  Object.assign(page.data, { devAvailable: true, agreed: true });
  const loggingIn = page.login(event('mode', 'dev')); page.onHide();
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.equal(application.session.token(), ''); assert.equal(calls, 1);
});

test('successful development login validates me and duplicate taps do not send more login requests', async () => {
  const pending = deferred(); const calls = [];
  const { page, application } = fixture({ request: async (path) => { calls.push(path); return path === 'auth/dev/' ? pending.promise : { data: user() }; } }, false);
  Object.assign(page.data, { devAvailable: true, agreed: true });
  const loggingIn = page.login(event('mode', 'dev')); await page.login(event('mode', 'dev'));
  pending.resolve({ data: { token: 'A-token', user: user() } }); await loggingIn;
  assert.deepEqual(calls, ['auth/dev/', 'me/']); assert.equal(page.data.user.id, 'A'); assert.equal(application.session.get().auth_mode, 'development');
});

test('login requires an explicit checkbox while both documents remain readable without agreeing', async () => {
  const calls = [];
  const { page, application, logins, modals, navigation } = fixture({ request: async (path) => {
    calls.push(path);
    return { data: path === 'auth/wechat/' ? { token: 'native-token', user: user() } : user() };
  } }, false);
  assert.equal(page.data.agreed, false);
  await page.login(event('mode', 'wechat'));
  assert.equal(logins.length, 0);
  assert.equal(calls.length, 0);
  page.legal(event('kind', 'terms')); page.legal(event('kind', 'privacy'));
  assert.deepEqual(navigation, ['/pages/legal/index?kind=terms', '/pages/legal/index?kind=privacy']);
  page.agreementChange({ detail: { value: ['agreed'] } });
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
  await page.saveProfile({ detail: { value: { nickname: ' ' } } }); await page.saveProfile({ detail: { value: { nickname: '名'.repeat(33) } } });
  assert.equal(calls, 0); assert.ok(toasts.some((text) => text.includes('32')));
  await page.saveProfile({ detail: { value: { nickname: '名'.repeat(32) } } }); assert.equal(calls, 1);
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
  Object.assign(page.data, { devAvailable: true, agreed: true }); await page.login(event('mode', 'dev'));
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


test('native nickname form value wins over stale bindinput and rejected nicknames never PATCH', async () => {
  const calls = [];
  const { page } = fixture({ request: async (path, options) => { calls.push(options.data); return { data: user('A', { nickname: options.data.nickname }) }; } });
  page.data.nickname = '输入事件仍是旧值';
  await page.saveProfile({ detail: { value: { nickname: ' 微信快捷昵称 ' } } });
  assert.deepEqual(calls, [{ nickname: '微信快捷昵称' }]);
  page.nicknameReview({ detail: { pass: false } });
  await page.saveProfile({ detail: { value: { nickname: '未通过昵称' } } });
  assert.equal(calls.length, 1); assert.match(page.data.nicknameNotice, /未通过/);
  page.nicknameInput({ detail: { value: '修改后的昵称' } });
  await page.saveProfile({ detail: { value: { nickname: '修改后的昵称' } } });
  assert.equal(calls.length, 2);
});

test('failed nickname save retains the native draft and can retry without old account data', async () => {
  let attempts = 0;
  const { page } = fixture({ request: async (path, options) => {
    if (++attempts === 1) throw new Error('网络中断');
    return { data: user('A', { nickname: options.data.nickname }) };
  } });
  const form = { detail: { value: { nickname: '我的新昵称' } } };
  await page.saveProfile(form);
  assert.equal(page.data.nickname, '我的新昵称'); assert.equal(page.data.user.nickname, '昵称 A'); assert.equal(page.data.busy, false);
  await page.saveProfile(form); assert.equal(page.data.user.nickname, '我的新昵称');
});

test('native avatar success displays the confirmed local selection without a redundant cloud download', async () => {
  let downloads = 0, uploads = 0;
  const { page } = fixture({ upload: async (path, purpose) => { uploads++; assert.equal(purpose, 'avatar'); return { id: 'asset-new' }; }, request: async (path, options) => {
    assert.deepEqual(options.data, { avatar_asset_id: 'asset-new' });
    return { data: user('A', { avatar_url: '/api/v1/uploads/new/content/?variant=thumbnail' }) };
  }, download: async () => { downloads++; return 'cloud-copy.jpg'; } });
  await page.chooseAvatar({ detail: { avatarUrl: 'chosen-avatar.jpg' } });
  assert.equal(page.data.avatar, 'chosen-avatar.jpg'); assert.equal(uploads, 1); assert.equal(downloads, 0);
});

test('failed avatar upload keeps the previous image and supports a deliberate retry', async () => {
  let uploads = 0, patches = 0;
  const { page } = fixture({ upload: async () => { if (++uploads === 1) throw new Error('上传中断'); return { id: 'new' }; }, request: async () => { patches++; return { data: user('A', { avatar_url: '/new/' }) }; } });
  page.data.avatar = 'previous.jpg';
  await page.chooseAvatar({ detail: { avatarUrl: 'new.jpg' } });
  assert.equal(page.data.avatar, 'previous.jpg'); assert.equal(patches, 0); assert.equal(page.data.busy, false);
  await page.chooseAvatar({ detail: { avatarUrl: 'new.jpg' } });
  assert.equal(page.data.avatar, 'new.jpg'); assert.equal(patches, 1);
});

test('profile identity and avatar do not wait for health or administrator status requests', async () => {
  const health = deferred(), access = deferred(); const calls = [];
  const { page, application } = fixture({ request: async (path) => { calls.push(path); if (path === 'health/') return health.promise; if (path === 'personal-admin/status/') return access.promise; return { data: user('A', { avatar_url: '/avatar/' }) }; }, download: async () => 'private-avatar.jpg' });
  application.config.transport = 'cloud-function';
  const loading = page.load();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(calls.slice(0, 2), ['health/', 'me/']);
  assert.equal(page.data.user.id, 'A'); assert.equal(page.data.loading, false); assert.equal(page.data.avatar, 'private-avatar.jpg');
  access.resolve({ data: { enabled: true } }); health.reject(new Error('health unavailable'));
  await loading; assert.equal(page.data.user.id, 'A'); assert.equal(page.data.error, ''); assert.equal(page.data.canManage, true);
});

test('cloud login carries explicit agreement version and logout clears the checkbox', async () => {
  let submitted;
  const { page, application, logins, modals } = fixture({ request: async (path, options) => {
    if (path === 'auth/wechat/') { submitted = options.data; return { data: { token: 'cloud-token', user: user() } }; }
    if (path === 'personal-admin/status/') return { data: { enabled: false } };
    return { data: path === 'me/' ? user() : null };
  } }, false);
  application.config.transport = 'cloud-function'; page.agreementChange({ detail: { value: ['agreed'] } });
  const loggingIn = page.login(event('mode', 'wechat')); logins[0].success({ code: 'code' }); await loggingIn;
  assert.deepEqual(submitted.agreement, { accepted: true, version: '2026-10-07' });
  page.logout(); await modals[0].success({ confirm: true }); assert.equal(page.data.agreed, false);
});


test('retired AI history events never navigate or request for signed-in users or guests', () => {
  for (const authenticated of [true, false]) {
    const calls = [];
    const { page, navigation } = fixture({ request: (...args) => { calls.push(args); throw new Error('retired feature requested data'); } }, authenticated);
    page.aiHistory(); page.onHide(); page.aiHistory();
    assert.deepEqual(navigation, []); assert.deepEqual(calls, []);
  }
});
