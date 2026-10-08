'use strict';
// Read only current public records. Selection and prompt text are server-owned.
const { ApiError, sha256 } = require('./core');
const catalog = require('./catalog');
const { termsFor, excerpt } = require('./explore-retrieval');
const MODULES = Object.freeze({
  home: { title: '首页助手', description: '帮助了解海晏河清的生态导览、公开科普、花卉与河道识别、天气资料和使用方式。' },
  explore: { title: '生态导览助手', description: '从已发布的城市、地点、路线和科普资料中检索。尚未选中地点，也不知道用户位置，不能推定附近、通行或开放情况。' },
  learn: { title: '科普智游助手', description: '从已发布科普、博客和学习路线中检索，解释概念并建议观察问题。尚未选中文章或路线。' },
  recognition: { title: '识别观察助手', description: '尚未选中任何图片或识别结果。仅提供通用拍摄、花卉观察、河道可见现象与模型局限的说明，不能声称看过图片或给出本次检测结果。' },
});
async function posts(ctx) {
  // The blog module applies its publication boundary and returns public fields.
  return require('../../blog.cjs').publishedPosts(ctx);
}
function citation(kind, row) {
  return { kind, id: row.id, title: row.title || row.name,
    source: row.source || row.source_note || (kind === 'blog_post' ? (row.author_name || '平台公开博客') : row.is_demo ? '平台模拟科普资料' : '平台公开资料'),
    source_path: kind === 'blog_post' ? '/blog/' + row.id : `/api/v1/${{ content: 'contents', place: 'places', route: 'routes' }[kind]}/${row.id}/` };
}
function material(kind, row, terms) {
  return { ...citation(kind, row), ...excerpt(row.body || row.description || row.summary, terms, 360),
    is_demo: row.is_demo === true, updated_at: row.updated_at || row.published_at || null,
    ...(row.region_name ? { region_name: row.region_name } : {}) };
}
async function getContext(ctx, session, question = '') {
  delete ctx._publicCatalogPromise;
  const current = await catalog.loadCatalog(ctx), published = await posts(ctx);
  const scope = session.scope, module = MODULES[scope];
  if (!module) throw new ApiError('LLM_SOURCE_INVALID', '请选择有效对话板块', 400);
  const pool = [['content', current.contents], ['place', current.places], ['route', current.routes], ['blog_post', published]]
    .flatMap(([kind, rows]) => rows.map(row => ({ kind, row })));
  let primary = null;
  if (session.source_type === 'blog_post') {
    const row = published.find(row => row.id === session.source_id);
    if (!row) throw new ApiError('SOURCE_UNAVAILABLE', '该文章已下架或尚未公开', 409);
    primary = { kind: 'blog_post', row };
  }
  const terms = termsFor(question);
  const matches = pool.map(hit => {
    const row = hit.row, title = String(row.title || row.name || '').toLowerCase();
    const text = [title, row.summary, row.body, row.description, row.plant_label].join(' ').toLowerCase();
    return { ...hit, score: terms.reduce((score, term) => score + (title.includes(term) ? 7 : text.includes(term) ? 2 : 0), 0) };
  }).filter(hit => hit.score > 0 && (!primary || hit.kind !== primary.kind || hit.row.id !== primary.row.id))
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id)).slice(0, primary ? 3 : 4);
  const selected = [...(primary ? [primary] : []), ...matches];
  const context = { context_kind: primary ? 'published_blog' : 'module', scope, module: module.title,
    module_description: module.description, selected_private_result: false,
    platform: { name: '海晏河清', flower_model: '五类花卉候选，不能替代完整物种鉴定', river_model: '河道可见漂浮物检测，不代表水质实测',
      private_data: '本轮没有提供私人记录。未附照片不能声称看过照片。', weather: '天气只有显式选择地点后的有效缓存可作依据，不代表校园内实测。' },
    regions: current.regions.slice(0, 6).map(row => ({ name: row.name, is_demo: row.is_demo === true })),
    retrieval: { status: !question ? 'awaiting_question' : selected.length ? 'published_matches' : 'no_evidence',
      notice: '仅为当前问题匹配的已发布资料，未匹配不代表地点不存在。不同城市、模拟资料与实际地点须区分；资料不证明实时开放、导航或水质。' },
    materials: selected.map(hit => material(hit.kind, hit.row, terms)) };
  return { title: primary ? primary.row.title : module.title, context, citations: selected.map(hit => citation(hit.kind, hit.row)),
    revision: sha256(JSON.stringify(context)), history_revision: sha256(JSON.stringify([scope, session.source_type, session.source_id,
      pool.map(hit => material(hit.kind, hit.row, []))])) };
}
async function visiblePost(ctx, id) { return (await posts(ctx)).some(row => row.id === id); }
module.exports = { getContext, visiblePost, MODULES };
