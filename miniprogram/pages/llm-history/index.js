const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message } = require('../../lib/format');
const { sessionView, readPage } = require('../../lib/llm');
Page(withTheme({
  data: { loggedIn: false, loading: true, loadingMore: false, busy: false, error: '', moreError: '', statusError: '', sessions: [], next: '', status: null },
  onLoad() { this._alive = true; },
  async onShow() {
    this._visible = true;
    const shown = this._showVersion = (this._showVersion || 0) + 1;
    if (this.hasMutation()) { this.setData({ loading: true }); await this._mutation.promise; if (!this.active() || shown !== this._showVersion) return; }
    return this.load();
  },
  onHide() { this._visible = false; this.invalidate(); this.clearView(); },
  onUnload() { this._alive = false; this.invalidate(); },
  active() { return this._alive !== false && this._visible !== false; },
  invalidate() { this._generation = (this._generation || 0) + 1; this._action = (this._action || 0) + 1; this._showVersion = (this._showVersion || 0) + 1; this._confirming = false; },
  clearView() { this.setData({ sessions: [], next: '', loading: false, loadingMore: false, busy: false }); },
  hasMutation() { return !!(this._mutation && !this._mutation.settled && this._mutation.token === app().session.token()); },
  current(generation, token) {
    if (!this.active() || generation !== this._generation) return false;
    if (app().session.token() === token) return true;
    this.invalidate(); this.clearView(); this.setData({ loggedIn: Boolean(app().session.token()), error: '登录状态已变化，请刷新会话列表。' }); wx.stopPullDownRefresh(); return false;
  },
  canAct() { return this.active() && !this.data.busy && !this.hasMutation() && this.current(this._generation, this._token) && !!app().session.token(); },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  onPullDownRefresh() { return this.load(); },
  onReachBottom() { return this.load(true); },
  more() { return this.load(true); },
  async load(more = false) {
    if (!this.active()) return;
    if (this.hasMutation()) { wx.stopPullDownRefresh(); return; }
    more = more === true;
    const token = app().session.token();
    if (this._token !== token) { this.clearView(); more = false; }
    this._token = token;
    if (!token) { this.invalidate(); this.clearView(); this.setData({ loggedIn: false, error: '' }); wx.stopPullDownRefresh(); return; }
    if (more && (!this.data.next || this.data.loading || this.data.loadingMore)) return;
    if (!more) { this._action = (this._action || 0) + 1; this._confirming = false; }
    const generation = this._generation = (this._generation || 0) + 1;
    const path = more ? this.data.next : 'llm/sessions/', seen = more ? new Set(this._seen || []) : new Set();
    this.setData({ loggedIn: true, loading: !more, loadingMore: more, error: '', moreError: '' });
    const status = !more ? app().api.request('llm/status/').then((response) => {
      if (this.current(generation, token)) this.setData({ status: response.data, statusError: '' });
    }).catch((error) => { if (this.current(generation, token)) this.setData({ statusError: message(error) }); }) : Promise.resolve();
    try {
      const response = await app().api.request(path, more ? undefined : { data: { page_size: 20 } });
      if (!this.current(generation, token)) return;
      const result = readPage(response, path, 'llm/sessions/', seen), records = new Map((more ? this.data.sessions : []).map((row) => [row.id, row]));
      result.items.map(sessionView).forEach((row) => records.set(row.id, row)); seen.add(result.key); this._seen = seen;
      this.setData({ sessions: Array.from(records.values()), next: result.next });
    } catch (error) { if (this.current(generation, token)) this.setData({ [more ? 'moreError' : 'error']: message(error) }); }
    finally { await status; if (this.current(generation, token)) { this.setData({ loading: false, loadingMore: false }); wx.stopPullDownRefresh(); } }
  },
  open(event) {
    if (!this.canAct()) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.sessions.some((row) => row.id === id)) wx.navigateTo({ url: '/pages/llm/index?sessionId=' + encodeURIComponent(id) });
  },
  remove(event) {
    if (!this.canAct() || this._confirming) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.sessions.some((row) => row.id === id)) return;
    const token = this._token, action = this._action = (this._action || 0) + 1;
    const current = () => {
      if (!this.active() || action !== this._action) return false;
      if (token === app().session.token()) return true;
      this.invalidate(); this.clearView(); this.setData({ loggedIn: Boolean(app().session.token()), error: '登录状态已变化，请刷新会话列表。' }); return false;
    };
    this._confirming = true; let handled = false;
    wx.showModal({ title: '删除 AI 对话', content: '删除平台保存的这段对话，不影响原始资料或识别任务。已提交给 DeepSeek 的请求不会因此撤回。', confirmText: '删除', confirmColor: '#a25e4a', success: async (result) => {
      if (handled) return; handled = true;
      if (!current()) { if (this.active() && this._token !== app().session.token()) { this.invalidate(); this.clearView(); } return; }
      this._confirming = false; if (!result.confirm) return;
      this._generation = (this._generation || 0) + 1;
      this.setData({ busy: true, loading: false, loadingMore: false, error: '' });
      const mutation = { token }; mutation.promise = new Promise((resolve) => { mutation.resolve = resolve; }); this._mutation = mutation;
      try {
        try { await app().api.request('llm/sessions/' + encodeURIComponent(id) + '/', { method: 'DELETE' }); }
        catch (error) { if (error.status !== 404) throw error; }
        mutation.settled = true;
        if (!current()) return;
        this.setData({ sessions: this.data.sessions.filter((row) => row.id !== id), next: '' });
        await this.load();
      } catch (error) { if (current()) this.setData({ error: message(error) }); }
      finally { if (this._mutation === mutation) this._mutation = null; mutation.resolve(); if (this.active() && token === app().session.token()) this.setData({ busy: false }); }
    }, fail: () => { if (current()) this._confirming = false; } });
  },
}));
