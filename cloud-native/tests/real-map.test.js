'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const catalog = require('../../cloudfunctions/hyhqApi/lib/catalog');
const management = require('../../cloudfunctions/hyhqApi/lib/management');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-07T12:00:00Z';
const tj = snapshot.collections.regions.find(row => row.slug === 'tianjin-nature');
const bj = snapshot.collections.regions.find(row => row.slug === 'beijing-nature');
const demo = snapshot.collections.regions.find(row => row.is_demo);
// Synthetic geometry is only a test fixture; never copy these positions into production data.
const river = () => ({ id: uid(2), slug: 'test-river', name: '测试河道', region: tj.id, is_published: true,
  description: '仅测试', coordinate_system: 'GCJ02', geometry_verified: true,
  path: [{ latitude: 39.1, longitude: 117.1 }, { latitude: 39.11, longitude: 117.12 }],
  source_url: 'https://example.org/source', source_note: '测试来源', checked_at: '2026-10-07', access_note: '测试中不进行真实导航' });
const place = () => ({ id: uid(3), slug: 'test-point', name: '测试地点', kind: 'park', region: tj.id,
  description: '仅测试', is_published: true, is_demo: false, coordinate_system: 'GCJ02',
  latitude: 39.1, longitude: 117.1, coordinates_verified: true, source_url: 'https://example.org/point', checked_at: '2026-10-07' });
async function fixture() {
  const store = new MemoryStore(), user = { id: uid(1), is_active: true, quota_key: 'test' };
  await store.set('users', user.id, user);
  const config = { catalogSeed: { schema_version: 1, collections: { regions: [tj, bj, demo], places: [place()], rivers: [river()] } }, management: { enabled: true, adminUserIds: [user.id] } };
  const context = (path, query = '', method = 'GET', body) => ({ path, query: new URLSearchParams(query), method, body, store, config, user, now });
  return { store, config, context, read: async (path, query) => (await catalog.handle(context(path, query))).data.data,
    edit: async (path, method, body) => (await management.handle(context('personal-admin/catalog/' + path, '', method, body))).data.data };
}
test('real city map metadata reuses existing regions without publishing new places or draft imports', async () => {
  const app = await fixture();
  assert.equal(tj.real_map.coordinate_system, 'GCJ02'); assert.equal(bj.real_map.coordinate_system, 'GCJ02');
  assert.equal(snapshot.collections.rivers.length, 0);
  assert.ok(snapshot.collections.places.every(row => row.coordinates_verified !== true));
  await app.store.set('content_drafts', 'draft-only', { title: '隐藏原稿', published: false });
  const context = await catalog.getContext(app.context('regions/'), 'region', tj.id);
  assert.equal(JSON.stringify(context).includes('隐藏原稿'), false);
});
test('river public reads filter by city, publication, geometry, source and coordinate system', async () => {
  const app = await fixture();
  assert.equal((await app.read('rivers/', 'region=' + tj.id)).length, 1);
  assert.deepEqual(await app.read('rivers/', 'region=' + bj.id), []);
  for (const change of [{ is_published: false }, { is_demo: true }, { geometry_verified: false }, { coordinate_system: 'WGS84' }, { source_url: '' }, { checked_at: '2026-02-30' }, { path: [{ latitude: 0, longitude: 0 }] }, { region: demo.id }]) {
    app.config.catalogSeed.collections.rivers = [{ ...river(), ...change }];
    assert.deepEqual(await app.read('rivers/'), []);
    await assert.rejects(app.read('rivers/' + uid(2) + '/'), e => e.code === 'NOT_FOUND');
  }
});
test('legacy places remain readable but lose navigation verification without valid reviewed coordinates', async () => {
  const app = await fixture();
  assert.equal((await app.read('places/' + uid(3) + '/')).coordinates_verified, true);
  for (const change of [{ coordinates_verified: false }, { coordinate_system: 'BD09' }, { checked_at: '' }, { latitude: null }, { is_demo: true }, { region: demo.id }]) {
    app.config.catalogSeed.collections.places = [{ ...place(), ...change }];
    assert.equal((await app.read('places/' + uid(3) + '/')).coordinates_verified, false);
  }
});
test('river admin draft, checked publication, withdrawal and RAG revision follow one catalogue', async () => {
  const app = await fixture(); app.config.catalogSeed.collections.rivers = [];
  const { id, is_published, ...value } = river();
  const draft = await app.edit('rivers/', 'POST', { value: { ...value, geometry_verified: false }, expected_revision: 0 });
  assert.equal(draft.published, false); assert.deepEqual(await app.read('rivers/'), []);
  await assert.rejects(app.edit(`rivers/${draft.id}/`, 'PATCH', { value: {}, publish: true, expected_revision: 1 }), e => e.code === 'VALIDATION_ERROR');
  await app.edit(`rivers/${draft.id}/`, 'PATCH', { value: { geometry_verified: true }, publish: true, expected_revision: 1 });
  assert.equal((await app.read('rivers/')).length, 1);
  const before = await catalog.getContext(app.context('regions/'), 'region', tj.id);
  assert.equal(before.context.rivers[0].name, value.name); assert.equal('path' in before.context.rivers[0], false);
  await app.edit(`rivers/${draft.id}/`, 'DELETE', { expected_revision: 2 });
  assert.deepEqual(await app.read('rivers/'), []);
  const after = await catalog.getContext(app.context('regions/'), 'region', tj.id);
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.context.rivers.length, 0);
});
test('coordinate changes require a new verification and cannot reuse old approval silently', async () => {
  const app = await fixture();
  const changed = await app.edit(`places/${uid(3)}/`, 'PATCH', { value: { latitude: 39.2 }, expected_revision: 0 });
  assert.equal(changed.value.coordinates_verified, false);
  assert.equal((await app.read('places/' + uid(3) + '/')).coordinates_verified, false);
  await assert.rejects(app.edit(`places/${uid(3)}/`, 'PATCH', { value: { coordinates_verified: true, checked_at: '2099-01-01' }, expected_revision: 1 }), e => e.code === 'VALIDATION_ERROR');
  await assert.rejects(app.edit(`rivers/${uid(2)}/`, 'PATCH', { value: { path: river().path }, expected_revision: 1 }), e => e.code === 'VALIDATION_ERROR');
  const draft = await app.edit(`rivers/${uid(2)}/`, 'PATCH', { value: { path: river().path }, publish: false, expected_revision: 1 });
  assert.equal(draft.value.geometry_verified, false);
});
