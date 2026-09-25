const { time } = require('./format');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = [
  { value: 'spam', label: '广告或无关信息' }, { value: 'abuse', label: '辱骂或不当内容' },
  { value: 'privacy', label: '泄露隐私' }, { value: 'inaccurate', label: '内容存在错误' }, { value: 'other', label: '其他问题' },
];
function target(options) {
  if (!options || !['content', 'route', 'place'].includes(options.kind) || !UUID.test(options.id || '')) return null;
  return { kind: options.kind, target_id: options.id.toLowerCase() };
}
function requestId() {
  // Idempotency only; never used for authentication or access control.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (key) => {
    const value = Math.floor(Math.random() * 16); return (key === 'x' ? value : (value & 3) | 8).toString(16);
  });
}
function present(row, reports = false) {
  if (!row || !UUID.test(row.id || '') || (!reports && typeof row.body !== 'string')) throw new Error('记录格式不正确，请刷新重试。');
  const states = reports ? { pending: '待处理', resolved: '已处理', dismissed: '不予受理' } : { pending: '仅自己可见 · 待审核', approved: '已公开', rejected: '仅自己可见 · 未通过' };
  if (!Object.prototype.hasOwnProperty.call(states, row.status)) throw new Error('记录状态不正确，请刷新重试。');
  return Object.assign({}, row, { status_label: states[row.status], created_label: time(row.created_at), reason_label: reports ? ((reasons.find((r) => r.value === row.reason) || {}).label || '内容问题') : '', is_owner: row.is_owner === true });
}
function pagePath(path, mode, context) {
  if (typeof path !== 'string' || /[\s\\#]/.test(path)) throw new Error('分页地址无效，请刷新重试。');
  const endpoint = mode === 'mine' ? 'community/comments/mine/' : mode === 'reports' ? 'community/reports/' : 'community/comments/';
  const match = path.match(/^(?:https?:\/\/[^/?#]+)?(?:\/api\/v1\/)?(community\/(?:comments\/(?:mine\/)?|reports\/))(?:\?([^#]*))?$/);
  if (!match || match[1] !== endpoint) throw new Error('分页地址无效，请刷新重试。');
  const params = {};
  (match[2] || '').split('&').filter(Boolean).forEach((entry) => {
    const pair = entry.split('='); if (pair.length !== 2) throw new Error('分页参数无效。');
    const key = decodeURIComponent(pair[0]), value = decodeURIComponent(pair[1]);
    if (Object.prototype.hasOwnProperty.call(params, key) || !['kind', 'target_id', 'page', 'page_size'].includes(key)) throw new Error('分页参数无效。');
    params[key] = value;
  });
  for (const key of ['page', 'page_size']) if (params[key] !== undefined && !/^[1-9][0-9]{0,5}$/.test(params[key])) throw new Error('分页参数无效。');
  if (mode === 'target' && (!context || params.kind !== context.kind || params.target_id !== context.target_id)) throw new Error('分页对象不一致，请刷新重试。');
  if (mode !== 'target' && (params.kind || params.target_id)) throw new Error('分页对象不一致。');
  return endpoint + (Object.keys(params).length ? '?' + Object.keys(params).sort().map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&') : '');
}
module.exports = { UUID, reasons, target, requestId, present, pagePath };
