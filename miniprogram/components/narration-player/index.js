const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTUP_TIMEOUT_MS = 20000;
function clock(value) {
  const seconds = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
function validMetadata(value) {
  return value && UUID.test(value.id) && /^[0-9a-f]{64}$/.test(value.revision)
    && ['audio/mpeg', 'audio/mp4', 'audio/wav'].includes(value.mime_type)
    && value.audio_path === '/api/v1/narrations/' + value.id + '/audio/';
}

Component({
  properties: { kind: { type: String, value: '' }, targetId: { type: String, value: '' } },
  data: { narration: null, loading: false, playing: false, paused: false, error: '', elapsed: '0:00', duration: '0:00' },
  observers: { 'kind,targetId': function () { if (this._alive) this.load(); } },
  lifetimes: {
    attached() { this._alive = true; this._visible = true; this.load(); },
    detached() { this._alive = false; this._visible = false; this._generation = (this._generation || 0) + 1; this.release(); },
  },
  pageLifetimes: {
    hide() {
      this._visible = false;
      this._generation = (this._generation || 0) + 1;
      this.release();
      this.setData({ playing: false, paused: false, loading: false, elapsed: '0:00' });
    },
    show() { this._visible = true; if (this._alive) this.load(); },
  },
  methods: {
    clearStartup() {
      this._startupVersion = (this._startupVersion || 0) + 1;
      if (this._startupTimer !== undefined && this._startupTimer !== null) clearTimeout(this._startupTimer);
      this._startupTimer = null;
    },
    armStartup(audio, generation) {
      this.clearStartup();
      const version = this._startupVersion;
      this._startupTimer = setTimeout(() => {
        if (!this.current(generation) || this._audio !== audio || this._startupVersion !== version) return;
        this._startupTimer = null;
        this.failPlayback('语音启动超时，请检查网络后点重试。');
      }, STARTUP_TIMEOUT_MS);
    },
    release() {
      this.clearStartup();
      const audio = this._audio;
      this._audio = null;
      if (audio) {
        try { audio.stop(); } catch (error) { /* The platform may already have destroyed it. */ }
        try { audio.destroy(); } catch (error) { /* No retained player can resume in the background. */ }
      }
    },
    current(generation) { return this._alive && this._visible && generation === this._generation; },
    async metadata() {
      const kind = this.data.kind, id = this.data.targetId;
      if (!['content', 'route'].includes(kind) || !UUID.test(id)) return null;
      const response = await getApp().api.request('narrations/', { data: { [kind]: id } });
      if (response.data === null) return null;
      if (!validMetadata(response.data)) throw new Error('Invalid narration metadata');
      return response.data;
    },
    async load() {
      const generation = this._generation = (this._generation || 0) + 1;
      this.release();
      this.setData({ narration: null, playing: false, paused: false, loading: false, error: '', elapsed: '0:00', duration: '0:00' });
      if (!this._alive || !this._visible) return;
      try {
        const narration = await this.metadata();
        if (this.current(generation)) this.setData({ narration });
      } catch (error) {
        // A missing optional narration does not add an empty/error card to every article.
        if (this.current(generation)) this.setData({ narration: null });
      }
    },
    async toggle() {
      if (!this._alive || !this._visible || this.data.loading || !this.data.narration) return;
      if (this._audio && this.data.playing) {
        this.clearStartup();
        try { this._audio.pause(); this.setData({ playing: false, paused: true }); }
        catch (error) { this.failPlayback(); }
        return;
      }
      const generation = this._generation = (this._generation || 0) + 1;
      this.setData({ loading: true, error: '' });
      try {
        // Recheck publication/revision on every explicit start or resume.
        const narration = await this.metadata();
        if (!this.current(generation)) return;
        if (!narration) {
          this.release();
          this.setData({ narration: null, playing: false, paused: false, loading: false });
          return;
        }
        if (this.data.narration.id !== narration.id || this.data.narration.revision !== narration.revision) {
          this.release();
          this.setData({ elapsed: '0:00', duration: '0:00' });
        }
        this.setData({ narration });
        // Create a fresh instance after an error/stop; source URLs always remain on our API origin.
        let audio = this._audio;
        if (!audio) {
          const origin = getApp().config.baseURL.match(/^(https?:\/\/[^/]+)\/api\/v1\/?$/i);
          if (!origin) throw new Error('Invalid API origin');
          audio = wx.createInnerAudioContext();
          this._audio = audio;
          audio.autoplay = false;
          audio.loop = false;
          const active = () => this._alive && this._visible && this._audio === audio;
          audio.onPlay(() => { if (active()) { this.clearStartup(); this.setData({ playing: true, paused: false, loading: false, error: '' }); } });
          audio.onPause(() => { if (active()) { this.clearStartup(); this.setData({ playing: false, paused: true, loading: false }); } });
          audio.onStop(() => { if (active()) { this.clearStartup(); this.setData({ playing: false, paused: false, loading: false, elapsed: '0:00' }); } });
          audio.onEnded(() => { if (active()) { this.release(); this.setData({ playing: false, paused: false, loading: false, elapsed: '0:00' }); } });
          audio.onError(() => { if (active()) this.failPlayback(); });
          audio.onTimeUpdate(() => { if (active()) this.setData({ elapsed: clock(audio.currentTime), duration: clock(audio.duration) }); });
          audio.src = origin[1] + narration.audio_path;
        }
        if (!this.current(generation) || this._audio !== audio) return;
        this.armStartup(audio, generation);
        audio.play();
      } catch (error) { if (this.current(generation)) this.failPlayback(); }
    },
    failPlayback(message) {
      this.release();
      if (this._alive && this._visible) this.setData({ loading: false, playing: false, paused: false, elapsed: '0:00', error: message || '暂时无法播放，请检查网络后点重试。' });
    },
    stop() {
      this._generation = (this._generation || 0) + 1;
      this.release();
      if (this._alive) this.setData({ loading: false, playing: false, paused: false, error: '', elapsed: '0:00' });
    },
  },
});
