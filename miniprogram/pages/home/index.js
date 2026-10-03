const { selectTab } = require('../../lib/tab-bar');
const { app } = require('../../lib/page');
const { time, value, message } = require('../../lib/format');
const { loadRegions, selectRegion } = require('../../lib/region');
const { weatherView } = require('../../lib/weather');
const { locateWeatherCity } = require('../../lib/weather-location');
const { entryUrl } = require('../../lib/llm');
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
  if (alerts.status === 'unavailable') return { label: '查询不可用', tone: 'unavailable' };
  if (alerts.stale) return { label: alerts.items.length ? '历史公告 ' + alerts.items.length + ' 条' : '历史缓存', tone: 'stale' };
  if (alerts.empty) return { label: '暂无预警', tone: 'empty' };
  if (alerts.items.length) return { label: alerts.items.length + ' 条公告', tone: 'active' };
  return { label: '状态待确认', tone: 'unavailable' };
}
Page({
  data: { loading: true, error: '', regions: [], regionIndex: 0, region: null, weather: null, air: null, alerts: [], alertNotice: '', sections: [], health: null, cityLoading: true, cityError: '', cities: [], cityIndex: 0, city: null, citySummary: null, cityEnabled: false, locationBusy: false, locationNotice: '', weatherTheme: 'calm', airExpanded: false, alertsExpanded: false, alertBadge: null, observationExpanded: false },
  onLoad() { this._alive = true; return this.load(); },
  onShow() {
    if (this._alive === false) return;
    selectTab(this, 0);
    const selected = app().globalData.region;
    if (this._hidden || (this._loaded && selected && (!this.data.region || selected.id !== this.data.region.id))) { this._hidden = false; return this.load(); }
  },
  onHide() { this._hidden = true; this._generation = (this._generation || 0) + 1; this._cityGeneration = (this._cityGeneration || 0) + 1; this._locationGeneration = (this._locationGeneration || 0) + 1; },
  onUnload() { this._alive = false; this.onHide(); },
  onPullDownRefresh() { return this.load(); },
  current(generation) { return this._alive !== false && !this._hidden && generation === this._generation; },
  clearEnvironment() { return { weather: null, air: null, alerts: [], alertNotice: '', sections: [] }; },
  async load() {
    if (this._alive === false || this._hidden) return;
    this._hidden = false;
    const generation = this._generation = (this._generation || 0) + 1;
    const cityRequest = this.loadCityLocations();
    this.setData(Object.assign({ loading: true, error: '' }, this.clearEnvironment()));
    try {
      const application = app();
      const [health, selection] = await Promise.all([application.api.request('health/'), loadRegions(application)]);
      if (!this.current(generation)) return;
      application.globalData.health = health.data;
      selectRegion(application, selection.region);
      this.setData(Object.assign({ health: health.data }, selection));
      if (selection.region) await this.loadEnvironment(selection.region.id, generation);
      if (this.current(generation)) this._loaded = true;
    } catch (error) { if (this.current(generation)) this.setData({ error: message(error) }); }
    finally { await cityRequest; if (this.current(generation)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); } }
  },
  cityCurrent(generation) { return this._alive !== false && !this._hidden && generation === this._cityGeneration; },
  async loadCityLocations() {
    const generation = this._cityGeneration = (this._cityGeneration || 0) + 1;
    this._locationGeneration = (this._locationGeneration || 0) + 1;
    this.setData({ cityLoading: true, cityError: '', citySummary: null, airExpanded: false, alertsExpanded: false, alertBadge: null, locationBusy: false, locationNotice: '' });
    try {
      const data = (await app().api.request('weather-data/locations/')).data || {};
      if (!this.cityCurrent(generation)) return;
      const cities = Array.isArray(data.items) ? data.items : [];
      const cityIndex = Math.max(0, cities.findIndex((item) => item.slug === app().globalData.weatherLocation));
      const city = cities[cityIndex] || null;
      this.setData({ cities, cityIndex, city, cityEnabled: Boolean(data.enabled) });
      if (city && data.enabled) await this.loadCitySummary(city.slug, generation);
    } catch (error) { if (this.cityCurrent(generation)) this.setData({ cityError: message(error) }); }
    finally { if (this.cityCurrent(generation)) this.setData({ cityLoading: false }); }
  },
  async loadCitySummary(slug, generation) {
    const data = (await app().api.request('weather-data/summary/', { data: { location: slug }, timeout: 55000 })).data;
    if (!this.cityCurrent(generation)) return;
    const citySummary = weatherView(data || {});
    this.setData({ citySummary, alertBadge: alertBadge(citySummary.alerts), weatherTheme: weatherTheme(data && data.weather && data.weather.data) });
  },
  changeCity(event) {
    this._locationGeneration = (this._locationGeneration || 0) + 1;
    return this.selectWeatherCity(Number(event.detail.value), '');
  },
  async selectWeatherCity(cityIndex, locationNotice) {
    const city = this.data.cities[cityIndex];
    if (!city || this._alive === false || this._hidden) return;
    const generation = this._cityGeneration = (this._cityGeneration || 0) + 1;
    app().globalData.weatherLocation = city.slug;
    this.setData({ cityIndex, city, cityLoading: true, cityError: '', citySummary: null, airExpanded: false, alertsExpanded: false, alertBadge: null, locationBusy: false, locationNotice });
    try { if (this.data.cityEnabled) await this.loadCitySummary(city.slug, generation); }
    catch (error) { if (this.cityCurrent(generation)) this.setData({ cityError: message(error) }); }
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
      if (city) return this.selectWeatherCity(index, '已选择邻近支持城市：' + city.name + '。以下是城市代表点天气。');
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
  toggleObservations() { if (this._alive !== false && !this._hidden) this.setData({ observationExpanded: !this.data.observationExpanded }); },
  openWeather() { wx.navigateTo({ url: '/pages/weather/index' }); },
  weatherSource() { wx.setClipboardData({ data: 'https://www.qweather.com' }); },
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
});
