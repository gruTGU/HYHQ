const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message, time } = require('../../lib/format');
const { requestId, UUID } = require('../../lib/community');
const categories = [{ value: 'green', name: '绿色生活' }, { value: 'plants', name: '植物知识' }, { value: 'water', name: '水资源保护' }, { value: 'travel', name: '生态智游' }];
const statuses = { draft: '私人草稿', checking: '原始反馈检查中', reviewing: '官方编辑内容检查中', pending: '等待编辑核实', rejected: '未通过', approved: '已采用 · 原稿仍为私密', withdrawn: '已撤回' };
const blank = () => ({ id: '', version: 0, title: '', body: '', source: '', category: 'green', status: 'draft', categoryIndex: 0 });
function view(row) {
  if (!row || !UUID.test(row.id || '') || !statuses[row.status] || !Number.isSafeInteger(row.version)) throw new Error('稿件格式无效，请刷新重试');
  return { ...row, status_label: statuses[row.status], time_label: time(row.updated_at || row.created_at), editable: ['draft', 'rejected', 'withdrawn'].includes(row.status), categoryIndex: Math.max(0, categories.findIndex(item => item.value === row.category)) };
}
Page(withTheme({
  data: { loading: false, busy: false, error: '', notice: '', loggedIn: false, enabled: false, reason: '', rows: [], next: null, editor: null, categories },
  onShow() {
    this._active = true;
    const token = app().session.token();
    if (this._token !== token) { this._token = token; this._saveRequest = null; this._submitRequest = null; this.setData({ rows: [], next: null, editor: null, notice: '' }); }
    this._version = (this._version || 0) + 1; this.setData({ loggedIn: Boolean(token), busy: false, loading: false, error: '' });
    return this.load();
  },
  onHide() { this._active = false; this._version = (this._version || 0) + 1; this._confirmation = null; },
  onUnload() { this.onHide(); this._token = ''; this._saveRequest = null; this._submitRequest = null; },
  valid(version) { return this._active && version === this._version && this._token === app().session.token(); },
  async operation(work) {
    if (!this._active || this.data.busy || this._confirmation) return;
    if (!this._token || this._token !== app().session.token()) { this.setData({ editor: null, rows: [], loggedIn: false, error: '请先登录后再使用资料反馈' }); return; }
    const version = this._version = (this._version || 0) + 1; this.setData({ busy: true, error: '', notice: '' });
    const check = () => { if (!this.valid(version)) throw new Error('页面状态已变化'); };
    try { const result = await work(check); check(); return result; }
    catch (error) {
      if (this.valid(version)) {
        const expired = error.status === 401;
        if (expired && app().session.token() === this._token) app().session.clear();
        this.setData({ error: message(error), ...(expired ? { editor: null, rows: [], loggedIn: false } : {}), ...(error.code === 'COMMUNITY_DISABLED' ? { enabled: false } : {}) });
      } else if (this._active && this._token !== app().session.token()) this.setData({ editor: null, rows: [], loggedIn: false, error: '登录已变化，请重新打开页面' });
    } finally { if (this._active && this._version === version) this.setData({ busy: false, loading: false }); }
  },
  async load() {
    if (!this._token || !this._active) return;
    const result = await this.operation(async check => {
      const [status, records] = await Promise.all([app().api.request('community/status/'), app().api.request('community/submissions/')]); check();
      return { status: status.data, rows: records.data.map(view), next: records.meta && records.meta.next || null };
    });
    if (result) this.setData({ enabled: result.status.submissions_enabled === true, reason: result.status.reason || '', rows: result.rows, next: result.next });
  },
  async more() {
    const next = this.data.next;
    if (!next) return;
    if (!/^\/api\/v1\/community\/submissions\/\?page=\d+(?:&page_size=\d+)?$/.test(next)) { this.setData({ error: '分页地址无效，请刷新' }); return; }
    const result = await this.operation(() => app().api.request(next));
    if (result) { const records = new Map(this.data.rows.map(row => [row.id, row])); result.data.map(view).forEach(row => records.set(row.id, row)); this.setData({ rows: [...records.values()], next: result.meta && result.meta.next || null }); }
  },
  create() { if (!this._active || this.data.busy || !this.data.loggedIn) return; this._saveRequest = null; this._submitRequest = null; this.setData({ editor: blank(), notice: '', error: '' }); },
  async edit(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.rows.some(row => row.id === id)) return;
    const result = await this.operation(() => app().api.request('community/submissions/' + id + '/'));
    if (result) { this._saveRequest = null; this._submitRequest = null; this.setData({ editor: view(result.data) }); }
  },
  field(event) {
    if (!this._active || this.data.busy || !this.data.editor || !['draft', 'rejected', 'withdrawn'].includes(this.data.editor.status)) return;
    const field = event.currentTarget.dataset.field;
    if (!['title', 'body', 'source'].includes(field)) return;
    this.setData({ editor: { ...this.data.editor, [field]: event.detail.value }, notice: '' });
  },
  category(event) { const item = categories[Number(event.detail.value)]; if (this._active && !this.data.busy && this.data.editor && item && ['draft', 'rejected', 'withdrawn'].includes(this.data.editor.status)) this.setData({ editor: { ...this.data.editor, category: item.value, categoryIndex: Number(event.detail.value) } }); },
  async save() {
    const editor = this.data.editor;
    if (!editor || !['draft', 'rejected', 'withdrawn'].includes(editor.status)) return;
    const payload = { title: editor.title.trim(), body: editor.body.trim(), category: editor.category, source: editor.source.trim() };
    if ([...payload.title].length > 80 || [...payload.body].length > 2000 || [...payload.source].length > 300) { this.setData({ error: '标题最多80字，正文最多2000字，来源最多300字' }); return; }
    const fingerprint = JSON.stringify(payload);
    if (!editor.id && (!this._saveRequest || this._saveRequest.fingerprint !== fingerprint)) this._saveRequest = { fingerprint, request_id: requestId() };
    const result = await this.operation(() => app().api.request('community/submissions/' + (editor.id ? editor.id + '/' : ''), { method: editor.id ? 'PATCH' : 'POST', data: { ...payload, ...(editor.id ? { expected_version: editor.version } : { request_id: this._saveRequest.request_id }) } }));
    if (result) { const row = view(result.data); this.setData({ editor: row, rows: [row, ...this.data.rows.filter(item => item.id !== row.id)], notice: '私人草稿已保存' }); this._saveRequest = null; this._submitRequest = null; }
  },
  async submit() {
    const editor = this.data.editor;
    if (!this.data.enabled || !editor || !editor.id || !['draft', 'rejected', 'withdrawn'].includes(editor.status)) return;
    if (!editor.title.trim() || !editor.body.trim()) { this.setData({ error: '请填写标题和正文并先保存草稿' }); return; }
    const saved = this.data.rows.find(item => item.id === editor.id);
    if (!saved || ['title', 'body', 'source', 'category'].some(key => saved[key] !== editor[key])) { this.setData({ error: '请先保存当前修改，再提交审核' }); return; }
    const fingerprint = editor.id + ':' + editor.version;
    if (!this._submitRequest || this._submitRequest.fingerprint !== fingerprint) this._submitRequest = { fingerprint, request_id: requestId() };
    const result = await this.operation(() => app().api.request('community/submissions/' + editor.id + '/submit/', { method: 'POST', data: { request_id: this._submitRequest.request_id, expected_version: editor.version } }));
    if (result) { const row = view(result.data); this.setData({ editor: row, rows: [row, ...this.data.rows.filter(item => item.id !== row.id)], notice: row.status === 'pending' ? '已提交给编辑核实；原始反馈不会公开，编辑后内容须再次审核' : ['checking', 'reviewing'].includes(row.status) ? '内容检查中，请稍后刷新核对' : row.review_reason || '内容检查未通过' }); this._submitRequest = null; }
  },
  async action(event) {
    const editor = this.data.editor, remove = event.currentTarget.dataset.action === 'delete';
    if (!editor || !editor.id || this.data.busy || !this._active || this._confirmation) return;
    const marker = { version: this._version, token: this._token }; this._confirmation = marker;
    const yes = await new Promise(resolve => wx.showModal({ title: remove ? '删除这份反馈？' : '撤回这份反馈？', content: remove ? '删除后无法恢复；由这份反馈形成的官方文章会一并撤下。' : '撤回后回到私人草稿，关联官方文章会撤下；可修改后重新提交。', success: r => resolve(r.confirm), fail: () => resolve(false) }));
    if (this._confirmation !== marker) return; this._confirmation = null;
    if (!yes || !this.valid(marker.version)) return;
    const result = await this.operation(() => app().api.request('community/submissions/' + editor.id + '/' + (remove ? '' : 'withdraw/'), { method: remove ? 'DELETE' : 'POST', data: { expected_version: editor.version } }));
    if (result) { this.setData({ editor: null }); await this.load(); }
  },
  closeEditor() { if (this._active && !this.data.busy) this.setData({ editor: null }); },
  login() { if (this._active) wx.switchTab({ url: '/pages/profile/index' }); },
}));
