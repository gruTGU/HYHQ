const { time } = require('./format');
const TIME_RULE = '活动前一天20:00（北京时间）；已过时间且活动未结束则尽快发送一次。';
const STATES = {
  pending: '已预约微信提醒', preparing: '正在准备发送', sending: '正在发送', retry: '等待重试发送',
  sent: '已发送一次', unknown: '发送结果待核实', failed: '发送未完成', expired: '提醒已过期', cancelled: '提醒已取消',
};
function poolView(value) {
  const raw = value || {}, amount = field => Number.isSafeInteger(raw[field]) && raw[field] >= 0 ? raw[field] : 0;
  return { remaining: amount('remaining'), reserved: amount('reserved'), held: amount('held'), needs_resubscribe: raw.needs_resubscribe === true };
}
function ended(event, now = Date.now()) { const end = Date.parse(event && event.ends_at); return !Number.isFinite(end) || end <= now; }
function scheduleLabel(event, reminder, now = Date.now()) {
  if (ended(event, now) && !reminder) return '活动已结束';
  let stamp = Date.parse(reminder && reminder.scheduled_for);
  if (!Number.isFinite(stamp)) {
    const start = Date.parse(event && event.starts_at);
    if (!Number.isFinite(start)) return '发送时间待核对';
    const previousDay = new Date(start + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    stamp = Date.parse(previousDay + 'T20:00:00+08:00');
  }
  if (stamp <= now && !ended(event, now) && (!reminder || ['pending', 'retry'].includes(reminder.state))) return '尽快发送一次（预计5分钟内）';
  return time(new Date(stamp).toISOString()).replace('UTC+8', '北京时间');
}
function reminderView(event, reminder, now = Date.now()) {
  return {
    reminder: reminder || null,
    reminder_label: reminder ? (STATES[reminder.state] || '提醒状态待核对') : '尚未预约微信提醒',
    schedule_label: scheduleLabel(event, reminder, now),
    ended: ended(event, now),
  };
}
module.exports = { TIME_RULE, poolView, ended, scheduleLabel, reminderView };
