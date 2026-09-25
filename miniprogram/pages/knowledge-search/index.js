const { app, detail } = require('../../lib/page');
const { loadAll } = require('../../lib/region');
const { message } = require('../../lib/format');
const { choices } = require('../../lib/knowledge');
const { searchData } = require('../../lib/knowledge-search');
Page({
  data: { input: '', categoryIndex: 0, plantIndex: 0, placeIndex: 0, categories: choices([], 'category'), plantLabels: choices([], 'plant'), places: [{ id: '', name: '全部地点' }], loading: false, moreLoading: false, filtersError: '', error: '', searched: false, results: [], count: 0, page: 0, hasMore: false, answer: '', notice: '' },
  onLoad() { this._alive = true; this._version = 0; this._filterVersion = 0; return this.loadFilters(); },
  onHide() { if (!this._alive) return; this._hidden = true; this._version += 1; this._filterVersion += 1; this._filtersLoading = false; this.setData({ loading: false, moreLoading: false }); },
  onShow() { if (!this._alive) return; this._hidden = false; if (!this._filtersLoaded && !this._filtersLoading) this.loadFilters(); if (this._criteria && this.data.searched) return this.run(false, this._criteria); },
  onUnload() { this._alive = false; this._hidden = true; this._version += 1; this._filterVersion += 1; },
  active() { return this._alive && !this._hidden; },
  current(version) { return this._alive && !this._hidden && this._version === version; },
  async loadFilters() {
    if (!this.active()) return;
    const version = ++this._filterVersion; this._filtersLoading = true;
    this.setData({ filtersError: '' });
    const results = await Promise.allSettled([app().api.request('content-tags/'), loadAll(app().api, 'places/')]);
    if (!this.active() || version !== this._filterVersion) return;
    this._filtersLoading = false; this._filtersLoaded = true;
    const errors = [];
    if (results[0].status === 'fulfilled') {
      const tags = results[0].value.data;
      if (tags && Array.isArray(tags.categories) && Array.isArray(tags.plant_labels)) {
        const category = (this.data.categories[this.data.categoryIndex] || {}).value || '', plant = (this.data.plantLabels[this.data.plantIndex] || {}).value || '';
        const categories = choices(tags.categories, 'category', category), plantLabels = choices(tags.plant_labels, 'plant', plant);
        this.setData({ categories, plantLabels, categoryIndex: Math.max(0, categories.findIndex((item) => item.value === category)), plantIndex: Math.max(0, plantLabels.findIndex((item) => item.value === plant)) });
      }
      else errors.push('标签读取失败');
    } else errors.push('标签读取失败');
    if (results[1].status === 'fulfilled') {
      const selected = (this.data.places[this.data.placeIndex] || {}).id || '';
      const places = [{ id: '', name: '全部地点' }].concat(results[1].value);
      this.setData({ places, placeIndex: Math.max(0, places.findIndex((item) => item.id === selected)) });
    }
    else errors.push('地点读取失败');
    this.setData({ filtersError: errors.join('，') });
  },
  input(event) { if (this.active()) this.setData({ input: typeof event.detail.value === 'string' ? event.detail.value : '' }); },
  filter(event) { if (!this.active()) return; const field = event.currentTarget.dataset.field, lists = { categoryIndex: 'categories', plantIndex: 'plantLabels', placeIndex: 'places' }, index = Number(event.detail.value); if (lists[field] && Number.isInteger(index) && index >= 0 && index < this.data[lists[field]].length) this.setData({ [field]: index }); },
  search() {
    const { input, categories, categoryIndex, plantLabels, plantIndex, places, placeIndex } = this.data;
    return this.run(false, { q: input.trim(), category: (categories[categoryIndex] || {}).value || '', plant_label: (plantLabels[plantIndex] || {}).value || '', place: (places[placeIndex] || {}).id || '' });
  },
  retry() { return this.run(false, this._criteria); },
  more() { if (!this.data.loading && !this.data.moreLoading && this.data.hasMore) return this.run(true, this._criteria); },
  async run(more, criteria) {
    if (!this._alive || this._hidden || !criteria) return;
    if (!Object.values(criteria).some(Boolean)) { ++this._version; this._criteria = null; this.setData({ error: '请输入关键词，或选择标签、地点后检索。', loading: false, moreLoading: false, results: [], count: 0, page: 0, hasMore: false, answer: '', notice: '', searched: false }); return; }
    const version = ++this._version, page = more ? this.data.page + 1 : 1;
    this._criteria = Object.assign({}, criteria);
    this.setData(Object.assign({ error: '', loading: !more, moreLoading: more, searched: true }, more ? {} : { results: [], count: 0, page: 0, hasMore: false, answer: '', notice: '' }));
    try {
      const result = searchData(await app().api.request('knowledge-search/', { data: Object.assign({}, criteria, { page, page_size: 10 }) }));
      if (!this.current(version)) return;
      if (result.page !== page) throw new Error('资料分页状态不一致，请重新检索。');
      const merged = more ? this.data.results.concat(result.results) : result.results;
      const seen = new Set();
      this.setData({ results: merged.filter((row) => !seen.has(row.key) && seen.add(row.key)), count: result.count, page, hasMore: result.has_more, answer: result.answer, notice: result.notice });
    } catch (error) { if (this.current(version)) this.setData({ error: message(error) }); }
    finally { if (this.current(version)) this.setData({ loading: false, moreLoading: false }); }
  },
  open(event) { if (!this.active()) return; const row = this.data.results.find((item) => item.key === event.currentTarget.dataset.key); if (row) detail(row.kind, row.id); },
  async onPullDownRefresh() { if (!this.active()) return; try { if (this._criteria) await this.retry(); else await this.loadFilters(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { return this.more(); },
});
