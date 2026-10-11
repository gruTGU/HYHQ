const releasePolicy = require('../../lib/release-policy');
const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { requestId } = require('../../lib/llm');
const { locateWeatherCity, weatherCityOptions } = require('../../lib/weather-location');
const { forecastView, reminderView, bookingFields, validateBooking, nextDailyBooking, aiDraftView, localDate, localClock } = require('../../lib/weather-forecast');
Page(withTheme({
  data: { loading: false, error: '', locations: [], locationIndex: 0, location: null, forecast: null,
    forecastEnabled: false, weatherReminderEnabled: false,
    subscriptionEnabled: false, subscriptionNotice: '', loggedIn: false, wechatLogin: false,
    reminders: [], intent: null, busy: false, locating: false, locationNotice: '', actionError: '', notice: '', canConfirmAgain: false,
    subscriptionPool: { remaining: 0, reserved: 0, held: 0, needs_resubscribe: false }, dailyPlans: [], currentDailyPlan: null, legacySimulationPlans: [], grantIntent: null, grantPreparing: false, grantBusy: false, grantError: '', canRetryGrant: false,
    dailyTime: '08:00', dailyNextLabel: '', templateId: '', naturalLanguageEnabled: releasePolicy.naturalLanguageReminderEnabled,
    bookingDate: '', bookingTime: '08:00', minDate: '', maxDate: '', aiText: '', aiNotice: '', aiError: '', aiBusy: false },
  onLoad(options) {
    this._alive = true; this._wantedLocation = options && options.location || app().globalData.weatherLocation || 'tianjin';
    let dailyTime = '08:00';
    try { const saved = wx.getStorageSync('hyhq.weather.daily-time.v1'); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(saved)) dailyTime = saved; } catch (_) { /* Optional time preference. */ }
    this.setData(Object.assign(bookingFields(), { dailyTime })); this.updateDailyLabel();
  },
  onShow() { if (this._alive === false) return; this._hidden = false; return this.load(); },
  onHide() {
    if (this._alive === false) return; this._hidden = true; this._version = (this._version || 0) + 1; this._accepted = null; this._grantAccepted = null;
    this.setData({ reminders: [], intent: null, grantIntent: null, grantPreparing: false, grantBusy: false, canRetryGrant: false, grantError: '', subscriptionPool: { remaining: 0, reserved: 0, held: 0, needs_resubscribe: false }, dailyPlans: [], currentDailyPlan: null, legacySimulationPlans: [], notice: '', actionError: '', canConfirmAgain: false, busy: false, aiBusy: false, locating: false });
  },
  onUnload() { this._alive = false; this._version = (this._version || 0) + 1; this._accepted = null; this._grantAccepted = null; },
  active() { return this._alive !== false && !this._hidden; },
  now() { return Date.now() + (this._serverOffset || 0); },
  current(version, token) {
    if (!this.active() || this._version !== version) return false;
    if (app().session.token() === token) return true;
    this._version += 1; this._accepted = null; this._grantAccepted = null; this._interpretRequest = null;
    this.setData({ reminders: [], intent: null, grantIntent: null, grantPreparing: false, grantBusy: false, canRetryGrant: false, subscriptionPool: { remaining: 0, reserved: 0, held: 0, needs_resubscribe: false }, dailyPlans: [], currentDailyPlan: null, legacySimulationPlans: [], busy: false, aiBusy: false, locating: false, loading: false,
      loggedIn: Boolean(app().session.token()), wechatLogin: false, subscriptionEnabled: false, canConfirmAgain: false,
      actionError: '登录状态已变化，请刷新后再操作。' }); return false;
  },
  onPullDownRefresh() { if (this.data.busy || this.data.locating) { wx.stopPullDownRefresh(); return; } return this.load(); },
  async load() {
    if (!this.active() || this.data.busy) return;
    const version = this._version = (this._version || 0) + 1, token = app().session.token();
    this._token = token; this._accepted = null; this._grantAccepted = null;
    this.setData({ loading: true, error: '', forecast: null, intent: null, grantIntent: null, grantError: '', canRetryGrant: false, reminders: [], legacySimulationPlans: [], loggedIn: Boolean(token), canConfirmAgain: false,
      forecastEnabled: false, weatherReminderEnabled: false, subscriptionEnabled: false, templateId: '', wechatLogin: false, subscriptionNotice: '正在读取提醒服务状态…' });
    try {
      const results = await Promise.allSettled([app().api.request('weather-data/locations/'), app().api.request('weather-data/reminders/')]);
      if (!this.current(version, token)) return;
      const status = results[1].status === 'fulfilled' ? results[1].value.data || {} : {};
      const serverTime = Date.parse(status.server_time);
      this._serverOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
      const range = bookingFields(this.now());
      this.setData({ minDate: range.minDate, maxDate: range.maxDate,
        weatherReminderEnabled: status.enabled === true,
        subscriptionEnabled: status.enabled === true, templateId: typeof status.template_id === 'string' ? status.template_id : '', wechatLogin: status.wechat_login === true,
        subscriptionNotice: status.notice || (results[1].status === 'rejected' ? '预约服务暂不可用，可稍后刷新。' : '天气预约暂未开放。'),
        reminders: (Array.isArray(status.items) ? status.items : []).map(reminderView),
        subscriptionPool: this.poolView(status.subscription_pool), dailyPlans: Array.isArray(status.daily_plans) ? status.daily_plans : [],
        legacySimulationPlans: (Array.isArray(status.daily_plans) ? status.daily_plans : []).filter(plan => plan.type === 'ecology_simulation' && plan.enabled) });
      this.updateCurrentDailyPlan(true);
      this.updateDailyLabel();
      if (results[0].status === 'rejected') throw results[0].reason;
      const catalog = results[0].value.data || {}, locations = weatherCityOptions(catalog.items);
      const wanted = locations.findIndex((item) => item.slug === this._wantedLocation), tianjin = locations.findIndex((item) => item.slug === 'tianjin');
      const locationIndex = wanted >= 0 ? wanted : Math.max(0, tianjin), location = locations[locationIndex] || null;
      this.setData({ locations, locationIndex, location, forecastEnabled: catalog.forecast_enabled === true });
      if (location && catalog.forecast_enabled === true) await this.loadForecast(location.slug, version, token);
    } catch (error) { if (this.current(version, token)) this.setData({ error: message(error) }); }
    finally { if (this.current(version, token)) { this.setData({ loading: false }); wx.stopPullDownRefresh(); await this.prepareSubscriptionGrant(); } }
  },
  async loadForecast(slug, version, token) {
    const result = await app().api.request('weather-data/' + encodeURIComponent(slug) + '/forecast/', { timeout: 20000 });
    if (this.current(version, token)) this.setData({ forecast: forecastView((result.data || {}).forecast) });
  },
  changeLocation(event) {
    if (!this.active() || this.data.busy || this.data.locating || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
    const selected = this.data.locations[Number(event.detail.value)];
    if (!selected) return;
    this._wantedLocation = selected.slug; app().globalData.weatherLocation = selected.slug;
    this._interpretRequest = null; this.setData({ aiNotice: '', aiError: '', notice: '', actionError: '', locationNotice: '' });
    return this.load();
  },
  async locateCity() {
    if (!this.active() || this.data.busy || this.data.loading || this.data.locating || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent || !this.data.locations.length) return;
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
  reminderRequest(scheduled_for) { return { location: this.data.location.slug, scheduled_for }; },
  updateDailyLabel() {
    const now = this.now(), clock = this.data.dailyTime, date = localDate(now), plan = this.data.currentDailyPlan;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) { this.setData({ dailyNextLabel: '' }); return; }
    let stamp = Date.parse(date + 'T' + clock + ':00+08:00');
    if (stamp <= now || plan && plan.last_target_date && date <= plan.last_target_date) stamp += 86400000;
    this.setData({ dailyNextLabel: localDate(stamp) + ' ' + localClock(stamp) });
  },
  changeDailyTime(event) {
    if (!this.active() || this.data.busy || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
    const clock = String(event.detail.value || '');
    if (nextDailyBooking(clock, this.now()).error) return;
    this.setData({ dailyTime: clock, actionError: '', notice: '' }); this.updateDailyLabel();
    try { wx.setStorageSync('hyhq.weather.daily-time.v1', clock); } catch (_) { /* The current selection still works without storage. */ }
  },
  poolView(value) {
    const raw = value || {}, amount = field => Number.isSafeInteger(raw[field]) && raw[field] >= 0 ? raw[field] : 0;
    return { remaining: amount('remaining'), reserved: amount('reserved'), held: amount('held'), needs_resubscribe: raw.needs_resubscribe === true };
  },
  updateCurrentDailyPlan(useSavedTime = false) {
    const found = this.data.dailyPlans.find(plan => plan && plan.type === 'weather') || null;
    const currentDailyPlan = found ? Object.assign({}, found, { subject_label: found.location_name || (found.location && found.location.name) || '天气' }) : null;
    this.setData({ currentDailyPlan, ...(useSavedTime && currentDailyPlan && /^([01]\d|2[0-3]):[0-5]\d$/.test(currentDailyPlan.time) ? { dailyTime: currentDailyPlan.time } : {}) });
    this.updateDailyLabel();
  },
  async prepareSubscriptionGrant() {
    if (!this.canAct() || !this.data.wechatLogin || !this.data.weatherReminderEnabled || !this.data.templateId || this.data.grantPreparing || this._grantAccepted || this.data.canConfirmAgain || this.data.intent || typeof wx.requestSubscribeMessage !== 'function') return;
    if (this.data.grantIntent && Date.parse(this.data.grantIntent.expires_at) > this.now() + 15000) return;
    const version = this._version, token = this._token;
    this.setData({ grantPreparing: true, grantError: '', grantIntent: null });
    try {
      const result = await app().api.request('weather-data/reminders/grants/', { method: 'POST', data: {} });
      if (!this.current(version, token)) return;
      const grant = result.data || {};
      if (!grant.id || grant.state !== 'prepared' || grant.template_id !== this.data.templateId || !(Date.parse(grant.expires_at) > this.now())) throw new Error('订阅准备未完成，请重试。');
      this.setData({ grantIntent: grant });
    } catch (error) { if (this.current(version, token)) this.setData({ grantError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ grantPreparing: false }); }
  },
  addSubscriptionCredit() {
    if (!this.canAct() || !this.data.wechatLogin || !this.data.weatherReminderEnabled || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent || this.data.grantPreparing) return;
    const grant = this.data.grantIntent;
    if (!grant || Date.parse(grant.expires_at) <= this.now() + 5000) {
      this.setData({ grantIntent: null, grantError: '正在准备订阅，请稍后再点 +1。' }); return this.prepareSubscriptionGrant();
    }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ grantError: '当前微信版本暂不支持订阅提醒。' }); return; }
    const version = this._version, token = this._token;
    this.setData({ busy: true, grantBusy: true, grantError: '', notice: '' });
    let handled = false;
    // One visible tap starts one native authorization synchronously. Preparing
    // the one-use grant happened earlier; no hidden/looped permission requests.
    try { wx.requestSubscribeMessage({ tmplIds: [grant.template_id], success: (result) => {
      if (handled) return; handled = true;
      if (!this.current(version, token)) return;
      if (result[grant.template_id] !== 'accept') { this.setData({ busy: false, grantBusy: false, notice: '未增加提醒次数。' }); return; }
      this._grantAccepted = { grant, version, token }; return this.confirmSubscriptionCredit();
    }, fail: () => {
      if (handled) return; handled = true;
      if (this.current(version, token)) this.setData({ busy: false, grantBusy: false, grantError: '本次订阅未完成，可以重新点击 +1。' });
    } }); } catch (_) { if (!handled && this.current(version, token)) this.setData({ busy: false, grantBusy: false, grantError: '本次订阅未完成，请稍后重试。' }); }
  },
  async confirmSubscriptionCredit() {
    const accepted = this._grantAccepted;
    if (!accepted || !this.current(accepted.version, accepted.token)) return;
    const { grant, version, token } = accepted;
    let saved = false;
    this.setData({ busy: true, grantBusy: true, canRetryGrant: false, grantError: '' });
    try {
      const result = await app().api.request('weather-data/reminders/grants/' + encodeURIComponent(grant.id) + '/confirm/', { method: 'POST', data: { template_id: grant.template_id, decision: 'accept' } });
      if (!this.current(version, token)) return;
      const data = result.data || {};
      if (!data.subscription_pool) throw new Error('提醒次数尚未核对，请重试保存。');
      this._grantAccepted = null; saved = true;
      this.setData({ subscriptionPool: this.poolView(data.subscription_pool), grantIntent: null, notice: '已增加 1 次提醒次数。' });
    } catch (error) { if (this.current(version, token)) this.setData({ canRetryGrant: true, grantError: message(error) + ' 授权已完成，重试保存不会再次询问微信授权。' }); }
    finally { if (this.current(version, token)) this.setData({ busy: false, grantBusy: false }); }
    if (saved && this.current(version, token)) await this.prepareSubscriptionGrant();
  },
  retrySubscriptionCredit() { if (this.canAct()) return this.confirmSubscriptionCredit(); },
  async saveDailyPlan() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
    if (nextDailyBooking(this.data.dailyTime, this.now()).error) { this.setData({ actionError: '请选择有效提醒时间。' }); return; }
    if (!this.data.location) return;
    const version = this._version, token = this._token;
    const body = { type: 'weather', location: this.data.location.slug, time: this.data.dailyTime, enabled: true };
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      const result = await app().api.request('weather-data/reminders/daily/', { method: 'POST', data: body });
      if (!this.current(version, token)) return;
      this.upsertDailyPlan(result.data);
      this.setData({ notice: this.data.subscriptionPool.remaining > 0 ? '每日提醒已保存，每次发送消耗 1 次提醒次数。' : '每日安排已保存，点击 +1 补充提醒次数后发送。' });
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  upsertDailyPlan(plan) {
    if (!plan || !['weather', 'ecology_simulation'].includes(plan.type) || typeof plan.enabled !== 'boolean') throw new Error('每日安排状态未确认，请刷新核对。');
    this.setData({ dailyPlans: [plan].concat(this.data.dailyPlans.filter(item => item.type !== plan.type)) }); this.updateCurrentDailyPlan();
  },
  async cancelDailyPlan() {
    if (!this.canAct() || !this.data.currentDailyPlan || !this.data.currentDailyPlan.enabled || this.data.canRetryGrant) return;
    const version = this._version, token = this._token, type = this.data.currentDailyPlan.type;
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      const result = await app().api.request('weather-data/reminders/daily/' + type + '/cancel/', { method: 'POST', data: {} });
      if (!this.current(version, token)) return;
      this.upsertDailyPlan(result.data); this.setData({ notice: '每日提醒已暂停，剩余次数保留。' });
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  async cancelLegacySimulationPlan() {
    if (!this.canAct() || this.data.canRetryGrant || !this.data.legacySimulationPlans.length) return;
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      await app().api.request('weather-data/reminders/daily/ecology_simulation/cancel/', { method: 'POST', data: {} });
      if (this.current(version, token)) this.setData({ legacySimulationPlans: [], notice: '原模拟每日安排已停止。' });
    } catch (error) { if (this.current(version, token)) this.setData({ actionError: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  changeBookingDate(event) { this.changeBooking('bookingDate', event.detail.value); },
  changeBookingTime(event) { this.changeBooking('bookingTime', event.detail.value); },
  changeBooking(field, value) {
    if (!this.active() || this.data.busy || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
    this._accepted = null; this._grantAccepted = null; this.setData({ [field]: value, intent: null, actionError: '', notice: '', aiNotice: '' });
  },
  inputAiText(event) {
    if (!releasePolicy.naturalLanguageReminderEnabled) return;
    if (!this.active() || this.data.busy || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
    const aiText = String(event.detail.value || '').slice(0, 500);
    if (aiText !== this.data.aiText) this._interpretRequest = null;
    this.setData({ aiText, aiNotice: '', aiError: '' });
  },
  async interpretReminder() {
    if (!releasePolicy.naturalLanguageReminderEnabled) return;
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.location || this.data.canConfirmAgain || this.data.canRetryGrant || this.data.intent) return;
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
      if (data.draft.type === 'ecology_simulation') { this.setData({ aiNotice: '模拟提醒请从首页生态观察手记中体验，即时发送，无需预约时间。' }); return; }
      const draft = aiDraftView(data.draft, this.data.locations, this.now());
      if (!draft) throw new Error('AI 返回的城市或时间暂不可用，请在下方手动选择。');
      this._wantedLocation = draft.location.slug; app().globalData.weatherLocation = draft.location.slug;
      const changedCity = this.data.location.slug !== draft.location.slug;
      this.setData({ location: draft.location, locationIndex: this.data.locations.findIndex((item) => item.slug === draft.location.slug),
        bookingDate: draft.bookingDate, bookingTime: draft.bookingTime, ...(draft.frequency === 'daily' ? { dailyTime: draft.bookingTime } : {}),
        aiNotice: (draft.summary || '已填入预约草稿。') + (draft.frequency === 'daily' ? ' 请核对上方每日安排，开启后按剩余次数逐日发送；次数不足可点击 +1 补充。' : ' 请核对下方城市和时间，再确认预约。'), ...(changedCity ? { forecast: null } : {}) });
      this.updateCurrentDailyPlan();
      if (draft.frequency === 'daily') { try { wx.setStorageSync('hyhq.weather.daily-time.v1', draft.bookingTime); } catch (_) { /* Optional preference. */ } }
      if (changedCity && this.data.forecastEnabled) {
        try { await this.loadForecast(draft.location.slug, version, token); }
        catch (_) { if (this.current(version, token)) this.setData({ error: '预报暂未更新，预约草稿已保留。' }); }
      }
    } catch (error) { if (this.current(version, token)) this.setData({ aiError: message(error) + ' 你也可以直接手动预约。' }); }
    finally { if (this.current(version, token)) this.setData({ busy: false, aiBusy: false }); }
  },
  async prepareReminder() {
    if (!this.canAct() || !this.data.subscriptionEnabled || !this.data.wechatLogin || !this.data.location || this.data.canConfirmAgain || this.data.canRetryGrant) return;
    const booking = validateBooking(this.data.bookingDate, this.data.bookingTime, this.now());
    if (booking.error) { this.setData({ actionError: booking.error }); return; }
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '', intent: null });
    try {
      const result = await app().api.request('weather-data/reminders/intents/', { method: 'POST',
        data: this.reminderRequest(booking.scheduled_for) });
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
      this._accepted = null; this._grantAccepted = null; this.upsertReminder(reminderView(result.data));
      this.setData({ intent: null, notice: result.data.state === 'pending' ? '本次预约已保存，发送前可取消。' : '提醒状态已更新，请查看下方记录。' });
    } catch (error) {
      if (this.current(version, token)) this.setData({ canConfirmAgain: true,
        actionError: message(error) + ' 授权结果尚未确认，可重试保存或刷新记录核对。' });
    } finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  retryConfirmation() { if (this.canAct()) return this.confirmAccepted(); },
  async cancelReminder(event) {
    if (!this.canAct() || this.data.canRetryGrant) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.reminders.some((row) => row.id === id && row.can_cancel)) return;
    const version = this._version, token = this._token;
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      const result = await app().api.request('weather-data/reminders/' + encodeURIComponent(id) + '/cancel/', { method: 'POST', data: {} });
      if (!this.current(version, token)) return;
      this.upsertReminder(reminderView(result.data)); this._accepted = null; this._grantAccepted = null;
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
