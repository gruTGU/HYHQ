const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const PREVIEW = '模拟异常：浊度偏高，请复核';
Component({
  properties: { open: { type: Boolean, value: false } },
  data: { preparing: false, busy: false, needsLogin: false, intent: null, error: '', notice: '', canRetry: false, finished: false, preview: PREVIEW },
  lifetimes: {
    attached() { this._alive = true; this._visible = true; if (this.data.open) this.prepare(); },
    detached() { this._alive = false; this._version = (this._version || 0) + 1; this._accepted = null; },
  },
  pageLifetimes: {
    show() { this._visible = true; },
    hide() { this._visible = false; this._version = (this._version || 0) + 1; this._accepted = null; this.setData({ busy: false, preparing: false, intent: null, canRetry: false }); this.triggerEvent('close'); },
  },
  observers: { open(value) { if (value && this._alive) this.prepare(); } },
  methods: {
    active() { return this._alive === true && this._visible !== false && this.data.open; },
    current(version, token) {
      if (!this.active() || this._version !== version) return false;
      if (app().session.token() === token) return true;
      this._version += 1; this._accepted = null;
      this.setData({ busy: false, preparing: false, intent: null, canRetry: false, needsLogin: true, error: '登录状态已变化，请重新登录后体验。' }); return false;
    },
    async prepare() {
      if (!this.active() || this.data.busy || this.data.preparing) return;
      const version = this._version = (this._version || 0) + 1, token = app().session.token();
      this._token = token;
      this._accepted = null;
      this.setData({ preparing: Boolean(token), needsLogin: !token, intent: null, error: '', notice: '', canRetry: false, finished: false });
      if (!token) return;
      try {
        const result = await app().api.request('weather-data/reminders/simulation-intents/', { method: 'POST', data: {} });
        if (!this.current(version, token)) return;
        const intent = result.data || {};
        if (!intent.id || !intent.template_id || intent.state !== 'prepared' || intent.mode !== 'instant_simulation') throw new Error('模拟提醒暂未准备好，请稍后重试。');
        this.setData({ intent });
      } catch (error) {
        if (this.current(version, token)) this.setData({ error: message(error), needsLogin: error.status === 401 || ['WECHAT_LOGIN_REQUIRED', 'WECHAT_IDENTITY_REQUIRED', 'NOT_AUTHENTICATED'].includes(error.code) });
      } finally { if (this.current(version, token)) this.setData({ preparing: false }); }
    },
    authorize() {
      if (!this.active() || this.data.busy || this.data.preparing || this.data.canRetry || this.data.finished || !this.data.intent) return;
      const intent = this.data.intent, version = this._version, token = this._token;
      if (!token || !this.current(version, token)) return;
      if (intent.consent_expires_at && Date.parse(intent.consent_expires_at) <= Date.now() + 5000) {
        this.setData({ intent: null, error: '确认已过期，请重新准备后再点击订阅。' }); return;
      }
      if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ error: '当前微信版本暂不支持订阅提醒。' }); return; }
      this.setData({ busy: true, error: '', notice: '' });
      let handled = false;
      // The server intent is prepared before this tap. Keep the native call
      // synchronous and request exactly one one-time template authorization.
      try { wx.requestSubscribeMessage({ tmplIds: [intent.template_id], success: async result => {
        if (handled) return; handled = true;
        if (!this.current(version, token)) return;
        const decision = result[intent.template_id];
        if (decision !== 'accept') {
          this.setData({ busy: false, finished: true, intent: null, notice: '未订阅，本次不会发送通知。' });
          if (decision === 'reject' || decision === 'ban') {
            try { await app().api.request('weather-data/reminders/simulation-intents/' + encodeURIComponent(intent.id) + '/confirm/', { method: 'POST', data: { template_id: intent.template_id, decision } }); } catch (_) { /* Rejection can never authorize delivery. */ }
          }
          return;
        }
        this._accepted = { intent, version, token }; return this.confirmAccepted();
      }, fail: () => {
        if (handled) return; handled = true;
        if (this.current(version, token)) this.setData({ busy: false, error: '本次订阅未完成，可以重新点击确认。' });
      } }); } catch (_) { if (!handled && this.current(version, token)) this.setData({ busy: false, error: '本次订阅未完成，请稍后重试。' }); }
    },
    async confirmAccepted() {
      const accepted = this._accepted;
      if (!accepted || !this.current(accepted.version, accepted.token)) return;
      const { intent, version, token } = accepted;
      this.setData({ busy: true, canRetry: false, error: '' });
      try {
        const result = await app().api.request('weather-data/reminders/simulation-intents/' + encodeURIComponent(intent.id) + '/confirm/',
          { method: 'POST', timeout: 30000, data: { template_id: intent.template_id, decision: 'accept' } });
        if (!this.current(version, token)) return;
        const state = (result.data || {}).state;
        const labels = { sent: '已发送，请在微信服务通知中查看。', unknown: '发送结果待核实，请先查看微信服务通知；本次不会重复发送。', failed: '本次未能发送，请稍后再体验。', pending: '已提交模拟提醒，请留意微信服务通知。', sending: '正在发送，请留意微信服务通知。', preparing: '正在发送，请留意微信服务通知。', retry: '已提交模拟提醒，请留意微信服务通知。', expired: '本次确认已过期，请重新体验。', cancelled: '本次提醒已取消。' };
        if (!labels[state]) throw new Error('本次发送状态尚未确认。');
        this._accepted = null;
        this.setData({ intent: null, finished: true, notice: labels[state] });
      } catch (error) {
        if (this.current(version, token)) this.setData({ canRetry: true, error: message(error) + ' 点击核对结果不会再次申请授权或重复发送。' });
      } finally { if (this.current(version, token)) this.setData({ busy: false }); }
    },
    retry() { if (this.active() && !this.data.busy) return this.confirmAccepted(); },
    close() {
      if (!this.active() || this.data.busy) return;
      this._version = (this._version || 0) + 1; this._accepted = null;
      this.setData({ preparing: false, intent: null, canRetry: false }); this.triggerEvent('close');
    },
    login() { if (this.active() && !this.data.busy) { this.close(); wx.switchTab({ url: '/pages/profile/index' }); } },
    noop() {},
  },
});
