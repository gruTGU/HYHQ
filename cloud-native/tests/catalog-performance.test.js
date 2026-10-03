'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const catalog = require('../../cloudfunctions/hyhqApi/lib/catalog');
const activity = require('../../cloudfunctions/hyhqApi/lib/activity');
const snapshot = require('../../cloudfunctions/hyhqApi/data/catalog.json');
const uid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const now = '2026-10-03T12:00:00Z';
// Model remote I/O latency. Assertions count calls rather than depending on
// machine speed or expanding the client timeout to conceal an N+1 regression.
function remoteStore(store = new MemoryStore()) {
  const calls = [];
  for (const method of ['get', 'list', 'count']) {
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      calls.push({ method, kind: args[0] });
      await new Promise(resolve => setTimeout(resolve, 35));
      return original(...args);
    };
  }
  return { store, calls };
}
function context(store, query = '', extra = {}) { return { method: 'GET', path: 'routes/', query: new URLSearchParams(query), store, config: {}, now, ...extra }; }

test('campus and all 31 routes resolve every stop with one remote catalogue read per request', async () => {
  const remote = remoteStore();
  for (const [query, expectedRows, expectedTotal] of [
    ['region=demo-campus&page_size=20', 1, 1],
    ['page_size=20', 20, 31],
    ['page_size=20&page=2', 11, 31],
    ['page_size=100', 31, 31],
  ]) {
    const before = remote.calls.length;
    const reply = await catalog.handle(context(remote.store, query));
    assert.equal(reply.data.data.length, expectedRows); assert.equal(reply.data.meta.count, expectedTotal);
    assert.deepEqual(remote.calls.slice(before), [{ method: 'list', kind: 'catalog' }]);
    for (const route of reply.data.data) {
      assert.equal(route.stop_count, route.stops.length);
      for (const stop of route.stops) assert.equal(stop.place.region, route.region);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 150000);
  }
});

test('concurrent place and route projections share only their current request promise', async () => {
  const remote = remoteStore(), ctx = context(remote.store);
  const items = await Promise.all([
    ...snapshot.collections.places.map(place => catalog.getPublicItem(ctx, 'places', place.id)),
    ...snapshot.collections.routes.map(route => catalog.getPublicItem(ctx, 'routes', route.id)),
    catalog.loadCatalog(ctx), catalog.loadCatalog(ctx),
  ]);
  assert.ok(items.every(Boolean)); assert.deepEqual(remote.calls, [{ method: 'list', kind: 'catalog' }]);
  const withdrawn = snapshot.collections.routes[0];
  await remote.store.set('catalog', 'routes_' + withdrawn.id, { id: 'routes_' + withdrawn.id, kind: 'routes', deleted: true });
  const next = await catalog.handle(context(remote.store, 'page_size=100'));
  assert.equal(next.data.meta.count, 30); assert.equal(next.data.data.some(route => route.id === withdrawn.id), false);
  assert.deepEqual(remote.calls, [{ method: 'list', kind: 'catalog' }, { method: 'list', kind: 'catalog' }]);
});

test('withdrawn places disappear from all route stop projections on the very next request', async () => {
  const remote = remoteStore(), route = snapshot.collections.routes.find(item => item.stops.length);
  const placeId = route.stops[0].place.id;
  const before = await catalog.handle(context(remote.store, 'page_size=100'));
  assert.ok(before.data.data.some(row => row.stops.some(stop => stop.place.id === placeId)));
  await remote.store.set('catalog', 'places_' + placeId, { id: 'places_' + placeId, kind: 'places', deleted: true });
  const after = await catalog.handle(context(remote.store, 'page_size=100'));
  assert.equal(after.data.data.some(row => row.stops.some(stop => stop.place.id === placeId)), false);
  assert.equal(remote.calls.length, 2);
});

test('LLM freshness boundaries intentionally re-read same-context public facts after each provider stage', async () => {
  const remote = remoteStore(), ctx = context(remote.store), item = snapshot.collections.contents[0];
  await catalog.getContext(ctx, 'content', item.id);
  await remote.store.set('catalog', 'contents_' + item.id, { id: 'contents_' + item.id, kind: 'contents', deleted: true });
  await assert.rejects(catalog.getContext(ctx, 'content', item.id), error => error.code === 'SOURCE_UNAVAILABLE');
  assert.deepEqual(remote.calls, [{ method: 'list', kind: 'catalog' }, { method: 'list', kind: 'catalog' }]);
});

test('private record serialization shares one catalogue load across all references', async () => {
  const store = new MemoryStore(), user = { id: uid(1), is_active: true, record_history: true };
  await store.set('users', user.id, user);
  for (const [index, place] of snapshot.collections.places.entries()) {
    const id = uid(index + 10); await store.set('favorites', id, { id, owner_id: user.id, place_id: place.id, content_id: null, created_at: now });
  }
  const remote = remoteStore(store);
  const result = await activity.handle(context(remote.store, 'page_size=100', { path: 'favorites/', user }));
  assert.equal(result.data.data.length, 82);
  assert.deepEqual(remote.calls, [{ method: 'get', kind: 'users' }, { method: 'list', kind: 'favorites' }, { method: 'list', kind: 'catalog' }]);
});
