const { time } = require('./format');
const DISCLAIMER = 'AI 回答仅供参考，请结合资料核对；不代表物种鉴定、饮用安全结论或官方水质评价。';
const SOURCE_LABELS = { region: '区域资料', place: '地点资料', water: '河湖资料', content: '科普文章', route: '游览路线' };
const SCOPE_LABELS = { recognition: '识别解读', explore: '生态导览', learn: '科普智游' };
const PUBLIC_SOURCES = { explore: ['region', 'place', 'water'], learn: ['region', 'content', 'route'] };
function publicSource(scope, type, id) { return !!(PUBLIC_SOURCES[scope] && PUBLIC_SOURCES[scope].includes(type) && typeof id === 'string' && id); }
function entryUrl(scope, type, id) { return publicSource(scope, type, id) ? '/pages/llm/index?scope=' + scope + '&source_type=' + type + '&source_id=' + encodeURIComponent(id) : ''; }
function modelLabel(model) { return model === 'deepseek-flash' || !model ? 'DeepSeek Flash' : model; }
const STATES = { queued: '等待解读', running: '正在解读', succeeded: '解读完成', failed: '本轮未完成' };
function pending(turn) { return turn && ['queued', 'running'].includes(turn.status); }
function turnView(turn) {
  if (!turn || typeof turn.id !== 'string' || !turn.id || !STATES[turn.status]) throw new Error('AI 解读返回格式不正确，请刷新核对。');
  return Object.assign({}, turn, { citations: Array.isArray(turn.citations) ? turn.citations.filter((item) => item && ['content', 'route', 'place'].includes(item.kind) && typeof item.id === 'string' && typeof item.title === 'string').slice(0, 8) : [], status_label: STATES[turn.status], created_label: time(turn.created_at), finished_label: turn.finished_at ? time(turn.finished_at) : '', image_label: pending(turn) ? '图像使用情况待处理完成后确认' : turn.used_image ? '本轮使用了原图与文字结果' : '本轮仅使用文字结果与对话', model_label: modelLabel(turn.model), answer: typeof turn.answer === 'string' ? turn.answer : '' });
}
function sessionView(session) {
  if (!session || typeof session.id !== 'string' || !session.id || !['recognition', 'assessment', 'explore', 'learn'].includes(session.kind)) throw new Error('AI 会话返回格式不正确，请刷新核对。');
  const scope = session.scope || (['recognition', 'assessment'].includes(session.kind) ? 'recognition' : session.kind);
  if (!SCOPE_LABELS[scope] || (['explore', 'learn'].includes(scope) && !publicSource(scope, session.source_type, session.source_id))) throw new Error('AI 会话来源不正确，请刷新核对。');
  const context = session.context_summary;
  const weather = session.weather_context;
  const weatherLabel = !session.weather_location ? '未附加天气资料' : weather && weather.location ? weather.location.name + (weather.status === 'available' ? ' · 仅使用有效缓存，详见回答中的时间' : ' · 缓存过期或不可用') : '所选天气地点不可用';
  return Object.assign({}, session, { weatherLabel, scope, is_recognition: scope === 'recognition', created_label: time(session.created_at), expires_label: time(session.expires_at), kind_label: session.kind === 'recognition' ? '花卉识别' : session.kind === 'assessment' ? '河道观察' : SCOPE_LABELS[scope], source_label: SOURCE_LABELS[session.source_type] || '原识别结果', context_text: typeof context === 'string' ? context : context ? JSON.stringify(context, null, 2) : '资料摘要暂不可用。' });
}
function pageKey(path, endpoint) {
  if (typeof path !== 'string' || /[\s\\#]/.test(path)) throw new Error('AI 记录分页地址无效，请刷新重试。');
  const match = path.match(/^(?:https?:\/\/[^/?#]+)?(?:\/api\/v1\/)?(llm\/(?:sessions\/|sessions\/[^/?]+\/turns\/))(\?[^#]*)?$/);
  if (!match || match[1] !== endpoint) throw new Error('AI 记录分页地址无效，请刷新重试。');
  return match[1] + (match[2] || '');
}
function readPage(response, path, endpoint, seen) {
  if (!response || !Array.isArray(response.data)) throw new Error('AI 记录返回格式不正确，请重试。');
  const key = pageKey(path, endpoint), next = response.meta && response.meta.next;
  if (seen.has(key) || (next && (typeof next !== 'string' || seen.has(pageKey(next, endpoint)) || pageKey(next, endpoint) === key))) throw new Error('AI 记录分页重复，请刷新重试。');
  if (next !== undefined && next !== null && typeof next !== 'string') throw new Error('AI 记录分页格式不正确，请重试。');
  return { key, items: response.data, next: next || '' };
}
function requestId() {
  // Correlation/idempotency key only; never an authentication credential.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (letter) => {
    const value = Math.floor(Math.random() * 16);
    return (letter === 'x' ? value : (value & 3) | 8).toString(16);
  });
}
module.exports = { SOURCE_LABELS, SCOPE_LABELS, publicSource, entryUrl, modelLabel, DISCLAIMER, pending, turnView, sessionView, pageKey, readPage, requestId };
