const releasePolicy = require('../../lib/release-policy');
const { withTheme } = require('../../lib/theme');
const { selectTab } = require('../../lib/tab-bar');
const { app, requireLogin, toast, finish, detail } = require('../../lib/page');
const { list, task, message } = require('../../lib/format');
const { capability } = require('../../lib/recognition');
const { selectedPhotoIdentity, canAcceptSelectedPhoto, rememberSelectedPhoto, canKeepSelectedPhoto, expiredPhotoNotice } = require('../../lib/selected-photo');
Page(withTheme({
  data: { mode: 'recognition', riverBusy: false, loading: false, error: '', busy: false, imagePath: '', imageOrigin: '', imageUnavailable: '', photoError: '', authNotice: '', task: null, jobs: [], loggedIn: false, capability: capability(null), capabilityKnown: false, capabilityError: '' },
  onShow() {
    this._destroyed = false;
    selectTab(this, 2);
    this._visible = true;
    this._pollCount = 0;
    const current = app().session.get();
    const userId = current && current.user && current.user.id;
    const sessionToken = app().session.token();
    if (this._userId !== userId || this._sessionToken !== sessionToken) this.clearPrivate();
    this._userId = userId;
    this._sessionToken = sessionToken;
    // Returning from a legacy recognition record must select its own workflow.
    if (app().globalData.recognitionJobId) this.setData({ mode: 'recognition', riverBusy: false });
    if (this.data.mode === 'assessment') return;
    return this.load();
  },
  onHide() { this._visible = false; this.stopPolling(); },
  onUnload() {
    this._visible = false;
    this._destroyed = true;
    this._loadGeneration = (this._loadGeneration || 0) + 1;
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    this._pickerGeneration = (this._pickerGeneration || 0) + 1;
    this.stopPolling();
  },
  onPullDownRefresh() {
    if (this.data.mode === 'assessment') { const observer = this.selectComponent && this.selectComponent('#river-observer'); return observer ? observer.refresh() : wx.stopPullDownRefresh(); }
    return this.load();
  },
  stopPolling() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },
  clearPrivate() {
    this.stopPolling();
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    const keepPhoto = canKeepSelectedPhoto(this, app().session);
    this.setData({ jobs: [], task: null, imagePath: keepPhoto ? this.data.imagePath : '', imageOrigin: keepPhoto ? 'selected' : '', imageUnavailable: '', busy: false });
    if (!keepPhoto) this._photoOwner = null;
    this.setData({ authNotice: !app().session.token() && keepPhoto ? expiredPhotoNotice(this) : '' });
  },
  current(token) {
    if (this._destroyed) return false;
    if (app().session.token() === token) return true;
    if (this._sessionToken !== undefined && this._sessionToken !== token) return false;
    this.clearPrivate();
    this._sessionToken = app().session.token();
    this.setData({ loggedIn: Boolean(this._sessionToken), error: this._sessionToken ? '登录状态已变化，请再次提交。' : expiredPhotoNotice(this) });
    return false;
  },
  async load() {
    if (this._destroyed || this.data.mode === 'assessment') return;
    const generation = this._loadGeneration = (this._loadGeneration || 0) + 1;
    const sentToken = app().session.token();
    const loggedIn = Boolean(app().session.token());
    this.setData({ loggedIn, error: '', loading: true, authNotice: loggedIn ? '' : this.data.authNotice });
    if (!loggedIn) this.clearPrivate();
    try {
      const results = await Promise.all([
        app().api.request('health/').then((response) => ({ response })).catch((error) => ({ error })),
        loggedIn ? app().api.request('recognition-jobs/', { data: { page_size: 5 } }).then((response) => ({ response })).catch((error) => ({ error })) : Promise.resolve({ response: { data: [] } }),
      ]);
      if (this._destroyed || generation !== this._loadGeneration) return;
      if (results[0].error) this.setData({ capabilityKnown: false, capabilityError: '暂时无法确认模型状态：' + message(results[0].error) });
      else {
        const health = results[0].response.data;
        app().globalData.health = health;
        this.setData({ capability: capability(health), capabilityKnown: true, capabilityError: '' });
      }
      if (results[1].error) throw results[1].error;
      if (loggedIn && !this.current(sentToken)) return;
      const jobs = list(results[1].response).map(task);
      const current = this.data.task && jobs.find((item) => item.id === this.data.task.id);
      this.setData({ jobs, task: current || this.data.task });
      if (this.data.task && !current && !this.data.busy) {
        const selectedId = this.data.task.id;
        try {
          const selected = (await app().api.request('recognition-jobs/' + encodeURIComponent(selectedId) + '/')).data;
          if (this._destroyed || generation !== this._loadGeneration || app().session.token() !== sentToken) return;
          if (this.data.task && this.data.task.id === selectedId) this.setData({ task: task(selected) });
        } catch (error) {
          if (this._destroyed || generation !== this._loadGeneration) return;
          if (error.status === 404 && this.data.task && this.data.task.id === selectedId) {
            this.stopPolling();
            this._selectionVersion = (this._selectionVersion || 0) + 1;
            this.setData({ task: null, imagePath: '', imageOrigin: '', imageUnavailable: '', error: '这条识别记录已删除或已到保留期限。' });
          } else throw error;
        }
      }
      const pendingJob = app().globalData.recognitionJobId;
      if (pendingJob && loggedIn) {
        app().globalData.recognitionJobId = null;
        await this.selectJob(pendingJob);
      } else if (this._visible && this.data.task && ['queued', 'running'].includes(this.data.task.status)) {
        this.poll(this.data.task.id);
      }
    } catch (error) { if (!this._destroyed && generation === this._loadGeneration) this.authError(error); }
    finally { if (!this._destroyed && generation === this._loadGeneration) finish(this); }
  },
  choose() {
    if (this._destroyed || this.data.mode === 'assessment' || this.data.busy || !requireLogin()) return;
    this.setData({ photoError: '' });
    const identity = selectedPhotoIdentity(app().session);
    const modeVersion = this._modeVersion;
    const pickerGeneration = this._pickerGeneration = (this._pickerGeneration || 0) + 1;
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: (result) => {
      if (this._destroyed || pickerGeneration !== this._pickerGeneration || modeVersion !== this._modeVersion || this.data.mode === 'assessment') return;
      if (!canAcceptSelectedPhoto(identity, app().session)) { this.clearPrivate(); this.setData({ loggedIn: Boolean(app().session.token()), photoError: '登录账号已变化，请在当前账号重新选择照片。' }); return; }
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || typeof file.tempFilePath !== 'string' || !file.tempFilePath) { this.showPhotoError('没有取得可用照片，请重新选择。'); return; }
      if (file.size > app().config.maxUploadBytes) { this.showPhotoError('这张图片超过 5MB，请压缩或选择较小的照片。'); return; }
      this.stopPolling();
      this._selectionVersion = (this._selectionVersion || 0) + 1;
      rememberSelectedPhoto(this, app().session, identity);
      this.setData({ imagePath: file.tempFilePath, imageOrigin: 'selected', imageUnavailable: '', task: null, error: '', authNotice: '' });
      // The native camera/album can outlive a business session. Preserve this
      // user's newly chosen local file instead of silently discarding it.
      if (!app().session.token()) this.authError(new Error('登录已失效，请重新登录'));
    }, fail: (error) => { if (!this._destroyed && pickerGeneration === this._pickerGeneration && !/cancel/i.test(error.errMsg || '')) this.showPhotoError('未能选择图片，请检查相机与相册权限'); } });
  },
  showPhotoError(notice) {
    if (this._destroyed) return;
    this.setData({ photoError: notice });
    toast(new Error(notice));
  },
  async submit() {
    if (this._destroyed || this.data.mode === 'assessment' || this.data.busy || this.data.imageOrigin === 'history' || (this.data.task && ['queued', 'running'].includes(this.data.task.status)) || !this.data.imagePath) return;
    if (!requireLogin()) { this.authError(new Error('登录已失效，请重新登录')); return; }
    if (!this._photoOwner && this.data.imageOrigin === 'selected') rememberSelectedPhoto(this, app().session);
    const sentToken = app().session.token();
    this.setData({ busy: true, error: '' });
    try {
      const asset = await app().api.upload(this.data.imagePath, 'recognition');
      if (this._destroyed) return;
      if (!this.current(sentToken)) return;
      const result = (await app().api.request('recognition-jobs/', { method: 'POST', data: { asset_id: asset.id } })).data;
      if (this._destroyed) return;
      if (!this.current(sentToken)) return;
      this.setData({ task: task(result) });
      this._pollCount = 0;
      this.poll(result.id);
    } catch (error) { if (!this._destroyed && (!app().session.token() || this.current(sentToken))) this.authError(error); }
    finally { if (!this._destroyed && (!app().session.token() || app().session.token() === sentToken)) this.setData({ busy: false }); }
  },
  async poll(id) {
    this.stopPolling();
    if (this._destroyed || !this._visible) return;
    const generation = this._pollGeneration;
    const sentToken = app().session.token();
    try {
      const result = (await app().api.request('recognition-jobs/' + encodeURIComponent(id) + '/')).data;
      if (this._destroyed || generation !== this._pollGeneration || app().session.token() !== sentToken || !this._visible || !this.data.task || this.data.task.id !== id) return;
      this.setData({ task: task(result) });
      if (['queued', 'running'].includes(result.status)) {
        this._pollCount = (this._pollCount || 0) + 1;
        if (this._pollCount < 10) this._timer = setTimeout(() => this.poll(id), 3000);
        else this.setData({ error: '识别还需要一点时间，可稍后刷新结果，无需重复上传。' });
      } else await this.load();
    } catch (error) {
      if (!this._destroyed && generation === this._pollGeneration && this._visible && (!app().session.token() || app().session.token() === sentToken)) {
        if (error.status === 404) this.setData({ task: null, imagePath: '', imageOrigin: '', imageUnavailable: '' });
        this.authError(error);
      }
    }
  },
  authError(error) {
    if (this._destroyed) return;
    const loggedIn = Boolean(app().session.token());
    if (!loggedIn) {
      this.clearPrivate();
      const notice = expiredPhotoNotice(this);
      this.setData({ authNotice: notice, error: '', loggedIn: false });
      toast(new Error(notice));
    } else this.setData({ error: message(error), loggedIn: true });
  },
  openJob(event) { this.selectJob(event.currentTarget.dataset.id); },
  async selectJob(id) {
    if (this._destroyed || this.data.busy || !requireLogin()) return;
    this.stopPolling();
    const version = this._selectionVersion = (this._selectionVersion || 0) + 1;
    const sentToken = app().session.token();
    this.setData({ busy: true, task: null, imagePath: '', imageOrigin: 'history', imageUnavailable: '', error: '' });
    try {
      const job = (await app().api.request('recognition-jobs/' + encodeURIComponent(id) + '/')).data;
      if (this._destroyed || version !== this._selectionVersion || app().session.token() !== sentToken) return;
      this.setData({ task: task(job) });
      if (job.asset_id) {
        try {
          const localPath = await app().api.download('uploads/' + encodeURIComponent(job.asset_id) + '/content/?variant=thumbnail');
          if (!this._destroyed && version === this._selectionVersion && app().session.token() === sentToken) this.setData({ imagePath: localPath });
        } catch (error) {
          if (!app().session.token()) throw error;
          if (!this._destroyed && version === this._selectionVersion) this.setData({ imageUnavailable: '历史图片已过期、删除或暂不可访问，识别记录仍可查看。' });
        }
      }
      if (!this._destroyed && version === this._selectionVersion && ['queued', 'running'].includes(job.status)) { this._pollCount = 0; this.poll(job.id); }
    } catch (error) { if (!this._destroyed && version === this._selectionVersion) this.authError(error); }
    finally { if (!this._destroyed && version === this._selectionVersion) this.setData({ busy: false }); }
  },
  openContent(event) { if (event.detail.id) detail('content', event.detail.id); },
  openAI() {
    if (!releasePolicy.recognitionInterpretationEnabled) return;
    if (this._destroyed || !this._visible || this.data.busy || !this.data.task || this.data.task.status !== 'succeeded' || this._sessionToken !== app().session.token() || !requireLogin()) return;
    wx.navigateTo({ url: '/pages/llm/index?kind=recognition&jobId=' + encodeURIComponent(this.data.task.id) });
  },
  refreshTask() { if (this.data.task) { this._pollCount = 0; this.poll(this.data.task.id); } else this.load(); },
  login() { wx.switchTab({ url: '/pages/profile/index' }); },
  changeMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (this._destroyed || this.data.busy || this.data.riverBusy || !['recognition', 'assessment'].includes(mode) || mode === this.data.mode) return;
    // The busy event is deferred to avoid nested setData; read the component
    // directly as well so a same-tick action cannot interrupt upload/location.
    const observer = this.data.mode === 'assessment' && this.selectComponent && this.selectComponent('#river-observer');
    if (observer && observer.data && (observer.data.busy || observer.data.locating)) return;
    this.stopPolling();
    this._modeVersion = (this._modeVersion || 0) + 1;
    this._loadGeneration = (this._loadGeneration || 0) + 1;
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    this.setData({ mode, riverBusy: false, loading: false, error: '' });
    if (mode === 'recognition') return this.onShow();
  },
  riverBusyChange(event) {
    const busy = Boolean(event.detail && event.detail.busy);
    if (!this._destroyed && this.data.mode === 'assessment' && busy !== this.data.riverBusy) this.setData({ riverBusy: busy });
  },
  assessment() { return this.changeMode({ currentTarget: { dataset: { mode: 'assessment' } } }); },
  privacy() { wx.navigateTo({ url: '/pages/legal/index?kind=privacy' }); },
}));
