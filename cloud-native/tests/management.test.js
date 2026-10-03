'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const management = require('../../cloudfunctions/hyhqApi/lib/management');
const catalog = require('../../cloudfunctions/hyhqApi/lib/catalog');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-03T12:00:00Z';
const code = (wanted) => (error) => error.code === wanted;
async function fixture(seed = snapshot) {
  const store = new MemoryStore(), owner = { id: uid(1), is_active: true, quota_key: 'private-stable-identity', record_revision: 0 }, other = { ...owner, id: uid(2) };
  await store.set('users', owner.id, owner); await store.set('users', other.id, other);
  const config = { catalogSeed: seed, management: { enabled: true, adminUserIds: [owner.id] }, qweatherMonthlyLimit: 12000 };
  const context = (path, method = 'GET', body, options = {}) => ({ path, method, body, query: new URLSearchParams(), user: owner, store, now, config, ...options });
  return { store, owner, other, config, context, request: (path, method, body, options) => management.handle(context('personal-admin/' + path, method, body, options)) };
}
const article = (slug = 'test-field-guide') => ({ title: '资料管理测试', slug, body: '可核对的科普正文', category: 'green', summary: '摘要', source: '公开来源 https://example.org/guide', is_demo: false });
function simulationSeed(count = 4) {
  const collections = structuredClone(snapshot.collections);
  const source = collections.data_sources.find((row) => row.code === 'demo-normal');
  const station = collections.stations.find((row) => row.kind === 'water');
  const metric = collections.metrics.find((row) => row.station_kind === station.kind);
  collections.simulation_runs = Array.from({ length: count }, (_, i) => ({ id: uid(100 + i), source,
    scenario: { code: 'normal', name: '正常波动' }, start: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    end: `2026-01-${String(i + 2).padStart(2, '0')}T00:00:00Z`, created_at: `2026-01-${String(i + 2).padStart(2, '0')}T01:00:00Z`, counts: 1, generator_version: 'hourly-v1' }));
  collections.observations = collections.simulation_runs.map((run, i) => ({ id: uid(200 + i), station_id: station.id, station_code: station.code,
    metric_code: metric.code, source_id: source.id, simulation_run_id: run.id, value: 7, quality_status: 'valid', observed_at: run.start,
    ingested_at: run.created_at, is_simulated: true }));
  return { schema_version: 1, collections };
}

test('management is closed by default and client role flags never authorize it', async () => {
  const app = await fixture();
  assert.equal((await app.request('status/', 'GET', undefined, { config: {} })).data.data.enabled, false);
  await assert.rejects(app.request('stats/', 'GET', undefined, { config: {} }), code('MANAGEMENT_DISABLED'));
  await assert.rejects(app.request('stats/', 'GET', undefined, { user: null }), (error) => error.status === 401);
  const forged = { ...app.other, is_staff: true, is_superuser: true, role: 'admin' };
  assert.equal((await app.request('status/', 'GET', undefined, { user: forged })).data.data.enabled, false);
  await assert.rejects(app.request('stats/', 'GET', undefined, { user: forged }), code('FORBIDDEN'));
  await app.store.update('users', app.owner.id, { is_active: false });
  await assert.rejects(app.request('stats/'), code('AUTH_REQUIRED'));
});

test('catalogue creation remains draft until explicitly published with a source', async () => {
  const app = await fixture();
  const draft = (await app.request('catalog/contents/', 'POST', { value: { ...article(), source: '' }, expected_revision: 0 })).data.data;
  assert.equal(draft.published, false); assert.equal(draft.revision, 1);
  assert.equal(await catalog.getPublicItem(app.context('contents/'), 'contents', draft.id), null);
  await assert.rejects(app.request(`catalog/contents/${draft.id}/`, 'PATCH', { value: {}, publish: true, expected_revision: 1 }), code('VALIDATION_ERROR'));
  const published = (await app.request(`catalog/contents/${draft.id}/`, 'PATCH', { value: { source: '植物园公开资料' }, publish: true, expected_revision: 1 })).data.data;
  assert.equal(published.published, true); assert.equal(published.revision, 2);
  assert.equal((await catalog.getPublicItem(app.context('contents/'), 'contents', draft.id)).source, '植物园公开资料');
  const detail = (await app.request(`catalog/contents/${draft.id}/`)).data.data;
  assert.equal(detail.value.body, article().body); assert.equal(detail.revision, 2);
  const list = await app.request('catalog/contents/');
  assert.equal(list.data.meta.revision, 2); assert.equal(list.data.data.some((row) => 'body' in row), false);
});

test('published withdrawal and restoration change retrieval and AI sources immediately', async () => {
  const app = await fixture(), content = snapshot.collections.contents[0];
  const ctx = app.context('contents/'); const before = await catalog.getContext(ctx, 'content', content.id);
  await app.request(`catalog/contents/${content.id}/`, 'DELETE', { expected_revision: 0 });
  await assert.rejects(catalog.getContext(ctx, 'content', content.id), code('SOURCE_UNAVAILABLE'));
  assert.equal((await app.request(`catalog/contents/${content.id}/`)).data.data.deleted, true);
  await app.request(`catalog/contents/${content.id}/`, 'PATCH', { value: { title: '重新核实后的科普' }, publish: true, expected_revision: 1 });
  const after = await catalog.getContext(ctx, 'content', content.id);
  assert.notEqual(after.revision, before.revision); assert.equal(after.title, '重新核实后的科普');
});

test('revision checks stop concurrent lost updates and roll back audit with failed mutations', async () => {
  const app = await fixture(), id = snapshot.collections.contents[0].id;
  const replies = await Promise.allSettled(['甲', '乙'].map((title) => app.request(`catalog/contents/${id}/`, 'PATCH', { value: { title }, expected_revision: 0 })));
  assert.equal(replies.filter((reply) => reply.status === 'fulfilled').length, 1);
  assert.equal(replies.find((reply) => reply.status === 'rejected').reason.code, 'ADMIN_REVISION_CHANGED');
  assert.equal(await app.store.count('admin_audit'), 1);
  const original = app.store.transaction.bind(app.store);
  app.store.transaction = (fn) => original(async (tx) => { await fn(tx); throw new Error('rollback'); });
  await assert.rejects(app.request(`catalog/contents/${id}/`, 'DELETE', { expected_revision: 1 }), /rollback/);
  assert.equal((await app.store.get('admin_config', 'catalog_revision')).revision, 1); assert.equal(await app.store.count('admin_audit'), 1);
  assert.notEqual(await catalog.getPublicItem(app.context('contents/'), 'contents', id), null);
});

test('catalogue read cannot pair stale text with a newer revision during concurrent edits', async () => {
  const app = await fixture(), item = snapshot.collections.contents[0], original = app.store.list.bind(app.store);
  let raced = false;
  app.store.list = async (...args) => {
    const rows = await original(...args);
    if (!raced && args[0] === 'catalog') {
      raced = true;
      await app.store.set('catalog', 'contents_' + item.id, { id: 'contents_' + item.id, kind: 'contents', value: { ...item, body: '另一个管理员刚保存的正文' } });
      await app.store.set('admin_config', 'catalog_revision', { id: 'catalog_revision', revision: 1 });
    }
    return rows;
  };
  await assert.rejects(app.request(`catalog/contents/${item.id}/`), code('ADMIN_REVISION_CHANGED'));
  const fresh = (await app.request(`catalog/contents/${item.id}/`)).data.data;
  assert.equal(fresh.value.body, '另一个管理员刚保存的正文'); assert.equal(fresh.revision, 1);
});

test('retention read rejects old policy combined with a concurrent newer revision', async () => {
  const app = await fixture(), original = app.store.get.bind(app.store); let raced = false;
  app.store.get = async (...args) => {
    const row = await original(...args);
    if (!raced && args[0] === 'admin_config' && args[1] === 'simulation_retention') {
      raced = true;
      await app.store.set('admin_config', 'simulation_retention', { id: 'simulation_retention', retain_days: 60, keep_successful: 5 });
      await app.store.set('admin_config', 'catalog_revision', { id: 'catalog_revision', revision: 1 });
    }
    return row;
  };
  await assert.rejects(app.request('simulation/retention/'), code('ADMIN_REVISION_CHANGED'));
  assert.deepEqual((await app.request('simulation/retention/')).data.data, { retain_days: 60, keep_successful: 5, revision: 1 });
});

test('fresh administrator identity is rechecked inside every write transaction', async () => {
  const app = await fixture(), original = app.store.transaction.bind(app.store);
  app.store.transaction = async (fn) => { await app.store.update('users', app.owner.id, { is_active: false }); return original(fn); };
  await assert.rejects(app.request('catalog/contents/', 'POST', { value: article(), expected_revision: 0 }), code('AUTH_REQUIRED'));
  assert.equal(await app.store.count('catalog'), 0); assert.equal(await app.store.count('admin_audit'), 0);
});

test('catalogue writes reject private/immutable fields, duplicate slugs and invalid coordinate semantics', async () => {
  const app = await fixture();
  for (const value of [{ ...article(), owner_id: app.owner.id }, { ...article(), status: 'published' }, { ...article(), category: 'forged' }, { ...article(), place: uid(999) }])
    await assert.rejects(app.request('catalog/contents/', 'POST', { value, expected_revision: 0 }), code('VALIDATION_ERROR'));
  await assert.rejects(app.request('catalog/contents/', 'POST', { value: { ...article(), slug: snapshot.collections.contents[0].slug }, expected_revision: 0 }), code('VALIDATION_ERROR'));
  const place = snapshot.collections.places.find((row) => !row.water_body_id);
  for (const change of [{ coordinate_system: 'UNKNOWN', latitude: null, longitude: null }, { latitude: 39, longitude: null }, { latitude: 120, longitude: 30, coordinate_system: 'WGS84' }, { x_ratio: 0.5, y_ratio: 0.5, map_layout: null }, { region: snapshot.collections.regions.find((row) => row.id !== place.region).id }])
    await assert.rejects(app.request(`catalog/places/${place.id}/`, 'PATCH', { value: change, expected_revision: 0 }), code('VALIDATION_ERROR'));
  assert.equal(await app.store.count('admin_audit'), 0);
});

test('route stop edits resolve only same-region public places with unique order', async () => {
  const app = await fixture(), route = snapshot.collections.routes[0];
  const place = snapshot.collections.places.find((row) => row.region === route.region);
  const foreign = snapshot.collections.places.find((row) => row.region !== route.region);
  for (const stops of [[{ order: 1, place_id: foreign.id }], [{ order: 1, place_id: place.id }, { order: 1, place_id: place.id }], [{ order: 1, place_id: place.id, body: 'unexpected' }]])
    await assert.rejects(app.request(`catalog/routes/${route.id}/`, 'PATCH', { value: { stops }, expected_revision: 0 }), code('VALIDATION_ERROR'));
  const edited = (await app.request(`catalog/routes/${route.id}/`, 'PATCH', { value: { stops: [{ order: 1, place_id: place.id, note: '观赏点' }] }, expected_revision: 0 })).data.data;
  assert.equal(edited.value.stop_count, 1); assert.equal(edited.value.stops[0].place.name, place.name);
});

test('audit records only hashes, field names and counts, retaining no text or login identity', async () => {
  const app = await fixture();
  const draft = (await app.request('catalog/contents/', 'POST', { value: article(), expected_revision: 0 })).data.data;
  const audit = (await app.request('audit/')).data.data;
  assert.equal(audit.length, 1); assert.equal(audit[0].target_id, draft.id); assert.match(audit[0].actor_ref, /^[a-f0-9]{64}$/);
  const json = JSON.stringify(audit);
  for (const secret of [app.owner.id, app.owner.quota_key, article().body, article().title, article().source]) assert.equal(json.includes(secret), false);
  await app.store.remove('users', app.owner.id); assert.equal(await app.store.count('admin_audit'), 1);
});

test('feedback processing does not expose owner IDs and stores audit without reply content', async () => {
  const app = await fixture(), id = uid(10);
  await app.store.set('feedback', id, { id, owner_id: app.other.id, body: '一个建议', status: 'pending', reply: '', created_at: now, resolved_at: null });
  const pending = await app.request('feedback/', 'GET', undefined, { query: new URLSearchParams('status=pending') });
  assert.equal(pending.data.meta.count, 1); assert.equal('owner_id' in pending.data.data[0], false);
  await assert.rejects(app.request(`feedback/${id}/resolve/`, 'POST', { reply: ' ', expected_revision: 0 }), code('VALIDATION_ERROR'));
  const result = await app.request(`feedback/${id}/resolve/`, 'POST', { reply: '  已确认并修订  ', expected_revision: 0 });
  assert.equal(result.data.data.status, 'resolved'); assert.equal((await app.store.get('feedback', id)).reply, '已确认并修订');
  assert.equal(JSON.stringify((await app.request('audit/')).data).includes('已确认并修订'), false);
});

test('statistics use active owners, published catalogue, visible job states and actual local usage ledgers', async () => {
  const app = await fixture(); await app.store.update('users', app.other.id, { is_active: false });
  await app.store.set('recognition_jobs', uid(11), { id: uid(11), visible: true, status: 'succeeded' });
  await app.store.set('recognition_jobs', uid(12), { id: uid(12), visible: false, status: 'succeeded' });
  await app.store.set('weather_gate', 'budget', { days: { '2026-09-05': 20, '2026-10-02': 8, '2026-10-03': 3 } });
  await app.store.set('llm_days', '2026-10-03', { attempts: 4, accounted_tokens: 256, reserved_tokens: 40 });
  const data = (await app.request('stats/')).data.data;
  assert.equal(data.users_active, 1); assert.equal(data.jobs.recognition_jobs.visible_total, 1);
  assert.equal(data.public_catalog.contents, snapshot.collections.contents.length);
  assert.deepEqual(data.llm_today, { day: '2026-10-03', attempts: 4, accounted_tokens: 256, reserved_tokens: 40 });
  assert.equal(data.weather_budget.calendar_month_requests, 11); assert.equal(data.weather_budget.rolling_31_days_requests, 31);
  assert.equal(data.weather_budget.environment_limit, 12000); assert.match(data.counting_note, /不是供应商结算/);
});

test('retention validates limits, requires the current revision, and records policy changes', async () => {
  const app = await fixture(simulationSeed());
  assert.deepEqual((await app.request('simulation/retention/')).data.data, { retain_days: 90, keep_successful: 3, revision: 0 });
  for (const policy of [{ retain_days: 29, keep_successful: 1 }, { retain_days: 3651, keep_successful: 1 }, { retain_days: 30, keep_successful: 0 }, { retain_days: 30, keep_successful: 101 }])
    await assert.rejects(app.request('simulation/retention/', 'PUT', { ...policy, expected_revision: 0 }), code('VALIDATION_ERROR'));
  const policy = await app.request('simulation/retention/', 'PUT', { retain_days: 30, keep_successful: 1, expected_revision: 0 });
  assert.equal(policy.data.data.revision, 1); assert.equal((await app.request('audit/')).data.data[0].action, 'retention_updated');
  await assert.rejects(app.request('simulation/retention/', 'PUT', { retain_days: 60, keep_successful: 1, expected_revision: 0 }), code('ADMIN_REVISION_CHANGED'));
});

test('cleanup withdraws whole expired simulated batches and public observations without per-row storage', async () => {
  const app = await fixture(simulationSeed());
  const preview = (await app.request('simulation/cleanup-preview/')).data.data;
  assert.equal(preview.selected_run_count, 1); assert.equal(preview.selected_observation_count, 1);
  assert.equal(preview.protected.length, 3); assert.equal(preview.candidates[0].id, uid(100));
  const result = await app.request('simulation/cleanup/', 'POST', { fingerprint: preview.fingerprint, expected_revision: preview.revision });
  assert.equal(result.data.data.withdrawn_runs, 1); assert.equal(result.data.data.hidden_observations, 1);
  const publicData = await catalog.loadCatalog(app.context('observations/'));
  assert.equal(publicData.simulation_runs.length, 3); assert.equal(publicData.observations.length, 3);
  const overrides = await app.store.list('catalog'); assert.equal(overrides.length, 1);
  assert.equal(overrides[0].kind, 'simulation_runs'); assert.equal(overrides[0].deleted, true);
  await assert.rejects(app.request('simulation/cleanup/', 'POST', { fingerprint: preview.fingerprint, expected_revision: 0 }), code('PREVIEW_CHANGED'));
});

test('preview protects latest-per-station, nonstandard generators and inconsistent or invalid simulated scope', async () => {
  for (const modification of ['station_latest', 'generator', 'count', 'time', 'metric']) {
    const seed = simulationSeed(), first = seed.collections.simulation_runs[0], row = seed.collections.observations[0];
    if (modification === 'station_latest') row.station_id = seed.collections.stations.find((station) => station.kind === 'water' && station.id !== row.station_id).id;
    if (modification === 'generator') first.generator_version = 'unknown';
    if (modification === 'count') first.counts = 1000;
    if (modification === 'time') row.observed_at = 'not-a-date';
    if (modification === 'metric') row.metric_code = seed.collections.metrics.find((metric) => metric.station_kind === 'air').code;
    const app = await fixture(seed), preview = (await app.request('simulation/cleanup-preview/')).data.data;
    assert.equal(preview.selected_run_count, 0, modification); assert.equal(preview.protected.some((run) => run.id === first.id), true);
  }
});

test('cleanup fingerprint changes when policy, catalogue or observed data change', async () => {
  const app = await fixture(simulationSeed()), preview = (await app.request('simulation/cleanup-preview/')).data.data;
  const original = app.config.catalogSeed.collections.simulation_runs[0];
  await app.store.set('catalog', 'simulation_runs_' + original.id, { id: 'simulation_runs_' + original.id, kind: 'simulation_runs', value: { ...original, counts: 2 } });
  await assert.rejects(app.request('simulation/cleanup/', 'POST', { fingerprint: preview.fingerprint, expected_revision: 0 }), code('PREVIEW_CHANGED'));
  assert.equal(await app.store.count('admin_audit'), 0);
});

test('real sources are excluded from cleanup and never turned into simulation tombstones', async () => {
  const seed = simulationSeed(), source = { ...seed.collections.data_sources[0], id: uid(901), kind: 'api', code: 'official' };
  seed.collections.data_sources.push(source);
  seed.collections.simulation_runs.push({ ...seed.collections.simulation_runs[0], id: uid(902), source });
  seed.collections.observations.push({ ...seed.collections.observations[0], id: uid(903), source_id: source.id, simulation_run_id: null, is_simulated: false });
  const app = await fixture(seed), preview = (await app.request('simulation/cleanup-preview/')).data.data;
  await app.request('simulation/cleanup/', 'POST', { fingerprint: preview.fingerprint, expected_revision: 0 });
  assert.equal(await app.store.get('catalog', 'simulation_runs_' + uid(902)), null);
  const data = await catalog.loadCatalog(app.context('observations/')); assert.equal(data.observations.some((row) => row.id === uid(903)), true);
});

test('large cleanup is bounded to twenty run tombstones and can continue from a fresh preview', async () => {
  const app = await fixture(simulationSeed(25));
  const preview = (await app.request('simulation/cleanup-preview/')).data.data;
  assert.equal(preview.total_eligible_count, 22); assert.equal(preview.selected_run_count, 20); assert.equal(preview.has_more, true);
  await app.request('simulation/cleanup/', 'POST', { fingerprint: preview.fingerprint, expected_revision: 0 });
  assert.equal(await app.store.count('catalog'), 20);
  const next = (await app.request('simulation/cleanup-preview/')).data.data;
  assert.equal(next.selected_run_count, 2); assert.equal(next.has_more, false); assert.equal(next.revision, 1);
});

test('administration paginates and filters audit/feedback with bounded queries', async () => {
  const app = await fixture();
  await app.request('catalog/contents/', 'POST', { value: article(), expected_revision: 0 });
  await app.request('catalog/contents/', 'POST', { value: article('second'), expected_revision: 1 });
  const page = await app.request('audit/', 'GET', undefined, { query: new URLSearchParams('action=catalog_created&page_size=1') });
  assert.equal(page.data.meta.count, 2); assert.equal(page.data.data.length, 1); assert.match(page.data.meta.next, /page=2/);
  for (const query of ['page_size=101', 'page=999', 'page=1&page=2', 'action=$or'])
    await assert.rejects(app.request('audit/', 'GET', undefined, { query: new URLSearchParams(query) }));
  assert.equal(await management.handle(app.context('unrelated/')), undefined);
});
