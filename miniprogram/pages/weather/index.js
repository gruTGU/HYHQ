const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { forecastView, reminderView } = require('../../lib/weather-forecast');
Page({
  data: { loading: false, error: '', locations: [], locationIndex: 0, location: null, forecast: null,
    forecastEnabled: false, subscriptionEnabled: false, subscriptionNotice: '', loggedIn: false, wechatLogin: false,
    reminders: [], intent: null, busy: false, actionError: '', notice: '', canConfirmAgain: false },
  onLoad(options) { this._alive = true; this._wantedLocation = options && options.location || app().globalData.weatherLocation || ''; },
  onShow() { if (this._alive === false) return; this._hidden = false; return this.load(); },
  onHide() { if (this._alive === false) return; this._hidden = true; this._version = (this._version || 0) + 1; this._accepted = null;
    this.setData({ reminders: [], intent: null, notice: '', actionError: '', canConfirmAgain: false, busy: false }); },
  onUnload() { this._alive = false; this._version = (this._version || 0) + 1; this._accepted = null; },
  active() { return this._alive !== false && !this._hidden; },
  current(version, token) {
    if (!this.active() || this._version !== version) return false;
    if (app().session.token() === token) return true;
    this._version += 1; this._accepted = null;
    this.setData({ reminders: [], intent: null, busy: false, loading: false, loggedIn: Boolean(app().session.token()), canConfirmAgain: false,
      actionError: '登录状态已变化，请刷新后再操作。' }); return false;
  },
  onPullDownRefresh() { if (this.data.busy) { wx.stopPullDownRefresh(); return; } return this.load(); },
  async load() {
    if (!this.active() || this.data.busy) return;
    const version = this._version = (this._version || 0) + 1, token = app().session.token();
    this._token = token; this._accepted = null;
    this.setData({ loading: true, error: '', forecast: null, intent: null, reminders: [], loggedIn: Boolean(token), canConfirmAgain: false, forecastEnabled: false, subscriptionEnabled: false, wechatLogin: false, subscriptionNotice: '正在读取提醒服务状态…' });
    try {
      const results = await Promise.all([app().api.request('weather-data/locations/'), app().api.request('weather-data/reminders/')]);
      if (!this.current(version, token)) return;
      const catalog = results[0].data || {}, status = results[1].data || {};
      const locations = Array.isArray(catalog.items) ? catalog.items : [];
      const locationIndex = Math.max(0, locations.findIndex((item) => item.slug === this._wantedLocation));
      const location = locations[locationIndex] || null;
      this.setData({ locations, locationIndex, location, forecastEnabled: catalog.forecast_enabled === true,
        subscriptionEnabled: status.enabled === true, subscriptionNotice: status.notice || '天气提醒暂未开放。',
        wechatLogin: status.wechat_login === true, reminders: (status.items || []).map(reminderView) });
      if (location && catalog.forecast_enabled === true) await this.loadForecast(location.slug, version, token);
    } catch (error) { if (this.current(version, token)) this.setData({ error: message(error), subscriptionNotice: this.data.subscriptionEnabled ? this.data.subscriptionNotice : '天气提醒状态暂不可用，请重试。' }); }
    finally { if (this.current(version, token)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); } }
  },
  async loadForecast(slug, version, token) {
    const result = await app().api.request('weather-data/' + encodeURIComponent(slug) + '/forecast/', { timeout: 20000 });
    if (this.current(version, token)) this.setData({ forecast: forecastView((result.data || {}).forecast) });
  },
  changeLocation(event) {
    if (!this.active() || this.data.busy) return;
    const selected = this.data.locations[Number(event.detail.value)];
    if (!selected) return;
    this._wantedLocation = selected.slug; app().globalData.weatherLocation = selected.slug;
    return this.load();
  },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  canAct() { return this.active() && !this.data.busy && !this.data.loading && Boolean(this._token) && this.current(this._version, this._token); },
  async prepareReminder() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.location) return;
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '', intent: null });
    try {
      const result = await app().api.request('weather-data/reminders/intents/', { method: 'POST', data: { location: this.data.location.slug } });
      if (!this.current(version, token)) return;
      const intent = reminderView(result.data);
      if (intent.state === 'prepared') this.setData({ intent });
      else this.setData({ notice: '明早的提醒已经安排，可在下方查看。' });
      this.upsertReminder(intent);
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  upsertReminder(item) { this.setData({ reminders: [item].concat(this.data.reminders.filter((row) => row.id !== item.id)).slice(0, 20) }); },
  authorizeReminder() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.intent || this.data.intent.state !== 'prepared') return;
    const intent = this.data.intent, version = this._version, token = this._token;
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ actionError: '当前微信版本暂不支持订阅提醒。' }); return; }
    this.setData({ busy: true, actionError: '', notice: '' });
    let handled = false;
    // Synchronous call in a user tap handler: never after an awaited network call.
    wx.requestSubscribeMessage({ tmplIds: [intent.template_id], success: (result) => {
      if (handled) return; handled = true;
      if (!this.current(version, token)) return;
      if (result[intent.template_id] !== 'accept') {
        this.setData({ busy: false, notice: '未开启本次提醒，你仍可正常查看天气。' }); return;
      }
      this._accepted = { intent, version, token };
      return this.confirmAccepted();
    }, fail: () => { if (handled) return; handled = true;
      if (this.current(version, token)) this.setData({ busy: false, actionError: '本次授权未完成，可稍后重试。' });
    } });
  },
  async confirmAccepted() {
    const accepted = this._accepted;
    if (!accepted || !this.current(accepted.version, accepted.token)) return;
    const { intent, version, token } = accepted;
    this.setData({ busy: true, canConfirmAgain: false, actionError: '' });
    try {
      const result = await app().api.request('weather-data/reminders/' + encodeURIComponent(intent.id) + '/consent/',
        { method: 'POST', data: { template_id: intent.template_id, acceptance: 'accept' } });
      if (!this.current(version, token)) return;
      this._accepted = null; this.upsertReminder(reminderView(result.data));
      this.setData({ intent: null, notice: result.data.state === 'pending' ? '已安排明早的天气提醒，可在发送前取消。' : '提醒状态已更新，请查看下方记录。' });
    } catch (error) {
      if (this.current(version, token)) this.setData({ canConfirmAgain: true,
        actionError: message(error) + ' 授权结果尚未确认，可重试保存或刷新记录核对。' });
    } finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  retryConfirmation() { if (this.canAct()) return this.confirmAccepted(); },
  async cancelReminder(event) {
    if (!this.canAct()) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.reminders.some((row) => row.id === id && row.can_cancel)) return;
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      const result = await app().api.request('weather-data/reminders/' + encodeURIComponent(id) + '/cancel/', { method: 'POST', data: {} });
      if (!this.current(version, token)) return;
      this.upsertReminder(reminderView(result.data)); this._accepted = null;
      this.setData({ intent: null, canConfirmAgain: false, notice: result.data.state === 'cancelled' ? '本次提醒已取消。' : '提醒状态已更新。' });
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  copySource() { if (this.active()) wx.setClipboardData({ data: 'https://www.qweather.com' }); },
});
