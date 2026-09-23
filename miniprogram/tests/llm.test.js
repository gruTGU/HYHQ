const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');
const { requestId, readPage, sessionView, entryUrl } = require('../lib/llm');
const quota = { date: '2026-09-20', limit: 5, used: 1, reserved: 0, remaining: 4, reset_at: '2026-09-20T16:00:00Z' };
const session = (id = 's1', extra = {}) => ({ id, kind: 'recognition', title: '花卉结果解读', context_summary: '候选为雏菊类，仅供参考。', recognition_job_id: 'j1', assessment_job_id: null, include_image: false, image_available: false, created_at: '2026-09-20T00:00:00Z', expires_at: '2026-10-20T00:00:00Z', ...extra });
const turn = (id = 't1', extra = {}) => ({ id, session_id: 's1', question: '如何核对？', answer: '观察其他特征。', status: 'succeeded', used_image: false, message: '', error_code: '', created_at: '2026-09-20T01:00:00Z', finished_at: '2026-09-20T01:00:03Z', model: 'test-model', ...extra });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const nativeSet = global.setTimeout, nativeClear = global.clearTimeout;
test.after(() => { global.setTimeout = nativeSet; global.clearTimeout = nativeClear; });
function fixture(handler, options = { sessionId: 's1' }, guest = false, pageName = 'llm') {
  const storage = new Map(), calls = [], modals = [], timers = [], navigation = [];
  const auth = createSession({ getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) });
  if (!guest) auth.save({ token: 'A', user: { id: 'A' } });
  const application = { session: auth, globalData: {}, api: { request: async (path, requestOptions) => {
    calls.push({ path, options: requestOptions });
    if (handler) { const result = await handler(path, requestOptions); if (result !== undefined) return result; }
    if (path === 'llm/status/') return { data: { enabled: true, consent_version: 'deepseek-v1', daily_limit: 5, model: 'deepseek-flash', notice: '测试服务', quota: guest ? null : quota } };
    if (path === 'regions/') return { data: [{ id: 'r1', name: '示范区域' }, { id: 'r2', name: '另一区域' }] };
    if (path === 'water-bodies/') return { data: [{ id: 'w1', name: '示范湖泊', region: 'r2' }] };
    if (/^(places|contents|routes)\//.test(path)) return { data: { id: path.split('/')[1], title: '当前公开资料', region: 'r1', body: '由服务端读取的正文', description: '摘要' } };
    if (path === 'recognition-jobs/j1/') return { data: { id: 'j1', status: 'succeeded', result: { decision: 'recognized', candidates: [{ name: '雏菊类', score: 0.8 }], threshold: 0 } } };
    if (path === 'assessment-jobs/a1/') return { data: { id: 'a1', status: 'succeeded', detections: [] } };
    if (path === 'llm/sessions/' && requestOptions && requestOptions.method === 'POST') { const d = requestOptions.data; return { data: session('s1', d.scope === 'recognition' ? { include_image: d.include_image } : { kind: d.scope, ...d }) }; }
    if (path === 'llm/sessions/') return { data: [session()] };
    if (path === 'llm/sessions/s1/turns/' && requestOptions && requestOptions.method === 'POST') return { data: turn('new', { question: requestOptions.data.question }) };
    if (path === 'llm/sessions/s1/turns/') return { data: [] };
    if (path.startsWith('llm/turns/')) return { data: turn(path.split('/')[2]) };
    return { data: session() };
  } } };
  global.getApp = () => application;
  global.wx = { stopPullDownRefresh() {}, showModal: (modal) => modals.push(modal), switchTab: ({ url }) => navigation.push(url), navigateTo: ({ url }) => navigation.push(url) };
  global.setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  let definition; global.Page = (value) => { definition = value; };
  const path = require.resolve('../pages/' + pageName + '/index'); delete require.cache[path]; require(path);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } }; page.onLoad(options);
  return { page, application, calls, modals, timers, navigation };
}
const change = (value) => ({ detail: { value } });
const idEvent = (id) => ({ currentTarget: { dataset: { id } } });
const flush = async () => { for (let count = 0; count < 8; count += 1) await Promise.resolve(); };

test('request identifiers remain valid UUIDs without exposing local quota UI state', () => {
  assert.match(requestId(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('guest reads service notice without fetching private source, sessions or sending a question', async () => {
  const { page, calls, navigation } = fixture(undefined, { kind: 'recognition', jobId: 'j1' }, true);
  await page.onShow(); assert.equal(page.data.loggedIn, false); assert.deepEqual(calls.map((item) => item.path), ['llm/status/']);
  await page.send(); page.createSession(); page.login(); assert.equal(calls.length, 1); assert.deepEqual(navigation, ['/pages/profile/index']);
});
test('unbound chat links fail and disabled service retains an explicit status without creating a session', async () => {
  const invalid = fixture(undefined, {}); await invalid.page.onShow(); assert.match(invalid.page.data.error, /识别结果/); assert.equal(invalid.calls.length, 0);
  const { page, calls, modals } = fixture(async (path) => path === 'llm/status/' ? { data: { enabled: false, notice: '密钥尚未配置', quota: null } } : undefined, { kind: 'recognition', jobId: 'j1' });
  await page.onShow(); await page.createSession();
  assert.equal(page.data.status.enabled, false); assert.equal(page.data.status.notice, '密钥尚未配置'); assert.equal(modals.length, 0); assert.equal(calls.some((item) => item.options && item.options.method), false);
});
test('source entry defaults to no image, creates only on tap, and needs a separate first send', async () => {
  const { page, calls, modals } = fixture(undefined, { kind: 'recognition', jobId: 'j1' }); await page.onShow();
  assert.equal(page.data.includeImage, false); assert.ok(page.data.source.result_view); assert.equal(page.data.turns.length, 0);
  assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
  await page.createSession();
  const posts = calls.filter((item) => item.options && item.options.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].options.data, { scope: 'recognition', recognition_job_id: 'j1', include_image: false });
  assert.equal(modals.length, 0); assert.equal(page.data.session.id, 's1'); assert.equal(page.data.question, ''); assert.equal(page.data.turns.length, 0);
});
test('explicit image preference and double taps create one session without a checkbox or modal', async () => {
  const posted = deferred();
  const { page, calls, modals } = fixture(async (path, options) => path === 'llm/sessions/' && options.method === 'POST' ? posted.promise : undefined, { kind: 'recognition', jobId: 'j1' }); await page.onShow();
  page.imageChange(change(true)); const creating = page.createSession(); await page.createSession();
  assert.equal(modals.length, 0); assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1);
  assert.deepEqual(calls.find((item) => item.options && item.options.method === 'POST').options.data, { scope: 'recognition', recognition_job_id: 'j1', include_image: true });
  posted.resolve({ data: session('s1', { include_image: true }) }); await creating;
  assert.equal(page.data.session.include_image, true); assert.equal(page.data.turns.length, 0);
});
test('expired original image is an explicit failure with no automatic thumbnail or image-free retry', async () => {
  const { page, calls } = fixture(async (path, options) => { if (path === 'llm/sessions/' && options.method === 'POST') throw Object.assign(new Error('原图已过期'), { code: 'IMAGE_UNAVAILABLE', status: 409 }); }, { kind: 'recognition', jobId: 'j1' });
  await page.onShow(); page.imageChange(change(true)); await page.createSession();
  assert.equal(page.data.session, null); assert.equal(page.data.includeImage, true); assert.match(page.data.actionError, /关闭附图/); assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1);
});
test('old create responses after hide or account switch never display private context', async () => {
  for (const mode of ['hide', 'account']) {
    const posted = deferred();
    const { page, application } = fixture(async (path, options) => path === 'llm/sessions/' && options.method === 'POST' ? posted.promise : undefined, { kind: 'recognition', jobId: 'j1' }); await page.onShow();
    const creating = page.createSession();
    if (mode === 'hide') page.onHide(); else application.session.save({ token: 'B', user: { id: 'B' } });
    posted.resolve({ data: session('private-A') }); await creating;
    assert.equal(page.data.session, null); assert.equal(page.data.source, null);
    assert.equal(page._sessionId, mode === 'hide' ? 'private-A' : undefined);
  }
});
test('returning during session creation waits for the request and refresh cannot create a duplicate', async () => {
  const posted = deferred();
  const { page, calls } = fixture(async (path, options) => path === 'llm/sessions/' && options.method === 'POST' ? posted.promise : undefined, { kind: 'recognition', jobId: 'j1' }); await page.onShow();
  const creating = page.createSession(); page.onHide(); const showing = page.onShow(); await page.onPullDownRefresh(); await page.createSession();
  posted.resolve({ data: session() }); await creating; await showing;
  assert.equal(page.data.session.id, 's1'); assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1);
});
test('first question requires send, has the same one-turn quota semantics, and duplicate clicks send once', async () => {
  const posted = deferred(); let submissions = 0;
  const { page, calls } = fixture(async (path, options) => { if (options && options.method === 'POST') { submissions += 1; return posted.promise; } });
  await page.onShow(); assert.equal(submissions, 0); page.inputQuestion(change('如何观察花序？'));
  const sending = page.send(); await page.send(); assert.equal(submissions, 1);
  posted.resolve({ data: turn() }); await sending;
  assert.equal(page.data.question, ''); assert.equal(page.data.turns.length, 1); assert.equal(page.data.busy, false);
  assert.ok(calls.filter((item) => item.path === 'llm/status/').length >= 2);
});
test('uncertain network failure preserves the question and reuses request_id on retry', async () => {
  const ids = []; let fail = true;
  const { page } = fixture(async (path, options) => {
    if (options && options.method === 'POST') { ids.push(options.data.request_id); if (fail) throw new Error('连接中断'); return { data: turn() }; }
  });
  await page.onShow(); page.inputQuestion(change('  核对叶片特征  ')); await page.send();
  assert.equal(page.data.question.trim(), '核对叶片特征'); assert.match(page.data.actionError, /先刷新核对/);
  fail = false; await page.send(); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});
test('zero or unknown cached quota never blocks sending; only the server displays the exhausted scope', async () => {
  for (const cached of [null, { ...quota, remaining: 0 }]) {
    const { page, calls } = fixture(async (path, options) => {
      if (path === 'llm/status/') return { data: { enabled: true, quota: cached } };
      if (options && options.method === 'POST') throw Object.assign(new Error('今日回合用完'), { status: 429, code: 'LLM_DAILY_LIMIT' });
    });
    await page.onShow(); assert.equal(page.data.actionError, ''); page.inputQuestion(change('请介绍这份资料')); await page.send();
    assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1);
    assert.match(page.data.actionError, /本板块今日使用已达上限.*北京时间零点/); assert.ok(page.data.question); assert.equal(page.data.busy, false);
  }
});
test('global 429 remains a readable service limit rather than a false personal quota message', async () => {
  const { page } = fixture(async (path, options) => options && options.method === 'POST' ? Promise.reject(Object.assign(new Error('服务繁忙，请稍后再试'), { status: 429, code: 'LLM_GLOBAL_LIMIT' })) : undefined);
  await page.onShow(); page.inputQuestion(change('请介绍这份资料')); await page.send(); assert.equal(page.data.actionError, '服务繁忙，请稍后再试'); assert.doesNotMatch(page.data.actionError, /5 轮/);
});
test('oversized and empty questions still do not create turns', async () => {
  const { page, calls } = fixture(); await page.onShow();
  page.inputQuestion(change(' ')); await page.send(); page.inputQuestion(change('字'.repeat(501))); await page.send();
  assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
});
test('old account turn responses never display answers or clear a new account draft', async () => {
  const posted = deferred();
  const { page, application } = fixture(async (path, options) => options && options.method === 'POST' ? posted.promise : undefined);
  await page.onShow(); page.inputQuestion(change('如何核对这些信息？')); const sending = page.send(); application.session.save({ token: 'B', user: { id: 'B' } });
  posted.resolve({ data: turn('private-A', { answer: '私有回答' }) }); await sending;
  assert.equal(page.data.session, null); assert.equal(page.data.turns.length, 0); assert.equal(page.data.busy, false); assert.equal(application.session.token(), 'B');
});
test('hide stops polling, late replies cannot write, and returning resumes from authoritative turns', async () => {
  const polled = deferred(); let pendingPoll = true;
  const { page, calls } = fixture(async (path) => {
    if (path === 'llm/sessions/s1/turns/') return { data: [turn('t1', { status: pendingPoll ? 'running' : 'succeeded' })] };
    if (path === 'llm/turns/t1/') return polled.promise;
  });
  await page.onShow(); page.onHide(); const write = page.setData; page.setData = () => { throw new Error('hidden write'); };
  polled.resolve({ data: turn() }); await flush();
  assert.equal(page.data.turns.length, 0); page.setData = write; pendingPoll = false; await page.onShow();
  assert.equal(page.data.turns[0].status, 'succeeded'); assert.equal(calls.filter((item) => item.path === 'llm/sessions/s1/turns/').length, 2);
});
test('pause cancels timers, old callbacks cannot poll, and resume explicitly continues', async () => {
  const { page, timers, calls } = fixture(async (path) => path === 'llm/sessions/s1/turns/' ? { data: [turn('t1', { status: 'running' })] } : path === 'llm/turns/t1/' ? { data: turn('t1', { status: 'running' }) } : undefined);
  await page.onShow(); await flush(); assert.equal(timers.length, 1);
  page.pausePolling(); const count = calls.length; await timers[0].fn(); assert.equal(calls.length, count); assert.equal(timers[0].cleared, true); assert.equal(page.data.polling, false);
  await page.resumePolling(); assert.equal(page.data.polling, true); page.onUnload();
});
test('failed polling is recoverable and a deleted session clears private answers without continuing timers', async () => {
  const { page, timers } = fixture(async (path) => path === 'llm/sessions/s1/turns/' ? { data: [turn('t1', { status: 'queued' })] } : path === 'llm/turns/t1/' ? Promise.reject(Object.assign(new Error('会话已删除'), { status: 404 })) : undefined);
  await page.onShow(); await flush(); assert.equal(page.data.unavailable, true); assert.equal(page.data.turns.length, 0); assert.equal(page.data.polling, false); assert.equal(timers.length, 0);
});
test('turn pages stay scoped to one session and include pages beyond the latest twenty', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => turn('t' + index));
  const { page } = fixture(async (path) => path === 'llm/sessions/s1/turns/' ? { data: rows.slice(0, 20), meta: { next: '/api/v1/llm/sessions/s1/turns/?page=2' } } : path.includes('page=2') ? { data: rows.slice(20) } : undefined);
  await page.onShow(); await page.more(); assert.equal(page.data.turns.length, 25);
  assert.throws(() => readPage({ data: [], meta: { next: '/api/v1/llm/sessions/other/turns/?page=2' } }, 'llm/sessions/s1/turns/', 'llm/sessions/s1/turns/', new Set()), /分页地址/);
});
test('existing no-image session states remain distinct from original machine results and unknown water quality', async () => {
  const { page, navigation } = fixture(async (path) => path === 'llm/sessions/s1/' ? { data: session('s1', { kind: 'assessment', assessment_job_id: 'a1', recognition_job_id: null, include_image: true, image_available: false }) } : undefined);
  await page.onShow(); assert.equal(page.data.session.image_available, false); assert.match(page.data.disclaimer, /官方水质评价/); page.original();
  assert.deepEqual(navigation, ['/pages/assessment/index?jobId=a1']);
});
test('returning while a turn is posting waits, and pull-to-refresh cannot bypass the mutation', async () => {
  const posted = deferred(); let reads = 0;
  const { page } = fixture(async (path, options) => { if (options && options.method === 'POST') return posted.promise; if (path === 'llm/sessions/s1/turns/') reads += 1; });
  await page.onShow(); page.inputQuestion(change('如何核对这些信息？')); const sending = page.send(); page.onHide(); const showing = page.onShow(); await page.onPullDownRefresh(); assert.equal(reads, 1);
  posted.resolve({ data: turn() }); await sending; await showing; assert.equal(reads, 2);
});
test('history lists all pages and creates no generic conversation', async () => {
  const { page, calls, navigation } = fixture(async (path) => path === 'llm/sessions/' ? { data: [session('s1')], meta: { next: '/api/v1/llm/sessions/?page=2' } } : path.includes('page=2') ? { data: [session('s2')] } : undefined, {}, false, 'llm-history');
  await page.onShow(); await page.more(); assert.equal(page.data.sessions.length, 2); page.open(idEvent('s2'));
  assert.deepEqual(navigation, ['/pages/llm/index?sessionId=s2']); assert.equal(calls.some((item) => item.options && item.options.method), false);
});
test('history deletion needs explicit confirmation, is private, and stale modal never deletes', async () => {
  for (const changeAccount of [false, true]) {
    let gone = false;
    const { page, application, calls, modals } = fixture(async (path, options) => { if (options && options.method === 'DELETE') { gone = true; return { data: null }; } if (path === 'llm/sessions/' && gone) return { data: [] }; }, {}, false, 'llm-history');
    await page.onShow(); page.remove(idEvent('s1')); page.remove(idEvent('s1')); assert.equal(modals.length, 1);
    if (changeAccount) application.session.save({ token: 'B', user: { id: 'B' } });
    await modals[0].success({ confirm: true }); await modals[0].success({ confirm: true });
    assert.equal(calls.filter((item) => item.options && item.options.method === 'DELETE').length, changeAccount ? 0 : 1); assert.equal(page.data.sessions.length, 0);
  }
});
test('private history results after hide and session renewal never enter the next account', async () => {
  const loading = deferred(); const { page, application } = fixture(async (path) => path === 'llm/sessions/' ? loading.promise : undefined, {}, false, 'llm-history');
  const showing = page.onShow(); application.session.save({ token: 'B', user: { id: 'B' } }); loading.resolve({ data: [session('private-A')] }); await showing;
  assert.equal(page.data.sessions.length, 0); assert.equal(page.data.quota, undefined);
});
test('a history delete response after account renewal clears the old list without changing the new login', async () => {
  const removed = deferred(); const { page, application, modals } = fixture(async (path, options) => options && options.method === 'DELETE' ? removed.promise : undefined, {}, false, 'llm-history');
  await page.onShow(); page.remove(idEvent('s1')); const deleting = modals[0].success({ confirm: true });
  application.session.save({ token: 'B', user: { id: 'B' } }); removed.resolve({ data: null }); await deleting;
  assert.equal(page.data.sessions.length, 0); assert.equal(page.data.busy, false); assert.equal(application.session.token(), 'B');
});
test('result entries only navigate from a completed current-account task, never create or send automatically', () => {
  for (const kind of ['recognition', 'assessment']) {
    let definition; const navigation = []; let token = 'A';
    global.Page = (value) => { definition = value; }; global.wx = { navigateTo: ({ url }) => navigation.push(url) };
    global.getApp = () => ({ session: { token: () => token } });
    const path = require.resolve('../pages/' + (kind === 'recognition' ? 'recognize' : 'assessment') + '/index'); delete require.cache[path]; require(path);
    const page = { ...definition, data: { task: { id: 'job', status: 'queued' }, busy: false }, _visible: true, _sessionToken: 'A' };
    page.openAI(); assert.equal(navigation.length, 0); page.data.task.status = 'succeeded'; page.openAI();
    assert.deepEqual(navigation, ['/pages/llm/index?kind=' + kind + '&jobId=job']);
    token = 'B'; page.openAI(); token = 'A'; page._visible = false; page.openAI(); assert.equal(navigation.length, 1);
  }
});

test('public source sessions send only scoped identifiers and always need a separate first question', async () => {
  for (const [scope, type, id] of [['explore', 'region', 'r1'], ['explore', 'place', 'p1'], ['explore', 'water', 'w1'], ['learn', 'region', 'r2'], ['learn', 'content', 'c1'], ['learn', 'route', 'route1']]) {
    const { page, calls, modals } = fixture(undefined, { scope, source_type: type, source_id: id }); await page.onShow();
    assert.equal(page.data.error, ''); assert.equal(page.data.source.id, id); assert.equal(page.data.isRecognition, false);
    assert.equal(calls[0].options.data.scope, scope); assert.equal(page.data.modelLabel, 'DeepSeek Flash');
    page.imageChange(change(true)); assert.equal(page.data.includeImage, false);
    await page.createSession();
    const posts = calls.filter((item) => item.options && item.options.method === 'POST');
    assert.equal(posts.length, 1); assert.deepEqual(posts[0].options.data, { scope, source_type: type, source_id: id, include_image: false });
    assert.equal(modals.length, 0); assert.equal(page.data.session.scope, scope); assert.equal(page.data.turns.length, 0); assert.equal(page.data.question, '');
    assert.equal(Object.hasOwn(posts[0].options.data, 'body'), false);
  }
});
test('wrong scope/source combinations and unavailable source never create sessions', async () => {
  for (const options of [{ scope: 'learn', source_type: 'place', source_id: 'p1' }, { scope: 'explore', source_type: 'content', source_id: 'c1' }, { scope: 'learn', source_type: 'region' }]) {
    const { page, calls } = fixture(undefined, options); await page.onShow(); await page.createSession(); assert.match(page.data.error, /资料进入/); assert.equal(calls.length, 0);
  }
  const { page, calls } = fixture(undefined, { scope: 'explore', source_type: 'water', source_id: 'missing' });
  await page.onShow(); await page.createSession(); assert.equal(page.data.unavailable, true); assert.equal(page.data.source, null);
  assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
  assert.equal(entryUrl('explore', 'content', 'c1'), '');
});
test('public preview response after leaving or login switch does not rebuild the old view', async () => {
  for (const mode of ['hide', 'account']) {
    const fetched = deferred();
    const { page, application } = fixture(async (path) => path === 'contents/c1/' ? fetched.promise : undefined, { scope: 'learn', source_type: 'content', source_id: 'c1' });
    const showing = page.onShow(); await flush();
    if (mode === 'hide') page.onHide(); else application.session.save({ token: 'B', user: { id: 'B' } });
    fetched.resolve({ data: { id: 'c1', title: '旧页资料' } }); await showing;
    assert.equal(page.data.source, null); assert.equal(page.data.session, null);
  }
});
test('returning from public sessions selects the original source and water region instead of current filters', async () => {
  for (const [scope, type, id, expected] of [
    ['explore', 'water', 'w1', '/pages/water/index?waterBodyId=w1&region=r2'],
    ['explore', 'place', 'p1', '/pages/detail/index?kind=place&id=p1'],
    ['learn', 'content', 'c1', '/pages/detail/index?kind=content&id=c1'],
    ['learn', 'route', 'route1', '/pages/detail/index?kind=route&id=route1'],
    ['explore', 'region', 'r2', '/pages/explore/index'],
    ['learn', 'region', 'r2', '/pages/learn/index'],
  ]) {
    const { page, navigation, application } = fixture(async (path) => path === 'llm/sessions/s1/' ? { data: session('s1', { kind: scope, scope, source_type: type, source_id: id, source_region_id: 'r2' }) } : undefined);
    application.globalData.region = { id: 'unrelated' }; application.globalData.pendingKnowledgeFilter = { place: 'unrelated' };
    await page.onShow(); page.original(); assert.deepEqual(navigation, [expected]);
    if (type === 'region' && scope === 'explore') assert.equal(application.globalData.region.id, id);
    if (type === 'region' && scope === 'learn') assert.deepEqual(application.globalData.pendingKnowledgeFilter, { region: id });
  }
});
test('history accepts all three scope buckets while retaining legacy recognition and assessment rows', async () => {
  const rows = [session('r'), session('a', { kind: 'assessment', assessment_job_id: 'a1' }), session('e', { kind: 'explore', scope: 'explore', source_type: 'place', source_id: 'p1' }), session('l', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'c1' })];
  const { page } = fixture(async (path) => path === 'llm/sessions/' ? { data: rows } : undefined, {}, false, 'llm-history'); await page.onShow();
  assert.equal(page.data.sessions.length, 4); assert.deepEqual(page.data.sessions.map((item) => item.scope), ['recognition', 'recognition', 'explore', 'learn']);
  assert.throws(() => sessionView(session('bad', { kind: 'learn', scope: 'learn', source_type: 'water', source_id: 'w1' })), /来源/);
});

test('article name and summary survive creation, history reopening and refresh using the session source ID', async () => {
  let revision = 0;
  const article = () => ({ id: 'c1', title: revision ? '向日葵类：更新后的观察重点' : '向日葵类：保留花序与整株信息', summary: revision ? '新的花序与叶片摘要' : '观察花序和整株形态' });
  const publicSession = session('s1', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'c1', title: '科普智游助手', context_summary: '通用说明' });
  const { page, calls, navigation } = fixture(async (path, options) => {
    if (path === 'contents/c1/') return { data: article() };
    if (path === 'llm/sessions/s1/' || (path === 'llm/sessions/' && options.method === 'POST')) return { data: publicSession };
  }, { scope: 'learn', source_type: 'content', source_id: 'c1' });
  await page.onShow(); assert.equal(page.data.source.title, article().title); await page.createSession();
  assert.equal(page.data.source.title, article().title); assert.equal(page.data.source.summary, article().summary);
  assert.equal(page.data.session.source_type, 'content'); assert.equal(page.data.session.source_id, 'c1'); page.original();
  page.onHide(); revision = 1; await page.onShow(); assert.equal(page.data.source.title, article().title);
  await page.load(); assert.equal(page.data.source.summary, article().summary); page.original();
  assert.deepEqual(navigation, ['/pages/detail/index?kind=content&id=c1', '/pages/detail/index?kind=content&id=c1']);
  assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1);
});
test('server session source is authoritative when creation returns a different source ID', async () => {
  const { page, navigation, calls } = fixture(async (path, options) => {
    if (path === 'llm/sessions/' && options.method === 'POST') return { data: session('s1', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'canonical' }) };
    if (path === 'contents/canonical/') return { data: { id: 'canonical', title: '实际关联文章', summary: '真实来源摘要' } };
  }, { scope: 'learn', source_type: 'content', source_id: 'c1' });
  await page.onShow(); await page.createSession(); assert.equal(page.data.source.id, 'canonical'); assert.equal(page.data.source.title, '实际关联文章'); page.original();
  assert.deepEqual(navigation, ['/pages/detail/index?kind=content&id=canonical']); assert.ok(calls.some((item) => item.path === 'contents/canonical/'));
});
test('late source metadata from an old session cannot overwrite a newly loaded session', async () => {
  const oldSource = deferred();
  const { page } = fixture(async (path) => {
    if (path === 'llm/sessions/s1/') return { data: session('s1', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'old' }) };
    if (path === 'contents/old/') return oldSource.promise;
    if (path === 'llm/sessions/s2/') return { data: session('s2', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'new' }) };
    if (path === 'contents/new/') return { data: { id: 'new', title: '新会话关联文章', summary: '新摘要' } };
    if (path === 'llm/sessions/s2/turns/') return { data: [] };
  });
  const oldLoading = page.onShow(); await flush(); page._sessionId = 's2'; await page.load();
  oldSource.resolve({ data: { id: 'old', title: '过时的文章', summary: '不应出现' } }); await oldLoading;
  assert.equal(page.data.session.id, 's2'); assert.equal(page.data.source.id, 'new'); assert.equal(page.data.source.title, '新会话关联文章'); assert.equal(page.data.sourceLoading, false);
});
test('source metadata failure is independently retryable without losing or recreating the session', async () => {
  let failed = true;
  const { page, calls, navigation } = fixture(async (path) => {
    if (path === 'llm/sessions/s1/') return { data: session('s1', { kind: 'explore', scope: 'explore', source_type: 'place', source_id: 'p1' }) };
    if (path === 'places/p1/') { if (failed) throw new Error('网络暂不可用'); return { data: { id: 'p1', name: '示范河岸', description: '公开地点描述' } }; }
  });
  await page.onShow(); assert.equal(page.data.session.id, 's1'); assert.equal(page.data.source, null); assert.match(page.data.sourceError, /网络暂不可用/);
  assert.equal(page.data.error, ''); page.original(); assert.deepEqual(navigation, ['/pages/detail/index?kind=place&id=p1']);
  failed = false; await page.load(); assert.equal(page.data.source.title, '示范河岸'); assert.equal(page.data.sourceError, '');
  assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
});
test('pending session source metadata after hide or login change cannot restore the old card', async () => {
  for (const mode of ['hide', 'account']) {
    const source = deferred();
    const { page, application } = fixture(async (path) => path === 'llm/sessions/s1/' ? { data: session('s1', { kind: 'learn', scope: 'learn', source_type: 'content', source_id: 'c1' }) } : path === 'contents/c1/' ? source.promise : undefined);
    const showing = page.onShow(); await flush();
    if (mode === 'hide') page.onHide(); else application.session.save({ token: 'B', user: { id: 'B' } });
    source.resolve({ data: { id: 'c1', title: '旧会话的资料' } }); await showing;
    assert.equal(page.data.source, null); assert.equal(page.data.session, null); assert.equal(page.data.sourceLoading, false);
  }
});

test('all fresh entry types start blank and creation or refresh never inserts a preset question', async () => {
  const entries = [{ kind: 'recognition', jobId: 'j1' }, { kind: 'assessment', jobId: 'a1' }, { scope: 'explore', source_type: 'region', source_id: 'r1' }, { scope: 'learn', source_type: 'content', source_id: 'c1' }];
  for (const options of entries) {
    const { page, calls } = fixture(undefined, options);
    await page.onShow(); assert.equal(page.data.question, ''); assert.equal(page.data.questionCount, 0);
    await page.load(); assert.equal(page.data.question, '');
    await page.createSession(); assert.equal(page.data.question, ''); await page.send();
    assert.match(page.data.actionError, /请填写/);
    assert.equal(calls.filter((item) => item.options && item.options.method === 'POST').length, 1, 'only creates a session; blank text never creates a turn');
  }
});
test('history entry and subsequent refresh stay empty in recognition, assessment, explore and learn', async () => {
  for (const kind of ['recognition', 'assessment', 'explore', 'learn']) {
    const publicScope = ['explore', 'learn'].includes(kind);
    const { page, calls } = fixture(async (path) => path === 'llm/sessions/s1/' ? { data: session('s1', { kind, ...(publicScope ? { scope: kind, source_type: 'region', source_id: 'r1' } : {}) }) } : undefined);
    await page.onShow(); assert.equal(page.data.question, ''); await page.load(); assert.equal(page.data.question, '');
    await page.send(); assert.match(page.data.actionError, /请填写/); assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
  }
});
test('user-authored unsent drafts survive refresh and returning to the same account and session', async () => {
  const { page, calls } = fixture(); await page.onShow();
  const draft = '  我想了解叶片边缘\n还有花序形态  '; page.inputQuestion(change(draft));
  await page.load(); assert.equal(page.data.question, draft);
  page.onHide(); assert.equal(page.data.question, ''); await page.onShow(); assert.equal(page.data.question, draft);
  assert.equal(page.data.questionCount, Array.from(draft.trim()).length); assert.equal(calls.some((item) => item.options && item.options.method === 'POST'), false);
});
test('an unsent draft never transfers to a different session or renewed account', async () => {
  for (const mode of ['session', 'account']) {
    const { page, application } = fixture(async (path) => path === 'llm/sessions/s2/' ? { data: session('s2') } : path === 'llm/sessions/s2/turns/' ? { data: [] } : undefined);
    await page.onShow(); page.inputQuestion(change('原账号原会话的私有草稿')); page.onHide();
    if (mode === 'session') page._sessionId = 's2'; else application.session.save({ token: 'B', user: { id: 'B' } });
    await page.onShow(); assert.equal(page.data.question, ''); assert.equal(page.data.questionCount, 0);
  }
});
test('a confirmed submission completed while hidden does not return as an unsent draft', async () => {
  const posted = deferred(); const { page } = fixture(async (path, options) => options && options.method === 'POST' ? posted.promise : undefined);
  await page.onShow(); page.inputQuestion(change('我主动发出的内容')); const sending = page.send(); page.onHide(); const showing = page.onShow();
  posted.resolve({ data: turn() }); await sending; await showing;
  assert.equal(page.data.question, ''); assert.equal(page.data.questionCount, 0);
});
test('chat textarea has no placeholder or automatic-prefill copy', () => {
  const fs = require('node:fs'), path = require('node:path');
  const markup = fs.readFileSync(path.join(__dirname, '../pages/llm/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /<textarea\b[^>]*\bplaceholder=/); assert.doesNotMatch(markup, /预填/);
});

test('chat reads chronologically while keeping scoped newest-first records, and hide removes both views', async () => {
  const { page } = fixture(async (path) => path === 'llm/sessions/s1/turns/' ? { data: [turn('latest'), turn('earlier')] } : undefined);
  await page.onShow();
  assert.deepEqual(page.data.turns.map((row) => row.id), ['latest', 'earlier']);
  assert.deepEqual(page.data.displayTurns.map((row) => row.id), ['earlier', 'latest']);
  page.onHide();
  assert.equal(page.data.turns.length, 0); assert.equal(page.data.displayTurns.length, 0);
});
test('failed answer can return to editing without a paid request or silently replacing a draft', async () => {
  const { page, calls } = fixture(async (path) => path === 'llm/sessions/s1/turns/' ? { data: [turn('failed', { status: 'failed', question: '如何观察叶片？' })] } : undefined);
  await page.onShow(); const count = calls.length;
  page.reuseQuestion(idEvent('failed'));
  assert.equal(page.data.question, '如何观察叶片？'); assert.equal(calls.length, count);
  page.inputQuestion(change('尚未发出的另一个问题'));
  page.reuseQuestion(idEvent('failed'));
  assert.equal(page.data.question, '尚未发出的另一个问题'); assert.match(page.data.actionError, /未发送/); assert.equal(calls.length, count);
});
test('keyboard docking ignores invalid sizes and hidden events, and context stays outside the input', async () => {
  const { page } = fixture(); await page.onShow();
  assert.equal(page.data.contextExpanded, false); page.toggleContext(); assert.equal(page.data.contextExpanded, true); assert.equal(page.data.question, '');
  page.keyboardHeightChanged({ detail: { height: 320 } }); assert.equal(page.data.keyboardHeight, 320);
  page.keyboardHeightChanged({ detail: { height: -1 } }); assert.equal(page.data.keyboardHeight, 0);
  page.keyboardHeightChanged({ detail: { height: 'bad' } }); assert.equal(page.data.keyboardHeight, 0);
  page.keyboardHeightChanged({ detail: { height: 900 } }); assert.equal(page.data.keyboardHeight, 700);
  page.inputBlur(); assert.equal(page.data.keyboardHeight, 0);
  page.onHide(); page.keyboardHeightChanged({ detail: { height: 320 } }); assert.equal(page.data.keyboardHeight, 0);
});
test('delayed render cannot scroll an old account conversation, and reading older answers pauses following', async () => {
  const { page, application } = fixture(); await page.onShow();
  const rendered = [], scrolls = [];
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) rendered.push(callback); };
  global.wx.pageScrollTo = (options) => scrolls.push(options);
  page.updateTurns([turn('late')], true);
  application.session.save({ token: 'B', user: { id: 'B' } });
  rendered.shift()();
  assert.equal(scrolls.length, 0); assert.equal(page.data.displayTurns.length, 0);
  page.onPageScroll({ scrollTop: 300 }); page.onPageScroll({ scrollTop: 200 });
  assert.equal(page._followLatest, false);
});

function composerMeasurements(page) {
  const pending = [], scrolls = [];
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  global.wx.pageScrollTo = (options) => scrolls.push(options);
  global.wx.createSelectorQuery = () => ({
    in(scope) { assert.equal(scope, page); return this; },
    select(selector) { assert.equal(selector, '.composer'); return this; },
    boundingClientRect() { return this; },
    exec(callback) { pending.push(callback); },
  });
  return { pending, scrolls };
}
test('composer space follows measured multiline input and error height plus the keyboard, preserving the draft', async () => {
  const { page } = fixture(async (path, options) => options && options.method === 'POST' ? Promise.reject(new Error('连接暂时中断，'.repeat(16))) : undefined);
  await page.onShow(); const measured = composerMeasurements(page);
  page.measureComposer(); measured.pending.pop()([{ height: 131.5 }]);
  assert.equal(page.data.composerHeight, 132);
  const question = '保留这段尚未发送的问题。'.repeat(20);
  page.inputQuestion(change(question));
  page.keyboardHeightChanged({ detail: { height: 310 } });
  page.composerLineChanged();
  measured.pending.pop()([{ height: 216.1 }]);
  assert.equal(page.data.composerHeight + page.data.keyboardHeight, 527);
  await page.send();
  assert.equal(page.data.question, question); assert.match(page.data.actionError, /连接暂时中断/);
  measured.pending.pop()([{ height: 294.2 }]);
  assert.equal(page.data.composerHeight, 295); assert.equal(page.data.composerHeight + page.data.keyboardHeight, 605);
  assert.ok(measured.scrolls.length > 0);
  const fs = require('node:fs'), path = require('node:path');
  const markup = fs.readFileSync(path.join(__dirname, '../pages/llm/index.wxml'), 'utf8');
  assert.match(markup, /height: {{composerHeight \+ keyboardHeight}}px/); assert.doesNotMatch(markup, /280rpx/);
});
test('older and unavailable composer measurements never replace the latest layout', async () => {
  const { page } = fixture(); await page.onShow(); const { pending } = composerMeasurements(page);
  page.measureComposer(); const old = pending.pop();
  page.measureComposer(); pending.pop()([{ height: 256 }]); old([{ height: 90 }]);
  assert.equal(page.data.composerHeight, 256);
  for (const value of [null, { height: NaN }, { height: -1 }]) {
    page.measureComposer(); pending.pop()([value]); assert.equal(page.data.composerHeight, 256);
  }
  page.setData({ loading: true }); page.measureComposer(); assert.equal(pending.length, 0);
});
test('composer query and layout callbacks cannot modify or scroll after unload, hide, account or session changes', async () => {
  for (const mode of ['unload', 'hide', 'account', 'session']) {
    const { page, application } = fixture(); await page.onShow();
    const { pending, scrolls } = composerMeasurements(page);
    page.measureComposer({ scroll: true, force: true }); const respond = pending.pop();
    if (mode === 'unload') page.onUnload();
    else if (mode === 'hide') page.onHide();
    else if (mode === 'account') application.session.save({ token: 'B', user: { id: 'B' } });
    else page.setData({ session: sessionView(session('s2')) });
    page.setData = () => { throw new Error('stale composer wrote to another screen'); };
    respond([{ height: 500 }]); assert.equal(scrolls.length, 0);
  }
  const { page, application } = fixture(); await page.onShow();
  const { pending, scrolls } = composerMeasurements(page); page.measureComposer({ scroll: true });
  let afterLayout;
  page.setData = function (patch, callback) { Object.assign(this.data, patch); afterLayout = callback; };
  pending.pop()([{ height: 220 }]);
  application.session.save({ token: 'B', user: { id: 'B' } }); afterLayout();
  assert.equal(scrolls.length, 0);
});
test('an unknown service status disables new sends while a measured existing composer stays recoverable', async () => {
  let unavailable = false;
  const { page, calls } = fixture(async (path) => { if (path === 'llm/status/' && unavailable) throw new Error('服务状态暂不可用'); });
  await page.onShow(); unavailable = true;
  await page.load(); assert.equal(page.data.status, null); assert.ok(page.data.session); assert.match(page.data.error, /服务状态暂不可用/);
  const { pending } = composerMeasurements(page); page.measureComposer(); pending.pop()([{ height: 170 }]);
  assert.equal(page.data.composerHeight, 170);
  page.inputQuestion(change('需要保留的问题')); await page.send();
  assert.equal(calls.some((call) => call.options && call.options.method === 'POST'), false);
  assert.equal(page.data.question, '需要保留的问题');
});
