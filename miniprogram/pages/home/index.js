const { withTheme } = require('../../lib/theme');
const { selectTab } = require('../../lib/tab-bar');
const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { loadRegions } = require('../../lib/region');
const { weatherView } = require('../../lib/weather');
const { locateWeatherCity, weatherCityOptions, weatherCitySlug } = require('../../lib/weather-location');
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
  data: { loading: true, error: '', regions: [], regionIndex: 0, region: null, weather: null, air: null, alerts: [], alertNotice: '', sections: [], observationLoading: false, cityLoading: true, cityError: '', cities: [], cityIndex: 0, city: null, citySummary: null, cityEnabled: false, locationBusy: false, locationNotice: '', weatherTheme: 'calm', airExpanded: false, alertsExpanded: false, alertBadge: null, observationExpanded: true },
  onLoad() { this._alive = true; return this.load(); },
  onShow() {
    if (this._alive === false) return;
    selectTab(this, 0);
    if (this._hidden) { this._hidden = false; return this.load(); }
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
      const regionIndex = selection.regions.findIndex(region => region.slug === 'demo-campus');
      this.setData({ regions: selection.regions, regionIndex, region: selection.regions[regionIndex] || null });
      if (this.current(generation)) this._loaded = true;
    } catch (error) { if (this.current(generation)) this.setData({ error: message(error) }); }
    finally {
      // Feature navigation does not wait for an external weather refresh.
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
    const selectedSlug = weatherCitySlug(app().globalData.weatherLocation || cache.selected());
    const cachedCities = weatherCityOptions(directory && directory.items);
    const cachedIndex = directory ? Math.max(0, cachedCities.findIndex(item => item.slug === selectedSlug)) : 0;
    const cachedCity = directory && cachedCities[cachedIndex];
    const snapshot = directory && directory.enabled && cachedCity && cache.read(cachedCity.slug);
    this.setData({ cityLoading: !snapshot, cityError: '', citySummary: null, airExpanded: false, alertsExpanded: false, alertBadge: null, locationBusy: false, locationNotice: '' });
    if (directory) this.setData({ cities: cachedCities, cityIndex: cachedIndex, city: cachedCity || null, cityEnabled: directory.enabled });
    if (snapshot) this.showCitySummary(snapshot.data);
    try {
      const data = await cache.locations(app().api, force);
      if (!this.cityCurrent(generation)) return;
      const cities = weatherCityOptions(data.items);
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
  toggleAir() { if (this._alive !== false && !this._hidden) this.setData({ airExpanded: !this.data.airExpanded }); },
  openWeather() { wx.navigateTo({ url: '/pages/weather/index' }); },
  weatherSource() { wx.setClipboardData({ data: 'https://www.qweather.com' }); },
  weatherAttribution(event) {
    const url = event && event.currentTarget && event.currentTarget.dataset.url;
    const summary = this.data.citySummary || {};
    const links = [...(summary.attribution_links || []), ...(summary.alerts && summary.alerts.attribution_links || [])];
    if (typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) && links.some(link => link.url === url)) wx.setClipboardData({ data: url });
  },
  openSimulation(event) {
    const page = event.detail && event.detail.page;
    if (!this.current(this._generation)) return;
    if (!['water', 'data-center'].includes(page)) return;
    if (!this.data.region) { wx.showToast({ title: '示范校园目录暂不可用，请稍后重试', icon: 'none' }); return; }
    this.measurements({ currentTarget: { dataset: { page } } });
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
