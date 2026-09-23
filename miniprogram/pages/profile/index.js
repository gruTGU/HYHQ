const { selectTab } = require('../../lib/tab-bar');
const { app, toast } = require('../../lib/page');
const { message } = require('../../lib/format');
Page({
  data: { loading: true, error: '', busy: false, user: null, nickname: '', avatar: '', avatarNotice: '', devAvailable: false, authMode: '', editingProfile: false },
  async onShow() {
    selectTab(this, 4);
    this._visible = true;
    const shown = this._showVersion = (this._showVersion || 0) + 1;
    if (this._pendingMutation && this._pendingMutation.token === app().session.token()) {
      this.setData({ loading: true });
      await this._pendingMutation.promise;
      if (!this._active() || shown !== this._showVersion) return;
    }
    return this.load();
  },
  onHide() {
    this._visible = false;
    this._invalidate();
    this.setData({ user: null, nickname: '', avatar: '', avatarNotice: '', authMode: '', loading: false, busy: false, editingProfile: false });
  },
  onUnload() { this._destroyed = true; this._invalidate(); },
  _active() { return !this._destroyed && this._visible !== false; },
  _invalidate() {
    this._version = (this._version || 0) + 1;
    this._showVersion = (this._showVersion || 0) + 1;
    this._profileToken = '';
    this._confirming = false;
  },
  _clearPrivate(error = '') {
    this._profileToken = '';
    this.setData({ user: null, nickname: '', avatar: '', avatarNotice: '', authMode: '', editingProfile: false, error });
  },
  _start(busy = false) {
    this._confirming = false;
    const session = app().session.get() || {};
    const operation = { version: this._version = (this._version || 0) + 1, token: app().session.token(), userId: session.user && session.user.id };
    if (busy) {
      operation.promise = new Promise((resolve) => { operation.resolve = resolve; });
      this._pendingMutation = operation;
      this.setData({ busy: true, error: '' });
    }
    return operation;
  },
  _current(operation) {
    if (!this._active() || operation.version !== this._version) return false;
    if (app().session.token() !== operation.token) {
      this._clearPrivate('登录状态已变化，请重新登录或刷新');
      return false;
    }
    return true;
  },
  _finish(operation) {
    if (this._pendingMutation === operation) this._pendingMutation = null;
    if (operation.resolve) operation.resolve();
    if (this._active() && operation.version === this._version) {
      this.setData({ busy: false, loading: false });
      wx.stopPullDownRefresh();
    }
  },
  _hasPendingMutation() { return !!(this._pendingMutation && this._pendingMutation.token === app().session.token()); },
  _canChange() {
    if (!this._active() || this.data.busy || this._confirming || this._hasPendingMutation()) return false;
    const token = app().session.token();
    if (!token || (this._profileToken && this._profileToken !== token)) {
      this._clearPrivate('登录状态已变化，请重新登录或刷新');
      return false;
    }
    return !!this.data.user;
  },
  onPullDownRefresh() { return this.load(); },
  async load() {
    if (!this._active()) return;
    if (this.data.busy || this._hasPendingMutation()) { wx.stopPullDownRefresh(); return; }
    const operation = this._start();
    this.setData({ loading: true, error: '', user: null, nickname: '', avatar: '', avatarNotice: '', authMode: '', devAvailable: false });
    try {
      const health = (await app().api.request('health/')).data;
      if (!this._current(operation)) return;
      app().globalData.health = health;
      this.setData({ devAvailable: app().config.development && health.dev_auth_enabled === true });
      if (operation.token) await this.loadUser(operation);
    } catch (error) {
      if (this._current(operation)) this._clearPrivate(message(error));
    } finally { this._finish(operation); }
  },
  async loadUser(context) {
    if (!this._active()) return;
    const operation = context || this._start();
    if (!operation.token) { this._clearPrivate(); if (!context) this._finish(operation); return; }
    try {
      const user = (await app().api.request('me/')).data;
      if (!this._current(operation)) return;
      await this._showUser(operation, user);
    } catch (error) {
      if (context) throw error;
      if (this._current(operation)) this._clearPrivate(message(error));
    } finally { if (!context) this._finish(operation); }
  },
  async _showUser(operation, user, fallbackAvatar) {
    if (!this._current(operation)) return;
    if (!user || typeof user.id !== 'string' || !user.id || (operation.userId && user.id !== operation.userId)) throw new Error('账号资料与登录身份不一致，请重新登录');
    app().session.updateUser(user);
    this._profileToken = operation.token;
    this.setData({ user, nickname: user.nickname || '', avatar: '', avatarNotice: '', authMode: (app().session.get() || {}).auth_mode || '' });
    const url = user.avatar_url || fallbackAvatar;
    if (url) {
      try {
        const avatar = await app().api.download(url);
        if (this._current(operation)) this.setData({ avatar });
      } catch (error) {
        if (this._current(operation)) this.setData({ avatar: '', avatarNotice: '头像暂不可用，可下拉刷新重试' });
      }
    }
  },
  async login(event) {
    if (!this._active() || this.data.busy || this._confirming || this._hasPendingMutation()) return;
    const dev = event.currentTarget.dataset.mode === 'dev';
    if (dev && !this.data.devAvailable) return;
    const operation = this._start(true);
    try {
      let path, data;
      if (dev) {
        path = 'auth/dev/'; data = { device_id: app().session.deviceId() };
      } else {
        const result = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: () => reject(new Error('微信登录暂不可用，请检查 AppID 与开发者权限')) }));
        if (!this._current(operation)) return;
        if (!result.code) throw new Error('微信未返回登录 code，请重试');
        path = 'auth/wechat/'; data = { code: result.code };
      }
      const result = (await app().api.request(path, { method: 'POST', data })).data;
      if (!this._current(operation)) return;
      if (!result || typeof result.token !== 'string' || !result.token || !result.user || typeof result.user.id !== 'string') throw new Error('登录返回格式不正确，请重试');
      app().session.save(Object.assign({}, result, { auth_mode: dev ? 'development' : 'wechat' }));
      operation.token = result.token;
      operation.userId = result.user.id;
      await this.loadUser(operation);
      if (this._current(operation)) wx.showToast({ title: dev ? '已进入开发账号' : '登录成功', icon: 'success' });
    } catch (error) { if (this._current(operation)) this.setData({ error: message(error) }); }
    finally { this._finish(operation); }
  },
  nicknameInput(event) { if (this._active()) this.setData({ nickname: event.detail.value }); },
  toggleProfileEditor() {
    if (!this._canChange()) return;
    this.setData({ editingProfile: !this.data.editingProfile, nickname: this.data.user.nickname || '' });
  },
  async saveProfile() {
    if (!this._canChange()) return;
    const nickname = this.data.nickname.trim();
    if (!nickname || Array.from(nickname).length > 32) { toast(new Error(nickname ? '昵称最多 32 个字' : '请输入昵称')); return; }
    return this.update({ nickname });
  },
  async privacyChange(event) { return this.update({ record_history: event.detail.value }); },
  async update(data) {
    if (!this._canChange()) return;
    const operation = this._start(true);
    try {
      const user = (await app().api.request('me/', { method: 'PATCH', data })).data;
      if (!this._current(operation)) return;
      await this._showUser(operation, user);
      if (this._current(operation)) wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) {
      if (!this._current(operation)) return;
      // Re-send the confirmed value so the native switch rolls back after a failed PATCH.
      this.setData({ user: this.data.user ? Object.assign({}, this.data.user) : null, error: message(error) });
      toast(error);
    } finally { this._finish(operation); }
  },
  async chooseAvatar(event) {
    if (!this._canChange() || !event.detail.avatarUrl) return;
    const operation = this._start(true);
    try {
      const asset = await app().api.upload(event.detail.avatarUrl, 'avatar');
      if (!this._current(operation)) return;
      const user = (await app().api.request('me/', { method: 'PATCH', data: { avatar_asset_id: asset.id } })).data;
      if (!this._current(operation)) return;
      await this._showUser(operation, user, asset.thumbnail_url);
      if (this._current(operation)) wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (error) { if (this._current(operation)) { this.setData({ error: message(error) }); toast(error); } }
    finally { this._finish(operation); }
  },
  records(event) {
    if (!this._canChange()) return;
    const kind = event.currentTarget.dataset.kind;
    if (['favorites', 'histories', 'recognition-jobs', 'assessment-jobs', 'visits'].includes(kind)) wx.navigateTo({ url: '/pages/records/index?kind=' + kind });
  },
  legal(event) { if (this._active()) wx.navigateTo({ url: '/pages/legal/index?kind=' + (event.currentTarget.dataset.kind === 'terms' ? 'terms' : 'privacy') }); },
  feedback() { if (this._active()) wx.navigateTo({ url: '/pages/feedback/index' }); },
  aiHistory() { if (this._active()) wx.navigateTo({ url: '/pages/llm-history/index' }); },
  logout() { return this._confirmRemoval(false); },
  deleteAccount() { return this._confirmRemoval(true); },
  _confirmRemoval(removeAccount) {
    if (!this._canChange()) return;
    const token = app().session.token();
    const version = this._version || 0;
    const valid = () => this._active() && version === (this._version || 0) && app().session.token() === token;
    let handled = false;
    this._confirming = true;
    wx.showModal({ title: removeAccount ? '注销账号' : '退出登录', content: removeAccount ? '注销会使现有会话失效，并删除账号、个人记录、AI 解读会话和上传图片。此操作无法恢复，已发送给外部服务的请求不能因此撤回。' : '退出后仍可浏览公开的生态与科普资料。', confirmText: removeAccount ? '确认注销' : '退出登录', confirmColor: removeAccount ? '#d97b4f' : '#3a7d5c', success: async (result) => {
      if (handled) return;
      handled = true;
      if (!valid()) {
        if (this._active() && version === (this._version || 0)) { this._confirming = false; if (app().session.token() !== token) this._clearPrivate('登录状态已变化，请重新确认当前账号'); }
        return;
      }
      this._confirming = false;
      if (!result.confirm) return;
      const operation = this._start(true);
      try {
        await app().api.request(removeAccount ? 'me/' : 'auth/logout/', { method: removeAccount ? 'DELETE' : 'POST' });
        // An accepted logout still revokes its original local session after navigation.
        // A newly signed-in account must never be cleared by the older response.
        if (app().session.token() === operation.token) { app().session.clear(); operation.token = ''; }
        if (!this._current(operation)) return;
        this._clearPrivate();
        wx.showToast({ title: removeAccount ? '账号已注销' : '已退出登录', icon: 'success' });
      } catch (error) { if (this._current(operation)) { this.setData({ error: message(error) }); toast(error); } }
      finally { this._finish(operation); }
    }, fail: () => { if (valid()) this._confirming = false; } });
  },
});
