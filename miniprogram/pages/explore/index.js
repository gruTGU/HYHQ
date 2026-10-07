const { withTheme } = require('../../lib/theme');
const { selectTab } = require('../../lib/tab-bar');
const { entryUrl } = require('../../lib/llm');
const { app, detail } = require('../../lib/page');
const { message } = require('../../lib/format');
const { loadAll, loadRegions, selectRegion } = require('../../lib/region');
const { imageResource, matchesType, mapPoints, geometry, clampPan, zoomPan } = require('../../lib/map-layout');
const realMap = require('../../lib/real-map');
const references = require('../../lib/map-reference-points');

Page(withTheme({
  data: {
    loading: true, error: '', placesError: '', places: [], filtered: [], region: null, regions: [], regionIndex: 0,
    maps: [], mapIndex: 0, activeMap: null, mapImage: '', imageFrames: [], mapNotice: '', imageReady: false, imageGeneration: 0,
    viewportGeneration: 0, viewportFrames: [], markers: [], selectedPoint: null, viewportWidth: 343, viewportHeight: 240.1, mapWidth: 343, mapHeight: 240.1,
    zoom: 1, zoomLabel: '100%', panX: 0, panY: 0, activeType: '', viewMode: 'map',
    useRealMap: false, realMapFrames: [], realMapGeneration: 0, realLatitude: null, realLongitude: null, realScale: 12,
    mapSubkey: '', realMarkers: [], realPointCount: 0, realPolyline: [], rivers: [], riversError: '', realMapFailed: false, locating: false, locationNotice: '', currentLocation: null,
    referencePoints: [], filteredReferences: [], selectedReference: null, referenceChoices: [], referenceIndex: 0, referenceScopeNote: references.scopeNote, catalogLoading: false,
    types: [{ value: '', label: '全部地点' }, { value: 'water', label: '河湖' }, { value: 'park', label: '公园' }, { value: 'campus', label: '校园' }, { value: 'walk', label: '步道地标' }],
  },
  onShow() { if (this._destroyed) return; selectTab(this, 1); this._visible = true; return this.load(); },
  onHide() {
    this.cancelLocation();
    if (this.data.useRealMap) this.setData({ currentLocation: null, selectedPoint: null, selectedReference: null, locating: false, realMarkers: [], realMapFrames: [], realLatitude: null, realLongitude: null });
    this._visible = false; this._generation = (this._generation || 0) + 1;
  },
  onUnload() { this._destroyed = true; this.onHide(); },
  onPullDownRefresh() { if (app().api.invalidatePublicCache) app().api.invalidatePublicCache(); return this.load(); },
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
    this.cancelLocation();
    this._metrics = null;
    this.setData({ loading: true, error: '', placesError: '', places: [], filtered: [], markers: [], selectedPoint: null, maps: [], activeMap: null, mapImage: '', imageFrames: [], viewportFrames: [], imageReady: false, imageGeneration: this.data.imageGeneration + 1, mapNotice: '', useRealMap: false, realMapFrames: [], realMapGeneration: this.data.realMapGeneration + 1, realLatitude: null, realLongitude: null, realMarkers: [], realPointCount: 0, realPolyline: [], rivers: [], riversError: '', realMapFailed: false, locating: false, locationNotice: '', currentLocation: null });
    this.setData({ referencePoints: [], filteredReferences: [], selectedReference: null, referenceChoices: [], referenceIndex: 0, catalogLoading: false });
    try {
      const application = app();
      const selection = await loadRegions(application, { realGuide: true });
      if (!this.current(generation)) return;
      if (requestedRegion) {
        const index = selection.regions.findIndex((region) => region.id === requestedRegion);
        if (index >= 0) Object.assign(selection, { regionIndex: index, region: selection.regions[index] });
      }
      this.setData(selection);
      selectRegion(application, selection.region);
      if (!selection.region) { this.setData({ mapNotice: '还没有可浏览的区域，请稍后再来。' }); return; }
      const region = selection.region;
      const city = realMap.cityMap(region);
      if (city) {
        this.setData({ loading: false, catalogLoading: true, useRealMap: true, realLatitude: city.latitude, realLongitude: city.longitude, realScale: city.scale, mapSubkey: application.config && application.config.mapSubkey || '', viewMode: 'map', realMapFrames: [{ generation: this.data.realMapGeneration }], referencePoints: references.forRegion(region) });
        this.filter();
        const results = await Promise.allSettled([loadAll(application.api, 'places/', { region: region.id }), loadAll(application.api, 'rivers/', { region: region.id })]);
        if (!this.current(generation)) return;
        const places = results[0].status === 'fulfilled' ? results[0].value.filter((point) => point.region === region.id && realMap.publishedReal(point)).map((point, index) => Object.assign({}, point, { order: String(index + 1).padStart(2, '0'), markerId: index + 1, canNavigate: realMap.navigable(point) })) : [];
        const rivers = results[1].status === 'fulfilled' ? results[1].value.filter((river) => river.region === region.id && river.is_published === true && river.is_demo !== true) : [];
        this.setData({ places, rivers, catalogLoading: false, placesError: results[0].status === 'rejected' ? message(results[0].reason) : '', riversError: results[1].status === 'rejected' ? '河道资料暂不可用，地图和参考点仍可浏览。' : '' });
        this.filter();
        return;
      }
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
      if (this.current(generation)) { this.setData({ loading: false, catalogLoading: false }); wx.stopPullDownRefresh(); }
    }
  },
  changeRegion(event) {
    if (!this.alive()) return;
    const selected = this.data.regions[Number(event.detail.value)];
    if (selected) return this.load(null, selected.id);
  },
  chooseMap(event) { if (this.alive()) this.selectMap(Number(event.detail.value)); },
  selectMap(index) {
    if (!this.alive() || this.data.useRealMap) return;
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
    if (!this.alive() || this.data.useRealMap) return;
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
    if (viewMode === 'map' && this.data.useRealMap && this.data.realMapFailed) {
      const realMapGeneration = this.data.realMapGeneration + 1;
      this.setData({ realMapFailed: false, mapNotice: '', realMapGeneration, realMapFrames: [{ generation: realMapGeneration }] });
    }
    this.setData({ viewMode });
    if (viewMode === 'map') this.resizeMap();
  },
  chooseType(event) {
    if (!this.alive()) return;
    this.setData({ activeType: event.currentTarget.dataset.type, selectedPoint: null, selectedReference: null }); this.filter();
  },
  filter() {
    if (!this.alive()) return;
    const activeType = this.data.activeType;
    if (this.data.useRealMap) {
      const filtered = this.data.places.filter((point) => matchesType(point, activeType));
      const realMarkers = realMap.realPoints(filtered, this.data.region).map((point) => realMap.marker(point, point.markerId));
      const realPointCount = realMarkers.length;
      const filteredReferences = references.filtered(this.data.referencePoints, activeType);
      realMarkers.push(...filteredReferences.map(references.marker));
      if (this.data.currentLocation) realMarkers.push(realMap.marker(Object.assign({ name: '本次附近位置' }, this.data.currentLocation), 0));
      const referenceChoices = [{ id: '', displayName: '选择参考点，地图移至该处' }].concat(filteredReferences);
      const referenceIndex = this.data.selectedReference ? Math.max(0, referenceChoices.findIndex((point) => point.id === this.data.selectedReference.id)) : 0;
      this.setData({ filtered, filteredReferences, referenceChoices, referenceIndex, realMarkers, realPointCount, realPolyline: !activeType || activeType === 'water' ? realMap.riverLines(this.data.rivers, this.data.region) : [] });
      return;
    }
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
  realEventCurrent(event) {
    return this.alive() && this.data.useRealMap && !this.data.realMapFailed && Number(event.currentTarget.dataset.generation) === this.data.realMapGeneration;
  },
  selectRealPoint(event) {
    if (!this.realEventCurrent(event)) return;
    const id = Number(event.detail.markerId);
    const reference = this.data.filteredReferences.find((item) => item.markerId === id);
    if (reference) { this.focusReference(reference, false); return; }
    const point = this.data.filtered.find((item) => item.markerId === id && realMap.navigable(item));
    if (point) this.setData({ selectedPoint: point, selectedReference: null, referenceIndex: 0 });
  },
  chooseReference(event) {
    if (!this.alive() || !this.data.useRealMap) return;
    const reference = this.data.referenceChoices[Number(event.detail.value)];
    if (reference && reference.id) this.focusReference(reference, true);
  },
  openReference(event) {
    if (!this.alive() || !this.data.useRealMap) return;
    const reference = this.data.filteredReferences.find((point) => point.id === event.currentTarget.dataset.id);
    if (reference) this.focusReference(reference, true);
  },
  focusReference(reference, recenter) {
    if (!this.alive() || !this.data.useRealMap || !this.data.filteredReferences.some((point) => point.id === reference.id)) return;
    const update = { selectedReference: reference, selectedPoint: null, referenceIndex: this.data.referenceChoices.findIndex((point) => point.id === reference.id) };
    if (recenter) {
      this.cancelLocation();
      const realMapGeneration = this.data.realMapGeneration + 1;
      Object.assign(update, { viewMode: 'map', locating: false, locationNotice: '', realMapFailed: false, mapNotice: '', realLatitude: reference.latitude, realLongitude: reference.longitude, realScale: 14, realMapGeneration, realMapFrames: [{ generation: realMapGeneration }] });
    }
    this.setData(update);
    if (recenter && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  realMapError(event) {
    if (!this.realEventCurrent(event)) return;
    this.cancelLocation();
    this.setData({ realMapFailed: true, realMapFrames: [], locating: false, selectedPoint: null, selectedReference: null, viewMode: 'list', mapNotice: '地图暂时无法显示，可先浏览地点列表，或点“真实地图”重试。' });
  },
  cancelLocation() {
    if (this._locationRequest) this._locationRequest.cancel();
    this._locationRequest = null;
  },
  async locateMe() {
    if (!this.alive() || this.data.loading || !this.data.useRealMap || this.data.locating || this.data.realMapFailed) return;
    const generation = this._generation;
    this.setData({ locating: true, locationNotice: '', selectedPoint: null, selectedReference: null, currentLocation: null });
    this.filter();
    const request = this._locationRequest = realMap.locationRequest(wx);
    const result = await request;
    if (!this.current(generation) || this._locationRequest !== request) return;
    this._locationRequest = null;
    if (result.status === 'selected') {
      const realMapGeneration = this.data.realMapGeneration + 1;
      this.setData({ locating: false, realMapGeneration, realMapFrames: [{ generation: realMapGeneration }], currentLocation: result.location, realLatitude: result.location.latitude, realLongitude: result.location.longitude, realScale: 13, locationNotice: '已显示附近位置。模糊位置仅用于本次地图浏览，不提交平台后端或保存到记录。' });
      this.filter();
    } else this.setData({ locating: false, locationNotice: '暂未获得附近位置；仍可手动切换城市、拖动地图和浏览地点。' });
  },
  resetCity() {
    if (!this.alive() || !this.data.useRealMap) return;
    const city = realMap.cityMap(this.data.region);
    if (!city) return;
    this.cancelLocation();
    const realMapGeneration = this.data.realMapGeneration + 1;
    this.setData({ currentLocation: null, selectedPoint: null, selectedReference: null, locating: false, locationNotice: '', realLatitude: city.latitude, realLongitude: city.longitude, realScale: city.scale, realMapFailed: false, realMapGeneration, realMapFrames: [{ generation: realMapGeneration }] });
    this.filter();
  },
  navigatePoint() {
    if (!this.alive() || !this.data.useRealMap || !this.data.selectedPoint) return;
    const generation = this._generation;
    realMap.openLocation(wx, this.data.selectedPoint, () => { if (this.current(generation)) this.setData({ locationNotice: '地点地图暂不可用，请稍后重试。' }); });
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
}));
