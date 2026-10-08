'use strict';

// A deterministic search over the current published catalogue. No embedding
// provider, network request, draft collection or client-supplied source text.
const TOPICS = Object.freeze({
  water: ['河流', '河道', '湖泊', '水质', '水资源', '漂浮物', '溶解氧', '浊度', '湿地', '护水', '水生', '污染'],
  plants: ['植物', '花卉', '花草', '花瓣', '叶片', '树木', '识别', '雏菊', '郁金香', '蒲公英', '蔷薇', '向日葵', '观鸟', '鸟类', '生物多样性'],
  green: ['垃圾', '分类', '低碳', '环保', '节水', '节能', '保护', '绿色生活'],
  travel: ['路线', '漫步', '步行', '游览', '导航', '交通', '公园', '出行', '预约', '开放', '门票'],
});
const GENERIC = /(?:请问|请你|帮我|一下|这里|这个|那里|那个|当前|有什么|是什么|什么|怎么|怎样|哪些|可以|适合|了解|介绍|告诉我|讲一讲|讲讲|一下|天津市?|北京市?|生态导览|生态|附近|相关|资料|知识|内容|观察|自然|为什么|能不能|有没有)/g;
const text = value => String(value || '').toLowerCase();
const compact = value => text(value).replace(/[\s··:：、，。！？?！()（）\-]/g, '');

function termsFor(question) {
  const query = text(question).slice(0, 500);
  const known = Object.values(TOPICS).flat().filter(term => query.includes(term));
  const chunks = query.replace(GENERIC, ' ').match(/[\p{Script=Han}a-z0-9]{2,}/gu) || [];
  const terms = new Set([...known, ...chunks]);
  for (const chunk of chunks) {
    if (chunk.length > 3) for (let i = 0; i < chunk.length - 1; i++) terms.add(chunk.slice(i, i + 2));
  }
  return [...terms].slice(0, 60);
}
function excerpt(value, terms, size = 420) {
  const body = String(value || '').replace(/\s+/g, ' ').trim();
  const positions = terms.map(term => text(body).indexOf(term)).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 70) : 0;
  return { body: (start ? '…' : '') + body.slice(start, start + size) + (body.length > start + size ? '…' : ''),
    body_truncated: start > 0 || body.length > size };
}
function sourceCitation(kind, row) {
  return { kind, id: row.id, title: row.title || row.name,
    source: row.source || row.source_note || (row.is_demo ? '平台模拟科普资料' : '平台管理员公开资料'),
    source_path: `/api/v1/${{ content: 'contents', route: 'routes', place: 'places' }[kind]}/${row.id}/` };
}
function searchPublished(catalog, { item, type, regionId, question = '' }) {
  const query = text(question).trim(), terms = termsFor(query);
  const region = catalog.regions.find(row => row.id === regionId);
  const city = ({ 'tianjin-nature': '天津', 'beijing-nature': '北京' })[region && region.slug] || '';
  const otherCity = city === '天津' ? '北京' : city === '北京' ? '天津' : '';
  const anchorNames = type === 'region' ? [] : [...new Set([item.name, item.title].filter(Boolean).map(compact))];
  const acceptsDemo = !region || region.is_demo || /模拟|教学|示例/.test(query);
  const cityAllowed = row => {
    const rowRegion = row.place_summary && row.place_summary.region || row.region || row.region_id;
    if (rowRegion && regionId && /^[0-9a-f-]{36}$/i.test(String(rowRegion)) && rowRegion !== regionId) return false;
    const explicit = [row.city, row.region_name, rowRegion].filter(Boolean).join(' ');
    if (otherCity && explicit.includes(otherCity) && !explicit.includes(city)) return false;
    const whole = [row.title, row.summary, row.body].filter(Boolean).join(' ');
    return !otherCity || !whole.includes(otherCity) || whole.includes(city);
  };
  const articles = catalog.contents.filter(row => (!row._linked_place || row.place)
    && (acceptsDemo || !row.is_demo)
    && cityAllowed(row));
  const places = catalog.places.filter(row => row.region === regionId && (acceptsDemo || !row.is_demo));
  const routes = catalog.routes.filter(row => row.region === regionId && (acceptsDemo || !row.is_demo));
  const topicCategories = Object.entries(TOPICS).filter(([, words]) => words.some(word => query.includes(word))).map(([category]) => category);
  const educational = /科普|学习|认识|观察|保护|注意|了解|介绍/.test(query);
  const generalEducation = educational && !topicCategories.length;
  if (generalEducation) {
    if (['river', 'lake'].includes(item.kind) || type === 'water') topicCategories.push('water');
    else if (item.kind === 'park') topicCategories.push('plants', 'green');
  }
  const rank = (kind, row) => {
    const title = row.title || row.name || '', titleText = text(title);
    const body = kind === 'content' ? row.body : row.description;
    const linkedName = row.place_summary && row.place_summary.name || '';
    const complete = text([title, row.summary, body, linkedName, row.plant_label].filter(Boolean).join(' '));
    const headline = compact(title + ' ' + linkedName);
    const boundAnchor = ['place', 'water'].includes(type) && (kind === 'place' ? row.id === item.id
      : kind === 'content' ? row.place === item.id : row.stops.some(stop => stop.place.id === item.id));
    const mixedCities = !!otherCity && complete.includes(otherCity) && complete.includes(city);
    // A passing mention in the article body is only background. A title or
    // published place binding must establish the relationship to the anchor.
    const namedAnchor = anchorNames.some(name => name.length >= 2 && headline.includes(name));
    const exactAnchor = boundAnchor || namedAnchor && !mixedCities;
    const queryHits = terms.filter(term => complete.includes(term));
    const specificQuery = kind === 'place' ? query.includes(titleText)
      : !mixedCities && (!!linkedName && query.includes(text(linkedName))
        || places.some(place => query.includes(text(place.name)) && headline.includes(compact(place.name))));
    const topicMatch = kind === 'content' && topicCategories.includes(row.category);
    // No generic default-first-three fallback. Topic-only material is permitted
    // for an explicit educational request and labelled general background.
    if (!query || (!exactAnchor && !specificQuery && !queryHits.length && !(generalEducation && topicMatch))) return null;
    const score = (exactAnchor ? 100 : 0) + (specificQuery ? 70 : 0)
      + queryHits.reduce((sum, term) => sum + (titleText.includes(term) ? 7 : 2), 0) + (topicMatch ? 4 : 0);
    return { kind, row, score, relation: exactAnchor ? 'selected_place' : specificQuery ? 'named_place_in_question'
      : kind !== 'content' || row.place_summary ? 'city_related' : 'general_background' };
  };
  const ranked = [['content', articles], ['place', places], ['route', routes]].flatMap(([kind, rows]) => rows.map(row => rank(kind, row)).filter(Boolean))
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.row.id.localeCompare(b.row.id));
  const selected = [], counts = { content: 0, place: 0, route: 0 };
  for (const hit of ranked) {
    if (selected.length >= 5) break;
    if (counts[hit.kind] >= (hit.kind === 'content' ? 3 : 2)) continue;
    if (hit.kind === type && hit.row.id === item.id) continue;
    counts[hit.kind]++; selected.push(hit);
  }
  const siteSpecific = selected.some(hit => ['selected_place', 'named_place_in_question'].includes(hit.relation));
  const status = !query ? 'awaiting_question' : !selected.length ? 'no_evidence' : siteSpecific ? 'place_related' : 'general_only';
  return { terms, selected, history_material: { articles, places, routes },
    summary: { status, query, city: city || (region && region.name) || '', has_place_specific_material: siteSpecific,
      notice: status === 'awaiting_question' ? '收到具体问题后检索当前已发布资料。' : status === 'no_evidence' ? '没有检索到匹配的补充文章、路线或正式地点资料；主来源和map_references已提供的名称、地址等元数据仍可使用，不能扩展为未知地点事实或实时环境结论。'
        : status === 'general_only' ? '未检索到本地点专属的已发布资料，以下只提供与问题相关的城市资料或通用科普，不能视为该地点的现场事实。'
          : '以下为与当前地点或问题中地点相关的已发布资料；请区分原文事实、通用知识与推测。' } };
}

module.exports = { searchPublished, sourceCitation, excerpt, termsFor };
