'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicReadCache } = require('../lib/public-read-cache');
const { apiError } = require('../lib/client');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler = () => ({ data: [{ id: 'public' }], meta: { next: null } })) {
  const calls = [], listeners = new Set(); let clock = 10000, token = 'A', revision = 1;
  const session = { token: () => token, revision: () => revision, subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); } };
  const raw = { request(path, options) { calls.push({ path, options }); return Promise.resolve().then(() => handler(path, options)); } };
  return { api: createPublicReadCache(raw, session, apiError, () => clock), calls,
    advance(ms) { clock += ms; }, change(value) { token = value; revision++; listeners.forEach(cb => cb()); } };
}
test('public list warm revisit and concurrent identical requests use one remote call with independent copies', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.api.request('contents/', { data: { page_size: 20, region: 'r' } }), f.api.request('contents/', { data: { region: 'r', page_size: 20 } })]);
  a.data[0].id = 'locally-mutated'; assert.equal(b.data[0].id, 'public');
  assert.equal((await f.api.request('contents/', { data: { page_size: 20, region: 'r' } })).data[0].id, 'public');
  assert.equal(f.calls.length, 1);
  f.advance(10000); await f.api.request('contents/', { data: { page_size: 20, region: 'r' } });
  assert.equal(f.calls.length, 2);
});
test('private, source details, RAG search and all AI/job GETs always reach the server', async () => {
  const f = fixture();
  for (const path of ['me/', 'favorites/', 'history/', 'contents/id/', 'places/id/', 'knowledge-search/', 'llm/status/', 'llm/turns/id/', 'recognition-jobs/id/', 'assessment-jobs/id/']) {
    const before = f.calls.length; await Promise.all([f.api.request(path), f.api.request(path)]); await f.api.request(path);
    assert.equal(f.calls.length - before, 3, path);
  }
});
test('all writes invalidate before and after their result so in-flight reads cannot repopulate old data', async () => {
  const write = deferred(); const f = fixture((path, opts) => opts && opts.method === 'PATCH' ? write.promise : { data: [{ id: 'public' }] });
  await f.api.request('contents/'); const saved = f.api.request('me/', { method: 'PATCH', data: { nickname: 'x' } });
  await f.api.request('contents/'); write.resolve({ data: {} }); await saved;
  await f.api.request('contents/'); assert.equal(f.calls.filter(row => row.path === 'contents/').length, 3);
});
test('manual invalidation, bypass and account changes never reuse an old public envelope', async () => {
  const f = fixture(); await f.api.request('regions/'); f.change('B'); await f.api.request('regions/');
  f.api.invalidatePublicCache(); await f.api.request('regions/'); await f.api.request('regions/', { cache: false });
  assert.equal(f.calls.length, 4);
});
test('failed public requests are never cached and invalidation during a pending request prevents later reuse', async () => {
  let failed = true; const response = deferred();
  const f = fixture(() => { if (failed) { failed = false; throw apiError('NETWORK_ERROR', 'failed'); } return response.promise; });
  await assert.rejects(f.api.request('regions/')); const read = f.api.request('regions/'); f.api.invalidatePublicCache(); response.resolve({ data: [] }); await read;
  await f.api.request('regions/'); assert.equal(f.calls.length, 3);
});
test('parallel consumers cancel independently; cancelling one cannot abort another', async () => {
  const response = deferred(); const f = fixture(() => response.promise);
  const first = f.api.request('regions/'), second = f.api.request('regions/'); first.abort();
  await assert.rejects(first, { code: 'CANCELLED' }); response.resolve({ data: ['available'] });
  assert.deepEqual((await second).data, ['available']); assert.equal(f.calls.length, 1);
});
test('identity changes invalidate a cache-hit promise before delivery', async () => {
  const f = fixture(); await f.api.request('regions/'); const hit = f.api.request('regions/'); f.change('B');
  await assert.rejects(hit, { code: 'SESSION_CHANGED' });
});
test('weather reuse ends at provider expiry and unavailable/stale components never cache', async () => {
  let status = 'fresh'; const f = fixture(() => ({ data: Object.fromEntries(['weather', 'air', 'alerts'].map(kind => [kind, { status, expires_at: new Date(12000).toISOString(), data: {} }])) }));
  await f.api.request('weather-data/summary/', { data: { location: 'tianjin' } });
  f.advance(1999); await f.api.request('weather-data/summary/', { data: { location: 'tianjin' } }); assert.equal(f.calls.length, 1);
  f.advance(1); await f.api.request('weather-data/summary/', { data: { location: 'tianjin' } }); assert.equal(f.calls.length, 2);
  for (status of ['stale', 'unavailable']) { await f.api.request('weather-data/summary/'); await f.api.request('weather-data/summary/'); }
  assert.equal(f.calls.length, 6);
});
test('slow reads do not extend freshness from response arrival', async () => {
  const response = deferred(); const f = fixture(() => response.promise), pending = f.api.request('contents/');
  f.advance(10001); response.resolve({ data: [] }); await pending; await f.api.request('contents/'); assert.equal(f.calls.length, 2);
});
test('a simulated one-second cloud trip becomes zero additional trips on immediate revisits', async () => {
  let networkMilliseconds = 0; const f = fixture(path => { networkMilliseconds += 1000; return { data: path === 'content-tags/' ? {} : [] }; });
  const paths = ['contents/', 'routes/', 'regions/', 'content-tags/'];
  await Promise.all(paths.map(path => f.api.request(path))); assert.equal(networkMilliseconds, 4000);
  await Promise.all(paths.map(path => f.api.request(path))); assert.equal(networkMilliseconds, 4000); assert.equal(f.calls.length, 4);
  f.advance(30000); await Promise.all(paths.map(path => f.api.request(path))); assert.equal(f.calls.length, 8);
});

test('malformed success payloads are never retained as public catalogues', async () => {
  for (const data of [null, true, 'server-error', { error: 'not a list' }]) {
    const f = fixture(() => ({ data })); await f.api.request('contents/'); await f.api.request('contents/'); assert.equal(f.calls.length, 2);
  }
});
