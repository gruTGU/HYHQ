const { selectTab } = require('../../lib/tab-bar');
const { entryUrl } = require('../../lib/llm');
const { app, detail } = require('../../lib/page');
const { message } = require('../../lib/format');
const { loadAll, loadRegions, selectRegion } = require('../../lib/region');
const { imageResource, matchesType, mapPoints, geometry, clampPan, zoomPan } = require('../../lib/map-layout');

Page({
  data: {
    loading: true, error: '', placesError: '', places: [], filtered: [], region: null, regions: [], regionIndex: 0,
    maps: [], mapIndex: 0, activeMap: null, mapImage: '', imageFrames: [], mapNotice: '', imageReady: false, imageGeneration: 0,
    viewportGeneration: 0, viewportFrames: [], markers: [], selectedPoint: null, viewportWidth: 343, viewportHeight: 240.1, mapWidth: 343, mapHeight: 240.1,
    zoom: 1, zoomLabel: '100%', panX: 0, panY: 0, activeType: '', viewMode: 'map',
    types: [{ value: '', label: '全部地点' }, { value: 'water', label: '河湖' }, { value: 'park', label: '公园' }, { value: 'campus', label: '校园' }],
  },
  onShow() { if (this._destroyed) return; selectTab(this, 1); this._visible = true; return this.load(); },
  onHide() { this._visible = false; this._generation = (this._generation || 0) + 1; },
  onUnload() { this._destroyed = true; this.onHide(); },
  onPullDownRefresh() { return this.load(); },
  onResize() { this.resizeMap(); },
  alive() { return !this._destroyed && this._visible !== false; },
  current(generation) { return this.alive() && generation === this._generation; },
  width() {
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null;
    return info && info.windowWidth > 0 ? info.windowWidth * 686 / 750 : 343;
  },
  async load(event, requestedRegion) {
    if (!this.alive()) return;
    const generation = this._generation = (this._generation || 0) + 1;
    const previousMapId = this.data.activeMap && this.data.activeMap.id;
    this._metrics = null;
    this.setData({ loading: true, error: '', placesError: '', places: [], filtered: [], markers: [], selectedPoint: null, maps: [], activeMap: null, mapImage: '', imageFrames: [], viewportFrames: [], imageReady: false, imageGeneration: this.data.imageGeneration + 1, mapNotice: '' });
    try {
      const application = app();
      const selection = await loadRegions(application);
      if (!this.current(generation)) return;
      if (requestedRegion) {
        const index = selection.regions.findIndex((region) => region.id === requestedRegion);
        if (index >= 0) Object.assign(selection, { regionIndex: index, region: selection.regions[index] });
      }
      this.setData(selection);
      selectRegion(application, selection.region);
      if (!selection.region) { this.setData({ mapNotice: '还没有可浏览的区域，请稍后再来。' }); return; }
      const region = selection.region;
      const results = await Promise.allSettled([loadAll(application.api, 'places/', { region: region.id }), loadAll(application.api, 'maps/', { region: region.id })]);
      if (!this.current(generation)) return;
      const places = results[0].status === 'fulfilled' ? results[0].value.filter((point) => point.region === region.id).map((point, index) => Object.assign({}, point, { order: String(index + 1).padStart(2, '0') })) : [];
      const maps = results[1].status === 'fulfilled' ? results[1].value.filter((layout) => layout.region === region.id).map((layout) => Object.assign({}, layout, { selectionLabel: layout.name + ' · v' + layout.version })) : [];
      const index = Math.max(0, maps.findIndex((layout) => layout.id === previousMapId));
      this.setData({ places, maps, placesError: results[0].status === 'rejected' ? message(results[0].reason) : '' });
      this.selectMap(index);
      if (results[1].status === 'rejected') this.setData({ mapNotice: '导览图暂不可用：' + message(results[1].reason) + '。地点列表仍可使用。' });
    } catch (error) {
      if (this.current(generation)) this.setData({ error: message(error) });
    } finally {
      if (this.current(generation)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); }
    }
  },
  changeRegion(event) {
    if (!this.alive()) return;
    const selected = this.data.regions[Number(event.detail.value)];
    if (selected) return this.load(null, selected.id);
  },
  chooseMap(event) { if (this.alive()) this.selectMap(Number(event.detail.value)); },
  selectMap(index) {
    if (!this.alive()) return;
    const activeMap = this.data.maps[index] || null;
    const resource = imageResource(activeMap, this.data.region);
    this._pan = { x: 0, y: 0 };
    this._metrics = null;
    const imageGeneration = this.data.imageGeneration + 1;
    this.setData({ mapIndex: activeMap ? index : 0, activeMap, mapImage: resource.src, imageFrames: resource.src ? [{ generation: imageGeneration, src: resource.src }] : [], viewportFrames: [], mapNotice: resource.notice, viewMode: resource.src ? this.data.viewMode : 'list', imageReady: false, imageGeneration, zoom: 1, zoomLabel: '100%', panX: 0, panY: 0, selectedPoint: null });
    this.resizeMap();
    this.filter();
  },
  resizeMap() {
    if (!this.alive()) return;
    const metrics = geometry(this.data.activeMap, this.width(), this.data.zoom);
    if (!metrics) return;
    const pan = clampPan(this._pan && this._pan.x, this._pan && this._pan.y, metrics);
    this.applyViewport(metrics, pan);
  },
  applyViewport(metrics, pan) {
    if (!this.alive()) return;
    this._metrics = metrics;
    this._pan = pan;
    // Rekey the native movable node; a queued event retains its own old geometry ID.
    const viewportGeneration = this.data.viewportGeneration + 1;
    this.setData(Object.assign({}, metrics, { viewportGeneration, viewportFrames: [{ generation: viewportGeneration }], zoomLabel: Math.round(metrics.zoom * 100) + '%', panX: pan.x, panY: pan.y }));
  },
  imageEventCurrent(event) {
    const dataset = event.currentTarget.dataset;
    return this.alive() && !!this.data.mapImage && Number(dataset.generation) === this.data.imageGeneration && Number(dataset.viewport) === this.data.viewportGeneration;
  },
  imageLoaded(event) {
    if (!this.imageEventCurrent(event)) return;
    const map = this.data.activeMap;
    if (!map || event.detail.width !== map.image_width || event.detail.height !== map.image_height) {
      this.setData({ imageReady: false, mapImage: '', imageFrames: [], selectedPoint: null, viewMode: 'list', mapNotice: '底图实际尺寸与此版本配置不一致，已隐藏图上点位。请管理员核对底图尺寸。地点列表仍可使用。' });
      return;
    }
    this.setData({ imageReady: true });
  },
  imageFailed(event) {
    if (!this.imageEventCurrent(event)) return;
    this.setData({ imageReady: false, mapImage: '', imageFrames: [], selectedPoint: null, viewMode: 'list', mapNotice: '底图加载失败，请稍后刷新；地点列表仍可使用。' });
  },
  changeView(event) {
    if (!this.alive()) return;
    const viewMode = event.currentTarget.dataset.mode;
    if (!['map', 'list'].includes(viewMode)) return;
    this.setData({ viewMode });
    if (viewMode === 'map') this.resizeMap();
  },
  chooseType(event) {
    if (!this.alive()) return;
    this.setData({ activeType: event.currentTarget.dataset.type, selectedPoint: null }); this.filter();
  },
  filter() {
    if (!this.alive()) return;
    const activeType = this.data.activeType;
    const orders = new Map(this.data.places.map((point) => [point.id, point.order]));
    const markers = mapPoints(this.data.activeMap, this.data.region).map((point, index) => Object.assign({}, point, { order: orders.get(point.id) || String(this.data.places.length + index + 1).padStart(2, '0'), left: point.x_ratio * 100, top: point.y_ratio * 100 })).filter((point) => matchesType(point, activeType));
    this.setData({ filtered: this.data.places.filter((point) => matchesType(point, activeType)), markers });
  },
  selectPoint(event) {
    if (!this.data.imageReady || !this.imageEventCurrent(event)) return;
    const point = this.data.markers.find((item) => item.id === event.currentTarget.dataset.id);
    if (point) this.setData({ selectedPoint: point });
  },
  zoomMap(event) {
    if (!this.alive() || !this._metrics || !this.data.imageReady) return;
    const action = event.currentTarget.dataset.action;
    const zoom = action === 'reset' ? 1 : Math.max(1, Math.min(3, this.data.zoom + (action === 'in' ? .5 : -.5)));
    const next = geometry(this.data.activeMap, this.width(), zoom);
    const pan = action === 'reset' ? { x: 0, y: 0 } : zoomPan(this._metrics, next, this._pan.x, this._pan.y);
    this.applyViewport(next, pan);
  },
  panMap(event) {
    if (!this._metrics || !this.data.imageReady || !this.imageEventCurrent(event)) return;
    this._pan = clampPan(event.detail.x, event.detail.y, this._metrics);
  },
  open(event) {
    if (!this.alive()) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.places.some((point) => point.id === id) || this.data.markers.some((point) => point.id === id)) detail('place', id);
  },
  openAI() {
    if (!this.alive() || this.data.loading || this.data.error || !this.data.region) return;
    const point = this.data.selectedPoint;
    const id = point && point.id || this.data.region.id;
    wx.navigateTo({ url: entryUrl('explore', point ? 'place' : 'region', id) });
  },
});
