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
const EDITORIAL = {
  id: 'design-2', name: '纪实自然志', description: '暖白纸页、自然摄影与杂志目录', ready: true,
  navigation: { backgroundColor: '#f8f7f2', frontColor: '#000000' },
  tokens: {
    background: '#f8f7f2', surface: '#fffefa', primary: '#293b28', text: '#222620',
    muted: '#777970', secondary: '#e9ebe4', secondaryText: '#34432f', accent: '#8d9b7b',
    lake: '#829b9d', warning: '#ac6545', border: '#dedfd5', notice: '#eeeee6',
    cardRadius: '6rpx', buttonRadius: '8rpx', leafPrimary: 'rgba(0,0,0,0)', leafSecondary: 'rgba(0,0,0,0)',
  },
};
const ATLAS = {
  id: 'design-3', name: '山水测绘册', description: '浅纸纹、测绘蓝与朱红标记', ready: true,
  navigation: { backgroundColor: '#f5eddf', frontColor: '#000000' },
  tokens: {
    background: '#f5eddf', surface: '#fcf7ed', primary: '#ad442b', text: '#34342d',
    muted: '#86775f', secondary: '#eee2cc', secondaryText: '#815633', accent: '#b78a57',
    lake: '#34667f', warning: '#b3542e', border: '#dbc4a1', notice: '#f0e4cf',
    cardRadius: '8rpx', buttonRadius: '12rpx', leafPrimary: 'rgba(0,0,0,0)', leafSecondary: 'rgba(0,0,0,0)',
  },
};
const THEMES = [FOREST, EDITORIAL, ATLAS, { id: 'design-4', name: '主题 4', description: '等待新的 UI 设计', ready: false }];
module.exports = { THEMES, FOREST, EDITORIAL, ATLAS };
