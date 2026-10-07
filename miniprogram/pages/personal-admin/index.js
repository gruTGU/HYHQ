const { withTheme } = require('../../lib/theme');
const { app } = require('../../lib/page');
const { message, time } = require('../../lib/format');
const editable = ['contents', 'routes', 'places'];
const tabs = ['stats', ...editable, 'feedback', 'audit', 'maintenance', 'submissions', 'comments', 'reports'];
const communityTabs = ['submissions', 'comments', 'reports'];
const communityStatus = { checking: '安全检查中', pending: '待审核', approved: '已公开', rejected: '未通过', resolved: '已处理', dismissed: '不予受理' };
const auditNames = { community_submitted: '提交社区内容', community_approved: '审核通过', community_rejected: '审核驳回或下架', community_deleted: '删除社区内容', community_withdrawn: '撤回投稿', community_reported: '提交举报', community_report_handled: '处理举报', community_safety_verified: '内容检查联通核验', catalog_created: '新增资料', catalog_updated: '修改资料', catalog_withdrawn: '撤下资料', feedback_resolved: '处理反馈', retention_updated: '修改保留策略', simulation_withdrawn: '维护模拟批次' };
const kindNames = { sessions: '登录会话', uploads: '上传任务', upload_chunks: '上传临时块', assets: '私人图片', storage_cleanup: '存储清理任务', llm_sessions: 'AI 会话', llm_turns: 'AI 对话', recognition_jobs: '图像识别记录', assessment_jobs: '河湖评估记录', asset_usage: '上传用量记录', llm_owners: 'AI 账户状态', llm_ledger: 'AI 用量账本', llm_quotas: 'AI 额度记录', llm_days: 'AI 每日用量', upload_budget: '上传预算记录', inference_daily: '识别每日用量', weather_requests: '天气请求记录', auth_gates: '登录频率记录' };
function cleared() { return { allowed: false, rows: [], next: null, editor: null, revision: 0, cleanup: null, retention: null, maintenance: null, metricGroups: [], countingNote: '', asOf: '', notice: '' }; }
function cards(data) {
  const catalog = data.public_catalog || {}, jobs = data.jobs || {}, feedback = data.feedback || {}, llm = data.llm_today || {}, weather = data.weather_budget || {};
  return [
    { title: '使用与内容', items: [{ label: '启用账号', value: data.users_active || 0 }, { label: '公开科普', value: catalog.contents || 0 }, { label: '漫步路线', value: catalog.routes || 0 }, { label: '公开地点', value: catalog.places || 0 }, { label: '待处理反馈', value: feedback.pending || 0 }, { label: '已处理反馈', value: feedback.resolved || 0 }] },
    { title: '识别与科普模拟', items: [{ label: '可见图像识别记录', value: jobs.recognition_jobs && jobs.recognition_jobs.visible_total || 0 }, { label: '可见河湖评估记录', value: jobs.assessment_jobs && jobs.assessment_jobs.visible_total || 0 }, { label: '模拟批次', value: catalog.simulation_runs || 0 }, { label: '公开观测记录', value: catalog.observations || 0 }] },
    { title: '今日 AI 用量', items: [{ label: '请求预约次数', value: llm.attempts || 0 }, { label: '已记账词元', value: llm.accounted_tokens || 0 }, { label: '尚在预约的词元', value: llm.reserved_tokens || 0 }] },
    { title: '天气请求预算', items: [{ label: '本月已预约请求', value: weather.calendar_month_requests || 0 }, { label: '最近31天请求', value: weather.rolling_31_days_requests || 0 }, { label: '此环境请求上限', value: weather.environment_limit || 0 }] },
  ];
}
function rowView(row, tab) {
  return { ...row, title_label: communityTabs.includes(tab) ? row.title || (tab === 'comments' ? '用户评论' : '用户举报') : editable.includes(tab) ? row.title || row.name : tab === 'feedback' ? '用户反馈' : auditNames[row.action] || '管理操作',
    status_label: communityTabs.includes(tab) ? communityStatus[row.status] || row.status : tab === 'feedback' ? row.status === 'resolved' ? '已处理' : '待处理' : editable.includes(tab) ? row.deleted ? '已撤下' : row.published ? '已发布' : '草稿' : '',
    time_label: time(row.created_at || row.updated_at), detail_label: tab === 'audit' ? (row.target_id ? '资料编号：' + row.target_id : '批量维护') : '',
    fields_label: (row.changed_fields || []).join('、') };
}
function maintenanceView(value) {
  const policy = value.policy || {};
  return { ...value, kind_options: [{ key: '', label: '自动轮换下一类' }, ...(value.kinds || []).map(key => ({ key, label: kindNames[key] || '维护记录' }))],
    recent: (value.recent || []).map(row => ({ ...row, kind_label: kindNames[row.kind] || '维护记录', time_label: time(row.finished_at) })),
    policy_cards: [{ label: '原图保留', value: (policy.original_hours || 24) + ' 小时' }, { label: '识别缩略图保留', value: (policy.recognition_thumbnail_days || 30) + ' 天' },
      { label: '用量账本保留', value: (policy.accounting_days || 90) + ' 天' }, { label: '单批上限', value: (policy.max_batch_size || 20) + ' 条' }],
    timer_label: value.timer_verified_at ? time(value.timer_verified_at) : '', kind_index: 0, limit: '10' };
}
Page(withTheme({
  data: { loading: true, busy: false, error: '', tab: 'stats', ...cleared() },
  onShow() { this._active = true; this._version = (this._version || 0) + 1; this._token = app().session.token(); this._confirmation = null; this.setData({ ...cleared(), loading: true, busy: false, error: '' }); return this.load(); },
  onHide() { this._active = false; this._version = (this._version || 0) + 1; this._confirmation = null; this.setData({ ...cleared(), loading: false, busy: false, error: '' }); },
  onUnload() { this.onHide(); },
  valid(version) { return this._active && version === this._version && this._token === app().session.token(); },
  async operation(work) {
    if (!this._active || this.data.busy || this._confirmation) return;
    if (this._token !== app().session.token()) { this.setData({ ...cleared(), error: '登录状态已变化，请重新打开管理页', busy: false, loading: false }); return; }
    const version = this._version = (this._version || 0) + 1;
    const check = () => { if (!this.valid(version)) throw Object.assign(new Error('登录状态已变化'), { code: 'STALE_VIEW' }); };
    this.setData({ busy: true, error: '', notice: '' });
    try {
      if (app().config.transport !== 'cloud-function' || !this._token) throw Object.assign(new Error('请使用已授权的云开发版管理账号'), { code: 'FORBIDDEN' });
      const data = await work(check); check(); return data;
    } catch (error) {
      if (this.valid(version)) {
        const denied = [401, 403].includes(error.status) || ['AUTH_REQUIRED', 'NOT_AUTHENTICATED', 'FORBIDDEN', 'MANAGEMENT_DISABLED'].includes(error.code);
        this.setData({ ...(denied ? cleared() : {}), error: error.code === 'ADMIN_REVISION_CHANGED' || error.code === 'PREVIEW_CHANGED'
          ? '管理内容已更新，请刷新后核对再操作；当前编辑内容尚未保存。' : message(error) });
      } else if (this._active && this._version === version) this.setData({ ...cleared(), error: '登录状态已变化，请重新打开管理页', busy: false, loading: false });
    } finally { if (this.valid(version)) this.setData({ loading: false, busy: false }); }
  },
  async load() {
    if (!this._active || this.data.busy || this._confirmation) return;
    const tab = this.data.tab;
    const result = await this.operation(async check => {
      const status = (await app().api.request('personal-admin/status/')).data; check();
      if (!status.enabled) throw Object.assign(new Error('当前账号未开通管理权限'), { code: 'FORBIDDEN' });
      const path = tab === 'stats' ? 'personal-admin/stats/' : editable.includes(tab) ? 'personal-admin/catalog/' + tab + '/' : tab === 'maintenance' ? 'management/maintenance/' : communityTabs.includes(tab) ? 'personal-admin/community/' + tab + '/' : 'personal-admin/' + tab + '/';
      const result = await app().api.request(path); check();
      const retention = tab === 'maintenance' ? (await app().api.request('personal-admin/simulation/retention/')).data : null; check();
      return { status, result, retention };
    });
    if (!result) return;
    const data = result.result.data;
    this.setData({ allowed: true, revision: result.retention ? result.retention.revision : result.result.meta && result.result.meta.revision !== undefined ? result.result.meta.revision : result.status.revision,
      rows: Array.isArray(data) ? data.map(row => rowView(row, tab)) : [], next: result.result.meta && result.result.meta.next || null,
      metricGroups: tab === 'stats' ? cards(data) : [], countingNote: tab === 'stats' ? data.counting_note : '', asOf: tab === 'stats' ? time(data.as_of) : '',
      maintenance: tab === 'maintenance' ? maintenanceView(data) : null, retention: result.retention, editor: null, cleanup: null });
  },
  tab(event) { if (!this._active || this.data.busy || this._confirmation) return; const tab = event.currentTarget.dataset.tab; if (!tabs.includes(tab)) return; this.setData({ ...cleared(), tab }); return this.load(); },
  async more() {
    if (!this.data.next) return;
    const tab = this.data.tab, prefix = '/api/v1/personal-admin/' + (editable.includes(tab) ? 'catalog/' + tab : communityTabs.includes(tab) ? 'community/' + tab : tab) + '/?';
    if (!this.data.next.startsWith(prefix)) { this.setData({ error: '分页地址无效，请刷新列表' }); return; }
    const result = await this.operation(() => app().api.request(this.data.next));
    if (result) { const rows = new Map(this.data.rows.map(row => [row.id, row])); for (const row of result.data) rows.set(row.id, rowView(row, tab)); this.setData({ rows: [...rows.values()], next: result.meta && result.meta.next || null }); }
  },
  async edit(event) {
    const id = event.currentTarget.dataset.id;
    if (!editable.includes(this.data.tab)) return;
    const result = await this.operation(() => app().api.request('personal-admin/catalog/' + this.data.tab + '/' + id + '/'));
    if (!result) return;
    const value = result.data.value; this.setData({ revision: result.data.revision, editor: { id, title: value.title || value.name || '', summary: this.data.tab === 'contents' ? value.summary || '' : value.description || '', body: value.body || '', source: value.source || value.source_note || '', published: result.data.published, deleted: result.data.deleted } });
  },
  field(event) { const field = event.currentTarget.dataset.field; if (this._active && this.data.editor && !this.data.busy && ['title', 'summary', 'body', 'source'].includes(field)) this.setData({ ['editor.' + field]: event.detail.value }); },
  async save(event) {
    if (!this.data.editor) return;
    const editor = this.data.editor, kind = this.data.tab;
    const value = kind === 'places' ? { name: editor.title, description: editor.summary, source_note: editor.source }
      : kind === 'routes' ? { title: editor.title, description: editor.summary, source: editor.source } : { title: editor.title, summary: editor.summary, body: editor.body, source: editor.source };
    const publish = event && event.currentTarget && event.currentTarget.dataset.publish === 'true';
    const result = await this.operation(() => app().api.request('personal-admin/catalog/' + kind + '/' + editor.id + '/', { method: 'PATCH', data: { value, ...(publish ? { publish: true } : {}), expected_revision: this.data.revision } }));
    if (result) return this.load();
  },
  async confirm(options) {
    if (!this._active || this.data.busy || this._confirmation) return null;
    const marker = { version: this._version, token: this._token }; this._confirmation = marker;
    const result = await new Promise(resolve => wx.showModal({ ...options, success: resolve, fail: () => resolve({ confirm: false }) }));
    if (this._confirmation !== marker) return null;
    this._confirmation = null;
    return result.confirm && this.valid(marker.version) && marker.token ? result : null;
  },
  async withdraw() {
    if (!this.data.editor) return;
    const id = this.data.editor.id, kind = this.data.tab, revision = this.data.revision;
    const confirm = await this.confirm({ title: '撤下这份资料', content: '撤下后，用户与 AI 将不再引用此资料。操作会记入审计。' });
    if (!confirm) return;
    const result = await this.operation(() => app().api.request('personal-admin/catalog/' + kind + '/' + id + '/', { method: 'DELETE', data: { expected_revision: revision } }));
    if (result) return this.load();
  },
  async reviewCommunity(event) {
    const { id, decision } = event.currentTarget.dataset, tab = this.data.tab;
    const row = this.data.rows.find(item => item.id === id);
    if (!communityTabs.includes(tab) || !row) return;
    const report = tab === 'reports';
    if (!(report ? ['resolved', 'dismissed'] : ['approved', 'rejected']).includes(decision)) return;
    const confirmed = await this.confirm({ title: report ? '处理举报' : decision === 'approved' ? '通过并公开内容' : '驳回或撤下内容',
      content: report ? '处理结果将记入审计。举报处理不会自动删除被举报内容，请先核对。' : decision === 'approved' ? '已核对正文与来源，确认适合公开。安全检查或业务资格不满足时，服务端仍会拒绝公开。' : '填写可向投稿者展示的原因，不填写他人隐私。',
      editable: !report && decision === 'rejected', placeholderText: '审核原因' });
    if (!confirmed || (!report && decision === 'rejected' && !(confirmed.content || '').trim())) return;
    const result = await this.operation(() => app().api.request('personal-admin/community/' + tab + '/' + id + '/review/', { method: 'POST', data: {
      decision, expected_version: row.version, ...(!report ? { reason: decision === 'rejected' ? confirmed.content.trim() : '' } : {}) } }));
    if (result) return this.load();
  },
  async resolveFeedback(event) {
    const id = event.currentTarget.dataset.id, revision = this.data.revision;
    const result = await this.confirm({ title: '答复用户反馈', editable: true, placeholderText: '填写答复内容' });
    if (!result || !result.content || !result.content.trim()) return;
    const saved = await this.operation(() => app().api.request('personal-admin/feedback/' + id + '/resolve/', { method: 'POST', data: { reply: result.content.trim(), expected_revision: revision } }));
    if (saved) return this.load();
  },
  retentionField(event) { const field = event.currentTarget.dataset.field; if (this._active && this.data.retention && !this.data.busy && ['retain_days', 'keep_successful'].includes(field)) this.setData({ ['retention.' + field]: event.detail.value }); },
  async saveRetention() {
    if (!this.data.retention) return;
    const retain = Number(this.data.retention.retain_days), keep = Number(this.data.retention.keep_successful);
    if (!Number.isInteger(retain) || retain < 30 || retain > 3650 || !Number.isInteger(keep) || keep < 1 || keep > 100) { this.setData({ error: '保留天数填写30至3650；每来源/场景保留批次填写1至100。' }); return; }
    const result = await this.operation(() => app().api.request('personal-admin/simulation/retention/', { method: 'PUT', data: { retain_days: retain, keep_successful: keep, expected_revision: this.data.revision } }));
    if (result) this.setData({ retention: result.data, revision: result.data.revision, cleanup: null, notice: '保留策略已保存，请重新预览维护范围。' });
  },
  async previewCleanup() { const result = await this.operation(() => app().api.request('personal-admin/simulation/cleanup-preview/')); if (result) this.setData({ cleanup: result.data, revision: result.data.revision }); },
  async cleanup() {
    const preview = this.data.cleanup;
    if (!preview || !preview.selected_run_count) return;
    const result = await this.confirm({ title: '维护模拟批次', content: '将撤下预览中的 ' + preview.selected_run_count + ' 批科普模拟数据；最新批次与真实来源会保留。源码快照占用不会因此减少。' });
    if (!result) return;
    const saved = await this.operation(() => app().api.request('personal-admin/simulation/cleanup/', { method: 'POST', data: { fingerprint: preview.fingerprint, expected_revision: preview.revision } }));
    if (saved) { const token = this._token; this.setData({ cleanup: null, revision: saved.data.revision }); await this.previewCleanup(); if (this._active && token === this._token && token === app().session.token() && this.data.allowed) this.setData({ notice: '已完成模拟批次维护。' }); }
  },
  maintenanceKind(event) { if (this._active && this.data.maintenance && !this.data.busy) this.setData({ 'maintenance.kind_index': Number(event.detail.value) }); },
  maintenanceLimit(event) { if (this._active && this.data.maintenance && !this.data.busy) this.setData({ 'maintenance.limit': event.detail.value }); },
  async runMaintenance() {
    const maintenance = this.data.maintenance;
    if (!maintenance || maintenance.running) return;
    const limit = Number(maintenance.limit), selected = maintenance.kind_options[maintenance.kind_index];
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !selected) { this.setData({ error: '每批维护数量须为1至20条。' }); return; }
    const confirmation = await this.confirm({ title: '执行到期数据维护', content: '仅处理已到期或待删除的数据，按既定保留规则执行。本次最多检查 ' + limit + ' 条。' });
    if (!confirmation) return;
    const result = await this.operation(() => app().api.request('management/maintenance/', { method: 'POST', data: { limit, ...(selected.key ? { kind: selected.key } : {}) } }));
    if (result) { const row = result.data, token = this._token; await this.load(); if (this._active && token === this._token && token === app().session.token() && this.data.allowed) this.setData({ notice: '本批检查 ' + row.scanned + ' 条，清理 ' + row.removed + ' 条，失败 ' + row.failed + ' 条。' }); }
  },
}));
