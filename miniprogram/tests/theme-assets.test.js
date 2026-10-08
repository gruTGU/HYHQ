const test = require('node:test');
const assert = require('node:assert/strict');
const { KEY, createThemeAssetStore, safeURL, assetStyle } = require('../lib/theme-assets');
const { createThemeStore, withTheme } = require('../lib/theme');
const URL = 'https://assets-123.tcb.qcloud.la/themes/paper.webp?sign=abc%3B123';
const START = Date.parse('2026-10-08T00:00:00Z');
function fixture() {
  const data = new Map(); let clock = START;
  const platform = { getStorageSync: key => data.get(key), setStorageSync: (key, value) => data.set(key, value), removeStorageSync: key => data.delete(key) };
  const config = { transport: 'cloud-function', cloud: { env: 'env-a', function: 'hyhqApi' } };
  return { data, platform, config, now: () => clock, tick(ms) { clock += ms; } };
}
function response(theme, assets = { paperTile: URL }, seconds = 3600) {
  return { data: { theme, version: '20261008', assets, expires_at: new Date(START + seconds * 1000).toISOString() } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
test('theme URLs accept signed Tencent HTTPS assets and cannot inject CSS or request arbitrary hosts', () => {
  assert.equal(safeURL(URL), true);
  for (const value of ['http://assets-123.tcb.qcloud.la/p.png', 'https://evil.example/a.png', 'https://assets-123.tcb.qcloud.la.evil.example/a', 'https://user@assets-123.tcb.qcloud.la/a', 'https://assets-123.tcb.qcloud.la:443/a', 'https://assets-123.tcb.qcloud.la/a");color:red;/*', 'https://assets-123.tcb.qcloud.la/\\a', 'https://assets-123.tcb.qcloud.la/a\nb']) {
    assert.equal(safeURL(value), false, value);
    assert.equal(assetStyle({ paperTile: value }), '--hyhq-paper-image:none;--hyhq-contours-image:none');
  }
  assert.equal(assetStyle({ paperTile: URL }), '--hyhq-paper-image:url("' + URL + '");--hyhq-contours-image:none');
});
test('concurrent loads merge, signed URLs restore only in their environment and expire without extension', async () => {
  const f = fixture(), calls = []; let finish;
  const api = { request(path, options) { calls.push([path, options]); return new Promise(resolve => { finish = resolve; }); } };
  const store = createThemeAssetStore(f.platform, f.config, f.now);
  const first = store.load('design-2', api), second = store.load('design-2', api);
  assert.equal(first, second); await turn(); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['theme-assets/', { data: { theme: 'design-2' }, cache: false }]);
  finish(response('design-2', { paperTile: URL, ignoredKey: URL, contours: 'https://evil.example/contour.png' }));
  assert.deepEqual((await first).assets, { paperTile: URL });
  f.tick(30000);
  assert.equal(createThemeAssetStore(f.platform, f.config, f.now).read('design-2').assets.paperTile, URL);
  assert.equal(createThemeAssetStore(f.platform, { ...f.config, cloud: { ...f.config.cloud, env: 'env-b' } }, f.now).read('design-2'), null);
  f.tick(270000); // The client cap is five minutes even if the server claims an hour.
  assert.equal(store.read('design-2'), null);
  assert.equal(f.data.size, 0);
});
test('old v1 one-hour URLs are ignored and new cache entries never exceed five minutes', async () => {
  const f = fixture(), suffix = encodeURIComponent('cloud-function|env-a|hyhqApi') + '.design-3';
  f.data.set('hyhq.theme-assets.v1.' + suffix, response('design-3', { paperTile: URL + '&old=1' }).data);
  const store = createThemeAssetStore(f.platform, f.config, f.now);
  assert.equal(store.read('design-3'), null, 'a still-dated v1 entry may already have an invalid signature');
  let calls = 0;
  const loaded = await store.load('design-3', { request: async () => { calls++; return response('design-3'); } });
  assert.equal(calls, 1); assert.equal(KEY, 'hyhq.theme-assets.v2.');
  assert.equal(loaded.expires_at, new Date(START + 300000).toISOString());
  assert.equal(f.data.get(KEY + suffix).assets.paperTile, URL);
  f.tick(299000);
  assert.equal(createThemeAssetStore(f.platform, f.config, f.now).read('design-3').assets.paperTile, URL);
  f.tick(1000);
  assert.equal(store.read('design-3'), null);
});
test('network or invalid signing failures stay retryable and never cache an unusable asset set', async () => {
  const f = fixture(), store = createThemeAssetStore(f.platform, f.config, f.now); let calls = 0;
  const api = { async request() { calls++; if (calls === 1) throw new Error('offline'); if (calls === 2) return response('design-2', {}); return response('design-2'); } };
  await assert.rejects(store.load('design-2', api), /offline/);
  await assert.rejects(store.load('design-2', api), /暂不可用/);
  assert.equal(store.read('design-2'), null);
  assert.equal((await store.load('design-2', api)).assets.paperTile, URL);
  assert.equal(calls, 3);
  await assert.rejects(store.load('../../bad', api), /不可用/);
  assert.equal(calls, 3);
});
test('restored theme URLs respect source expiry and storage failures retain the in-memory copy', async () => {
  const f = fixture(), store = createThemeAssetStore(f.platform, f.config, f.now);
  f.platform.setStorageSync = () => { throw new Error('full'); };
  await store.load('forest', { request: async () => response('forest', { riverExample: URL }, 120) });
  assert.equal(store.read('forest').assets.riverExample, URL);
  f.tick(120000);
  assert.equal(store.read('forest'), null);
  assert.equal(f.data.size, 0);
});
test('short-lived partial success displays available assets and retries missing assets after its server expiry', async () => {
  const f = fixture(), store = createThemeAssetStore(f.platform, f.config, f.now); let calls = 0;
  const api = { async request() {
    calls++;
    return calls === 1 ? response('design-2', { riverExample: URL }, 30)
      : response('design-2', { riverExample: URL, entryExplore: URL + '&file=explore' });
  } };
  const partial = await store.load('design-2', api);
  assert.deepEqual(partial.assets, { riverExample: URL });
  f.tick(2000); // Network transit must not erase a valid short-lived response.
  const restored = createThemeAssetStore(f.platform, f.config, f.now);
  assert.deepEqual(restored.read('design-2').assets, partial.assets);
  await restored.load('design-2', api);
  assert.equal(calls, 1);
  f.tick(28000);
  assert.equal(store.read('design-2'), null);
  assert.equal(restored.read('design-2'), null);
  const recovered = await restored.load('design-2', api);
  assert.equal(calls, 2);
  assert.equal(recovered.assets.entryExplore, URL + '&file=explore');
});
test('forest home adds no signing request, while recognition requests its example and alternate themes race safely', async t => {
  const f = fixture(), requests = new Map(), calls = [];
  const api = { request(_path, { data }) { calls.push(data.theme); return new Promise(resolve => requests.set(data.theme, resolve)); } };
  const app = { theme: createThemeStore(f.platform), themeAssets: createThemeAssetStore(f.platform, f.config, f.now), api };
  global.getApp = () => app; global.wx = {};
  t.after(() => { delete global.getApp; delete global.wx; });
  const definition = withTheme({});
  const page = { ...definition, route: 'pages/home/index', data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad(); page.onShow(); await turn(); assert.deepEqual(calls, []);
  app.theme.select('design-2'); await turn();
  app.theme.select('design-3'); await turn();
  requests.get('design-2')(response('design-2')); await turn();
  assert.equal(page.data.themeId, 'design-3'); assert.deepEqual(page.data.themeAssets, {});
  requests.get('design-3')(response('design-3', { contours: URL })); await turn();
  assert.deepEqual(page.data.themeAssets, { contours: URL });
  app.theme.select('forest'); assert.deepEqual(page.data.themeAssets, {});
  page.route = 'pages/recognize/index'; page.onShow(); await turn();
  assert.equal(calls.at(-1), 'forest');
  page.onHide(); const previous = JSON.stringify(page.data); let hiddenUpdates = 0;
  page.setData = () => { hiddenUpdates++; };
  requests.get('forest')(response('forest', { riverExample: URL })); await turn();
  assert.equal(hiddenUpdates, 0);
  assert.equal(JSON.stringify(page.data), previous);
  page.setData = patch => Object.assign(page.data, patch);
  page.onShow(); assert.equal(page.data.themeAssets.riverExample, URL);
  page.onUnload();
});
