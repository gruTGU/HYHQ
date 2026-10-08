const releasePolicy = require('../../lib/release-policy');
const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { requestId } = require('../../lib/llm');
const { locateWeatherCity, weatherCityOptions } = require('../../lib/weather-location');
const { forecastView, reminderView, bookingFields, validateBooking, aiDraftView } = require('../../lib/weather-forecast');
Page(withTheme({
  data: { loading: false, error: '', locations: [], locationIndex: 0, location: null, forecast: null,
    forecastEnabled: false, subscriptionEnabled: false, subscriptionNotice: '', loggedIn: false, wechatLogin: false,
    reminders: [], intent: null, busy: false, locating: false, locationNotice: '', actionError: '', notice: '', canConfirmAgain: false,
    bookingDate: '', bookingTime: '08:00', minDate: '', maxDate: '', aiText: '', aiNotice: '', aiError: '', aiBusy: false },
  onLoad(options) {
    this._alive = true; this._wantedLocation = options && options.location || app().globalData.weatherLocation || 'tianjin';
    this.setData(bookingFields());
  },
  onShow() { if (this._alive === false) return; this._hidden = false; return this.load(); },
  onHide() {
    if (this._alive === false) return; this._hidden = true; this._version = (this._version || 0) + 1; this._accepted = null;
    this.setData({ reminders: [], intent: null, notice: '', actionError: '', canConfirmAgain: false, busy: false, aiBusy: false, locating: false });
  },
  onUnload() { this._alive = false; this._version = (this._version || 0) + 1; this._accepted = null; },
  active() { return this._alive !== false && !this._hidden; },
  now() { return Date.now() + (this._serverOffset || 0); },
  current(version, token) {
    if (!this.active() || this._version !== version) return false;
    if (app().session.token() === token) return true;
    this._version += 1; this._accepted = null; this._interpretRequest = null;
    this.setData({ reminders: [], intent: null, busy: false, aiBusy: false, locating: false, loading: false,
      loggedIn: Boolean(app().session.token()), wechatLogin: false, subscriptionEnabled: false, canConfirmAgain: false,
      actionError: '登录状态已变化，请刷新后再操作。' }); return false;
  },
  onPullDownRefresh() { if (this.data.busy || this.data.locating) { wx.stopPullDownRefresh(); return; } return this.load(); },
  async load() {
    if (!this.active() || this.data.busy) return;
    const version = this._version = (this._version || 0) + 1, token = app().session.token();
    this._token = token; this._accepted = null;
    this.setData({ loading: true, error: '', forecast: null, intent: null, reminders: [], loggedIn: Boolean(token), canConfirmAgain: false,
      forecastEnabled: false, subscriptionEnabled: false, wechatLogin: false, subscriptionNotice: '正在读取提醒服务状态…' });
    try {
      const results = await Promise.allSettled([app().api.request('weather-data/locations/'), app().api.request('weather-data/reminders/')]);
      if (!this.current(version, token)) return;
      const status = results[1].status === 'fulfilled' ? results[1].value.data || {} : {};
      const serverTime = Date.parse(status.server_time);
      this._serverOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
      const range = bookingFields(this.now());
      this.setData({ minDate: range.minDate, maxDate: range.maxDate,
        subscriptionEnabled: status.enabled === true, wechatLogin: status.wechat_login === true,
        subscriptionNotice: status.notice || (results[1].status === 'rejected' ? '预约服务暂不可用，可稍后刷新。' : '天气预约暂未开放。'),
        reminders: (Array.isArray(status.items) ? status.items : []).map(reminderView) });
      if (results[0].status === 'rejected') throw results[0].reason;
      const catalog = results[0].value.data || {}, locations = weatherCityOptions(catalog.items);
      const wanted = locations.findIndex((item) => item.slug === this._wantedLocation), tianjin = locations.findIndex((item) => item.slug === 'tianjin');
      const locationIndex = wanted >= 0 ? wanted : Math.max(0, tianjin), location = locations[locationIndex] || null;
      this.setData({ locations, locationIndex, location, forecastEnabled: catalog.forecast_enabled === true });
      if (location && catalog.forecast_enabled === true) await this.loadForecast(location.slug, version, token);
    } catch (error) { if (this.current(version, token)) this.setData({ error: message(error) }); }
    finally { if (this.current(version, token)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); } }
  },
  async loadForecast(slug, version, token) {
    const result = await app().api.request('weather-data/' + encodeURIComponent(slug) + '/forecast/', { timeout: 20000 });
    if (this.current(version, token)) this.setData({ forecast: forecastView((result.data || {}).forecast) });
  },
  changeLocation(event) {
    if (!this.active() || this.data.busy || this.data.locating || this.data.canConfirmAgain) return;
    const selected = this.data.locations[Number(event.detail.value)];
    if (!selected) return;
    this._wantedLocation = selected.slug; app().globalData.weatherLocation = selected.slug;
    this._interpretRequest = null; this.setData({ aiNotice: '', aiError: '', notice: '', actionError: '', locationNotice: '' });
    return this.load();
  },
  async locateCity() {
    if (!this.active() || this.data.busy || this.data.loading || this.data.locating || this.data.canConfirmAgain || !this.data.locations.length) return;
    const version = this._version, token = this._token;
    this.setData({ locating: true, locationNotice: '' });
    const result = await locateWeatherCity(wx, this.data.locations);
    if (!this.current(version, token)) return;
    this.setData({ locating: false });
    if (result.status === 'selected') {
      const index = this.data.locations.findIndex((item) => item.slug === result.slug);
      if (index >= 0) return this.changeLocation({ detail: { value: index } });
    }
    this.setData({ locationNotice: result.status === 'unsupported' ? '附近暂无支持的天气城市，请手动选择。' : '暂未取得位置，请重试或手动选择城市。' });
  },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  canAct() { return this.active() && !this.data.busy && !this.data.loading && !this.data.locating && Boolean(this._token) && this.current(this._version, this._token); },
  changeBookingDate(event) { this.changeBooking('bookingDate', event.detail.value); },
  changeBookingTime(event) { this.changeBooking('bookingTime', event.detail.value); },
  changeBooking(field, value) {
    if (!this.active() || this.data.busy || this.data.canConfirmAgain) return;
    this._accepted = null; this.setData({ [field]: value, intent: null, actionError: '', notice: '', aiNotice: '' });
  },
  inputAiText(event) {
    if (!releasePolicy.naturalLanguageReminderEnabled) return;
    if (!this.active() || this.data.busy || this.data.canConfirmAgain) return;
    const aiText = String(event.detail.value || '').slice(0, 500);
    if (aiText !== this.data.aiText) this._interpretRequest = null;
    this.setData({ aiText, aiNotice: '', aiError: '' });
  },
  async interpretReminder() {
    if (!releasePolicy.naturalLanguageReminderEnabled) return;
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.location || this.data.canConfirmAgain) return;
    const text = this.data.aiText.trim();
    if (!text) { this.setData({ aiError: '先写下想在哪座城市、什么时间收到提醒。' }); return; }
    const version = this._version, token = this._token, location = this.data.location.slug;
    if (!this._interpretRequest || this._interpretRequest.text !== text || this._interpretRequest.token !== token) {
      this._interpretRequest = { text, location, token, key: requestId() };
    }
    this.setData({ busy: true, aiBusy: true, aiNotice: '', aiError: '', intent: null, notice: '', actionError: '' });
    try {
      const result = await app().api.request('weather-data/reminders/interpret/', { method: 'POST', timeout: 55000,
        data: { text, location: this._interpretRequest.location, request_key: this._interpretRequest.key } });
      if (!this.current(version, token)) return;
      const data = result.data || {};
      if (data.needs_clarification === true || !data.draft) {
        this.setData({ aiNotice: data.message || '请补充具体城市和时间，或直接在下方选择。' }); return;
      }
      const draft = aiDraftView(data.draft, this.data.locations, this.now());
      if (!draft) throw new Error('AI 返回的城市或时间暂不可用，请在下方手动选择。');
      this._wantedLocation = draft.location.slug; app().globalData.weatherLocation = draft.location.slug;
      const changedCity = this.data.location.slug !== draft.location.slug;
      this.setData({ location: draft.location, locationIndex: this.data.locations.findIndex((item) => item.slug === draft.location.slug),
        bookingDate: draft.bookingDate, bookingTime: draft.bookingTime,
        aiNotice: (draft.summary || '已填入预约草稿。') + ' 请核对下方城市和时间，再确认预约。', ...(changedCity ? { forecast: null } : {}) });
      if (changedCity && this.data.forecastEnabled) {
        try { await this.loadForecast(draft.location.slug, version, token); }
        catch (_) { if (this.current(version, token)) this.setData({ error: '预报暂未更新，预约草稿已保留。' }); }
      }
    } catch (error) { if (this.current(version, token)) this.setData({ aiError: message(error) + ' 你也可以直接手动预约。' }); }
    finally { if (this.current(version, token)) this.setData({ busy: false, aiBusy: false }); }
  },
  async prepareReminder() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.location || this.data.canConfirmAgain) return;
    const booking = validateBooking(this.data.bookingDate, this.data.bookingTime, this.now());
    if (booking.error) { this.setData({ actionError: booking.error }); return; }
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '', intent: null });
    try {
      const result = await app().api.request('weather-data/reminders/intents/', { method: 'POST',
        data: { location: this.data.location.slug, scheduled_for: booking.scheduled_for } });
      if (!this.current(version, token)) return;
      const intent = reminderView(result.data);
      if (intent.state === 'prepared' && intent.id && intent.template_id) this.setData({ intent });
      else this.setData({ notice: '这个预约已有记录，请在下方核对。' });
      this.upsertReminder(intent);
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  async editReminder() {
    if (!this.canAct() || this.data.canConfirmAgain || !this.data.intent) return;
    return this.cancelReminder({ currentTarget: { dataset: { id: this.data.intent.id } } });
  },
  upsertReminder(item) { this.setData({ reminders: [item].concat(this.data.reminders.filter((row) => row.id !== item.id)).slice(0, 30) }); },
  authorizeReminder() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.intent || this.data.intent.state !== 'prepared') return;
    const intent = this.data.intent, version = this._version, token = this._token;
    if (intent.consent_expires_at && Date.parse(intent.consent_expires_at) <= this.now()) {
      this.setData({ intent: null, actionError: '这次确认已过期，请重新核对并预约。' }); return;
    }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ actionError: '当前微信版本暂不支持订阅提醒。' }); return; }
    this.setData({ busy: true, actionError: '', notice: '' });
    let handled = false;
    // Keep the native authorization call synchronous inside the user's tap.
    try { wx.requestSubscribeMessage({ tmplIds: [intent.template_id], success: (result) => {
      if (handled) return; handled = true;
      if (!this.current(version, token)) return;
      if (result[intent.template_id] !== 'accept') {
        this.setData({ busy: false, notice: '未开启本次提醒，你仍可正常查看天气。' }); return;
      }
      this._accepted = { intent, version, token };
      return this.confirmAccepted();
    }, fail: () => { if (handled) return; handled = true;
      if (this.current(version, token)) this.setData({ busy: false, actionError: '本次授权未完成，可稍后重试。' });
    } }); } catch (_) { if (!handled && this.current(version, token)) this.setData({ busy: false, actionError: '本次授权未完成，请稍后重试。' }); }
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
      this.setData({ intent: null, notice: result.data.state === 'pending' ? '本次天气预约已保存，发送前可取消。' : '提醒状态已更新，请查看下方记录。' });
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
  copyForecastSource(event) {
    const url = event.currentTarget.dataset.url, forecast = this.data.forecast;
    if (this.active() && forecast && forecast.attribution_links.some((item) => item.url === url)) wx.setClipboardData({ data: url });
  },
  copySource() { if (this.active()) wx.setClipboardData({ data: 'https://www.qweather.com' }); },
}));
