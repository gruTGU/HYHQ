const DAY = 86400000;
const chinaDate = stamp => new Date(stamp + 8 * 3600000).toISOString().slice(0, 10);
const monthKey = date => date.slice(0, 7);
function shiftedMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}
function covers(item, date) {
  const start = Date.parse(item.starts_at), end = Date.parse(item.ends_at), midnight = Date.parse(date + 'T00:00:00+08:00');
  return Number.isFinite(start) && Number.isFinite(end) && start < midnight + DAY && end > midnight;
}
function calendarView(items, month, selectedDate, now = Date.now()) {
  const today = chinaDate(now), minimum = monthKey(today);
  const last = items.reduce((value, item) => {
    const stamp = Date.parse(item.ends_at);
    return Number.isFinite(stamp) ? Math.max(value, stamp - 1) : value;
  }, now);
  const maximum = monthKey(chinaDate(last));
  const chosen = /^\d{4}-\d{2}$/.test(month || '') && month >= minimum && month <= maximum ? month : minimum;
  const [year, number] = chosen.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > days) return { id: 'blank-' + index, blank: true };
    const date = chosen + '-' + String(day).padStart(2, '0');
    const count = items.filter(item => covers(item, date)).length;
    return { id: date, date, day, count, today: date === today, selected: date === selectedDate, past: date < today };
  });
  const date = cells.some(cell => cell.date === selectedDate) ? selectedDate : '';
  const begin = chosen + '-01', finish = shiftedMonth(chosen, 1) + '-01';
  const visible = items.filter(item => date ? covers(item, date)
    : Date.parse(item.starts_at) < Date.parse(finish + 'T00:00:00+08:00') && Date.parse(item.ends_at) > Date.parse(begin + 'T00:00:00+08:00'));
  return { calendarMonth: chosen, calendarTitle: year + '年' + number + '月', calendarCells: cells,
    calendarPreviousDisabled: chosen <= minimum, calendarNextDisabled: chosen >= maximum,
    selectedDate: date, selectedDateLabel: date ? number + '月' + Number(date.slice(8)) + '日' : '本月全部活动', visibleItems: visible };
}
module.exports = { calendarView, shiftedMonth, covers, chinaDate };
