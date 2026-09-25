const TYPES = { content: '科普手记', route: '漫步路线', place: '公开地点' };
function searchData(response) {
  const value = response && response.data;
  if (!value || !Array.isArray(value.results) || !Number.isInteger(value.count) || value.count < 0 || (!Number.isInteger(value.page) || value.page < 1) || typeof value.answer !== 'string' || typeof value.notice !== 'string' || typeof value.has_more !== 'boolean' || !['published_excerpts', 'no_evidence'].includes(value.answer_kind)) throw new Error('资料检索返回格式不正确，请重试。');
  if (value.count < value.results.length || (value.has_more && !value.results.length) || (value.answer_kind === 'no_evidence' ? value.count !== 0 || value.results.length || value.has_more : value.count === 0)) throw new Error('资料证据状态不一致，请重试。');
  const results = value.results.map((item) => {
    if (!item || !TYPES[item.kind] || typeof item.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.id) || typeof item.title !== 'string' || typeof item.excerpt !== 'string' || typeof item.source !== 'string' || !item.source.trim()) throw new Error('来源信息不完整，请重试。');
    return Object.assign({}, item, { key: item.kind + ':' + item.id, kindLabel: TYPES[item.kind], dateLabel: typeof item.updated_at === 'string' ? item.updated_at.slice(0, 10) : '' });
  });
  return Object.assign({}, value, { results });
}
module.exports = { searchData };
