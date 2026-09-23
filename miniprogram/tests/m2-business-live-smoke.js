/** Local-only M2 business integration. Public catalogues use two-item pages to exercise real pagination. */
const assert = require('node:assert/strict');
const { createClient } = require('../lib/client');
const { createSession } = require('../lib/session');
const baseURL = process.env.HYHQ_TEST_API || 'http://127.0.0.1:18203/api/v1';
const origin = new URL(baseURL);
assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
const storage = new Map(), navigation = [], requests = [];
const wx = {
  getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
  stopPullDownRefresh() {}, setNavigationBarTitle() {}, showToast() {},
  navigateTo: ({ url }) => navigation.push(url), switchTab: ({ url }) => navigation.push(url),
  showModal() { throw new Error('Test must explicitly handle any confirmation.'); },
  request(options) {
    const url = new URL(options.url), method = options.method || 'GET';
    assert.equal(url.origin, origin.origin);
    if (method === 'GET') {
      Object.entries(options.data || {}).forEach(([key, value]) => url.searchParams.set(key, value));
      if (/\/(contents|routes|favorites|histories|visits|feedback)\/$/.test(url.pathname)) url.searchParams.set('page_size', '2');
    }
    requests.push({ path: url.pathname, method });
    fetch(url, { method, headers: options.header, body: method === 'GET' || options.data === undefined ? undefined : JSON.stringify(options.data), signal: AbortSignal.timeout(5000), redirect: 'error' })
      .then(async (response) => options.success({ statusCode: response.status, data: await response.text() }))
      .catch((error) => options.fail({ errMsg: error.message }));
  },
};
const session = createSession(wx);
const app = { session, config: { development: true }, globalData: {}, api: createClient(wx, { baseURL, timeout: 5000 }, session) };
function page(name) {
  let definition;
  global.Page = (input) => { definition = input; }; global.getApp = () => app; global.wx = wx;
  const filename = require.resolve('../pages/' + name + '/index'); delete require.cache[filename]; require(filename);
  return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
}
const change = (index) => ({ detail: { value: index } });
const event = (dataset) => ({ currentTarget: { dataset } });
async function main() {
  const checks = [];
  const health = (await app.api.request('health/')).data;
  assert.equal(health.mode, 'simulation');
  const publicArticleCount = (await app.api.request('contents/')).meta.count;
  assert.ok(publicArticleCount >= 8);
  const learn = page('learn'); await learn.onLoad();
  assert.equal(learn.data.contentsError, ''); assert.equal(learn.data.tagsError, '');
  assert.equal(learn.data.contents.length, 2); assert.ok(learn.data.contentsNext);
  let pages = 1;
  while (learn.data.contentsNext) { assert.ok(pages++ < publicArticleCount); await learn.moreContents(); assert.equal(learn.data.contentsMoreError, ''); }
  assert.equal(learn.data.contents.length, publicArticleCount); assert.equal(new Set(learn.data.contents.map((item) => item.id)).size, publicArticleCount);
  const waterArticle = learn.data.contents.find((item) => item.slug === 'read-water-indicators');
  assert.ok(waterArticle.place_summary && waterArticle.source);
  const plant = learn.data.categories.findIndex((item) => item.value === 'plants'); assert.ok(plant > 0);
  await learn.changeCategory(change(plant));
  const roses = learn.data.plantLabels.findIndex((item) => item.value === 'roses'); assert.ok(roses > 0);
  await learn.changePlant(change(roses));
  learn.inputSearch({ detail: { value: '花瓣' } }); await learn.searchContents();
  assert.equal(learn.data.contentsError, ''); assert.equal(learn.data.contents.length, 1);
  assert.equal(learn.data.contents[0].plant_label, 'roses'); assert.equal(learn.data.contents[0].category, 'plants');
  checks.push('B01_real_pagination_and_combined_category_plant_search');
  const place = page('detail'); await place.onLoad({ kind: 'place', id: waterArticle.place_summary.id });
  assert.equal(place.data.error, ''); assert.equal(place.data.relatedError, '');
  assert.ok(place.data.relatedContents.some((item) => item.id === waterArticle.id));
  place.openRelatedContents(); await learn.onShow();
  assert.equal(learn.data.contentsError, '');
  assert.ok(learn.data.contents.length && learn.data.contents.every((item) => item.place === waterArticle.place_summary.id));
  const article = page('detail'); await article.onLoad({ kind: 'content', id: waterArticle.id });
  article.openAssociatedPlace();
  assert.ok(navigation.some((url) => url.includes('kind=place&id=' + waterArticle.place_summary.id)));
  checks.push('B01_place_related_articles_and_public_association');
  const route = learn.data.routes.find((item) => item.slug === 'campus-eco-walk');
  assert.ok(route); assert.equal(route.public_stop_count, 6); assert.ok(route.source);
  const routePage = page('detail'); await routePage.onLoad({ kind: 'route', id: route.id });
  assert.equal(routePage.data.routeStops.length, 6); assert.equal(routePage.data.activeStop.position, 1);
  routePage.stepRoute(event({ direction: 'next' }));
  assert.equal(routePage.data.activeStop.position, 2);
  const selected = routePage.data.activeStop.id, destination = routePage.data.activeStop.place.id;
  routePage.openRouteStop(); assert.equal(navigation.at(-1), '/pages/detail/index?kind=place&id=' + destination);
  routePage.onHide(); await routePage.onShow(); assert.equal(routePage.data.activeStop.id, selected);
  routePage.openRouteList(); await learn.onShow();
  assert.equal(learn.data.tab, 'routes'); assert.equal(learn.data.regionId, route.region);
  checks.push('B02_six_ordered_stops_selection_return_and_region_list');
  assert.equal(session.token(), ''); assert.ok(requests.every((request) => request.method === 'GET'));
  checks.push('B01_B02_public_browsing_without_login_location_or_writes');
  process.stdout.write(JSON.stringify({ status: 'passed', checks, catalogue_pages: pages, public_articles: publicArticleCount, route_public_stops: 6, transport: 'real_local_http_with_wx_mock', page_size_override: 2, wechat_device_verified: false, server_deployed: false }, null, 2) + '\n');
}
main().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
