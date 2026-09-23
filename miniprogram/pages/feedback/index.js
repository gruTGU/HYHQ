const { app } = require('../../lib/page');
const { message, time } = require('../../lib/format');
function pageKey(path) {
  if (typeof path !== 'string' || /[\s\\#]/.test(path)) throw new Error('反馈分页地址无效，请刷新重试。');
  const match = path.match(/^(?:https?:\/\/[^/?#]+)?(?:\/api\/v1\/)?feedback\/(\?[^#]*)?$/);
  if (!match) throw new Error('反馈分页地址无效，请刷新重试。');
  return 'feedback/' + (match[1] || '');
}
function present(record) {
  if (!record || typeof record.id !== 'string' || !record.id || typeof record.body !== 'string') throw new Error('反馈返回格式不正确，请刷新核对。');
  const resolved = record.status === 'resolved';
  return Object.assign({}, record, {
    status_label: resolved ? '已处理' : '待处理', created_label: time(record.created_at),
    reply: resolved ? record.reply || '' : '', resolved_label: resolved && record.resolved_at ? time(record.resolved_at) : '',
  });
}
Page({
  data: { loggedIn: false, body: '', bodyCount: 0, records: [], next: '', loading: false, loadingMore: false, listError: '', moreError: '', actionError: '', notice: '', busy: false },
  onLoad() { this._alive = true; },
  onShow() { if (this._alive === false) return; this._hidden = false; return this.load(); },
  onHide() {
    this._hidden = true; this.invalidate();
    this.setData({ body: '', bodyCount: 0, records: [], next: '', busy: false, loading: false, loadingMore: false, notice: '', actionError: '' });
  },
  onUnload() { this._alive = false; this.invalidate(); },
  active() { return this._alive !== false && !this._hidden; },
  invalidate() { this._listVersion = (this._listVersion || 0) + 1; this._actionVersion = (this._actionVersion || 0) + 1; this._confirming = false; },
  clearSessionState(error = '') {
    if (!this.active()) return;
    this.invalidate(); this._sessionToken = app().session.token();
    this.setData({ loggedIn: Boolean(this._sessionToken), body: '', bodyCount: 0, records: [], next: '', loading: false, loadingMore: false, busy: false, listError: error, moreError: '', actionError: '', notice: '' });
  },
  sameSession(token) {
    if (!this.active()) return false;
    if (app().session.token() === token) return true;
    this.clearSessionState('登录状态已变化，请刷新后再操作。'); return false;
  },
  accepted(version, token, action = false) {
    if (!this.active() || version !== (action ? this._actionVersion : this._listVersion)) return false;
    return this.sameSession(token);
  },
  expire(error, token) { if (error && error.status === 401 && app().session.token() === token) app().session.clear(); },
  canAct() {
    if (!this.active() || this.data.busy) return false;
    if (!this.sameSession(this._sessionToken)) return false;
    if (!app().session.token()) { this.clearSessionState(); return false; }
    return true;
  },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  onPullDownRefresh() {
    if (!this.active()) return;
    if (this.data.busy) { wx.stopPullDownRefresh(); return; }
    return this.load();
  },
  onReachBottom() { return this.load(true); },
  more() { return this.load(true); },
  async load(more = false, internal = false) {
    if (!this.active() || (this.data.busy && !internal)) return;
    more = more === true;
    const token = app().session.token();
    if (this._sessionToken !== token) this.clearSessionState();
    this._sessionToken = token;
    if (!token) { this.clearSessionState(); wx.stopPullDownRefresh(); return; }
    if (more && (!this.data.next || this.data.loading || this.data.loadingMore)) return;
    if (!more && !internal) { this._actionVersion = (this._actionVersion || 0) + 1; this._confirming = false; }
    const version = this._listVersion = (this._listVersion || 0) + 1;
    const path = more ? this.data.next : 'feedback/';
    this.setData({ loggedIn: true, loading: !more, loadingMore: more, listError: '', moreError: '' });
    try {
      const seen = more ? new Set(this._seen || []) : new Set(), key = pageKey(path);
      if (seen.has(key)) throw new Error('反馈分页重复，请刷新重试。');
      const response = await app().api.request(path, more ? undefined : { data: { page_size: 20 } });
      if (!this.accepted(version, token)) return;
      if (!response || !Array.isArray(response.data)) throw new Error('反馈返回格式不正确，请重试。');
      const next = response.meta && response.meta.next;
      if (next !== undefined && next !== null && typeof next !== 'string') throw new Error('反馈分页格式不正确，请重试。');
      seen.add(key); if (next && seen.has(pageKey(next))) throw new Error('反馈分页重复，请刷新重试。');
      const incoming = response.data.map(present), records = new Map((more ? this.data.records : []).map((item) => [item.id, item]));
      incoming.forEach((item) => records.set(item.id, item)); this._seen = seen;
      this.setData({ records: Array.from(records.values()), next: next || '' });
    } catch (error) {
      if (!this.active() || version !== this._listVersion) return;
      this.expire(error, token);
      if (this.accepted(version, token)) this.setData({ [more ? 'moreError' : 'listError']: message(error) });
    } finally {
      if (this.active() && version === this._listVersion) { this.setData({ loading: false, loadingMore: false }); wx.stopPullDownRefresh(); }
    }
  },
  inputBody(event) {
    if (!this.canAct()) return;
    const body = typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({ body, bodyCount: Array.from(body.trim()).length, actionError: '', notice: '' });
  },
  async submit() {
    if (!this.canAct() || this._confirming) return;
    const body = this.data.body.trim(), size = Array.from(body).length;
    if (!size || size > 1000) { this.setData({ actionError: '请填写 1 至 1000 字的反馈内容。' }); return; }
    const token = app().session.token(), action = this._actionVersion = (this._actionVersion || 0) + 1;
    this._listVersion = (this._listVersion || 0) + 1;
    this.setData({ busy: true, loading: false, loadingMore: false, actionError: '', notice: '' });
    try {
      const response = await app().api.request('feedback/', { method: 'POST', data: { body } });
      if (!this.accepted(action, token, true)) return;
      const record = present(response && response.data);
      this.setData({ body: '', bodyCount: 0, records: [record].concat(this.data.records.filter((item) => item.id !== record.id)), next: '', notice: '反馈已提交，可在下方查看处理进度与答复。' });
      await this.load(false, true);
    } catch (error) {
      if (!this.active() || action !== this._actionVersion) return;
      this.expire(error, token);
      if (this.accepted(action, token, true)) this.setData({ actionError: message(error) + ' 如提交结果未确认，请先刷新记录核对，再决定是否重试。' });
    } finally { if (this.accepted(action, token, true)) this.setData({ busy: false }); }
  },
  remove(event) {
    if (!this.canAct() || this._confirming) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.records.some((item) => item.id === id)) return;
    const token = app().session.token(), action = this._actionVersion = (this._actionVersion || 0) + 1;
    this._confirming = true; let handled = false;
    wx.showModal({ title: '删除这条反馈', content: '反馈内容及对应答复将删除，无法恢复。', confirmText: '删除', confirmColor: '#d97b4f', success: async (result) => {
      if (handled) return; handled = true;
      if (!this.accepted(action, token, true)) return;
      this._confirming = false; if (!result.confirm) return;
      // In-flight pages may still contain the deleted item; retire their generation before deleting.
      this._listVersion = (this._listVersion || 0) + 1;
      this.setData({ busy: true, loading: false, loadingMore: false, actionError: '', notice: '' });
      try {
        try { await app().api.request('feedback/' + encodeURIComponent(id) + '/', { method: 'DELETE' }); }
        catch (error) { if (error.status !== 404) throw error; }
        if (!this.accepted(action, token, true)) return;
        this.setData({ records: this.data.records.filter((item) => item.id !== id), next: '', notice: '反馈及答复已删除。' });
        await this.load(false, true);
      } catch (error) {
        if (!this.active() || action !== this._actionVersion) return;
        this.expire(error, token);
        if (this.accepted(action, token, true)) this.setData({ actionError: message(error) });
      } finally { if (this.accepted(action, token, true)) this.setData({ busy: false }); }
    }, fail: () => { if (this.accepted(action, token, true)) this._confirming = false; } });
  },
});
