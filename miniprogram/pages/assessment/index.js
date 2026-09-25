const { app, requireLogin, toast, finish } = require('../../lib/page');
const { list, message } = require('../../lib/format');
const { capability, assessmentTask: baseAssessmentTask } = require('../../lib/assessment');
const { summaryView } = require('./summary');
const assessmentTask = (job) => Object.assign(baseAssessmentTask(job), { summary_view: summaryView(job) });
const NONE = { id: '', name: '不关联水体（可直接上传）' };
const pending = (job) => job && ['queued', 'running'].includes(job.status);

Page({
  data: {
    loading: false, error: '', busy: false, loggedIn: false, helpExpanded: false, associationExpanded: false, metadataExpanded: false,
    capability: capability(null), capabilityKnown: false, capabilityError: '',
    imagePath: '', imageOrigin: '', imageReady: false, imageUnavailable: '', task: null, jobs: [],
    waterBodies: [NONE], waterIndex: 0, waterNotice: '', location: null, locating: false, locationNotice: '', nearby: null,
  },
  onLoad(options) { this._requestedJob = options && options.jobId || ''; },
  onShow() {
    this._destroyed = false;
    this._visible = true;
    this._pollCount = 0;
    const token = app().session.token();
    if (token !== this._sessionToken) this.clearPrivate();
    this._sessionToken = token;
    return this.load();
  },
  onHide() { this._visible = false; this.stopPolling(); },
  onUnload() {
    this._destroyed = true;
    this._visible = false;
    this._loadGeneration = (this._loadGeneration || 0) + 1;
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    this._locationVersion = (this._locationVersion || 0) + 1;
    this.stopPolling();
  },
  onPullDownRefresh() { return this.load(); },
  stopPolling() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },
  clearSelection() {
    this.stopPolling();
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    this.setData({ task: null, imagePath: '', imageOrigin: '', imageReady: false, imageUnavailable: '', busy: false });
  },
  clearPrivate() {
    this.clearSelection();
    this._locationVersion = (this._locationVersion || 0) + 1;
    this.setData({ jobs: [], location: null, nearby: null, locating: false, locationNotice: '', waterIndex: 0 });
  },
  current(token) {
    if (this._destroyed) return false;
    if (app().session.token() === token) return true;
    // A callback from an older identity must not clear a newly loaded account's view.
    if (this._sessionToken !== undefined && this._sessionToken !== token) return false;
    this.clearPrivate();
    this._sessionToken = app().session.token();
    this.setData({ loggedIn: Boolean(app().session.token()), error: '登录状态已变化，请重新加载个人记录。' });
    return false;
  },
  async load() {
    if (this._destroyed) return;
    const generation = this._loadGeneration = (this._loadGeneration || 0) + 1;
    const selection = this._selectionVersion;
    const token = app().session.token();
    this.setData({ loading: true, error: '', loggedIn: Boolean(token) });
    if (!token) this.clearPrivate();
    const safe = (promise) => promise.then((response) => ({ response })).catch((error) => ({ error }));
    try {
      const results = await Promise.all([
        safe(app().api.request('health/')),
        safe(app().api.request('water-bodies/', { data: { page_size: 100 } })),
        token ? safe(app().api.request('assessment-jobs/', { data: { page_size: 5 } })) : Promise.resolve({ response: { data: [] } }),
      ]);
      if (this._destroyed || generation !== this._loadGeneration || !this.current(token)) return;
      if (results[0].error) this.setData({ capabilityKnown: false, capabilityError: '暂时无法确认模型状态：' + message(results[0].error) });
      else {
        app().globalData.health = results[0].response.data;
        this.setData({ capability: capability(results[0].response.data), capabilityKnown: true, capabilityError: '' });
      }
      if (results[1].error) this.setData({ waterNotice: '水体列表暂不可用，仍可不关联水体上传。' });
      else {
        const selected = this.data.waterBodies[this.data.waterIndex];
        const waterBodies = [NONE].concat(list(results[1].response));
        this.setData({ waterBodies, waterIndex: Math.max(0, waterBodies.findIndex((item) => selected && item.id === selected.id)), waterNotice: '' });
      }
      if (results[2].error) throw results[2].error;
      const jobs = list(results[2].response).map(assessmentTask);
      this.setData({ jobs });
      if (this._requestedJob && token) {
        const id = this._requestedJob;
        this._requestedJob = '';
        await this.selectJob(id);
      } else if (this.data.task && !this.data.busy) {
        const id = this.data.task.id;
        const selected = jobs.find((item) => item.id === id);
        const job = selected || (await app().api.request('assessment-jobs/' + encodeURIComponent(id) + '/')).data;
        if (this._destroyed || generation !== this._loadGeneration || !this.current(token) || !this.data.task || this.data.task.id !== id) return;
        this.setData({ task: assessmentTask(job) });
        if (this._visible && pending(job)) this.poll(id);
      }
    } catch (error) {
      if (!this._destroyed && generation === this._loadGeneration && this.current(token)) {
        if (error.status === 404 && selection === this._selectionVersion) { this.clearSelection(); this.setData({ error: '这条河道观察记录已删除或已到保留期限。' }); }
        else this.authError(error);
      }
    } finally { if (!this._destroyed && generation === this._loadGeneration) finish(this); }
  },
  toggleHelp() { this.setData({ helpExpanded: !this.data.helpExpanded }); },
  toggleAssociation() { this.setData({ associationExpanded: !this.data.associationExpanded }); },
  toggleMetadata() { this.setData({ metadataExpanded: !this.data.metadataExpanded }); },
  choose() {
    if (this._destroyed || this.data.busy || !requireLogin()) return;
    const token = app().session.token();
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: (result) => {
      if (!this.current(token)) return;
      const file = result.tempFiles && result.tempFiles[0];
      if (!file) return;
      if (file.size > app().config.maxUploadBytes) { toast(new Error('图片不能超过 5MB，请压缩后重试')); return; }
      this.clearSelection();
      this.setData({ imagePath: file.tempFilePath, imageOrigin: 'selected', error: '' });
    }, fail: (error) => { if (!this._destroyed && !/cancel/i.test(error.errMsg || '')) toast(new Error('未能选择图片，请检查相机与相册权限')); } });
  },
  async submit() {
    if (this._destroyed || this.data.busy || this.data.locating || this.data.imageOrigin !== 'selected' || !this.data.imagePath || pending(this.data.task) || !requireLogin()) return;
    if (!this.data.capabilityKnown || !this.data.capability.enabled) { this.setData({ error: '河道观察模型未启用或状态未知，请稍后刷新。' }); return; }
    const token = app().session.token();
    const version = this._selectionVersion;
    const selected = this.data.waterBodies[this.data.waterIndex];
    const payload = Object.assign({}, this.data.location || {});
    if (selected && selected.id) payload.water_body_id = selected.id;
    this.setData({ busy: true, error: '' });
    try {
      const asset = await app().api.upload(this.data.imagePath, 'recognition');
      if (!this.current(token) || version !== this._selectionVersion) return;
      // Each submission uploads a fresh asset: recognition and assessment cannot share one.
      payload.asset_id = asset.id;
      const job = (await app().api.request('assessment-jobs/', { method: 'POST', data: payload })).data;
      if (!this.current(token) || version !== this._selectionVersion) return;
      this.setData({ task: assessmentTask(job) });
      this._pollCount = 0;
      if (pending(job)) this.poll(job.id);
      else await this.load();
    } catch (error) { if (this.current(token) && version === this._selectionVersion) this.authError(error); }
    finally { if (!this._destroyed && version === this._selectionVersion && app().session.token() === token) this.setData({ busy: false }); }
  },
  async poll(id) {
    this.stopPolling();
    if (this._destroyed || !this._visible) return;
    const generation = this._pollGeneration;
    const token = app().session.token();
    try {
      const job = (await app().api.request('assessment-jobs/' + encodeURIComponent(id) + '/')).data;
      if (this._destroyed || generation !== this._pollGeneration || !this.current(token) || !this._visible || !this.data.task || this.data.task.id !== id) return;
      this.setData({ task: assessmentTask(job) });
      if (pending(job)) {
        this._pollCount = (this._pollCount || 0) + 1;
        if (this._pollCount < 20) this._timer = setTimeout(() => this.poll(id), 3000);
        else this.setData({ error: '任务仍在处理中，可以稍后手动刷新。' });
      } else await this.load();
    } catch (error) {
      if (!this._destroyed && generation === this._pollGeneration && this.current(token) && this._visible) {
        if (error.status === 404) this.clearSelection();
        this.authError(error);
      }
    }
  },
  authError(error) {
    if (this._destroyed) return;
    if (!app().session.token()) this.clearPrivate();
    this.setData({ error: message(error), loggedIn: Boolean(app().session.token()) });
  },
  openJob(event) { return this.selectJob(event.currentTarget.dataset.id); },
  async selectJob(id) {
    if (this._destroyed || this.data.busy || !requireLogin()) return;
    this.clearSelection();
    const version = this._selectionVersion;
    const token = app().session.token();
    this.setData({ busy: true, imageOrigin: 'history', error: '' });
    try {
      const job = (await app().api.request('assessment-jobs/' + encodeURIComponent(id) + '/')).data;
      if (!this.current(token) || version !== this._selectionVersion) return;
      this.setData({ task: assessmentTask(job) });
      if (job.asset_id) {
        try {
          const imagePath = await app().api.download('uploads/' + encodeURIComponent(job.asset_id) + '/content/?variant=thumbnail');
          if (!this.current(token) || version !== this._selectionVersion) return;
          this.setData({ imagePath });
        } catch (error) {
          if (!this.current(token) || version !== this._selectionVersion) return;
          this.setData({ imageUnavailable: '照片已过期、删除或暂不可访问，观察记录仍可查看。' });
        }
      }
      if (this.current(token) && version === this._selectionVersion && pending(job)) { this._pollCount = 0; this.poll(id); }
    } catch (error) { if (this.current(token) && version === this._selectionVersion) this.authError(error); }
    finally { if (!this._destroyed && version === this._selectionVersion && app().session.token() === token) this.setData({ busy: false }); }
  },
  remove(event) {
    if (this._destroyed || this.data.busy || !requireLogin()) return;
    const id = event.currentTarget.dataset.id;
    const token = app().session.token();
    wx.showModal({ title: '删除河道观察记录', content: '删除这条个人记录、关联图片、可选位置和关联的 AI 解读会话，无法恢复。', confirmText: '删除', confirmColor: '#a25e4a', success: async (result) => {
      if (!result.confirm || !this.current(token)) return;
      this.setData({ busy: true });
      this.stopPolling();
      try {
        await app().api.request('assessment-jobs/' + encodeURIComponent(id) + '/', { method: 'DELETE' });
        if (!this.current(token)) return;
        if (this.data.task && this.data.task.id === id) this.clearSelection();
        await this.load();
      } catch (error) { if (this.current(token)) this.authError(error); }
      finally { if (!this._destroyed && app().session.token() === token) this.setData({ busy: false }); }
    } });
  },
  changeWater(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    if (Number.isInteger(index) && this.data.waterBodies[index]) this.setData({ waterIndex: index });
  },
  locate() {
    if (this._destroyed || this.data.busy || this.data.locating || !requireLogin()) return;
    const token = app().session.token();
    const version = this._locationVersion = (this._locationVersion || 0) + 1;
    this.setData({ locating: true, nearby: null, location: null, locationNotice: '' });
    wx.getLocation({ type: 'gcj02', success: async (position) => {
      if (!this.current(token) || version !== this._locationVersion) return;
      const latitude = position.latitude, longitude = position.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        this.setData({ locating: false, locationNotice: '未取得有效位置，仍可手选水体或直接上传。' }); return;
      }
      const location = { latitude, longitude, coordinate_system: 'GCJ02' };
      this.setData({ location, locationNotice: '已取得本次可选位置；上传时会保存到仅本人可见的记录。' });
      try {
        const response = await app().api.request('nearby-water-bodies/', { data: location });
        if (!this.current(token) || version !== this._locationVersion) return;
        this.setData({ nearby: response.data && response.data.match || null, locationNotice: response.data && response.data.match ? '找到一个候选水体，请自行确认；不代表到访认证。' : '没有同坐标系的附近候选，仍可手选水体或直接上传。' });
      } catch (error) { if (this.current(token) && version === this._locationVersion) this.setData({ locationNotice: '附近水体查询暂不可用，仍可手选水体或直接上传。' }); }
      finally { if (!this._destroyed && version === this._locationVersion && app().session.token() === token) this.setData({ locating: false }); }
    }, fail: () => {
      if (this.current(token) && version === this._locationVersion) this.setData({ locating: false, location: null, locationNotice: '未授权或未取得位置，仍可手选水体或直接上传。' });
    } });
  },
  acceptNearby() {
    const match = this.data.nearby;
    if (!match || this.data.busy) return;
    const waterBodies = this.data.waterBodies.slice();
    let index = waterBodies.findIndex((item) => item.id === match.water_body_id);
    if (index < 0) { index = waterBodies.length; waterBodies.push({ id: match.water_body_id, name: match.water_body_name }); }
    this.setData({ waterBodies, waterIndex: index, nearby: null });
  },
  clearLocation() {
    if (this.data.busy) return;
    this._locationVersion = (this._locationVersion || 0) + 1;
    this.setData({ location: null, nearby: null, locating: false, locationNotice: '本次不保存位置；手选水体关联仍可独立修改。' });
  },
  imageLoaded() { if (!this._destroyed) this.setData({ imageReady: true }); },
  imageError() { if (!this._destroyed) this.setData({ imageReady: false, imageUnavailable: '图片暂时无法显示，观察记录仍可查看。' }); },
  refreshTask() { this._pollCount = 0; return this.data.task ? this.poll(this.data.task.id) : this.load(); },
  allRecords() { wx.navigateTo({ url: '/pages/records/index?kind=assessment-jobs' }); },
  openAI() {
    if (this._destroyed || !this._visible || this.data.busy || !this.data.task || this.data.task.status !== 'succeeded' || this._sessionToken !== app().session.token() || !requireLogin()) return;
    wx.navigateTo({ url: '/pages/llm/index?kind=assessment&jobId=' + encodeURIComponent(this.data.task.id) });
  },
  login() { wx.switchTab({ url: '/pages/profile/index' }); },
  privacy() { wx.navigateTo({ url: '/pages/legal/index?kind=privacy' }); },
});
