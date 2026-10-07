// Add approved designs here. Pending entries are never applied as usable themes.
const FOREST = {
  id: 'forest', name: '森系自然', description: '晨雾绿与植物图样', ready: true,
  navigation: { backgroundColor: '#f0f4ed', frontColor: '#000000' },
  tokens: {
    background: '#f0f4ed', surface: '#fffefa', primary: '#3a7d5c', text: '#2c3e33',
    muted: '#65796c', secondary: '#e5efdf', secondaryText: '#326849', accent: '#a8c99b',
    lake: '#7fb3c8', warning: '#d97b4f', border: '#e7eee1', notice: '#e7efdf',
    cardRadius: '32rpx', buttonRadius: '24rpx', leafPrimary: 'rgba(168,201,155,.16)',
    leafSecondary: 'rgba(127,179,200,.10)',
  },
};
const THEMES = [FOREST, ...[2, 3, 4].map(number => ({ id: 'design-' + number, name: '主题 ' + number, description: '等待新的 UI 设计', ready: false }))];
module.exports = { THEMES, FOREST };
