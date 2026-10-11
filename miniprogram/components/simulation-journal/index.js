const { SCENARIOS, METRICS } = require('../../lib/simulation-journal');
const TIMES = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '24:00'];
function view(scenarioId, metricId) {
  const scenario = SCENARIOS.find(item => item.id === scenarioId) || SCENARIOS[0];
  const metric = METRICS.find(item => item.id === metricId) || METRICS[3];
  const values = scenario.series[metric.id];
  return { scenario, metric, values, minimum: Math.min(...values), maximum: Math.max(...values),
    metrics: METRICS.map(item => ({ ...item, value: scenario.series[item.id][3] })),
    rows: TIMES.map((time, index) => ({ time, values: METRICS.map(item => ({ id: item.id, value: scenario.series[item.id][index] })) })) };
}
function selected(event, key) { return event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset[key]; }
Component({
  properties: { appearance: { type: String, value: 'forest' } },
  data: { scenarios: SCENARIOS.map(({id, name}) => ({id, name})), showTable: false, showReminder: false, chartError: '', ...view('steady', 'oxygen') },
  lifetimes: {
    attached() { this._alive = true; this._visible = true; },
    ready() { this._ready = true; this.draw(); },
    detached() { this._alive = false; this._visible = false; this._drawGeneration = (this._drawGeneration || 0) + 1; },
  },
  pageLifetimes: {
    show() { if (this._alive) { this._visible = true; this.draw(); } },
    hide() { this._visible = false; this._drawGeneration = (this._drawGeneration || 0) + 1; this.setData({ showReminder: false }); },
    resize() { if (this.active()) this.draw(); },
  },
  observers: { appearance() { if (this.active()) this.draw(); } },
  methods: {
    active() { return this._alive === true && this._visible !== false; },
    chooseScenario(event) {
      const id = selected(event, 'id');
      if (!this.active() || !SCENARIOS.some(item => item.id === id)) return;
      this._drawGeneration = (this._drawGeneration || 0) + 1;
      this.setData(view(id, this.data.metric.id), () => this.draw());
    },
    chooseMetric(event) {
      const id = selected(event, 'id');
      if (!this.active() || !METRICS.some(item => item.id === id)) return;
      this._drawGeneration = (this._drawGeneration || 0) + 1;
      this.setData(view(this.data.scenario.id, id), () => this.draw());
    },
    toggleTable() { if (this.active()) this.setData({ showTable: !this.data.showTable }); },
    bookReminder() {
      if (!this.active()) return;
      this._drawGeneration = (this._drawGeneration || 0) + 1;
      this.setData({ showReminder: true });
    },
    closeReminder() { if (this._alive) this.setData({ showReminder: false }, () => this.draw()); },
    navigate(event) { const page = selected(event, 'page'); if (this.active() && ['water', 'data-center'].includes(page)) this.triggerEvent('navigate', { page }); },
    canvasFailure() { if (this.active() && !this.data.showReminder) this.setData({ chartError: '图表暂不可用，数值如下。', showTable: true }); },
    draw() {
      if (!this.active() || !this._ready || this.data.showReminder) return;
      const generation = this._drawGeneration = (this._drawGeneration || 0) + 1;
      try { this.createSelectorQuery().select('.simulation-canvas').fields({ node: true, size: true }, bounds => {
        if (!this.active() || this.data.showReminder || generation !== this._drawGeneration) return;
        if (!bounds || !bounds.node || !Number.isFinite(bounds.width) || bounds.width <= 28 || !Number.isFinite(bounds.height) || bounds.height <= 40) return this.canvasFailure();
        try {
          const canvas = bounds.node, width = bounds.width, height = bounds.height;
          const pixelRatio = typeof wx.getWindowInfo === 'function' ? Number(wx.getWindowInfo().pixelRatio) : 1;
          const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 3) : 1;
          // Setting the canvas size resets its transform before density scaling.
          canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
          const ctx = canvas.getContext('2d');
          ctx.scale(ratio, ratio);
          const values = this.data.values, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
          const points = values.map((value, i) => [14 + i * (width - 28) / (values.length - 1), height - 20 - (value - min) / span * (height - 40)]);
          ctx.clearRect(0, 0, width, height); ctx.lineWidth = 1; ctx.strokeStyle = '#b8c5b9';
          [0.15, 0.5, 0.85].forEach(part => { const y = 20 + (height - 40) * part; ctx.beginPath(); ctx.moveTo(14, y); ctx.lineTo(width-14, y); ctx.stroke(); });
          ctx.strokeStyle = this.data.scenario.color; ctx.fillStyle = this.data.scenario.color; ctx.lineWidth = 2.5; ctx.beginPath();
          points.forEach(([x,y], i) => { if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y); }); ctx.stroke();
          points.forEach(([x,y]) => { ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill(); });
          this.setData({ chartError: '' });
        } catch (_) { this.canvasFailure(); }
      }).exec(); } catch (_) { this.canvasFailure(); }
    },
  },
});
