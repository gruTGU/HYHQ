const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { eventView } = require('../../lib/events');
const { calendarView, shiftedMonth } = require('../../lib/event-calendar');
const { TIME_RULE, poolView, ended, scheduleLabel, reminderView } = require('../../lib/event-subscriptions');
const emptyDialog = () => ({ creditOnly: false, dialogOpen: false, dialogEvent: null, dialogSchedule: '', dialogError: '', dialogNotice: '', dialogFinished: false, needsCredit: false, grantIntent: null, grantPreparing: false, canRetryGrant: false, canRetryBooking: false });
Page(withTheme({
  data: {
    loading: false, busy: false, error: '', privateError: '', notice: '', actionNotice: '', items: [], subscriptions: [],
    poolGrant: null, poolPreparing: false, poolNotice: '', calendarMonth: '', calendarCells: [], selectedDate: '', visibleItems: [], weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    loggedIn: false, enabled: false, filtered: false, reminderEnabled: false, wechatLogin: false, templateId: '',
    subscriptionPool: poolView(), timeRule: TIME_RULE, reminderNotice: '共享次数为本地估计，微信拒绝后需重新授权；不确定的发送结果不会自动重发。', ...emptyDialog(),
  },
  onLoad(options = {}) {
    this._alive = true;
    this._filter = options.map_reference_id ? { map_reference_id: options.map_reference_id } : options.place_id ? { place_id: options.place_id } : {};
    this.setData({ filtered: !!Object.keys(this._filter).length });
  },
  onShow() {
    this._active = true;
    if (app().session.subscribe) this._unsubscribe = app().session.subscribe(() => {
      if (this._active) this.clearPrivate('登录状态已变化，请重新登录或刷新。');
    });
    const pending = this._grantAccepted || this._nativeAttempt;
    if (pending && this.grantCurrent(pending)) {
      this._token = pending.token;
      this.setData({ loggedIn: true, privateError: '', reminderEnabled: true, wechatLogin: true, templateId: pending.grant.template_id, creditOnly: !!pending.creditOnly, dialogOpen: !pending.creditOnly, dialogEvent: this._pendingEvent, dialogSchedule: pending.creditOnly ? '' : scheduleLabel(this._pendingEvent, null, this.now()), needsCredit: true, busy: !!this._nativeAttempt, canRetryGrant: !!this._grantAccepted });
      if (this._grantAccepted) return this.confirmSubscriptionCredit();
      return;
    }
    this._grantAccepted = null; this._nativeAttempt = null; this._pendingEvent = null;
    return this.load();
  },
  onHide() {
    if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null;
    this._active = false; this.clearPrivate('', true);
  },
  onUnload() { this._alive = false; this.onHide(); this._grantAccepted = null; this._nativeAttempt = null; this._pendingEvent = null; },
  clearPrivate(privateError, preservePending = false) {
    this._version = (this._version || 0) + 1;
    if (!preservePending) { this._grantAccepted = null; this._nativeAttempt = null; this._pendingEvent = null; this._confirmingGrant = null; }
    this.setData({ ...emptyDialog(), subscriptions: [], items: this.data.items.map(item => ({ ...item, subscribed: false, reminder: null, reminder_label: '' })),
      loggedIn: false, enabled: false, reminderEnabled: false, wechatLogin: false, templateId: '', subscriptionPool: poolView(),
      busy: false, loading: false, poolGrant: null, poolPreparing: false, poolNotice: '', actionNotice: '', privateError });
    this.refreshCalendar();
  },
  now() { return Date.now() + (this._serverOffset || 0); },
  grantCurrent(attempt) { return this._alive !== false && !!attempt && app().session.token() === attempt.token; },
  current(version, token) { return this._active && this._version === version && app().session.token() === token; },
  canAct() { return this._active && !this.data.busy && !this.data.loading && !this.data.privateError && !!this._token && this.current(this._version, this._token); },
  decorateItems(subscriptions = this.data.subscriptions) {
    const byId = new Map(subscriptions.map(row => [row.event_id, row]));
    return this.data.items.map(item => {
      const row = byId.get(item.id);
      return { ...item, subscribed: !!row, ...reminderView(item, row && row.reminder, this.now()) };
    });
  },
  refreshCalendar() { this.setData(calendarView(this.data.items, this.data.calendarMonth, this.data.selectedDate, this.now())); },
  calendarMonth(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    if (![-1, 1].includes(delta) || delta < 0 && this.data.calendarPreviousDisabled || delta > 0 && this.data.calendarNextDisabled) return;
    this.setData({ calendarMonth: shiftedMonth(this.data.calendarMonth, delta), selectedDate: '' }); this.refreshCalendar();
  },
  calendarDay(event) {
    const date = event.currentTarget.dataset.date;
    if (!this.data.calendarCells.some(cell => cell.date === date)) return;
    this.setData({ selectedDate: date }); this.refreshCalendar();
  },
  calendarAll() { this.setData({ selectedDate: '' }); this.refreshCalendar(); },
  async load() {
    if (!this._active || this.data.busy || this._grantAccepted) { wx.stopPullDownRefresh(); return; }
    const token = this._token = app().session.token(), version = this._version = (this._version || 0) + 1;
    this.setData({ ...emptyDialog(), poolGrant: null, poolPreparing: false, poolNotice: '', loading: true, error: '', privateError: '', subscriptions: [], enabled: false,
      reminderEnabled: false, wechatLogin: false, templateId: '', subscriptionPool: poolView(), loggedIn: !!token });
    const requests = [app().api.request('events/', { data: this._filter || {} })];
    if (token) requests.push(app().api.request('event-subscriptions/'), app().api.request('event-notifications/'));
    const results = await Promise.allSettled(requests);
    if (!this.current(version, token)) return;
    if (results[0].status === 'fulfilled') {
      const data = results[0].value.data || {}, serverTime = Date.parse(data.server_time);
      this._serverOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
      this.setData({ items: (data.items || []).map(item => ({ ...eventView(item), ...reminderView(item, null, this.now()) })), notice: data.notice || '' });
    } else this.setData({ items: [], error: message(results[0].reason) });
    if (token) {
      if (results[1].status === 'fulfilled' && results[2].status === 'fulfilled') {
        const data = results[1].value.data || {}, reminder = data.reminder || {};
        const subscriptions = (data.items || []).map(item => ({ ...item, event: eventView(item.event), ...reminderView(item.event, item.reminder, this.now()) }));
        this.setData({ subscriptions, enabled: results[2].value.data.enabled === true, items: this.decorateItems(subscriptions),
          reminderEnabled: reminder.enabled === true, wechatLogin: reminder.wechat_login === true,
          templateId: typeof reminder.template_id === 'string' ? reminder.template_id : '', subscriptionPool: poolView(data.subscription_pool),
          reminderNotice: reminder.notice || '共享次数为本地估计，微信拒绝后需重新授权；不确定的发送结果不会自动重发。' });
      } else this.setData({ privateError: '订阅状态暂不可用，请刷新后再操作。' });
    }
    this.setData({ loading: false }); this.refreshCalendar(); wx.stopPullDownRefresh();
    await this.preparePoolGrant();
  },
  async mutate(path, method, data) {
    if (!this.canAct() || this._grantAccepted || this.data.dialogOpen) return;
    const token = this._token, version = this._version;
    this.setData({ busy: true, error: '', actionNotice: '' });
    try { await app().api.request(path, { method, data }); if (!this.current(version, token)) return; this.setData({ busy: false }); await this.load(); }
    catch (error) { if (this.current(version, token)) this.setData({ error: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  subscribe(event) {
    if (!this.canAct()) return;
    if (this._grantAccepted || this.data.canRetryBooking) { if (!this.data.creditOnly) this.setData({ dialogOpen: true }); return; }
    const id = event.currentTarget.dataset.id;
    const row = this.data.items.find(item => item.id === id) || (this.data.subscriptions.find(item => item.event_id === id) || {}).event;
    const existing = this.data.subscriptions.find(item => item.event_id === id);
    if (!row || ended(row, this.now()) || existing && existing.reminder) return;
    this.setData({ ...emptyDialog(), dialogOpen: true, dialogEvent: row, dialogSchedule: scheduleLabel(row, null, this.now()), needsCredit: this.data.subscriptionPool.remaining < 1, grantIntent: this.data.poolGrant, poolGrant: null });
    if (this.data.needsCredit) return this.prepareSubscriptionGrant();
  },
  closeDialog() {
    if (this.data.busy) return;
    // Keep an accepted grant until its idempotent save completes, even if the dialog is closed.
    if (this._grantAccepted || this.data.canRetryBooking) this.setData({ dialogOpen: false });
    else { const finished = this.data.dialogFinished; this.setData(emptyDialog()); if (finished) return this.load(); }
  },
  resumeDialog() { if (this.canAct() && this.data.dialogEvent) this.setData({ dialogOpen: true }); },
  stopTouch() {},
  async preparePoolGrant() {
    if (!this.canAct() || !this.data.reminderEnabled || !this.data.wechatLogin || this.data.dialogOpen || this.data.creditOnly || this.data.poolPreparing || this._grantAccepted || this._nativeAttempt) return;
    if (this.data.poolGrant && Date.parse(this.data.poolGrant.expires_at) > this.now() + 15000) return;
    const version = this._version, token = this._token;
    this.setData({ poolPreparing: true, poolGrant: null });
    try {
      const result = await app().api.request('weather-data/reminders/grants/', { method: 'POST', data: {} });
      if (!this.current(version, token) || this.data.dialogOpen || this.data.creditOnly) return;
      const grant = result.data || {};
      if (!grant.id || grant.state !== 'prepared' || grant.template_id !== this.data.templateId || !(Date.parse(grant.expires_at) > this.now())) throw new Error('提醒次数暂未准备好，请稍后点击 +1 重试。');
      this.setData({ poolGrant: grant });
    } catch (error) { if (this.current(version, token)) this.setData({ poolNotice: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ poolPreparing: false }); }
  },
  addPoolCredit() {
    if (!this.canAct() || this.data.dialogOpen || this._grantAccepted || this._nativeAttempt || !this.data.reminderEnabled || !this.data.wechatLogin || this.data.poolPreparing) return;
    const grant = this.data.poolGrant;
    if (!grant || Date.parse(grant.expires_at) <= this.now() + 5000) {
      this.setData({ creditOnly: false, poolNotice: '正在准备，请稍后再点 +1。' }); return this.preparePoolGrant();
    }
    this.setData({ ...emptyDialog(), creditOnly: true, grantIntent: grant, poolGrant: null, needsCredit: true, poolNotice: '' });
    return this.addSubscriptionCredit();
  },
  async prepareSubscriptionGrant() {
    if (!this.canAct() || !this.data.dialogOpen || !this.data.needsCredit || !this.data.reminderEnabled || !this.data.wechatLogin || this.data.grantPreparing || this._grantAccepted) return;
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ dialogError: '当前微信版本暂不支持订阅提醒。' }); return; }
    const currentGrant = this.data.grantIntent;
    if (currentGrant && Date.parse(currentGrant.expires_at) > this.now() + 15000) return;
    const version = this._version, token = this._token, eventId = this.data.dialogEvent.id;
    this.setData({ grantPreparing: true, grantIntent: null, dialogError: '' });
    try {
      const result = await app().api.request('weather-data/reminders/grants/', { method: 'POST', data: {} });
      if (!this.current(version, token) || !this.data.dialogOpen || !this.data.dialogEvent || this.data.dialogEvent.id !== eventId) return;
      const grant = result.data || {};
      if (!grant.id || grant.state !== 'prepared' || typeof grant.template_id !== 'string' || !grant.template_id || (this.data.templateId && grant.template_id !== this.data.templateId) || !(Date.parse(grant.expires_at) > this.now())) throw new Error('订阅准备未完成，请重试。');
      this.setData({ grantIntent: grant });
    } catch (error) {
      if (this.current(version, token) && this.data.dialogEvent && this.data.dialogEvent.id === eventId) this.setData({ dialogError: message(error) });
    } finally {
      if (this.current(version, token) && this.data.dialogEvent && this.data.dialogEvent.id === eventId) this.setData({ grantPreparing: false });
    }
  },
  addSubscriptionCredit() {
    if (!this.canAct() || (!this.data.dialogOpen && !this.data.creditOnly) || !this.data.needsCredit || !this.data.reminderEnabled || !this.data.wechatLogin || this.data.canRetryGrant || this.data.grantPreparing || this._grantAccepted) return;
    const grant = this.data.grantIntent;
    if (!grant || Date.parse(grant.expires_at) <= this.now() + 5000) {
      this.setData({ grantIntent: null, dialogError: '正在准备订阅，请准备好后再点 +1。' }); return this.prepareSubscriptionGrant();
    }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ dialogError: '当前微信版本暂不支持订阅提醒。' }); return; }
    const version = this._version, token = this._token, attempt = { grant, version, token, creditOnly: this.data.creditOnly };
    this._nativeAttempt = attempt; this._pendingEvent = this.data.dialogEvent;
    this.setData({ busy: true, dialogError: '', dialogNotice: '' });
    let handled = false;
    // Native permission is requested synchronously by this visible button tap only.
    try { wx.requestSubscribeMessage({ tmplIds: [grant.template_id], success: result => {
      if (handled) return; handled = true;
      if (this._nativeAttempt !== attempt || !this.grantCurrent(attempt)) return;
      this._nativeAttempt = null;
      if (!result || result[grant.template_id] !== 'accept') { this._pendingEvent = null; if (this._active) this.setData({ busy: false, dialogNotice: '未增加次数，也未预约活动提醒。可稍后再试。', poolGrant: attempt.creditOnly ? grant : this.data.poolGrant }); return; }
      this._grantAccepted = attempt;
      if (this._active) return this.confirmSubscriptionCredit();
    }, fail: () => {
      if (handled) return; handled = true;
      if (this._nativeAttempt !== attempt || !this.grantCurrent(attempt)) return;
      this._nativeAttempt = null; this._pendingEvent = null;
      if (this._active) this.setData({ busy: false, dialogError: '微信授权未完成，未预约活动提醒。可重新点击 +1。', poolGrant: attempt.creditOnly ? grant : this.data.poolGrant });
    } }); } catch (_) {
      if (!handled && this._nativeAttempt === attempt && this.grantCurrent(attempt)) { this._nativeAttempt = null; this._pendingEvent = null; if (this._active) this.setData({ busy: false, dialogError: '微信授权未完成，请稍后重试。', poolGrant: attempt.creditOnly ? grant : this.data.poolGrant }); }
    }
  },
  async confirmSubscriptionCredit() {
    const accepted = this._grantAccepted;
    if (!accepted || this._confirmingGrant || !this._active || !this.grantCurrent(accepted)) return;
    const { grant } = accepted;
    this._confirmingGrant = accepted; this.setData({ busy: true, canRetryGrant: false, dialogError: '' });
    let saved = false;
    try {
      const result = await app().api.request('weather-data/reminders/grants/' + encodeURIComponent(grant.id) + '/confirm/', { method: 'POST', data: { template_id: grant.template_id, decision: 'accept' } });
      if (!this.grantCurrent(accepted) || this._grantAccepted !== accepted || !this._active) return;
      const data = result.data || {};
      if (data.state !== 'accepted' || !data.subscription_pool) throw new Error('提醒次数尚未核对，请重试保存。');
      this._grantAccepted = null; this._pendingEvent = null; saved = true;
      this.setData({ subscriptionPool: poolView(data.subscription_pool), grantIntent: null, needsCredit: false, dialogNotice: accepted.creditOnly ? '提醒次数已 +1。选择活动后可预约提醒。' : '已增加1次，正在预约此活动提醒…' });
    } catch (error) {
      if (this.grantCurrent(accepted) && this._grantAccepted === accepted && this._active) {
        if (['REMINDER_CONSENT_EXPIRED', 'NOT_FOUND'].includes(error.code)) {
          this._grantAccepted = null; this._pendingEvent = null;
          this.setData({ canRetryGrant: false, grantIntent: null, needsCredit: true, dialogNotice: '', dialogError: '本次授权确认已失效，尚未预约活动。请重新准备 +1，再主动授权；也可关闭后刷新次数。' });
        } else this.setData({ canRetryGrant: true, dialogError: message(error) + ' 授权已完成，重试保存不会再次询问微信授权。' });
      }
    } finally {
      if (this._confirmingGrant === accepted) {
        this._confirmingGrant = null;
        if (this.grantCurrent(accepted) && this._active) this.setData({ busy: false });
      }
    }
    if (saved && this.grantCurrent(accepted) && this._active) {
      if (accepted.creditOnly) { this.setData({ creditOnly: false, poolNotice: '提醒次数已 +1。选择活动后可预约提醒。' }); return this.preparePoolGrant(); }
      return this.confirmBooking();
    }
  },
  retrySubscriptionCredit() { if (this.canAct() && this.data.canRetryGrant) return this.confirmSubscriptionCredit(); },
  async confirmBooking() {
    if (!this.canAct() || !this.data.dialogOpen || !this.data.dialogEvent || this.data.dialogFinished || this._grantAccepted || !this.data.reminderEnabled || !this.data.wechatLogin) return;
    const event = this.data.dialogEvent, version = this._version, token = this._token;
    if (ended(event, this.now())) { this.setData({ dialogError: '活动已结束，无法预约提醒。' }); return; }
    this.setData({ busy: true, dialogError: '', canRetryBooking: false });
    let needGrant = false;
    try {
      const result = await app().api.request('event-subscriptions/', { method: 'POST', data: { event_id: event.id } });
      if (!this.current(version, token)) return;
      const data = result.data || {};
      if (!data.reminder || !data.reminder.id || !data.subscription_pool) throw new Error('预约状态尚未核对，请重试确认。');
      const row = { event_id: event.id, event: eventView(event), ...reminderView(event, data.reminder, this.now()) };
      const subscriptions = [row].concat(this.data.subscriptions.filter(item => item.event_id !== event.id));
      this.setData({ subscriptions, items: this.decorateItems(subscriptions), subscriptionPool: poolView(data.subscription_pool),
        dialogFinished: true, needsCredit: false, dialogSchedule: row.schedule_label,
        dialogNotice: row.reminder_label + '。' + (data.notice || '此活动只提醒一次。') });
    } catch (error) {
      if (!this.current(version, token)) return;
      if (error.code === 'SUBSCRIPTION_CREDIT_REQUIRED') {
        needGrant = true; this.setData({ needsCredit: true, subscriptionPool: { ...this.data.subscriptionPool, remaining: 0 }, dialogNotice: '', dialogError: '可用次数不足，请主动 +1 后再预约。' });
      } else if (error.code === 'SUBSCRIPTIONS_DISABLED') this.setData({ reminderEnabled: false, dialogError: '微信提醒暂不可用，请稍后再试。' });
      else if (['WECHAT_IDENTITY_REQUIRED', 'WECHAT_LOGIN_REQUIRED'].includes(error.code)) this.setData({ wechatLogin: false, dialogError: '请先使用微信登录，再预约微信提醒。' });
      else this.setData({ canRetryBooking: true, dialogError: message(error) + ' 可重试确认同一活动，不会重复预约。' });
    } finally { if (this.current(version, token)) this.setData({ busy: false }); }
    this.refreshCalendar();
    if (needGrant && this.current(version, token)) return this.prepareSubscriptionGrant();
  },
  cancel(event) { const id = event.currentTarget.dataset.id; if (this.data.subscriptions.some(item => item.event_id === id)) return this.mutate('event-subscriptions/' + encodeURIComponent(id) + '/', 'DELETE', {}); },
  notifications(event) { return this.mutate('event-notifications/', 'PATCH', { enabled: event.detail.value === true }); },
  login() { wx.switchTab({ url: '/pages/profile/index' }); },
  all() { if (this.data.busy || this._grantAccepted) return; this._filter = {}; this.setData({ filtered: false }); return this.load(); },
  map(event) { const row = this.data.items.find(item => item.id === event.currentTarget.dataset.id); if (row && row.map_reference_id) { app().globalData.pendingMapReferenceId = row.map_reference_id; wx.switchTab({ url: '/pages/explore/index' }); } },
  onPullDownRefresh() { return this.load(); },
}));
