const { selectTab } = require('../../lib/tab-bar');
const { entryUrl } = require('../../lib/llm');
const { app, detail } = require('../../lib/page');
const { message } = require('../../lib/format');
const { loadAll, selectRegion } = require('../../lib/region');
const { contentView, routeView, choices, pageData, appendUnique } = require('../../lib/knowledge');
Page({
  data: {
    regions: [{ id: '', name: '全部区域' }], regionIndex: 0, regionId: '', regionError: '',
    categories: [{ value: '', name: '全部分类' }], categoryIndex: 0, category: '',
    plantLabels: [{ value: '', name: '全部植物标签' }], plantIndex: 0, plant_label: '',
    showFilters: false, tagsLoading: false, tagsError: '', searchInput: '', search: '', place: '',
    contents: [], contentsLoading: false, contentsLoadingMore: false, contentsError: '', contentsMoreError: '', contentsNext: '',
    routes: [], routesLoading: false, routesLoadingMore: false, routesError: '', routesMoreError: '', routesNext: '', tab: 'contents',
  },
  onLoad() {
    this._alive = true;
    this._sharedRegionId = app().globalData.region && app().globalData.region.id || '';
    this.setData(this.regionSelection(this._sharedRegionId));
    this.consumePending();
    return this.load();
  },
  onShow() {
    if (this._alive === false) return;
    selectTab(this, 3);
    const returning = this._hidden;
    this._hidden = false;
    const pending = this.consumePending();
    const shared = app().globalData.region && app().globalData.region.id || '';
    const changed = shared !== this._sharedRegionId;
    if (changed && !pending) this.setData(Object.assign(this.regionSelection(shared), { place: '' }));
    this._sharedRegionId = shared;
    if (returning || pending || changed) return this.load();
  },
  onHide() { this._hidden = true; this._generation = (this._generation || 0) + 1; },
  onUnload() { this._alive = false; this.onHide(); },
  visible() { return this._alive !== false && !this._hidden; },
  current(generation) { return this.visible() && generation === this._generation; },
  regionSelection(id) {
    const regions = this.data.regions.slice();
    let regionIndex = regions.findIndex((item) => item.id === id || item.slug === id);
    if (regionIndex < 0) {
      const shared = app().globalData.region;
      regions.push(shared && (shared.id === id || shared.slug === id) ? shared : { id, name: '指定区域（可切换）' });
      regionIndex = regions.length - 1;
    }
    return { regions, regionIndex, regionId: id };
  },
  consumePending() {
    if (!this.visible()) return false;
    const pending = app().globalData.pendingKnowledgeFilter;
    if (!pending) return false;
    delete app().globalData.pendingKnowledgeFilter;
    const string = (value) => typeof value === 'string' ? value : '';
    const label = string(pending.plant_label), plantLabels = choices([], 'plant', label);
    this.setData(Object.assign(this.regionSelection(string(pending.region)), { tab: pending.tab === 'routes' ? 'routes' : 'contents', place: string(pending.place), plant_label: label, category: '', search: '', searchInput: '', categories: choices([], 'category'), categoryIndex: 0, plantLabels, plantIndex: label ? 1 : 0 }));
    return true;
  },
  onPullDownRefresh() { return this.load(); },
  async load() {
    if (!this.visible()) return;
    const generation = this._generation = (this._generation || 0) + 1;
    this._requests = this._requests || {};
    this._seen = this._seen || {};
    try { await Promise.all([this.loadRegions(generation), this.loadTags(generation), this.loadList('contents', false, generation), this.loadList('routes', false, generation)]); }
    finally { if (this.current(generation)) wx.stopPullDownRefresh(); }
  },
  async loadRegions(generation) {
    this.setData({ regionError: '' });
    try {
      const publicRegions = await loadAll(app().api, 'regions/');
      if (!this.current(generation)) return;
      const regions = [{ id: '', name: '全部区域' }].concat(publicRegions);
      let regionIndex = regions.findIndex((item) => item.id === this.data.regionId || item.slug === this.data.regionId);
      if (regionIndex < 0) { regions.push({ id: this.data.regionId, name: '指定区域（可切换）' }); regionIndex = regions.length - 1; }
      this.setData({ regions, regionIndex });
    } catch (error) { if (this.current(generation)) this.setData({ regionError: message(error) }); }
  },
  async loadTags(generation = this._generation) {
    if (!this.current(generation)) return;
    const request = this._tagRequest = (this._tagRequest || 0) + 1;
    this.setData({ tagsLoading: true, tagsError: '' });
    try {
      const data = this.data.regionId ? { region: this.data.regionId } : {};
      const response = await app().api.request('content-tags/', { data });
      if (!this.current(generation) || request !== this._tagRequest) return;
      const tags = response && response.data;
      if (!tags || !Array.isArray(tags.categories) || !Array.isArray(tags.plant_labels)) throw new Error('科普标签返回格式不正确，请重试。');
      const categories = choices(tags.categories, 'category', this.data.category), plantLabels = choices(tags.plant_labels, 'plant', this.data.plant_label);
      this.setData({ categories, plantLabels, categoryIndex: categories.findIndex((item) => item.value === this.data.category), plantIndex: plantLabels.findIndex((item) => item.value === this.data.plant_label) });
    } catch (error) { if (this.current(generation) && request === this._tagRequest) this.setData({ tagsError: message(error) }); }
    finally { if (this.current(generation) && request === this._tagRequest) this.setData({ tagsLoading: false }); }
  },
  retryTags() { return this.loadTags(); },
  params(kind) {
    const data = { page_size: 20 };
    if (this.data.regionId) data.region = this.data.regionId;
    if (kind === 'contents') ['category', 'plant_label', 'place', 'search'].forEach((key) => { if (this.data[key]) data[key] = this.data[key]; });
    return data;
  },
  async loadList(kind, more = false, generation = this._generation) {
    if (!this.current(generation) || !['contents', 'routes'].includes(kind)) return;
    if (more && (this.data[kind + 'Loading'] || this.data[kind + 'LoadingMore'] || !this.data[kind + 'Next'])) return;
    this._requests = this._requests || {}; this._seen = this._seen || {};
    const request = this._requests[kind] = (this._requests[kind] || 0) + 1;
    const path = more ? this.data[kind + 'Next'] : kind + '/';
    if (!more) this._seen[kind] = new Set();
    const seen = this._seen[kind];
    const patch = { [kind + 'Error']: '', [kind + 'MoreError']: '', [kind + 'LoadingMore']: more, [kind + 'Loading']: !more };
    if (!more) Object.assign(patch, { [kind]: [], [kind + 'Next']: '' });
    this.setData(patch);
    const accepted = () => this.current(generation) && request === this._requests[kind];
    try {
      const response = await app().api.request(path, more ? undefined : { data: this.params(kind) });
      if (!accepted()) return;
      const result = pageData(response, path, seen), transform = kind === 'contents' ? contentView : routeView;
      seen.add(path);
      const items = result.items.map(transform);
      this.setData({ [kind]: more ? appendUnique(this.data[kind], items) : items, [kind + 'Next']: result.next });
    } catch (error) { if (accepted()) this.setData({ [kind + (more ? 'MoreError' : 'Error')]: message(error) }); }
    finally { if (accepted()) this.setData({ [kind + 'Loading']: false, [kind + 'LoadingMore']: false }); }
  },
  retryContents() { return this.loadList('contents'); },
  retryRoutes() { return this.loadList('routes'); },
  moreContents() { return this.loadList('contents', true); },
  moreRoutes() { return this.loadList('routes', true); },
  onReachBottom() { return this.loadList(this.data.tab, true); },
  toggleFilters() { if (this.visible()) this.setData({ showFilters: !this.data.showFilters }); },
  changeTab(event) { if (this.visible() && ['contents', 'routes'].includes(event.currentTarget.dataset.tab)) this.setData({ tab: event.currentTarget.dataset.tab }); },
  allRoutes() { return this.changeRegion({ detail: { value: 0 } }); },
  changeRegion(event) {
    if (!this.visible()) return;
    const index = Number(event.detail.value), region = this.data.regions[index];
    if (!region) return;
    if (region.id) selectRegion(app(), region);
    this._sharedRegionId = app().globalData.region && app().globalData.region.id || '';
    this.setData({ regionId: region.id, regionIndex: index, place: '' });
    return this.load();
  },
  changeCategory(event) {
    if (!this.visible()) return;
    const index = Number(event.detail.value), selected = this.data.categories[index];
    if (!selected) return;
    this.setData({ category: selected.value, categoryIndex: index }); return this.loadList('contents');
  },
  changePlant(event) {
    if (!this.visible()) return;
    const index = Number(event.detail.value), selected = this.data.plantLabels[index];
    if (!selected) return;
    this.setData({ plant_label: selected.value, plantIndex: index }); return this.loadList('contents');
  },
  inputSearch(event) { if (this.visible()) this.setData({ searchInput: event.detail.value }); },
  searchContents() { if (!this.visible()) return; this.setData({ search: this.data.searchInput.trim() }); return this.loadList('contents'); },
  clearPlace() { if (!this.visible()) return; this.setData({ place: '' }); return this.loadList('contents'); },
  resetFilters() {
    if (!this.visible()) return;
    this.setData({ category: '', categoryIndex: 0, plant_label: '', plantIndex: 0, place: '', search: '', searchInput: '' });
    return this.loadList('contents');
  },
  open(event) {
    if (!this.visible()) return;
    const { kind, id } = event.currentTarget.dataset;
    const items = kind === 'content' ? this.data.contents : kind === 'route' ? this.data.routes : [];
    if (items.some((item) => item.id === id)) detail(kind, id);
  },
  openAI() {
    if (!this.visible() || this.data.regionError) return;
    const regions = this.data.regions.filter((item) => item.id);
    const shared = app().globalData.region;
    const region = regions.find((item) => item.id === this.data.regionId || item.slug === this.data.regionId) || regions.find((item) => shared && item.id === shared.id) || regions[0];
    if (region) wx.navigateTo({ url: entryUrl('learn', 'region', region.id) });
  },
});
