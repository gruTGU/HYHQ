const { withTheme } = require('../../lib/theme');
Page(withTheme({
  data: { privacy: true, cloudMode: false },
  onLoad(options) {
    const config = getApp().config || {};
    this.setData({ cloudMode: ['cloud', 'cloud-function'].includes(config.transport) });
    this.showDocument(options.kind !== 'terms');
  },
  showDocument(privacy) {
    this.setData({ privacy });
    wx.setNavigationBarTitle({ title: privacy ? '隐私说明' : '用户协议' });
  },
  switchDocument(event) { this.showDocument(event.currentTarget.dataset.kind !== 'terms'); },
  feedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
}));
