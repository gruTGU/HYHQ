const { app } = require('../../lib/page');
const { withTheme } = require('../../lib/theme');
Page(withTheme({
  data: { themes: [], notice: '' },
  onShow() { this.refresh(); },
  refresh() { this.setData({ themes: app().theme.list() }); },
  choose(event) {
    try {
      const result = app().theme.select(event.currentTarget.dataset.id);
      this.setData({ notice: result.persisted ? '' : '本次切换已生效，但未能保存；下次打开可能恢复默认主题。' });
      this.refresh();
      wx.showToast({ title: '主题已应用', icon: 'success' });
    } catch (error) { this.setData({ notice: error.message }); }
  },
}));
