'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const community = require('../../cloudfunctions/hyhqApi/lib/community');
const catalog = require('../../cloudfunctions/hyhqApi/lib/catalog');
const { configFromEnvironment } = require('../../cloudfunctions/hyhqApi/lib/config');
const seed = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const code = name => error => error.code === name;
async function fixture(options = {}) {
  const store = new MemoryStore(), author = { id: uid(1), quota_key: 'author-hash', is_active: true }, other = { id: uid(2), quota_key: 'other-hash', is_active: true }, admin = { id: uid(3), quota_key: 'admin-hash', is_active: true };
  for (const user of [author, other, admin]) await store.set('users', user.id, user);
  const config = { appId: 'test-app', management: { enabled: true, adminUserIds: [admin.id] }, community: { mode: 'official-editorial', feedbackEnabled: true, feedbackQualificationConfirmed: true, feedbackQualificationReference: 'verified editorial fixture', feedbackQualificationDate: '2026-10-01', enabled: true, qualificationConfirmed: true, qualificationReference: 'verified test fixture', qualificationDate: '2026-10-01', moderationReady: true } };
  const now = '2026-10-07T12:00:00Z'; await store.set('admin_config', 'community_safety', { id: 'community_safety', app_id: config.appId, checked_at: now });
  let calls = 0;
  const context = (path, method = 'GET', body = {}, extra = {}) => ({ path: path.split('?')[0], query: new URLSearchParams(path.split('?')[1] || ''), method, body, store, config, now, user: author, checkCommunityText: async payload => { calls++; if (options.check) return options.check(payload); return { errCode: 0, result: { suggest: options.outcome || 'pass' } }; }, ...extra });
  const request = (path, method, body, extra) => community.handle(context(path, method, body, extra));
  const draft = async (title = '树影观察', request_id = uid(10)) => (await request('community/submissions/', 'POST', { title, body: '观察叶形与树影的变化，内容仅为自然观察。', category: 'green', source: '', request_id })).data.data;
  const submit = async row => (await request(`community/submissions/${row.id}/submit/`, 'POST', { expected_version: row.version, request_id: uid(20) })).data.data;
  const review = async (row, decision = 'approved', reason = '') => (await request(`personal-admin/community/submissions/${row.id}/review/`, 'POST', { expected_version: row.version, decision, reason, ...(decision === 'approved' ? { edited_title: '官方编辑：树影与叶形', edited_body: '观察树木时可记录叶片的外形及树影随光照的变化，保持距离并避免采摘。', edited_source: '编辑核实的植物科普资料', request_id: uid(1000 + row.version) } : {}) }, { user: admin })).data.data;
  return { store, author, other, admin, config, now, context, request, draft, submit, review, calls: () => calls };
}
test('default config closes public features but permits private drafts without calling safety', async () => {
  assert.equal(configFromEnvironment({}).community.enabled, false);
  const f = await fixture(); f.config.community = {};
  const status = (await f.request('community/status/')).data.data; assert.equal(status.enabled, false); assert.equal(status.drafts_enabled, true);
  const draft = await f.draft(); assert.equal(draft.status, 'draft');
  await assert.rejects(f.submit(draft), code('COMMUNITY_DISABLED')); assert.equal(f.calls(), 0);
});
test('all business gates, proof age/app binding and active reviewer are required independently', async () => {
  const f = await fixture(); assert.equal(await community.feedbackEnabled(f.context('')), true);
  for (const [key, value] of Object.entries({ feedbackEnabled: false, feedbackQualificationConfirmed: false, feedbackQualificationReference: '', feedbackQualificationDate: '2026-10-08', moderationReady: false })) { const old = f.config.community[key]; f.config.community[key] = value; assert.equal(await community.feedbackEnabled(f.context('')), false, key); f.config.community[key] = old; }
  await f.store.update('users', f.admin.id, { is_active: false }); assert.equal(await community.feedbackEnabled(f.context('')), false); await f.store.update('users', f.admin.id, { is_active: true });
  for (const proof of [{ app_id: 'wrong', checked_at: f.now }, { app_id: f.config.appId, checked_at: '2026-09-30T11:59:59Z' }, { app_id: f.config.appId, checked_at: '2026-10-08T00:00:00Z' }]) { await f.store.set('admin_config', 'community_safety', proof); assert.equal(await community.feedbackEnabled(f.context('')), false); }
});
test('draft creation is idempotent, own-only and optimistic editing cannot overwrite newer content', async () => {
  const f = await fixture(), draft = await f.draft(); assert.equal((await f.draft()).id, draft.id); assert.equal(await f.store.count('community_submissions'), 1);
  await assert.rejects(f.draft('changed'), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.request(`community/submissions/${draft.id}/`, 'GET', {}, { user: f.other }), code('NOT_FOUND'));
  const body = { title: '更新观察', body: '叶子与水面', expected_version: draft.version };
  const results = await Promise.allSettled([1, 2].map(() => f.request(`community/submissions/${draft.id}/`, 'PATCH', body)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SUBMISSION_CHANGED');
  assert.equal((await f.request('personal-admin/community/submissions/', 'GET', {}, { user: f.admin })).data.data.length, 0);
});
test('safety pass still needs human approval; published entry participates in catalogue, withdraw removes it', async () => {
  const f = await fixture(), draft = await f.draft(), pending = await f.submit(draft);
  assert.equal(pending.status, 'pending'); assert.equal(pending.safety_status, 'pass');
  assert.equal(await catalog.getPublicItem(f.context(''), 'contents', draft.id), null);
  await assert.rejects(f.request(`personal-admin/community/submissions/${draft.id}/review/`, 'POST', { expected_version: pending.version, decision: 'approved' }, { user: f.other }), code('FORBIDDEN'));
  const approved = await f.review(pending); assert.equal(approved.status, 'approved');
  const published = await catalog.getPublicItem(f.context(''), 'contents', draft.id); assert.notEqual(published.title, draft.title); assert.notEqual(published.body, draft.body); assert.match(published.source, /官方编辑整理/); assert.equal(published.owner_id, undefined); assert.equal(published._community_owner_id, undefined);
  f.config.community.feedbackEnabled = false; assert.equal(await catalog.getPublicItem(f.context(''), 'contents', draft.id), null); f.config.community.feedbackEnabled = true;
  await f.request(`community/submissions/${draft.id}/withdraw/`, 'POST', { expected_version: approved.version }); assert.equal(await catalog.getPublicItem(f.context(''), 'contents', draft.id), null);
  const audits = await f.store.list('admin_audit'); assert.ok(audits.length >= 3); assert.equal(JSON.stringify(audits).includes(draft.body), false); assert.equal(JSON.stringify(audits).includes('author-hash'), false);
});
test('unsafe or unavailable safety results never enter pending/public state or permit override', async () => {
  for (const outcome of ['review', 'risky', 'unavailable']) {
    const f = await fixture({ outcome }), rejected = await f.submit(await f.draft()); assert.equal(rejected.status, 'rejected');
    await assert.rejects(f.review(rejected), code('SUBMISSION_CHANGED')); assert.equal(await f.store.count('catalog'), 0);
  }
});
test('duplicate submit reuses record and never rechecks or bills safety; changed payload conflicts', async () => {
  const f = await fixture(), draft = await f.draft(), pending = await f.submit(draft), repeated = await f.submit(draft);
  assert.equal(repeated.id, pending.id); assert.equal(f.calls(), 1);
  await assert.rejects(f.request(`community/submissions/${draft.id}/submit/`, 'POST', { expected_version: pending.version, request_id: uid(20) }), code('IDEMPOTENCY_CONFLICT'));
});
test('review conflict and rejected approved article remove catalogue atomically; audit failure rolls back', async () => {
  const f = await fixture(), approved = await f.review(await f.submit(await f.draft()));
  await assert.rejects(f.review({ ...approved, version: 1 }), code('SUBMISSION_CHANGED'));
  const tx = f.store.transaction.bind(f.store); f.store.transaction = fn => tx(async transaction => { await fn(transaction); throw new Error('rollback'); });
  await assert.rejects(f.review(approved, 'rejected', '来源需核实'), /rollback/); assert.ok(await catalog.getPublicItem(f.context(''), 'contents', approved.id)); f.store.transaction = tx;
  const rejected = await f.review(approved, 'rejected', '来源需核实'); assert.equal(rejected.status, 'rejected'); assert.equal(await catalog.getPublicItem(f.context(''), 'contents', approved.id), null);
});
test('account removal and withdrawals during an external check cannot resurrect the record', async () => {
  for (const action of ['delete', 'disable', 'withdraw']) {
    let finish, started; const waiting = new Promise(resolve => { started = resolve; });
    const f = await fixture({ check: () => { started(); return new Promise(resolve => { finish = resolve; }); } }), draft = await f.draft(), promise = f.submit(draft); await waiting;
    if (action === 'delete') { await f.store.update('users', f.author.id, { is_active: false }); await community.purgeOwner(f.context(''), f.author); }
    if (action === 'disable') f.config.community.feedbackEnabled = false;
    if (action === 'withdraw') await f.request(`community/submissions/${draft.id}/withdraw/`, 'POST', { expected_version: draft.version + 1 });
    finish({ errCode: 0, result: { suggest: 'pass' } });
    if (action === 'disable') assert.equal((await promise).status, 'rejected'); else await assert.rejects(promise);
    assert.equal(await f.store.count('catalog'), 0);
  }
});
test('daily safety budget is reserved before upstream call and survives account deletion', async () => {
  const f = await fixture(); await f.store.set('community_safety_days', '2026-10-07', { count: 80 });
  const draft = await f.draft(); await assert.rejects(f.submit(draft), code('CONTENT_SAFETY_UNAVAILABLE')); assert.equal(f.calls(), 0);
  await community.purgeOwner(f.context(''), f.author); assert.equal((await f.store.get('community_safety_days', '2026-10-07')).count, 80);
});
test('comments preserve existing API and keep pending/private data from other users; reports private and duplicate-safe', async () => {
  const f = await fixture(), target = seed.collections.contents[0].id; f.config.community.mode = 'public-community';
  const post = { kind: 'content', target_id: target, body: '认真观察，不采摘植物', request_id: uid(25) };
  const comment = (await f.request('community/comments/', 'POST', post)).data.data; assert.equal(comment.status, 'pending');
  const url = `community/comments/?kind=content&target_id=${target}`;
  assert.equal((await f.request(url, 'GET', {}, { user: f.other })).data.data.length, 0);
  assert.equal((await f.request(url)).data.data[0].id, comment.id);
  await f.request(`personal-admin/community/comments/${comment.id}/review/`, 'POST', { expected_version: comment.version, decision: 'approved' }, { user: f.admin });
  const publicComment = (await f.request(url, 'GET', {}, { user: null })).data.data[0]; assert.equal(publicComment.author, '生态同行者'); assert.equal(publicComment.owner_id, undefined); assert.equal(publicComment.safety_status, undefined);
  const report = { kind: 'comment', target_id: comment.id, reason: 'inaccurate', detail: '私密意见', request_id: uid(26) };
  const first = (await f.request('community/reports/', 'POST', report, { user: f.other })).data.data;
  const twice = (await f.request('community/reports/', 'POST', { ...report, request_id: uid(27) }, { user: f.other })).data.data;
  assert.equal(first.id, twice.id); assert.equal((await f.request('community/reports/')).data.data.length, 0);
  f.config.community.enabled = false; await f.request(`community/comments/${comment.id}/`, 'DELETE'); assert.equal(await f.store.count('community_comments'), 0);
});
test('safety input is bounded text; unexpected response/exception fails closed and no provider detail escapes', async () => {
  const f = await fixture(); await assert.rejects(f.request('community/submissions/', 'POST', { title: '<script>', body: 'text', request_id: uid(90) }), code('VALIDATION_ERROR'));
  await assert.rejects(f.request('community/submissions/', 'POST', { title: '标题', body: '字'.repeat(2001), request_id: uid(90) }), code('VALIDATION_ERROR'));
  for (const checkCommunityText of [null, async () => { throw new Error('private-url-secret'); }, async () => ({ errcode: 0, result: { suggest: 'unexpected' } })]) assert.equal(await community.checkText({ checkCommunityText }, '正常文本', 2), 'unavailable');
});
test('admin safety verification is explicit, budgeted and not an automatic public switch', async () => {
  const f = await fixture(); f.config.community.feedbackEnabled = false;
  const result = (await f.request('personal-admin/community/verify-safety/', 'POST', {}, { user: f.admin })).data.data;
  assert.equal(result.enabled, false); assert.equal(f.calls(), 1); assert.equal((await f.store.get('community_safety_days', '2026-10-07')).count, 1);
  await assert.rejects(f.request('personal-admin/community/verify-safety/', 'POST', {}, { user: f.other }), code('FORBIDDEN'));
});

test('published user content cannot be edited via administrator catalogue to bypass the review path', async () => {
  const f = await fixture(), approved = await f.review(await f.submit(await f.draft()));
  const management = require('../../cloudfunctions/hyhqApi/lib/management');
  await assert.rejects(management.handle(f.context(`personal-admin/catalog/contents/${approved.id}/`, 'PATCH', { value: { body: '未经内容检查的新正文' }, expected_revision: 1 }, { user: f.admin })), code('COMMUNITY_REVIEW_REQUIRED'));
  assert.notEqual((await catalog.getPublicItem(f.context(''), 'contents', approved.id)).body, approved.body);
});

test('report idempotency remains bound even when a new request deduplicates to an existing target', async () => {
  const f = await fixture(), target = seed.collections.contents[0].id, other = seed.collections.contents[1].id; f.config.community.mode = 'public-community';
  const payload = { kind: 'content', target_id: target, reason: 'inaccurate', detail: '', request_id: uid(30) };
  await f.request('community/reports/', 'POST', payload); await f.request('community/reports/', 'POST', { ...payload, request_id: uid(31) });
  await assert.rejects(f.request('community/reports/', 'POST', { ...payload, target_id: other, request_id: uid(31) }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(await f.store.count('community_reports'), 1);
});

test('cloud dispatcher wires trusted SDK identity and never forwards client-supplied identity to safety', async () => {
  const { createApp } = require('../../cloudfunctions/hyhqApi');
  const store = new MemoryStore(), payloads = [], identity = { APPID: 'trusted-app', OPENID: 'trusted-openid-123456' };
  const config = { appId: identity.APPID, management: { enabled: true, adminUserIds: [] }, community: { mode: 'official-editorial', feedbackEnabled: true, feedbackQualificationConfirmed: true, feedbackQualificationReference: 'verified editorial fixture', feedbackQualificationDate: '2026-10-01', enabled: true, qualificationConfirmed: true, qualificationReference: 'test fixture', qualificationDate: '2026-10-01', moderationReady: true } };
  const cloud = { openapi: { security: { msgSecCheck: async payload => { payloads.push(payload); return { errCode: 0, result: { suggest: 'pass' } }; } } } };
  config.community.mode = 'public-community';
  const now = '2026-10-07T12:00:00Z', dispatch = createApp({ store, cloud, config, now: () => now });
  const login = await dispatch({ path: '/api/v1/auth/wechat/', method: 'POST', body: { code: 'valid-test-code' } }, identity);
  assert.equal(login.statusCode, 200); const { token, user } = login.data.data; config.management.adminUserIds = [user.id];
  await store.set('admin_config', 'community_safety', { app_id: config.appId, checked_at: now });
  const headers = { Authorization: 'Bearer ' + token };
  const result = await dispatch({ path: '/api/v1/community/comments/', method: 'POST', headers, OPENID: 'forged-client-value',
    body: { body: '自然观察文字', kind: 'content', target_id: seed.collections.contents[0].id, request_id: uid(80) } }, identity);
  assert.equal(result.statusCode, 201); assert.equal(result.data.data.status, 'pending'); assert.equal(payloads.length, 1);
  assert.equal(payloads[0].openid, identity.OPENID); assert.equal(payloads[0].version, 2); assert.equal(payloads[0].scene, 2);
  assert.equal(JSON.stringify(result).includes(identity.OPENID), false);
});

test('deactivated author immediately disappears from catalogue and RAG even if cleanup fails midway', async () => {
  const f = await fixture(), approved = await f.review(await f.submit(await f.draft()));
  const article = await catalog.getPublicItem(f.context(''), 'contents', approved.id); assert.equal(article._community_owner_id, undefined);
  await f.store.update('users', f.author.id, { is_active: false });
  assert.ok(await f.store.get('catalog', 'contents_' + approved.id));
  assert.equal(await catalog.getPublicItem(f.context(''), 'contents', approved.id), null);
  await assert.rejects(catalog.getContext(f.context(''), 'content', approved.id), code('SOURCE_UNAVAILABLE'));
});

test('route or parent region withdrawal during safety check cannot leave an approvable comment', async () => {
  for (const withdrawal of ['route', 'region']) {
    let finish, signal; const started = new Promise(resolve => { signal = resolve; });
    const f = await fixture({ check: () => { signal(); return new Promise(resolve => { finish = resolve; }); } }), route = seed.collections.routes[0];
    f.config.community.mode = 'public-community';
    const pending = f.request('community/comments/', 'POST', { kind: 'route', target_id: route.id, body: '观察沿途自然', request_id: uid(110) }); await started;
    if (withdrawal === 'route') await f.store.set('catalog', 'routes_' + route.id, { id: 'routes_' + route.id, kind: 'routes', value: { ...route, published: false } });
    else await f.store.set('catalog', 'regions_' + route.region, { id: 'regions_' + route.region, kind: 'regions', deleted: true });
    finish({ errCode: 0, result: { suggest: 'pass' } }); const result = (await pending).data.data; assert.equal(result.status, 'rejected');
    await assert.rejects(f.request(`personal-admin/community/comments/${result.id}/review/`, 'POST', { decision: 'approved', expected_version: result.version }, { user: f.admin }), code('SUBMISSION_CHANGED'));
  }
});

test('publication obeys shared catalogue capacity and rejects a changed capacity snapshot', async () => {
  const f = await fixture(), pending = await f.submit(await f.draft()), count = f.store.count.bind(f.store);
  f.store.count = async (kind, where) => kind === 'catalog' ? 4900 : count(kind, where);
  await assert.rejects(f.review(pending), code('CATALOG_LIMIT')); assert.equal((await f.store.get('community_submissions', pending.id)).status, 'pending');
  f.store.count = async (kind, where) => { if (kind === 'catalog') { await f.store.set('admin_config', 'catalog_revision', { revision: 1 }); return 4899; } return count(kind, where); };
  await assert.rejects(f.review(pending), code('ADMIN_REVISION_CHANGED'));
  f.store.count = count; assert.equal((await f.review(pending)).status, 'approved');
});

test('editorial mode defaults closed and cannot borrow public-comment qualification', async () => {
  const config = configFromEnvironment({ HYHQ_COMMUNITY_ENABLED: 'true', HYHQ_COMMUNITY_QUALIFIED: 'true', HYHQ_FEEDBACK_ENABLED: 'true' });
  assert.equal(config.community.mode, 'official-editorial'); assert.equal(config.community.feedbackQualificationConfirmed, false);
  const f = await fixture(); f.config.community.feedbackQualificationConfirmed = false;
  assert.equal(await community.feedbackEnabled(f.context('')), false); assert.equal(await community.enabled(f.context('')), false);
  await assert.rejects(f.submit(await f.draft()), code('COMMUNITY_DISABLED'));
  f.config.community.feedbackQualificationConfirmed = true;
  const status = (await f.request('community/status/')).data.data;
  assert.equal(status.submissions_enabled, true); assert.equal(status.comments_enabled, false); assert.equal(status.enabled, false);
  await assert.rejects(f.request('community/comments/', 'POST', { kind: 'content', target_id: seed.collections.contents[0].id, body: '不得开放评论', request_id: uid(120) }), code('COMMUNITY_DISABLED'));
  await assert.rejects(f.request('community/comments/?kind=content&target_id=' + seed.collections.contents[0].id), code('COMMUNITY_DISABLED'));
});

test('editorial publication requires changed content and checks exactly revised title body source', async () => {
  const seen = [], f = await fixture({ check: async payload => { seen.push(payload); return { errcode: 0, result: { suggest: 'pass' } }; } });
  const draft = await f.draft(), pending = await f.submit(draft), url = `personal-admin/community/submissions/${draft.id}/review/`;
  const base = { decision: 'approved', expected_version: pending.version, request_id: uid(121) };
  await assert.rejects(f.request(url, 'POST', base, { user: f.admin }), code('VALIDATION_ERROR'));
  await assert.rejects(f.request(url, 'POST', { ...base, edited_title: '编辑稿', edited_body: ' ' + draft.body + '\n', edited_source: '可靠公开来源' }, { user: f.admin }), code('VALIDATION_ERROR'));
  assert.equal(f.calls(), 1);
  const edited = { ...base, edited_title: '官方观察建议', edited_body: '观察树叶时保持距离，可记录形状与颜色，不采集样本。', edited_source: '经编辑核实的植物科普公开资料' };
  const published = (await f.request(url, 'POST', edited, { user: f.admin })).data.data;
  const repeated = (await f.request(url, 'POST', edited, { user: f.admin })).data.data;
  assert.equal(published.status, 'approved'); assert.equal(repeated.version, published.version); assert.equal(f.calls(), 2);
  assert.deepEqual(seen[1], { content: [edited.edited_title, edited.edited_body, edited.edited_source].join('\n'), version: 2, scene: 3 });
  const stored = await f.store.get('catalog', 'contents_' + draft.id);
  assert.equal(stored.value.body, edited.edited_body); assert.equal(stored.value._editorial_feedback, true);
  assert.equal(stored.value.source, '官方编辑整理 · 来源：' + edited.edited_source);
  const owner = (await f.request(`community/submissions/${draft.id}/`)).data.data;
  assert.equal(owner.body, draft.body); assert.equal(owner.editorial, undefined); assert.equal(owner.original_private, true);
  await assert.rejects(f.request('community/submissions/' + draft.id + '/', 'GET', {}, { user: f.other }), code('NOT_FOUND'));
  await assert.rejects(f.request(url, 'POST', { ...edited, edited_body: '更改后的正文' }, { user: f.admin }), code('IDEMPOTENCY_CONFLICT'));
});

test('unsafe revised text remains private even when original passed and admin approved it', async () => {
  for (const outcome of ['risky', 'review', 'unavailable']) {
    let calls = 0;
    const f = await fixture({ check: async () => ({ errcode: 0, result: { suggest: ++calls === 1 ? 'pass' : outcome } }) });
    const result = await f.review(await f.submit(await f.draft()));
    assert.equal(result.status, 'pending'); assert.equal(result.editorial_safety_status, outcome); assert.equal(await f.store.count('catalog'), 0);
    assert.equal((await f.store.get('community_safety_days', '2026-10-07')).count, 2);
  }
});

test('withdrawal deletion reviewer revocation and gate closure during edited check cannot publish', async () => {
  for (const action of ['withdraw', 'delete', 'author-delete', 'reviewer-revoke', 'close']) {
    let finish, signal, calls = 0; const started = new Promise(resolve => { signal = resolve; });
    const f = await fixture({ check: async () => {
      if (++calls === 1) return { errcode: 0, result: { suggest: 'pass' } };
      signal(); return new Promise(resolve => { finish = resolve; });
    } });
    const pending = await f.submit(await f.draft()), review = f.review(pending); await started;
    if (action === 'withdraw') await f.request(`community/submissions/${pending.id}/withdraw/`, 'POST', { expected_version: pending.version + 1 });
    if (action === 'delete') await f.request(`community/submissions/${pending.id}/`, 'DELETE', { expected_version: pending.version + 1 });
    if (action === 'author-delete') await f.store.update('users', f.author.id, { is_active: false });
    if (action === 'reviewer-revoke') f.config.management.adminUserIds = [];
    if (action === 'close') f.config.community.feedbackEnabled = false;
    finish({ errcode: 0, result: { suggest: 'pass' } });
    if (action === 'close') assert.equal((await review).status, 'pending'); else await assert.rejects(review);
    assert.equal(await f.store.count('catalog'), 0, action);
  }
});

test('concurrent editorial approvals share one safety reservation and never overwrite each other', async () => {
  let finish, signal, calls = 0; const started = new Promise(resolve => { signal = resolve; });
  const f = await fixture({ check: async () => {
    if (++calls === 1) return { errcode: 0, result: { suggest: 'pass' } };
    signal(); return new Promise(resolve => { finish = resolve; });
  } });
  const pending = await f.submit(await f.draft()), first = f.review(pending); await started;
  const duplicate = await f.review(pending); assert.equal(duplicate.status, 'reviewing'); assert.equal(calls, 2);
  await assert.rejects(f.request(`personal-admin/community/submissions/${pending.id}/review/`, 'POST', {
    decision: 'approved', expected_version: pending.version, request_id: uid(130), edited_title: '并发编辑', edited_body: '另一份编辑整理的正文', edited_source: '可靠公开来源',
  }, { user: f.admin }), code('SUBMISSION_CHANGED'));
  finish({ errcode: 0, result: { suggest: 'pass' } }); assert.equal((await first).status, 'approved');
  assert.equal(await f.store.count('catalog'), 1);
});

test('original legacy publications are never eligible for public catalogue or RAG', async () => {
  const f = await fixture();
  for (const mode of ['official-editorial', 'public-community']) {
    f.config.community.mode = mode;
    assert.equal(await community.publicationEnabled(f.context(''), { _community_submission: true }), false);
  }
});

test('edited safety quota and final storage failure remain charged and leave a retryable private record', async () => {
  const f = await fixture(), pending = await f.submit(await f.draft());
  await f.store.set('community_safety_days', '2026-10-07', { count: 80 });
  await assert.rejects(f.review(pending), code('CONTENT_SAFETY_UNAVAILABLE'));
  assert.equal((await f.store.get('community_submissions', pending.id)).status, 'pending'); assert.equal(f.calls(), 1);
  await f.store.set('community_safety_days', '2026-10-07', { count: 1 });
  const originalTransaction = f.store.transaction.bind(f.store); let failAudit = true;
  f.store.transaction = fn => originalTransaction(async tx => {
    const create = tx.create.bind(tx);
    tx.create = async (kind, id, value) => { if (kind === 'admin_audit' && value.action === 'community_approved' && failAudit) { failAudit = false; throw new Error('audit write failed'); } return create(kind, id, value); };
    return fn(tx);
  });
  await assert.rejects(f.review(pending), /audit write failed/);
  const recovered = await f.store.get('community_submissions', pending.id);
  assert.equal(recovered.status, 'pending'); assert.equal(recovered.version, pending.version + 2);
  assert.equal(await f.store.count('catalog'), 0); assert.equal((await f.store.get('community_safety_days', '2026-10-07')).count, 2);
  const duplicate = await f.review(pending); assert.equal(duplicate.status, 'pending'); assert.equal(f.calls(), 2);
  // A refreshed, deliberately retried review uses a new version/request key.
  const nextTime = '2026-10-07T12:01:01Z';
  const retry = (await f.request(`personal-admin/community/submissions/${pending.id}/review/`, 'POST', {
    decision: 'approved', expected_version: recovered.version, request_id: uid(140), edited_title: '核实后的文章', edited_body: '记录树木叶形时避免攀折，采用远距离观察和摄影。', edited_source: '编辑核实的公开来源',
  }, { user: f.admin, now: nextTime })).data.data;
  assert.equal(retry.status, 'approved'); assert.equal((await f.store.get('community_safety_days', '2026-10-07')).count, 3);
});

test('catalogue capacity read failure after edited safety restores private pending state', async () => {
  const f = await fixture(), pending = await f.submit(await f.draft()), count = f.store.count.bind(f.store); let calls = 0;
  f.store.count = async (kind, where) => { if (kind === 'catalog' && ++calls === 2) throw new Error('catalogue unavailable'); return count(kind, where); };
  await assert.rejects(f.review(pending), /catalogue unavailable/);
  const current = await f.store.get('community_submissions', pending.id);
  assert.equal(current.status, 'pending'); assert.equal(current.editorial_safety_status, 'pass'); assert.equal(await count('catalog'), 0);
});
