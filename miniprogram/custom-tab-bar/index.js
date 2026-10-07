const { TABS, currentIndex, tabAt } = require('../lib/tab-bar');
const { connectTheme, disconnectTheme } = require('../lib/theme');

Component({
  data: { tabs: TABS, selected: 0 },
  lifetimes: {
    attached() { this._detached = false; connectTheme(this); this.syncSelected(); },
    detached() { disconnectTheme(this); this._detached = true; this._switchVersion = (this._switchVersion || 0) + 1; },
  },
  pageLifetimes: {
    show() { connectTheme(this); this._switching = false; this.syncSelected(); },
    hide() { disconnectTheme(this); },
  },
  methods: {
    syncSelected() {
      if (this._detached) return;
      const index = tabAt(this._pageIndex) ? this._pageIndex : currentIndex(typeof getCurrentPages === 'function' ? getCurrentPages() : []);
      if (index >= 0 && index !== this.data.selected) this.setData({ selected: index });
    },
    switchTab(event) {
      const tab = tabAt(event && event.currentTarget && event.currentTarget.dataset.index);
      if (!tab || this._detached || this._switching) return;
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const selected = tabAt(this._pageIndex) ? this._pageIndex : currentIndex(pages);
      if (selected === TABS.indexOf(tab)) { this.syncSelected(); return; }
      const version = this._switchVersion = (this._switchVersion || 0) + 1;
      this._switching = true;
      wx.switchTab({
        url: '/' + tab.pagePath,
        success: () => { if (!this._detached && version === this._switchVersion) this.syncSelected(); },
        fail: () => {
          if (this._detached || version !== this._switchVersion) return;
          this.syncSelected();
          wx.showToast({ title: '暂时无法切换，请再试一次', icon: 'none' });
        },
        complete: () => { if (!this._detached && version === this._switchVersion) this._switching = false; },
      });
    },
  },
});
