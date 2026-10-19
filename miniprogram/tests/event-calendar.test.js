const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarView, shiftedMonth, chinaDate } = require('../lib/event-calendar');
const monthly = { id: 'month', starts_at: '2032-02-01T00:00:00+08:00', ends_at: '2032-03-01T00:00:00+08:00' };
test('calendar uses Beijing dates, Monday columns and leap February', () => {
  const now = Date.parse('2032-01-31T16:00:00Z');
  assert.equal(chinaDate(now), '2032-02-01');
  const c = calendarView([monthly], null, '', now);
  assert.equal(c.calendarCells.filter(cell => !cell.blank).length, 29);
  assert.equal(c.calendarCells[6].date, '2032-02-01');
  assert.equal(c.calendarCells[6].today, true);
  assert.equal(c.calendarCells.filter(cell => cell.count === 1).length, 29);
  assert.equal(c.calendarPreviousDisabled, true); assert.equal(c.calendarNextDisabled, true);
});
test('calendar includes spanning events but not the exclusive end day', () => {
  const now = Date.parse('2032-02-01T00:00:00+08:00');
  const evening = { id: 'night', starts_at: '2032-02-08T23:00:00+08:00', ends_at: '2032-02-09T00:00:00+08:00' };
  assert.deepEqual(calendarView([monthly, evening], '2032-02', '2032-02-08', now).visibleItems.map(x => x.id), ['month', 'night']);
  assert.deepEqual(calendarView([monthly, evening], '2032-02', '2032-02-09', now).visibleItems.map(x => x.id), ['month']);
  assert.equal(calendarView([monthly], '2032-02', '2032-02-31', now).selectedDate, '');
});
test('calendar month boundaries are bounded by available data and support crossing years', () => {
  assert.equal(shiftedMonth('2031-12', 1), '2032-01');
  assert.equal(shiftedMonth('2032-01', -1), '2031-12');
  const c = calendarView([], '2020-01', '2020-01-01', Date.parse('2032-02-01T00:00:00+08:00'));
  assert.equal(c.calendarMonth, '2032-02'); assert.equal(c.selectedDate, ''); assert.deepEqual(c.visibleItems, []);
});
