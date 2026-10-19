const { time } = require('./format');
function eventView(item) { return { ...item, time_label: time(item.starts_at), end_label: time(item.ends_at), kind_label: item.annual ? '年度花季' : '近期活动' }; }
function createEventExperience(application, platform) {
  let shownToken = '', pendingToken = '';
  return {
    async showLoginSummary(active = () => true, login = false) {
      const token = application.session.token(), key = token + '.' + new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (!token || shownToken === key || pendingToken === key || !active()) return;
      pendingToken = key;
      try {
        const preferences = (await application.api.request('event-notifications/')).data || {};
        if (!active() || application.session.token() !== token) return;
        if (login && preferences.prompted !== true) {
          const upcoming = Array.isArray(preferences.upcoming) ? preferences.upcoming.slice(0, 3) : [];
          const choice = await new Promise(resolve => platform.showModal({
            title: '开启站内活动提醒？',
            content: (upcoming.length ? '近期演示活动：\n' + upcoming.map(item => item.title + '\n' + (item.location_name || '地点待补充') + ' · ' + time(item.starts_at)).join('\n\n') + '\n\n' : '')
              + '开启后，打开应用时展示今日与近期活动，优先已订阅活动，每天最多一次。模拟安排非场地方公告。此设置只开启站内摘要，可随时关闭；具体活动需另点“订阅活动提醒”，次数不足时可主动 +1 授权微信一次性提醒。',
            confirmText: '开启提醒', cancelText: '暂不开启', success: resolve, fail: () => resolve(null),
          }));
          if (!choice || !choice.confirm && !choice.cancel || !active() || application.session.token() !== token) return;
          await application.api.request('event-notifications/', { method: 'PATCH', data: { enabled: choice.confirm === true } });
          if (!active() || application.session.token() !== token) return;
          shownToken = key;
          if (choice.confirm) platform.navigateTo({ url: '/pages/events/index' });
          return;
        }
        if (preferences.enabled !== true) { shownToken = key; return; }
        const result = await application.api.request('event-notifications/claim/', { method: 'POST', data: { login: login === true } });
        if (!active() || application.session.token() !== token) return;
        const data = result.data || {}, items = data.should_show === true ? data.items : [];
        if (!Array.isArray(items) || !items.length) { shownToken = key; return; }
        shownToken = key;
        platform.showModal({ title: '今日与近期活动 · 演示', content: items.slice(0, 3).map(item => item.title + '\n' + (item.location_name || '地点待补充') + ' · ' + time(item.starts_at)).join('\n\n') + '\n\n演示安排，非场地方公告。可在活动页主动订阅一次微信提醒；次数不足时可主动 +1。', confirmText: '查看活动', cancelText: '稍后再看', success(result) {
          if (result.confirm && active() && application.session.token() === token) platform.navigateTo({ url: '/pages/events/index' });
        } });
      } catch (_) { /* Optional activity lookup never blocks login or the home page. */ }
      finally { if (pendingToken === key) pendingToken = ''; }
    },
  };
}
module.exports = { eventView, createEventExperience };
