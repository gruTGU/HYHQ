const { app } = require('../../lib/page');
const { eventView } = require('../../lib/events');
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { placeId: { type: String, value: '' }, referenceId: { type: String, value: '' } },
  data: { items: [], loading: false, error: '' },
  observers: { 'placeId, referenceId'() { if (this._active) this.load(); } },
  lifetimes: { attached() { this._active = true; this.load(); }, detached() { this._active = false; this._version = (this._version || 0) + 1; } },
  pageLifetimes: { hide() { this._active = false; this._version = (this._version || 0) + 1; }, show() { this._active = true; this.load(); } },
  methods: {
    async load() {
      const version = this._version = (this._version || 0) + 1, props = this.properties;
      this.setData({ items: [], loading: true, error: '' });
      if (!props.placeId && !props.referenceId) { this.setData({ loading: false }); return; }
      try {
        const result = await app().api.request('events/', { data: props.referenceId ? { map_reference_id: props.referenceId } : { place_id: props.placeId } });
        if (!this._active || version !== this._version) return;
        const now = Date.parse(result.data.server_time);
        this.setData({ items: (result.data.items || []).filter(row => Date.parse(row.starts_at) <= now + 30 * 86400000).slice(0, 3).map(eventView) });
      } catch (_) { if (this._active && version === this._version) this.setData({ error: '活动暂不可用，可稍后重试。' }); }
      finally { if (this._active && version === this._version) this.setData({ loading: false }); }
    },
    open() { const p = this.properties, query = p.referenceId ? 'map_reference_id=' + encodeURIComponent(p.referenceId) : 'place_id=' + encodeURIComponent(p.placeId); wx.navigateTo({ url: '/pages/events/index?' + query }); },
  },
});
