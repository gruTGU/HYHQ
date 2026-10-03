'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const activity = require('../../cloudfunctions/hyhqApi/lib/activity');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-03T12:00:00.000Z';
const place = snapshot.collections.places[0];
const content = snapshot.collections.contents[0];
async function fixture() {
  const store = new MemoryStore(), owner = { id: uid(1), is_active: true, record_history: true, record_revision: 0 }, other = { ...owner, id: uid(2) };
  await store.set('users', owner.id, owner); await store.set('users', other.id, other);
  const context = (path, method = 'GET', body, options = {}) => ({ path, method, body, query: new URLSearchParams(), user: owner, store, now, config: {}, ...options });
  return { store, owner, other, context, request: (path, method, body, options) => activity.handle(context(path, method, body, options)) };
}
const code = (expected) => (error) => error.code === expected;

test('activities always require login and fresh active identity', async () => {
  const app = await fixture();
  await assert.rejects(app.request('favorites/', 'POST', { place_id: place.id }, { user: null }), (error) => error.status === 401);
  await app.store.update('users', app.owner.id, { is_active: false });
  await assert.rejects(app.request('favorites/', 'POST', { place_id: place.id }), code('AUTH_REQUIRED'));
  await assert.rejects(app.request('histories/'), code('AUTH_REQUIRED'));
  assert.equal(await app.store.count('favorites'), 0);
});

test('favorites are transactional, owner-scoped and idempotent under concurrent requests', async () => {
  const app = await fixture();
  const requests = await Promise.all(Array.from({ length: 8 }, () => app.request('favorites/', 'POST', { place_id: place.id })));
  assert.equal(requests.filter((reply) => reply.statusCode === 201).length, 1);
  assert.equal(new Set(requests.map((reply) => reply.data.data.id)).size, 1);
  assert.equal(await app.store.count('favorites'), 1);
  const owner = await app.store.get('users', app.owner.id); assert.equal(owner.activity_counts.favorites, 1); assert.equal(owner.record_revision, 8);
  const other = await app.request('favorites/', 'POST', { place_id: place.id }, { user: app.other });
  assert.notEqual(other.data.data.id, requests[0].data.data.id);
  const list = await app.request('favorites/'); assert.equal(list.data.meta.count, 1);
  assert.deepEqual(list.data.data[0].place, { id: place.id, name: place.name }); assert.equal('owner_id' in list.data.data[0], false);
});

test('exactly one public target is required and visits cannot target articles', async () => {
  const app = await fixture();
  for (const body of [{}, { place_id: 'bad' }, { place_id: uid(90) }, { content_id: uid(90) }, { place_id: place.id, content_id: content.id }])
    await assert.rejects(app.request('favorites/', 'POST', body), code('VALIDATION_ERROR'));
  await assert.rejects(app.request('visits/', 'POST', { content_id: content.id }), code('VALIDATION_ERROR'));
  const article = await app.request('favorites/', 'POST', { content_id: content.id });
  assert.deepEqual(article.data.data.content, { id: content.id, title: content.title }); assert.equal(article.data.data.place, null);
});

test('withdrawn target is hidden in existing records and rejected on later writes', async () => {
  const app = await fixture(); await app.request('favorites/', 'POST', { content_id: content.id });
  await app.store.set('catalog', 'contents_' + content.id, { id: 'contents_' + content.id, kind: 'contents', deleted: true });
  const list = await app.request('favorites/'); assert.equal(list.data.data[0].content, null); assert.equal(list.data.data[0].content_id, content.id);
  await assert.rejects(app.request('favorites/', 'POST', { content_id: content.id }), code('VALIDATION_ERROR'));
});

test('withdrawal racing target validation is rechecked inside the transaction', async () => {
  const app = await fixture(); const original = app.store.transaction.bind(app.store);
  app.store.transaction = async (callback) => {
    await app.store.set('catalog', 'places_' + place.id, { id: 'places_' + place.id, kind: 'places', deleted: true });
    return original(callback);
  };
  await assert.rejects(app.request('favorites/', 'POST', { place_id: place.id }), code('VALIDATION_ERROR'));
  assert.equal(await app.store.count('favorites'), 0);
});

test('history revisits update viewed_at without duplicate rows and honor current privacy setting', async () => {
  const app = await fixture(); const first = await app.request('histories/', 'POST', { place_id: place.id });
  const nextTime = '2026-10-03T12:02:00Z';
  const second = await app.request('histories/', 'POST', { place_id: place.id }, { now: nextTime });
  assert.equal(first.statusCode, 201); assert.equal(second.statusCode, 200); assert.equal(second.data.data.id, first.data.data.id);
  assert.equal(second.data.data.viewed_at, nextTime); assert.equal(second.data.data.created_at, first.data.data.created_at);
  await app.store.update('users', app.owner.id, { record_history: false });
  await assert.rejects(app.request('histories/', 'POST', { place_id: place.id }), code('HISTORY_DISABLED'));
  assert.equal((await app.request('histories/')).data.meta.count, 1);
  await app.request(`histories/${first.data.data.id}/`, 'DELETE'); assert.equal(await app.store.count('histories'), 0);
});

test('privacy disable racing a write is observed in the user transaction', async () => {
  const app = await fixture(); const original = app.store.transaction.bind(app.store);
  app.store.transaction = async (callback) => {
    await app.store.update('users', app.owner.id, { record_history: false }); return original(callback);
  };
  await assert.rejects(app.request('histories/', 'POST', { place_id: place.id }), code('HISTORY_DISABLED'));
  assert.equal(await app.store.count('histories'), 0);
});

test('visits deduplicate by Shanghai day and remain distinct across local midnight', async () => {
  const app = await fixture(); const firstTime = '2026-10-03T15:59:59Z', secondTime = '2026-10-03T16:00:00Z';
  const first = await app.request('visits/', 'POST', { place_id: place.id }, { now: firstTime });
  const same = await app.request('visits/', 'POST', { place_id: place.id }, { now: firstTime });
  const next = await app.request('visits/', 'POST', { place_id: place.id }, { now: secondTime });
  assert.equal(same.statusCode, 200); assert.equal(first.data.data.visited_on, '2026-10-03'); assert.equal(next.data.data.visited_on, '2026-10-04');
  assert.notEqual(first.data.data.id, next.data.data.id); assert.equal(await app.store.count('visits'), 2);
});

test('cross-owner reads and deletions do not expose or remove personal records', async () => {
  const app = await fixture();
  for (const collection of activity.COLLECTIONS) {
    const body = collection === 'feedback' ? { body: '私人反馈' } : { place_id: place.id };
    const item = (await app.request(collection + '/', 'POST', body)).data.data;
    assert.equal((await app.request(collection + '/', 'GET', undefined, { user: app.other })).data.meta.count, 0);
    await assert.rejects(app.request(`${collection}/${item.id}/`, 'DELETE', undefined, { user: app.other }), code('NOT_FOUND'));
    assert.equal((await app.request(`${collection}/${item.id}/`, 'DELETE')).statusCode, 204);
    assert.equal((await app.store.get('users', app.owner.id)).activity_counts[collection], 0);
  }
});

test('feedback trims and bounds content; users cannot preapprove or inject visible replies', async () => {
  const app = await fixture();
  for (const body of [{ body: '' }, { body: ' ' }, { body: 'a'.repeat(1001) }, { body: 42 }])
    await assert.rejects(app.request('feedback/', 'POST', body), code('VALIDATION_ERROR'));
  const result = await app.request('feedback/', 'POST', { body: '  联系建议  ', status: 'resolved', reply: '伪造处理', owner_id: app.other.id });
  assert.equal(result.data.data.body, '联系建议'); assert.equal(result.data.data.status, 'pending'); assert.equal(result.data.data.reply, '');
  await app.store.update('feedback', result.data.data.id, { reply: '内部草稿' });
  assert.equal((await app.request('feedback/')).data.data[0].reply, '');
  await app.store.update('feedback', result.data.data.id, { status: 'resolved', reply: '已处理', resolved_at: now });
  assert.equal((await app.request('feedback/')).data.data[0].reply, '已处理');
});

test('per-owner storage cap is enforced transactionally and deletion frees capacity', async () => {
  const app = await fixture(); await app.store.update('users', app.owner.id, { activity_counts: { favorites: 1000 } });
  await assert.rejects(app.request('favorites/', 'POST', { place_id: place.id }), code('STORAGE_QUOTA'));
  assert.equal(await app.store.count('favorites'), 0);
  await app.store.update('users', app.owner.id, { activity_counts: { favorites: 0 } });
  const item = (await app.request('favorites/', 'POST', { place_id: place.id })).data.data;
  await app.request(`favorites/${item.id}/`, 'DELETE');
  assert.equal((await app.request('favorites/', 'POST', { place_id: place.id })).statusCode, 201);
});

test('listing honors owner filters and pagination without leaking private fields', async () => {
  const app = await fixture(); await app.request('favorites/', 'POST', { place_id: place.id }); await app.request('favorites/', 'POST', { content_id: content.id });
  const first = await app.request('favorites/', 'GET', undefined, { query: new URLSearchParams('page_size=1') });
  assert.equal(first.data.data.length, 1); assert.equal(first.data.meta.count, 2); assert.match(first.data.meta.next, /^\/api\/v1\/favorites\//);
  const filtered = await app.request('favorites/', 'GET', undefined, { query: new URLSearchParams('place_id=' + place.id) }); assert.equal(filtered.data.meta.count, 1);
  await assert.rejects(app.request('favorites/', 'GET', undefined, { query: new URLSearchParams('place_id=bad') }), code('VALIDATION_ERROR'));
});

test('failed transaction does not advance owner counts or create a record', async () => {
  const app = await fixture(); const original = app.store.transaction.bind(app.store);
  app.store.transaction = (callback) => original(async (tx) => { const result = await callback(tx); throw new Error('rollback after writes'); });
  await assert.rejects(app.request('favorites/', 'POST', { place_id: place.id }), /rollback/);
  assert.equal(await app.store.count('favorites'), 0); assert.equal((await app.store.get('users', app.owner.id)).record_revision, 0);
});

test('account deletion gate prevents new private writes after authorization snapshot', async () => {
  const app = await fixture(); const original = app.store.transaction.bind(app.store);
  app.store.transaction = async (callback) => { await app.store.update('users', app.owner.id, { is_active: false, record_revision: 1 }); return original(callback); };
  await assert.rejects(app.request('feedback/', 'POST', { body: '不应落库' }), code('AUTH_REQUIRED'));
  assert.equal(await app.store.count('feedback'), 0);
});
