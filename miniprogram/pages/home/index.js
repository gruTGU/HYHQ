const { withTheme } = require('../../lib/theme');
const { selectTab } = require('../../lib/tab-bar');
const { app } = require('../../lib/page');
const { time, value, message } = require('../../lib/format');
const { loadRegions, selectRegion } = require('../../lib/region');
const { weatherView } = require('../../lib/weather');
const { locateWeatherCity } = require('../../lib/weather-location');
const { entryUrl } = require('../../lib/llm');
const { createWeatherSnapshotStore, RETRY } = require('../../lib/weather-snapshot');
function weatherCache() {
  const application = app();
  if (!application.weatherSnapshots) application.weatherSnapshots = createWeatherSnapshotStore(wx, application.config || {});
  return application.weatherSnapshots;
}
function weatherTheme(data) {
  const condition = String(data && data.condition || '').toLowerCase();
  const code = Number(data && data.condition_code);
  if (/雪|snow|sleet/.test(condition) || code >= 400 && code < 500) return 'snow';
  if (/雨|雷|rain|storm|shower/.test(condition) || code >= 300 && code < 400) return 'rain';
  if (/雾|霾|沙|尘|fog|haze|dust/.test(condition) || code >= 500 && code < 600) return 'mist';
  if (/阴|多云|cloud|overcast/.test(condition) || code >= 101 && code <= 104) return 'cloud';
  if (/晴|sun|clear/.test(condition) || code === 100 || code === 150) return 'sun';
  return 'calm';
}
function alertBadge(alerts) {
  if (alerts.status === 'unavailable') return { visible: true, label: '查询不可用', tone: 'unavailable' };
  if (alerts.stale) return { visible: true, label: alerts.items.length ? '历史公告 ' + alerts.items.length + ' 条' : '状态待更新', tone: 'stale' };
  if (alerts.empty) return { visible: false, label: '暂无预警', tone: 'empty' };
  const count = alerts.current_count === undefined ? alerts.items.length : alerts.current_count;
  if (count) return { visible: true, label: count + ' 条公告', tone: 'active' };
  return { visible: true, label: '状态待确认', tone: 'unavailable' };
}
Page(withTheme({
  data: { loading: true, error: '', regions: [], regionIndex: 0, region: null, weather: null, air: null, alerts: [], alertNotice: '', sections: [], observationLoading: false, cityLoading: true, cityError: '', cities: [], cityIndex: 0, city: null, citySummary: null, cityEnabled: false, locationBusy: false, locationNotice: '', weatherTheme: 'calm', airExpanded: false, alertsExpanded: false, alertBadge: null, observationExpanded: false },
  onLoad() { this._alive = true; return this.load(); },
  onShow() {
    if (this._alive === false) return;
    selectTab(this, 0);
    const selected = app().globalData.region;
    if (this._hidden || (this._loaded && selected && (!this.data.region || selected.id !== this.data.region.id))) { this._hidden = false; return this.load(); }
  },
  onHide() { this._hidden = true; this.clearWeatherTimer(); this._generation = (this._generation || 0) + 1; this._cityGeneration = (this._cityGeneration || 0) + 1; this._locationGeneration = (this._locationGeneration || 0) + 1; },
  onUnload() { this._alive = false; this.onHide(); },
  onPullDownRefresh() { if (app().api.invalidatePublicCache) app().api.invalidatePublicCache(); return this.load(true); },
  current(generation) { return this._alive !== false && !this._hidden && generation === this._generation; },
  clearEnvironment() { return { weather: null, air: null, alerts: [], alertNotice: '', sections: [] }; },
  async load(forceWeather = false) {
    if (this._alive === false || this._hidden) return;
    this._hidden = false;
    const generation = this._generation = (this._generation || 0) + 1;
    const cityRequest = this.loadCityLocations(forceWeather === true);
    this._observationRegion = null; this._observationLoad = null;
    this.setData(Object.assign({ loading: true, error: '', observationLoading: this.data.observationExpanded }, this.clearEnvironment()));
    try {
      const application = app();
      const selection = await loadRegions(application);
      if (!this.current(generation)) return;
      selectRegion(application, selection.region);
      this.setData(selection);
      // The simulation summary is collapsed by default; read it on demand.
      if (selection.region && this.data.observationExpanded) await this.loadEnvironment(selection.region.id, generation);
      if (this.current(generation)) this._loaded = true;
    } catch (error) { if (this.current(generation)) this.setData({ error: message(error) }); }
    finally {
      // Feature navigation and the AI entry do not wait for an external weather refresh.
      if (this.current(generation)) this.setData({ loading: false, observationLoading: false });
      await cityRequest; if (this.current(generation)) wx.stopPullDownRefresh();
    }
  },
  cityCurrent(generation) { return this._alive !== false && !this._hidden && generation === this._cityGeneration; },
  clearWeatherTimer() { if (this._weatherTimer) clearTimeout(this._weatherTimer); this._weatherTimer = null; },
  scheduleWeatherRefresh(slug, generation, delay) {
    this.clearWeatherTimer();
    if (this._alive !== true || !this.cityCurrent(generation)) return;
    const saved = weatherCache().read(slug);
    if (!saved && delay === undefined) return;
    const wait = delay === undefined ? Math.max(1000, saved.refreshAt - Date.now()) : delay;
    this._weatherTimer = setTimeout(() => {
      this._weatherTimer = null;
      if (!this.cityCurrent(generation) || !this.data.city || this.data.city.slug !== slug) return;
      this.loadCitySummary(slug, generation, true).catch(() => {
        if (!this.cityCurrent(generation)) return;
        const previous = weatherCache().read(slug);
        if (previous) this.showCitySummary(previous.data);
        this.scheduleWeatherRefresh(slug, generation, RETRY);
      });
    }, Math.min(wait, 2147483647));
    if (this._weatherTimer && this._weatherTimer.unref) this._weatherTimer.unref();
  },
  showCitySummary(data) {
    const citySummary = weatherView(data || {});
    this.setData({ citySummary, cityLoading: false, cityError: '', alertBadge: alertBadge(citySummary.alerts), weatherTheme: weatherTheme(data && data.weather && data.weather.data) });
  },
  async loadCityLocations(force = false) {
    force = force === true;
    this.clearWeatherTimer();
    const generation = this._cityGeneration = (this._cityGeneration || 0) + 1;
    this._locationGeneration = (this._locationGeneration || 0) + 1;
    const cache = weatherCache(), directory = cache.directory(true);
    const selectedSlug = app().globalData.weatherLocation || cache.selected();
    const cachedIndex = directory ? Math.max(0, directory.items.findIndex(item => item.slug === selectedSlug)) : 0;
    const cachedCity = directory && directory.items[cachedIndex];
    const snapshot = directory && directory.enabled && cachedCity && cache.read(cachedCity.slug);
    this.setData({ cityLoading: !snapshot, cityError: '', citySummary: null, airExpanded: false, alertsExpanded: false, alertBadge: null, locationBusy: false, locationNotice: '' });
    if (directory) this.setData({ cities: directory.items, cityIndex: cachedIndex, city: cachedCity || null, cityEnabled: directory.enabled });
    if (snapshot) this.showCitySummary(snapshot.data);
    try {
      const data = await cache.locations(app().api, force);
      if (!this.cityCurrent(generation)) return;
      const cities = Array.isArray(data.items) ? data.items : [];
      const cityIndex = Math.max(0, cities.findIndex((item) => item.slug === selectedSlug));
      const city = cities[cityIndex] || null;
      if (!city || !this.data.city || city.slug !== this.data.city.slug) this.setData({ citySummary: null, alertBadge: null, weatherTheme: 'calm', cityLoading: Boolean(city && data.enabled) });
      this.setData({ cities, cityIndex, city, cityEnabled: Boolean(data.enabled) });
      if (city && data.enabled) await this.loadCitySummary(city.slug, generation, force);
      else this.setData({ citySummary: null, alertBadge: null });
    } catch (error) {
      if (this.cityCurrent(generation)) {
        if (!this.data.citySummary) this.setData({ cityError: message(error) });
        if (this.data.city) this.scheduleWeatherRefresh(this.data.city.slug, generation, RETRY);
      }
    }
    finally { if (this.cityCurrent(generation)) this.setData({ cityLoading: false }); }
  },
  async loadCitySummary(slug, generation, force = false) {
    const cache = weatherCache(), saved = cache.read(slug);
    if (saved && this.cityCurrent(generation)) {
      this.showCitySummary(saved.data);
      this.setData({ cityLoading: false });
    }
    const data = await cache.load(slug, app().api, force);
    if (!this.cityCurrent(generation)) return;
    this.showCitySummary(data);
    this.scheduleWeatherRefresh(slug, generation);
  },
  changeCity(event) {
    this._locationGeneration = (this._locationGeneration || 0) + 1;
    return this.selectWeatherCity(Number(event.detail.value), '');
  },
  async selectWeatherCity(cityIndex, locationNotice) {
    const city = this.data.cities[cityIndex];
    if (!city || this._alive === false || this._hidden) return;
    const generation = this._cityGeneration = (this._cityGeneration || 0) + 1;
    this.clearWeatherTimer();
    app().globalData.weatherLocation = city.slug;
    weatherCache().select(city.slug);
    this.setData({ cityIndex, city, cityLoading: true, cityError: '', citySummary: null, airExpanded: false, alertsExpanded: false, alertBadge: null, locationBusy: false, locationNotice });
    try { if (this.data.cityEnabled) await this.loadCitySummary(city.slug, generation); }
    catch (error) { if (this.cityCurrent(generation)) { if (!this.data.citySummary) this.setData({ cityError: message(error) }); this.scheduleWeatherRefresh(city.slug, generation, RETRY); } }
    finally { if (this.cityCurrent(generation)) this.setData({ cityLoading: false }); }
  },
  async locateCity() {
    if (this._alive === false || this._hidden || this.data.locationBusy || this.data.cityLoading || !this.data.cities.length) return;
    const generation = this._locationGeneration = (this._locationGeneration || 0) + 1;
    this.setData({ locationBusy: true, locationNotice: '' });
    const result = await locateWeatherCity(wx, this.data.cities);
    if (this._alive === false || this._hidden || generation !== this._locationGeneration) return;
    if (result.status === 'selected') {
      const index = this.data.cities.findIndex(city => city.slug === result.slug), city = this.data.cities[index];
      if (city) return this.selectWeatherCity(index, '');
    }
    this.setData({ locationBusy: false, locationNotice: result.status === 'unsupported'
      ? '当前位置附近暂无支持城市，请手动选择要查看的城市。'
      : '未能获取位置，你可以继续手动切换城市。' });
  },
  toggleAlerts() {
    if (this._alive !== false && !this._hidden && !this.data.cityLoading && !this.data.cityError && this.data.citySummary) this.setData({ alertsExpanded: !this.data.alertsExpanded });
  },
  openAI() {
    if (this._alive === false || this._hidden || this.data.loading || this.data.error || !this.data.region) return;
    let url = entryUrl('explore', 'region', this.data.region.id);
    if (!url) return;
    const city = this.data.city;
    if (city && typeof city.slug === 'string' && this.data.cities.some(item => item.slug === city.slug)) url += '&weather_location=' + encodeURIComponent(city.slug);
    wx.navigateTo({ url });
  },
  toggleAir() { if (this._alive !== false && !this._hidden) this.setData({ airExpanded: !this.data.airExpanded }); },
  toggleObservations() {
    if (this._alive === false || this._hidden) return;
    const expanded = !this.data.observationExpanded;
    this.setData({ observationExpanded: expanded });
    if (!expanded || !this.data.region || this._observationRegion === this.data.region.id) return;
    if (this._observationLoad) return this._observationLoad;
    const generation = this._generation;
    this.setData({ observationLoading: true });
    const loading = this.loadEnvironment(this.data.region.id, generation).finally(() => {
      if (this._observationLoad === loading) this._observationLoad = null;
      if (this.current(generation)) this.setData({ observationLoading: false });
    });
    this._observationLoad = loading; return loading;
  },
  openWeather() { wx.navigateTo({ url: '/pages/weather/index' }); },
  weatherSource() { wx.setClipboardData({ data: 'https://www.qweather.com' }); },
  weatherAttribution(event) {
    const url = event && event.currentTarget && event.currentTarget.dataset.url;
    const summary = this.data.citySummary || {};
    const links = [...(summary.attribution_links || []), ...(summary.alerts && summary.alerts.attribution_links || [])];
    if (typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) && links.some(link => link.url === url)) wx.setClipboardData({ data: url });
  },
  async loadEnvironment(id, generation) {
    const definitions = [
      { key: 'weather', title: '天气', path: 'weather/' },
      { key: 'air', title: '空气质量', path: 'air-quality/' },
      { key: 'alerts', title: '气象提示', path: 'weather-alerts/' },
    ];
    const settled = await Promise.all(definitions.map(async (definition) => {
      try { return { key: definition.key, data: (await app().api.request(definition.path, { data: { region: id } })).data }; }
      catch (error) { return { key: definition.key, title: definition.title, error: message(error) }; }
    }));
    if (!this.current(generation)) return;
    const patch = { sections: settled.filter((item) => item.error) };
    settled.forEach((result) => {
      if (result.error) return;
      const data = result.data || {};
      if (result.key === 'alerts') {
        patch.alerts = (Array.isArray(data) ? data : data.alerts || []).map((item) => Object.assign({}, item, { time_label: time(item.issued_at || item.published_at) }));
        patch.alertNotice = data.notice || '当前仅查询模拟气象提示，不提供真实气象预警。';
      } else {
        patch[result.key] = Object.assign({}, data, {
          temp_label: value(data.temperature, '°'), humidity_label: value(data.humidity, '%'),
          pm10_label: value(data.pm10), pm25_label: value(data.pm25 !== undefined ? data.pm25 : data.pm2_5),
          updated_label: time(data.observed_at || data.updated_at),
        });
      }
    });
    this._observationRegion = id;
    this.setData(patch);
  },
  async changeRegion(event) {
    const index = Number(event.detail.value), region = this.data.regions[index];
    if (!region || this._alive === false || this._hidden) return;
    const generation = this._generation = (this._generation || 0) + 1;
    selectRegion(app(), region);
    this.setData(Object.assign({ regionIndex: index, region, loading: true, error: '' }, this.clearEnvironment()));
    try { await this.loadEnvironment(region.id, generation); }
    finally { if (this.current(generation)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); } }
  },
  navigate(event) { if (this._alive !== false && !this._hidden) wx.switchTab({ url: '/pages/' + event.currentTarget.dataset.page + '/index' }); },
  measurements(event) {
    if (this._alive === false || this._hidden) return;
    const page = event.currentTarget.dataset.page;
    if (!['water', 'data-center'].includes(page)) return;
    const region = this.data.region;
    wx.navigateTo({ url: '/pages/' + page + '/index' + (region ? '?region=' + encodeURIComponent(region.id) : '') });
  },
  assessment() { if (this._alive !== false && !this._hidden) wx.navigateTo({ url: '/pages/assessment/index' }); },
}));
