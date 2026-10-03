const { createAssessmentController } = require('../../pages/assessment/controller');
const controller = createAssessmentController();
const lifecycle = new Set(['onLoad', 'onShow', 'onHide', 'onUnload', 'onPullDownRefresh']);
const methods = Object.fromEntries(Object.entries(controller).filter(([key, value]) => typeof value === 'function' && !lifecycle.has(key)));
Component({
  options: { styleIsolation: 'isolated' },
  properties: { jobId: { type: String, value: '' } },
  data: { ...controller.data, embedded: true },
  lifetimes: {
    attached() { this._attached = true; controller.onLoad.call(this, { jobId: this.properties.jobId }); return controller.onShow.call(this); },
    detached() { this._attached = false; controller.onUnload.call(this); },
  },
  pageLifetimes: {
    show() { if (this._attached && !this._visible) return controller.onShow.call(this); },
    hide() { controller.onHide.call(this); },
  },
  observers: {
    'busy, locating'() { this.notifyBusy(); },
  },
  methods: {
    ...methods,
    refresh() { return controller.onPullDownRefresh.call(this); },
    notifyBusy() {
      if (!this._attached || this._busyNoticeScheduled) return;
      this._busyNoticeScheduled = true;
      // A synchronous event from this data observer makes the parent setData
      // during component attachment/update. Report the final state next tick.
      wx.nextTick(() => {
        this._busyNoticeScheduled = false;
        if (!this._attached || this._destroyed) return;
        const busy = Boolean(this.data.busy || this.data.locating);
        if (busy === this._reportedBusy) return;
        this._reportedBusy = busy;
        this.triggerEvent('busychange', { busy });
      });
    },
  },
});
