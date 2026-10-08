const TABS = [
  { pagePath: 'pages/home/index', label: '首页', icon: 'home' },
  { pagePath: 'pages/explore/index', label: '生态导览', icon: 'explore' },
  { pagePath: 'pages/recognize/index', label: '智慧识别', icon: 'camera' },
  { pagePath: 'pages/learn/index', label: '科普智游', icon: 'learn' },
  { pagePath: 'pages/profile/index', label: '我的', icon: 'profile' },
];

function currentIndex(pages) {
  const page = Array.isArray(pages) && pages[pages.length - 1];
  const route = page && (page.route || page.__route__);
  return TABS.findIndex((tab) => tab.pagePath === route);
}

function tabAt(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-4]$/.test(value))) return null;
  return Number.isInteger(Number(value)) ? TABS[Number(value)] || null : null;
}

function selectTab(page, index) {
  if (!tabAt(index) || !page || typeof page.getTabBar !== 'function') return;
  const bar = page.getTabBar();
  if (!bar || typeof bar.setData !== 'function') return;
  // Each tab page owns an instance. Pin its identity so a later component show
  // callback cannot overwrite it with getCurrentPages() from the previous route.
  bar._pageIndex = Number(index);
  bar.setData({ selected: Number(index) });
}

module.exports = { TABS, currentIndex, tabAt, selectTab };
