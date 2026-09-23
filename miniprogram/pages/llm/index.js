const { app } = require('../../lib/page');
const { message, task } = require('../../lib/format');
const { assessmentTask } = require('../../lib/assessment');
const { loadAll, selectRegion } = require('../../lib/region');
const { DISCLAIMER, SOURCE_LABELS, SCOPE_LABELS, publicSource, modelLabel, pending, turnView, sessionView, readPage, requestId } = require('../../lib/llm');
Page({
  data: { loading: true, busy: false, loggedIn: false, error: '', actionError: '', unavailable: false, status: null, modelLabel: 'DeepSeek Flash', scopeLabel: '识别解读', session: null, source: null, sourceLoading: false, sourceError: '', sourceKind: '', isRecognition: true, includeImage: false, question: '', questionCount: 0, turns: [], next: '', loadingMore: false, moreError: '', polling: false, pollNotice: '', hasPending: false, displayTurns: [], contextExpanded: false, keyboardHeight: 0, composerHeight: 0, disclaimer: DISCLAIMER },
  onLoad(options) {
    this._alive = true; this._scope = 'recognition'; this._followLatest = true;
    if (options && options.sessionId) this._sessionId = options.sessionId;
    else if (options && ['recognition', 'assessment'].includes(options.kind) && options.jobId) { this._sourceKind = options.kind; this._sourceId = options.jobId; }
    else if (options && publicSource(options.scope, options.source_type, options.source_id)) { this._scope = options.scope; this._sourceType = options.source_type; this._sourceId = options.source_id; }
    else this._invalid = true;
    this.setData({ isRecognition: this._scope === 'recognition', scopeLabel: SCOPE_LABELS[this._scope] });
  },
  async onShow() {
    this._visible = true;
    const shown = this._showVersion = (this._showVersion || 0) + 1;
    if (this._mutation && this._mutation.token === app().session.token()) {
      this.setData({ loading: true }); await this._mutation.promise;
      if (!this.active() || shown !== this._showVersion) return;
    }
    return this.load();
  },
  onHide() { this._visible = false; this.invalidate(); this.clearView(); },
  onUnload() { this._alive = false; this.invalidate(); },
  active() { return this._alive !== false && this._visible !== false; },
  invalidate() { this._generation = (this._generation || 0) + 1; this._showVersion = (this._showVersion || 0) + 1; this.stopTimer(); },
  stopTimer() { this._pollVersion = (this._pollVersion || 0) + 1; if (this._timer) clearTimeout(this._timer); this._timer = null; },
  clearView() { this.setData({ source: null, sourceLoading: false, sourceError: '', session: null, turns: [], displayTurns: [], contextExpanded: false, keyboardHeight: 0, composerHeight: 0, next: '', question: '', questionCount: 0, includeImage: false, busy: false, loading: false, loadingMore: false, polling: false, hasPending: false, actionError: '', pollNotice: '' }); },
  hasMutation() { return !!(this._mutation && this._mutation.token === app().session.token()); },
  current(generation, token) {
    if (!this.active() || generation !== this._generation) return false;
    if (app().session.token() === token) return true;
    this.invalidate(); this.clearView(); this.setData({ loggedIn: Boolean(app().session.token()), error: '登录状态已变化，请刷新当前会话。' }); wx.stopPullDownRefresh(); return false;
  },
  canAct() { return this.active() && !this.data.busy && !this.hasMutation() && this.current(this._generation, this._token) && !!app().session.token(); },
  login() { if (this.active()) wx.switchTab({ url: '/pages/profile/index' }); },
  history() { if (this.active()) wx.navigateTo({ url: '/pages/llm-history/index' }); },
  privacy() { if (this.active()) wx.navigateTo({ url: '/pages/legal/index?kind=privacy' }); },
  onPullDownRefresh() { if (this.hasMutation()) { wx.stopPullDownRefresh(); return; } return this.load(); },
  async load() {
    if (!this.active()) return;
    if (this.hasMutation()) { wx.stopPullDownRefresh(); return; }
    this.stopTimer();
    this._pollPaused = false;
    const generation = this._generation = (this._generation || 0) + 1, token = app().session.token();
    if (this._token !== token) { this.clearView(); this._retry = null; this._draft = null; }
    this._token = token;
    this.restoreDraft();
    this.setData({ loading: true, error: '', actionError: '', unavailable: false, loggedIn: Boolean(token), polling: false, pollNotice: '' });
    try {
      if (this._invalid) throw new Error('请从识别结果、生态导览或科普智游资料进入 AI。');
      await this.loadStatus(generation, token);
      if (!this.current(generation, token) || !token) return;
      if (this._sessionId) {
        const sessionId = this._sessionId;
        const result = await app().api.request('llm/sessions/' + encodeURIComponent(sessionId) + '/');
        if (!this.current(generation, token) || sessionId !== this._sessionId) return;
        const session = sessionView(result.data);
        if (session.id !== sessionId) throw new Error('返回的会话不匹配，请刷新核对。');
        this._scope = session.scope;
        this.setData({ session, source: null, sourceError: '', sourceKind: session.kind, isRecognition: session.is_recognition, scopeLabel: SCOPE_LABELS[session.scope], includeImage: session.include_image === true });
        if (!session.is_recognition) await this.loadSessionSource(session, generation, token);
        if (!this.current(generation, token) || this._sessionId !== session.id || this.data.unavailable) return;
        await this.loadTurns(false, generation, token);
      } else if (this._scope !== 'recognition') {
        const source = await this.loadPublicSource();
        if (!this.current(generation, token)) return;
        this.setData({ source, sourceKind: this._scope, isRecognition: false, scopeLabel: SCOPE_LABELS[this._scope] });
      } else {
        const endpoint = this._sourceKind === 'recognition' ? 'recognition-jobs/' : 'assessment-jobs/';
        const result = await app().api.request(endpoint + encodeURIComponent(this._sourceId) + '/');
        if (!this.current(generation, token)) return;
        const source = this._sourceKind === 'recognition' ? task(result.data) : assessmentTask(result.data);
        if (source.status !== 'succeeded') throw new Error('请在原任务完成并有可查看结果后使用 AI 解读。');
        this.setData({ source, sourceKind: this._sourceKind });
      }
    } catch (error) { if (this.current(generation, token)) this.handleError(error); }
    finally { if (this.current(generation, token)) { this.setData({ loading: false }, () => { if (this.current(generation, token)) this.measureComposer({ scroll: true }); }); wx.stopPullDownRefresh(); } }
  },
  async loadPublicSource(type = this._sourceType, id = this._sourceId) {
    let item;
    if (type === 'region' || type === 'water') item = (await loadAll(app().api, type === 'region' ? 'regions/' : 'water-bodies/')).find((row) => row.id === id);
    else item = (await app().api.request(({ place: 'places/', content: 'contents/', route: 'routes/', water: 'water-bodies/' })[type] + encodeURIComponent(id) + '/')).data;
    if (!item || item.id !== id) throw Object.assign(new Error('当前公开资料已不可用，请返回重新选择。'), { status: 404 });
    return { id: item.id, type, region: item.region || (type === 'region' ? item.id : ''), label: SOURCE_LABELS[type], title: item.title || item.name || SOURCE_LABELS[type], summary: item.summary || item.description || '结合当前公开资料回答；资料中的模拟内容会保留说明。' };
  },
  async loadSessionSource(session, generation, token) {
    const accepted = () => this.current(generation, token) && this._sessionId === session.id && this.data.session && this.data.session.id === session.id;
    if (!accepted()) return;
    this.setData({ sourceLoading: true, sourceError: '' });
    try {
      const source = await this.loadPublicSource(session.source_type, session.source_id);
      if (accepted()) this.setData({ source });
    } catch (error) {
      if (accepted()) {
        this.setData({ source: null, sourceError: '相关资料暂未加载：' + message(error) });
        if (error.status === 404) this.handleError(error);
      }
    } finally { if (accepted()) this.setData({ sourceLoading: false }); }
  },
  async loadStatus(generation = this._generation, token = this._token) {
    if (!this.current(generation, token)) return;
    this.setData({ status: null });
    const version = this._statusVersion = (this._statusVersion || 0) + 1;
    const response = await app().api.request('llm/status/', { data: { scope: this._scope || 'recognition' } });
    if (!this.current(generation, token) || version !== this._statusVersion) return;
    const status = response.data;
    if (!status || typeof status.enabled !== 'boolean') throw new Error('AI 服务状态返回异常，请刷新重试。');
    this.setData({ status, modelLabel: modelLabel(status.model) });
  },
  handleError(error) {
    if (error.status === 404) { this.stopTimer(); this.setData({ session: null, source: null, sourceLoading: false, sourceError: '', turns: [], displayTurns: [], next: '', unavailable: true, hasPending: false, polling: false }); }
    this.setData({ error: message(error) });
  },
  draftKey() { return this._sessionId ? 'session:' + this._sessionId : ['source', this._scope, this._sourceType || this._sourceKind, this._sourceId].join(':'); },
  restoreDraft() {
    const draft = this._draft;
    const question = draft && draft.token === this._token && draft.key === this.draftKey() ? draft.question : '';
    this.setData({ question, questionCount: Array.from(question.trim()).length });
  },
  setQuestion(question) {
    this._draft = { token: this._token, key: this.draftKey(), question };
    this.setData({ question, questionCount: Array.from(question.trim()).length }, () => this.measureComposer());
  },
  toggleContext() { if (this.active()) this.setData({ contextExpanded: !this.data.contextExpanded }); },
  onPageScroll(event) {
    const top = Number(event && event.scrollTop) || 0;
    if (this._scrollTop !== undefined && top < this._scrollTop - 24) this._followLatest = false;
    this._scrollTop = top;
  },
  scrollToLatest(force = false) {
    if (!this.active() || !this.data.session || (!force && !this._followLatest)) return;
    if (force) this._followLatest = true;
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#chat-latest', duration: 220 });
  },
  updateTurns(turns, scroll = false, anchor = '') {
    const generation = this._generation, token = this._token;
    this.setData({ turns, displayTurns: turns.slice().reverse(), hasPending: turns.some(pending) }, () => {
      if (!this.current(generation, token)) return;
      if (anchor && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#turn-' + anchor, duration: 0 });
      else this.measureComposer({ scroll });
    });
  },
  composerVisible() { return this.active() && !!this.data.session && this.data.loggedIn && !this.data.unavailable && !this.data.loading; },
  measureComposer({ scroll = false, force = false } = {}) {
    if (!this.composerVisible()) return;
    const generation = this._generation, token = this._token, sessionId = this.data.session.id;
    const version = this._composerVersion = (this._composerVersion || 0) + 1;
    // Measurements are asynchronous too: an older render must never affect a new
    // account, session, keyboard layout, or a page that has left the screen.
    const accepted = () => this.active() && generation === this._generation && token === this._token && token === app().session.token() && version === this._composerVersion && this.composerVisible() && this.data.session.id === sessionId;
    if (typeof wx.createSelectorQuery !== 'function') return;
    wx.createSelectorQuery().in(this).select('.composer').boundingClientRect().exec((rects) => {
      if (!accepted()) return;
      const height = rects && rects[0] && rects[0].height;
      if (!Number.isFinite(height) || height <= 0) return;
      const composerHeight = Math.ceil(height);
      const afterLayout = () => { if (accepted() && scroll) this.scrollToLatest(force); };
      if (composerHeight !== this.data.composerHeight) this.setData({ composerHeight }, afterLayout);
      else afterLayout();
    });
  },
  composerLineChanged() { this.measureComposer({ scroll: true }); },
  onResize() { this.measureComposer({ scroll: true }); },
  keyboardHeightChanged(event) {
    if (!this.active()) return;
    const height = Number(event && event.detail && event.detail.height);
    const generation = this._generation, token = this._token;
    this.setData({ keyboardHeight: Number.isFinite(height) ? Math.max(0, Math.min(height, 700)) : 0 }, () => {
      if (this.current(generation, token)) this.measureComposer({ scroll: true, force: true });
    });
  },
  inputBlur() {
    if (!this.active()) return;
    const generation = this._generation, token = this._token;
    this.setData({ keyboardHeight: 0 }, () => { if (this.current(generation, token)) this.measureComposer(); });
  },
  reuseQuestion(event) {
    if (!this.canAct() || this.data.hasPending) return;
    const turn = this.data.turns.find((row) => row.id === event.currentTarget.dataset.id && row.status === 'failed');
    if (!turn) return;
    if (this.data.question.trim() && this.data.question.trim() !== turn.question.trim()) {
      this.setData({ actionError: '输入框中还有未发送的问题，请先保留或清空后再编辑。' }, () => this.measureComposer()); return;
    }
    this.setQuestion(turn.question); this.setData({ actionError: '' }, () => this.measureComposer({ scroll: true, force: true }));
  },
  inputQuestion(event) { if (!this.canAct()) return; this.setQuestion(typeof event.detail.value === 'string' ? event.detail.value : ''); this.setData({ actionError: '' }, () => this.measureComposer()); },
  imageChange(event) { if (this.canAct() && this.data.isRecognition && !this.data.session) this.setData({ includeImage: event.detail.value === true }); },
  async mutate(work) {
    const mutation = { token: app().session.token() }; mutation.promise = new Promise((resolve) => { mutation.resolve = resolve; }); this._mutation = mutation;
    this.setData({ busy: true, actionError: '' });
    try { await work(mutation.token); }
    finally { if (this._mutation === mutation) this._mutation = null; mutation.resolve(); if (this.active() && this._token === mutation.token && app().session.token() === mutation.token) this.setData({ busy: false }, () => this.measureComposer({ scroll: true })); }
  },
  async createSession() {
    if (!this.canAct() || !this.data.source || !this.data.status || !this.data.status.enabled || this._sessionId) return;
    const draftKey = this.draftKey();
    const generation = this._generation, token = this._token, includeImage = this.data.isRecognition && this.data.includeImage;
    await this.mutate(async () => {
      try {
        const data = { scope: this._scope, include_image: includeImage };
        if (this._scope === 'recognition') data[this._sourceKind === 'recognition' ? 'recognition_job_id' : 'assessment_job_id'] = this._sourceId;
        else Object.assign(data, { source_type: this._sourceType, source_id: this._sourceId });
        const response = await app().api.request('llm/sessions/', { method: 'POST', data });
        const session = sessionView(response.data);
        // Remember a created session across hide, but never for another login.
        if (app().session.token() === token && this._alive !== false) {
          this._sessionId = session.id;
          if (this._draft && this._draft.token === token && this._draft.key === draftKey) this._draft.key = this.draftKey();
        }
        if (!this.current(generation, token)) return;
        const source = !session.is_recognition && this.data.source && this.data.source.id === session.source_id && this.data.source.type === session.source_type ? this.data.source : null;
        this.setData({ session, source, sourceError: '', turns: [], displayTurns: [], contextExpanded: false, next: '', actionError: '' });
        if (!session.is_recognition) await this.loadSessionSource(session, generation, token);
      } catch (error) { if (this.current(generation, token)) this.setData({ actionError: message(error) + (error.code === 'IMAGE_UNAVAILABLE' ? ' 可关闭附图，再建立仅文字结果的会话。' : error.status === 429 ? '' : ' 若结果未确认，可先去会话记录查看。') }); }
    });
  },
  async send() {
    if (!this.canAct() || !this.data.session || !this.data.status || !this.data.status.enabled || this.data.hasPending) return;
    const question = this.data.question.trim();
    if (!question || Array.from(question).length > 500) { this.setData({ actionError: '请填写 1 至 500 字的问题。' }, () => this.measureComposer()); return; }
    const generation = this._generation, token = this._token, sessionId = this._sessionId;
    const retry = this._retry && this._retry.question === question && this._retry.sessionId === sessionId ? this._retry : { question, sessionId, requestId: requestId() };
    this._retry = retry;
    await this.mutate(async () => {
      try {
        const response = await app().api.request('llm/sessions/' + encodeURIComponent(sessionId) + '/turns/', { method: 'POST', data: { question, request_id: retry.requestId } });
        const turn = turnView(response.data);
        if (turn.session_id !== sessionId) throw new Error('返回轮次不属于当前会话，请刷新核对。');
        // A confirmed send clears that submitted draft even if its page was hidden.
        if (app().session.token() === token && this._draft && this._draft.token === token && this._draft.key === 'session:' + sessionId && this._draft.question.trim() === question) this._draft = null;
        if (!this.current(generation, token)) return;
        this._retry = null; this.setQuestion('');
        this._followLatest = true;
        this.updateTurns([turn].concat(this.data.turns.filter((row) => row.id !== turn.id)), true);
        this.setData({ actionError: '' });
        if (pending(turn)) this.startPolling(turn.id);
      } catch (error) { if (this.current(generation, token)) { if (error.status === 404) this.handleError(error); this.setData({ actionError: error.code === 'LLM_DAILY_LIMIT' ? '本板块今日使用已达上限，请在北京时间零点后继续。' : message(error) + (error.status === 429 ? '' : ' 请先刷新核对是否已发送；重试同一问题不会重复提交。') }); } }
      finally { if (this.current(generation, token)) { try { await this.loadStatus(generation, token); } catch (error) { if (this.current(generation, token)) this.setData({ actionError: this.data.actionError || '服务状态暂不可确认，请刷新重试。' }); } } }
    });
  },
  async loadTurns(more = false, generation = this._generation, token = this._token) {
    if (!this.current(generation, token) || !this._sessionId || (more && (!this.data.next || this.data.loadingMore || this.hasMutation()))) return;
    const version = this._turnsVersion = (this._turnsVersion || 0) + 1;
    const endpoint = 'llm/sessions/' + encodeURIComponent(this._sessionId) + '/turns/', path = more ? this.data.next : endpoint;
    const seen = more ? new Set(this._seen || []) : new Set();
    this.setData({ loadingMore: more, moreError: '' });
    try {
      const response = await app().api.request(path, more ? undefined : { data: { page_size: 20 } });
      if (!this.current(generation, token) || version !== this._turnsVersion) return;
      const page = readPage(response, path, endpoint, seen), rows = page.items.map(turnView);
      if (rows.some((turn) => turn.session_id !== this._sessionId)) throw new Error('轮次记录不属于当前会话。');
      const turns = new Map((more ? this.data.turns : []).map((row) => [row.id, row])); rows.forEach((row) => turns.set(row.id, row));
      seen.add(page.key); this._seen = seen;
      const values = Array.from(turns.values());
      this.updateTurns(values, !more, more && this.data.displayTurns.length ? this.data.displayTurns[0].id : '');
      this.setData({ next: page.next });
      const active = values.find(pending); if (active && !this.data.polling && !this._pollPaused) this.startPolling(active.id);
    } catch (error) { if (this.current(generation, token) && version === this._turnsVersion) { if (error.status === 404) this.handleError(error); this.setData({ moreError: message(error) }); } }
    finally { if (this.current(generation, token) && version === this._turnsVersion) this.setData({ loadingMore: false }); }
  },
  more() { return this.loadTurns(true); },
  startPolling(id) {
    this.stopTimer(); if (!this.active()) return;
    this._pollPaused = false;
    this._pollCount = 0; this.setData({ polling: true, pollNotice: '' }); return this.poll(id, this._pollVersion, this._generation, this._token);
  },
  async poll(id, version, generation, token) {
    if (!this.current(generation, token) || version !== this._pollVersion) return;
    try {
      const response = await app().api.request('llm/turns/' + encodeURIComponent(id) + '/');
      if (!this.current(generation, token) || version !== this._pollVersion) return;
      const turn = turnView(response.data);
      if (turn.session_id !== this._sessionId || turn.id !== id) throw new Error('AI 轮次身份不一致，请刷新核对。');
      const turns = this.data.turns.map((row) => row.id === id ? turn : row);
      this.updateTurns(turns, !pending(turn));
      if (pending(turn)) {
        this._pollCount += 1;
        if (this._pollCount < 24) this._timer = setTimeout(() => this.poll(id, version, generation, token), 2500);
        else this.pausePolling('已暂停自动刷新，可稍后恢复；已提交的任务仍由服务端处理。');
      } else {
        this.stopTimer(); this.setData({ polling: false });
        const another = turns.find(pending); if (another) this.startPolling(another.id);
        try { await this.loadStatus(generation, token); } catch (error) { if (this.current(generation, token)) this.setData({ pollNotice: '解读已完成，服务状态暂不可确认，可稍后刷新。' }); }
      }
    } catch (error) { if (this.current(generation, token) && version === this._pollVersion) { if (error.status === 404) this.handleError(error); this.pausePolling(message(error) + ' 可手动刷新或恢复查询。'); } }
  },
  pausePolling(notice) { this.stopTimer(); this._pollPaused = true; if (this.active()) this.setData({ polling: false, pollNotice: typeof notice === 'string' ? notice : '已停止自动刷新；这不会取消已提交的 DeepSeek 请求。' }); },
  resumePolling() { if (this.canAct()) { const turn = this.data.turns.find(pending); if (turn) this.startPolling(turn.id); else return this.load(); } },
  original() {
    if (!this.canAct()) return;
    const session = this.data.session, kind = session ? session.kind : this._sourceKind;
    const scope = session ? session.scope : this._scope;
    if (scope !== 'recognition') {
      const type = session ? session.source_type : this._sourceType, id = session ? session.source_id : this._sourceId;
      if (!publicSource(scope, type, id)) return;
      if (type === 'region') {
        if (scope === 'learn') app().globalData.pendingKnowledgeFilter = { region: id };
        else selectRegion(app(), { id });
        wx.switchTab({ url: '/pages/' + scope + '/index' });
      } else if (type === 'water') wx.navigateTo({ url: '/pages/water/index?waterBodyId=' + encodeURIComponent(id) + ((session && session.source_region_id || this.data.source && this.data.source.region) ? '&region=' + encodeURIComponent(session && session.source_region_id || this.data.source.region) : '') });
      else wx.navigateTo({ url: '/pages/detail/index?kind=' + type + '&id=' + encodeURIComponent(id) });
      return;
    }
    const id = session ? (kind === 'recognition' ? session.recognition_job_id : session.assessment_job_id) : this._sourceId;
    if (!id) return;
    if (kind === 'recognition') { app().globalData.recognitionJobId = id; wx.switchTab({ url: '/pages/recognize/index' }); }
    else wx.navigateTo({ url: '/pages/assessment/index?jobId=' + encodeURIComponent(id) });
  },
});
