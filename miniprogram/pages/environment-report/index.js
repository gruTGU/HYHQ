const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message, time } = require('../../lib/format');
const references = require('../../lib/map-reference-points');
const present = row => ({ ...row, created_label: time(row.created_at), status_label: row.status === 'resolved' ? '管理员已回复 · 模拟上报' : '待管理员核对 · 模拟上报' });
const choices = [{ id: '', name: '手动填写观察地点' }].concat(['tianjin-nature', 'beijing-nature'].flatMap(slug => references.forRegion({ slug, is_demo: false })).map(row => ({ id: row.id, name: row.displayName || row.name })));
const officialSites = [{ id: 'tianjin', label: '天津生态环境局网站跳转', url: 'https://sthj.tj.gov.cn/' }, { id: 'beijing', label: '北京生态环境局网站跳转', url: 'https://sthjj.beijing.gov.cn/' }];
Page(withTheme({
  data: { loggedIn: false, loading: false, busy: false, error: '', notice: '', context: null, photo: '', description: '', locationText: '', choices, officialSites, locationIndex: 0, records: [], next: '' },
  onLoad(options = {}) { this._source = ['recognition', 'assessment'].includes(options.task_kind) && /^[a-f0-9-]{36}$/i.test(options.task_id || '') ? { task_kind: options.task_kind, task_id: options.task_id } : null; },
  onShow() {
    this._active = true;
    if (app().session.subscribe) this._unsubscribe = app().session.subscribe(() => { if (this._active) { this._version = (this._version || 0) + 1; this.setData({ context: null, photo: '', records: [], description: '', locationText: '', loggedIn: false, busy: false, loading: false, error: '登录状态已变化，请重新登录或刷新。' }); } });
    return this.load();
  },
  onHide() { if (this._unsubscribe) this._unsubscribe(); this._unsubscribe = null; this._active = false; this._version = (this._version || 0) + 1; this.setData({ context: null, photo: '', records: [], description: '', locationText: '', notice: '', busy: false, loggedIn: false }); },
  onUnload() { this.onHide(); },
  current(version, token) { return this._active && version === this._version && token === app().session.token(); },
  async load(more = false) {
    if (!this._active || this.data.busy) return;
    more = more === true;
    if (more && (!this.data.next || this.data.loading)) return;
    const token = this._token = app().session.token(), version = this._version = (this._version || 0) + 1;
    if (!token) { this.setData({ loggedIn: false, context: null, photo: '', records: [], loading: false }); return; }
    this.setData({ loggedIn: true, loading: true, error: '' });
    try {
      const path = more ? this.data.next : 'environment-reports/';
      if (more && !/^\/api\/v1\/environment-reports\/\?/.test(path)) throw new Error('分页地址无效，请刷新');
      const result = await app().api.request(path);
      if (!this.current(version, token)) return;
      const rows = new Map((more ? this.data.records : []).map(row => [row.id, row]));
      (result.data || []).map(present).forEach(row => rows.set(row.id, row));
      this.setData({ records: [...rows.values()], next: result.meta && result.meta.next || '' });
      if (!more && this._source) {
        const result = await app().api.request('environment-reports/context/', { data: this._source });
        if (!this.current(version, token)) return;
        this.setData({ context: result.data, locationText: this.data.locationText || result.data.location_hint || '' });
        try { const photo = await app().api.download(result.data.photo_url); if (this.current(version, token)) this.setData({ photo }); }
        catch (_) { if (this.current(version, token)) this.setData({ notice: '缩略图暂不可用，提交前请核对原识别记录。' }); }
      }
    } catch (error) { if (this.current(version, token)) this.setData({ error: message(error) }); }
    finally { if (this.current(version, token)) this.setData({ loading: false }); wx.stopPullDownRefresh(); }
  },
  field(event) { if (this._active && !this.data.busy && ['description', 'locationText'].includes(event.currentTarget.dataset.field)) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  location(event) { const index = Number(event.detail.value); if (this._active && !this.data.busy && choices[index]) this.setData({ locationIndex: index }); },
  async submit() {
    if (!this._active || this.data.busy || this.data.loading || !this.data.context || this.data.context.existing_report || !this._token || this._token !== app().session.token()) return;
    const description = this.data.description.trim(), place = choices[this.data.locationIndex];
    if (!description || Array.from(description).length > 1000 || !place || !place.id && !this.data.locationText.trim()) { this.setData({ error: '请填写观察地点与1至1000字的环境描述。' }); return; }
    const token = this._token, version = this._version;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const data = { ...this._source, description, ...(place.id ? { map_reference_id: place.id } : { location_text: this.data.locationText.trim() }) };
      const result = await app().api.request('environment-reports/', { method: 'POST', data });
      if (!this.current(version, token)) return;
      const row = present(result.data);
      this.setData({ 'context.existing_report': row, description: '', records: [row].concat(this.data.records.filter(item => item.id !== row.id)), notice: '模拟上报已保存至平台管理员队列。未发送政府部门或外部机构。' });
    } catch (error) { if (this.current(version, token)) this.setData({ error: message(error) + ' 如结果未确认，可刷新核对；同一识别记录不会重复创建上报。' }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  async photo(event) {
    const row = this.data.records.find(item => item.id === event.currentTarget.dataset.id);
    if (!row || !this._active || this.data.busy || this._token !== app().session.token()) return;
    const token = this._token, version = this._version; this.setData({ busy: true, error: '' });
    try { const photo = await app().api.download(row.photo_url); if (this.current(version, token)) wx.previewImage({ current: photo, urls: [photo] }); }
    catch (_) { if (this.current(version, token)) this.setData({ error: '照片已到期、已删除或暂不可读取；文字反馈仍可查看。' }); }
    finally { if (this.current(version, token)) this.setData({ busy: false }); }
  },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    if (!this._active || this.data.busy || !this.data.records.some(row => row.id === id) || this._token !== app().session.token()) return;
    const token = this._token, version = this._version; this.setData({ busy: true });
    wx.showModal({ title: '删除模拟上报', content: '删除此反馈及管理员答复。原识别记录仍可单独管理。', success: async result => {
      if (!this.current(version, token)) return;
      if (!result.confirm) { this.setData({ busy: false }); return; }
      try { await app().api.request('environment-reports/' + id + '/', { method: 'DELETE' }); if (this.current(version, token)) { this.setData({ busy: false }); await this.load(); } }
      catch (error) { if (this.current(version, token)) this.setData({ error: message(error), busy: false }); }
    }, fail: () => { if (this.current(version, token)) this.setData({ busy: false }); } });
  },
  login() { wx.switchTab({ url: '/pages/profile/index' }); },
  identify() { wx.switchTab({ url: '/pages/recognize/index' }); },
  copyOfficialSite(event) {
    const site = officialSites.find(row => row.id === (event.currentTarget.dataset || {}).id);
    if (!this._active || !site) return;
    wx.setClipboardData({ data: site.url,
      success: () => { if (this._active) this.setData({ notice: '官网链接已复制，可在浏览器中打开。未向有关部门发送照片或反馈。' }); },
      fail: () => { if (this._active) this.setData({ notice: '暂时无法复制，可长按下方网址选取。' }); },
    });
  },
  more() { return this.load(true); },
  onPullDownRefresh() { return this.load(); },
}));
