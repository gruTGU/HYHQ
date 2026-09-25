const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const community = require('../../lib/community');
Page({
  data: { mode: 'target', enabled: false, statusKnown: false, unavailable: '', loggedIn: false, records: [], next: '', loading: false, loadingMore: false, busy: false, listError: '', moreError: '', actionError: '', notice: '', body: '', bodyCount: 0, reportTarget: null, reasons: community.reasons, reasonIndex: 0, reportDetail: '', invalid: false },
  onLoad(options) {
    this._alive = true; this._target = community.target(options);
    const mode = options && ['mine', 'reports'].includes(options.mode) ? options.mode : 'target';
    this.setData({ mode, invalid: mode === 'target' && !this._target });
  },
  onShow() { if (this._alive === false) return; this._hidden = false; return this.load(); },
  onHide() { this._hidden = true; this.invalidate(); this.resetPrivate(); },
  onUnload() { this._alive = false; this.invalidate(); },
  active() { return this._alive !== false && !this._hidden; },
  invalidate() { this._listVersion = (this._listVersion || 0) + 1; this._actionVersion = (this._actionVersion || 0) + 1; this._confirming = false; },
  resetPrivate() { this._requestId = ''; this._reportRequestId = ''; this.setData({ records: [], next: '', body: '', bodyCount: 0, reportTarget: null, reportDetail: '', busy: false, loading: false, loadingMore: false, notice: '', actionError: '' }); },
  sameSession(token) {
    if (!this.active()) return false;
    if (app().session.token() === token) return true;
    this.invalidate(); this.resetPrivate(); this._sessionToken = app().session.token(); this.setData({ loggedIn: Boolean(this._sessionToken), listError: '登录状态已变化，请刷新后再操作。' }); return false;
  },
  accepted(version, token, action = false) { return this.active() && version === (action ? this._actionVersion : this._listVersion) && this.sameSession(token); },
  expire(error, token) { if (error && error.status === 401 && app().session.token() === token) app().session.clear(); },
  canAct(requireEnabled = true) { return this.active() && !this.data.busy && this.sameSession(this._sessionToken) && Boolean(app().session.token()) && (!requireEnabled || this.data.enabled); },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  onPullDownRefresh() { if (!this.active()) return; if (this.data.busy) { wx.stopPullDownRefresh(); return; } return this.load(); },
  more() { return this.load(true); },
  onReachBottom() { return this.load(true); },
  myComments() { if (this.active() && !this.data.busy) wx.navigateTo({ url: '/pages/comments/index?mode=mine' }); },
  myReports() { if (this.active() && !this.data.busy) wx.navigateTo({ url: '/pages/comments/index?mode=reports' }); },
  async load(more = false, internal = false) {
    if (!this.active() || this.data.invalid || (this.data.busy && !internal)) { if (this.active()) wx.stopPullDownRefresh(); return; }
    more = more === true;
    const token = app().session.token();
    if (this._sessionToken !== token) { this.invalidate(); this.resetPrivate(); }
    this._sessionToken = token;
    this.setData({ loggedIn: Boolean(token) });
    if (this.data.mode !== 'target' && !token) { wx.stopPullDownRefresh(); return; }
    if (more && (!this.data.next || this.data.loading || this.data.loadingMore)) return;
    if (!more && !internal) { this._actionVersion = (this._actionVersion || 0) + 1; this._confirming = false; }
    const version = this._listVersion = (this._listVersion || 0) + 1;
    this.setData(Object.assign({ loading: !more, loadingMore: more, listError: '', moreError: '' }, more ? {} : { enabled: false, statusKnown: false }));
    try {
      if (!more) {
        const status = await app().api.request('community/status/');
        if (!this.accepted(version, token)) return;
        if (!status || !status.data || typeof status.data.enabled !== 'boolean') throw new Error('服务状态暂不可用，请重试。');
        this.setData({ statusKnown: true, enabled: status.data.enabled, unavailable: status.data.enabled ? '' : '评论与举报暂未开放。' });
        if (this.data.mode === 'target' && !status.data.enabled) { this.setData({ records: [], next: '' }); return; }
      }
      const initial = this.data.mode === 'mine' ? 'community/comments/mine/' : this.data.mode === 'reports' ? 'community/reports/' : 'community/comments/';
      const path = more ? community.pagePath(this.data.next, this.data.mode, this._target) : initial;
      const response = await app().api.request(path, more ? undefined : { data: Object.assign({ page_size: 20 }, this.data.mode === 'target' ? this._target : {}) });
      if (!this.accepted(version, token)) return;
      if (!response || !Array.isArray(response.data)) throw new Error('记录格式不正确，请刷新重试。');
      const rawNext = response.meta && response.meta.next;
      if (rawNext !== undefined && rawNext !== null && typeof rawNext !== 'string') throw new Error('分页格式不正确。');
      const next = rawNext ? community.pagePath(rawNext, this.data.mode, this._target) : '';
      const seen = more ? new Set(this._seen || []) : new Set(); seen.add(path);
      if (next && seen.has(next)) throw new Error('分页重复，请刷新重试。');
      const incoming = response.data.map((row) => community.present(row, this.data.mode === 'reports'));
      const records = new Map((more ? this.data.records : []).map((row) => [row.id, row])); incoming.forEach((row) => records.set(row.id, row));
      this._seen = seen; this.setData({ records: Array.from(records.values()), next });
    } catch (error) {
      if (!this.active() || version !== this._listVersion) return;
      this.expire(error, token);
      if (this.accepted(version, token)) {
        const closed = error.code === 'COMMUNITY_DISABLED' || error.status === 404;
        this.setData(Object.assign({ [more ? 'moreError' : 'listError']: message(error) }, closed ? { enabled: false, records: [], next: '', reportTarget: null } : {}));
        if (!more && !this.data.statusKnown) this.setData({ enabled: false });
      }
    } finally { if (this.active() && version === this._listVersion) { this.setData({ loading: false, loadingMore: false }); wx.stopPullDownRefresh(); } }
  },
  inputBody(event) {
    if (!this.canAct() || this.data.mode !== 'target') return;
    const body = typeof event.detail.value === 'string' ? event.detail.value : '';
    if (body !== this.data.body) this._requestId = '';
    this.setData({ body, bodyCount: Array.from(body.trim()).length, actionError: '', notice: '' });
  },
  async submit() {
    if (!this.canAct() || this.data.mode !== 'target' || !this._target || this._confirming) return;
    const body = this.data.body.trim();
    if (!body || Array.from(body).length > 500) { this.setData({ actionError: '请填写 1 至 500 字的评论。' }); return; }
    const token = app().session.token(), version = this._actionVersion = (this._actionVersion || 0) + 1;
    this._requestId = this._requestId || community.requestId(); this._listVersion += 1;
    this.setData({ busy: true, loading: false, loadingMore: false, actionError: '', notice: '' });
    try {
      const response = await app().api.request('community/comments/', { method: 'POST', data: Object.assign({}, this._target, { body, request_id: this._requestId }) });
      if (!this.accepted(version, token, true)) return;
      const row = community.present(response && response.data);
      this._requestId = ''; this.setData({ body: '', bodyCount: 0, records: [row].concat(this.data.records.filter((item) => item.id !== row.id)), next: '', notice: row.status === 'rejected' ? '这条评论未通过内容检查，仅你自己可见。可删除后重新撰写。' : '评论已收到，审核通过后才会公开。' });
      await this.load(false, true);
    } catch (error) { this.actionFailure(error, token, version, ' 草稿已保留，请先刷新记录核对提交结果。'); }
    finally { if (this.accepted(version, token, true)) this.setData({ busy: false }); }
  },
  actionFailure(error, token, version, suffix = '') {
    if (!this.active() || version !== this._actionVersion) return;
    this.expire(error, token);
    if (!this.accepted(version, token, true)) return;
    if (['CONTENT_SAFETY_UNAVAILABLE', 'WECHAT_RELOGIN_REQUIRED', 'SUBMISSION_FAILED'].includes(error.code)) this._requestId = '';
    this.setData({ actionError: message(error) + suffix });
    if (error.code === 'COMMUNITY_DISABLED') this.setData({ enabled: false, records: [], next: '', reportTarget: null, unavailable: '评论与举报暂未开放。' });
  },
  remove(event) {
    if (!this.canAct(false) || this._confirming || this.data.mode === 'reports') return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.records.some((row) => row.id === id && row.is_owner)) return;
    const token = app().session.token(), version = this._actionVersion = (this._actionVersion || 0) + 1;
    this._confirming = true; let handled = false;
    wx.showModal({ title: '删除这条评论', content: '删除后无法恢复，对应的评论举报记录也会清除。', confirmText: '删除', confirmColor: '#d97b4f', success: async (result) => {
      if (handled) return; handled = true;
      if (!this.accepted(version, token, true)) return;
      this._confirming = false; if (!result.confirm) return;
      this._listVersion += 1; this.setData({ busy: true, loading: false, loadingMore: false, actionError: '', notice: '' });
      try {
        try { await app().api.request('community/comments/' + encodeURIComponent(id) + '/', { method: 'DELETE' }); } catch (error) { if (error.status !== 404) throw error; }
        if (!this.accepted(version, token, true)) return;
        this.setData({ records: this.data.records.filter((row) => row.id !== id), next: '', notice: '评论已删除。' }); await this.load(false, true);
      } catch (error) { this.actionFailure(error, token, version); }
      finally { if (this.accepted(version, token, true)) this.setData({ busy: false }); }
    }, fail: () => { if (this.accepted(version, token, true)) this._confirming = false; } });
  },
  openReport(event) {
    if (!this.canAct() || this._confirming) return;
    const id = event.currentTarget.dataset.id;
    let reportTarget;
    if (id) { const row = this.data.records.find((item) => item.id === id && item.status === 'approved' && !item.is_owner); if (!row) return; reportTarget = { kind: 'comment', target_id: id }; }
    else { if (this.data.mode !== 'target' || !this._target) return; reportTarget = this._target; }
    this._reportRequestId = ''; this.setData({ reportTarget, reportDetail: '', reasonIndex: 0, actionError: '', notice: '' });
  },
  closeReport() { if (this.active() && !this.data.busy) { this._reportRequestId = ''; this.setData({ reportTarget: null, reportDetail: '' }); } },
  selectReason(event) { if (this.canAct()) { const index = Number(event.detail.value); if (Number.isInteger(index) && community.reasons[index]) { this._reportRequestId = ''; this.setData({ reasonIndex: index }); } } },
  inputReport(event) { if (this.canAct()) { this._reportRequestId = ''; this.setData({ reportDetail: event.detail.value || '' }); } },
  async submitReport() {
    if (!this.canAct() || !this.data.reportTarget || this._confirming) return;
    const detail = this.data.reportDetail.trim();
    if (Array.from(detail).length > 300) { this.setData({ actionError: '举报说明不能超过 300 字。' }); return; }
    const token = app().session.token(), version = this._actionVersion = (this._actionVersion || 0) + 1;
    this._reportRequestId = this._reportRequestId || community.requestId();
    this.setData({ busy: true, actionError: '', notice: '' });
    try {
      await app().api.request('community/reports/', { method: 'POST', data: Object.assign({}, this.data.reportTarget, { reason: community.reasons[this.data.reasonIndex].value, detail, request_id: this._reportRequestId }) });
      if (!this.accepted(version, token, true)) return;
      this._reportRequestId = ''; this.setData({ reportTarget: null, reportDetail: '', notice: '举报已收到，可在我的举报中查看处理状态。重复举报不会重复创建。' });
    } catch (error) { this.actionFailure(error, token, version); }
    finally { if (this.accepted(version, token, true)) this.setData({ busy: false }); }
  },
});
