'use strict';

const references = require('../data/all-map-reference-points');
const reviewedGuide = require('../data/tianjin-reviewed-guide');
const { excerpt, termsFor } = require('./explore-retrieval');
const REFERENCE_ID = /^reference-[a-z][a-z0-9]{1,15}-[0-9]{3}(?:-poi-[a-f0-9]{8,16})?$/;
const CITIES = Object.freeze({ 'tianjin-nature': '天津', 'beijing-nature': '北京' });

function validReferenceId(id) { return typeof id === 'string' && REFERENCE_ID.test(id); }

// The exact bundled whitelist establishes availability; matching the identifier
// format alone never accepts client-supplied coordinates or material.
function referenceFor(catalog, id) {
  if (!validReferenceId(id)) return null;
  const row = (references.locations || []).find(item => item.id === id);
  if (!row || !CITIES[row.region_slug] || row.city !== CITIES[row.region_slug]
    || row.coordinate_system !== 'GCJ02' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)
    || row.latitude < 38 || row.latitude > 42 || row.longitude < 114 || row.longitude > 119) return null;
  const region = catalog.regions.find(item => item.slug === row.region_slug && item.is_demo === false);
  if (!region) return null;
  const sourceIds = [...new Set((Array.isArray(row.source_ids) ? row.source_ids : [row.source_id]).filter(value => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,15}-[0-9]{3}$/.test(value)))];
  const campus = sourceIds.includes('WALK-001');
  const importedCampus = row.kind === 'campus' && row.review_status === 'campus_identity_checked';
  const manual = campus || row.point_type === 'manual_reference' || row.provider === 'manual';
  const hasReviewedMaterial = (reviewedGuide.records || []).some(material => material.editorial_status === 'reviewed'
    && material.city === '天津' && sourceIds.includes(material.id) && (material.map_reference_ids || []).includes(row.id));
  return { id: row.id, name: campus ? '天津工业大学' : row.name,
    kind: campus ? 'campus' : sourceIds.includes('RIV-001') ? (row.kind === 'trail' ? 'trail' : 'landmark') : row.kind,
    source_ids: sourceIds, source_entity_names: hasReviewedMaterial || importedCampus ? (row.source_entity_names || []).filter(value => typeof value === 'string').slice(0, 5) : [],
    description: campus ? '畔湖' : hasReviewedMaterial ? String(row.description || '').slice(0, 200) : '',
    city: row.city, district: row.district, poi_category: row.poi_category,
    region: region.id, region_slug: region.slug,
    address: row.address, latitude: row.latitude, longitude: row.longitude, coordinate_system: 'GCJ02',
    source_note: manual ? '地图点位资料' : row.source_note || '腾讯地图 POI 查询参考点', checked_at: row.checked_at,
    point_type: manual ? 'manual_reference' : importedCampus ? 'campus_poi_reference' : 'tencent_poi_reference', identity_confirmed: true, navigation_verified: false,
    ...(importedCampus ? { university: row.university, campus: row.campus, poi_id: row.poi_id,
      source_record_id: row.source_record_id, review_status: row.review_status, review_reason: row.review_reason,
      evidence_urls: row.evidence_urls, limitations: row.limitations, review_scope: row.review_scope,
      point_scope: row.point_scope, coordinate_ground_verified: false, source_provenance: row.source } : {}),
    article_status: 'not_published', is_demo: false,
    notice: importedCampus ? row.point_scope + '仅校区身份经过资料核对，坐标未经独立测绘或实地核验。'
      : '已确认的地图参考点；表示具体地点身份和参考位置，不代表入口、完整河道范围、实时水质、开放时间或可通行路线。来源记录可能介绍上级河流或区域，不能移用为此具体点的现场事实。' };
}

function reviewedMaterialsFor(row) {
  if (!row || row.city !== '天津') return [];
  return (reviewedGuide.records || []).filter(material => material.editorial_status === 'reviewed' && material.city === '天津'
    && (row.source_ids || []).includes(material.id) && (material.map_reference_ids || []).includes(row.id));
}

function materialContext(row, question = '', limit = 2) {
  const query = String(question || '');
  const records = reviewedMaterialsFor(row).map(material => ({ material,
    score: query.includes(material.entity_name || material.title) ? 5 : 0 }))
    .sort((a, b) => b.score - a.score || a.material.id.localeCompare(b.material.id)).slice(0, limit);
  return records.map(({ material }) => {
    const campus = material.id === 'WALK-001';
    const body = campus ? '畔湖' : String(material.body_md || material.summary || '').trim();
    const title = campus ? '天津工业大学' : material.title || material.entity_name;
    const entityName = campus ? '天津工业大学' : material.entity_name || material.title;
    const sameEntity = entityName === row.name;
    return { source_id: material.id, title, entity_name: entityName,
      map_reference_id: row.id, map_point_name: row.name,
      relation: sameEntity ? 'same_named_entity_background' : 'parent_entity_background',
      ...excerpt(body, termsFor(question), limit === 1 ? 260 : 550),
      source: reviewedGuide.source_note || '天津地点与地理位置资料', reviewed_on: material.reviewed_on || reviewedGuide.reviewed_on,
      source_scope: campus ? '仅天津工业大学的畔湖简介。' : material.source_scope || '仅本次已审阅的天津文件，未扩展到原内容库其他稿件。',
      verification_date: material.verification_date || null,
      source_urls: campus ? [] : (Array.isArray(material.source_urls) ? material.source_urls : []).filter(value => typeof value === 'string' && /^https?:\/\//.test(value)).slice(0, 3),
      source_path: referenceCitation(row).source_path,
      notice: sameEntity ? '经用户审阅的背景资料，不等于实时监测或开放公告，也尚未发布为博客。'
        : '材料描述的是来源记录所指河流或区域；当前地图标记是其中具体 POI，不得将父级河流介绍当作广场、码头或步道点位的实测情况。' };
  });
}

function reviewedPoolFor(rows) {
  const ids = new Set(rows.flatMap(row => reviewedMaterialsFor(row).map(material => material.id)));
  return (reviewedGuide.records || []).filter(material => ids.has(material.id));
}

function referenceCitation(row) {
  const materialSource = reviewedMaterialsFor(row).length ? '；导览文字：' + (reviewedGuide.source_note || '天津地点与地理位置资料') : '';
  return { kind: 'map_reference', id: row.id, title: row.name, source: row.source_note + materialSource,
    source_path: '/pages/explore/index?reference_id=' + row.id };
}

function forRegion(catalog, regionId) {
  const region = catalog.regions.find(row => row.id === regionId && row.is_demo === false);
  if (!region || !CITIES[region.slug]) return [];
  return (references.locations || []).filter(row => row.region_slug === region.slug)
    .map(row => referenceFor(catalog, row.id)).filter(Boolean);
}

function searchReferences(rows, question, selectedId) {
  const query = String(question || '').trim();
  if (!query) return [];
  const requestedKinds = [];
  if (/河流|河道|河湖|有哪些河|哪条河/.test(query)) requestedKinds.push('river', 'lake');
  if (/公园|湿地|绿地|森林/.test(query)) requestedKinds.push('park');
  if (/大学|高校|校园|校区|学校|畔湖/.test(query)) requestedKinds.push('campus');
  if (/步道|步行|漫步|地标|广场|码头|海河/.test(query)) requestedKinds.push('trail', 'landmark');
  const explicitOtherCity = rows.length && (rows[0].city === '天津' ? '北京' : '天津');
  if (explicitOtherCity && query.includes(explicitOtherCity) && !query.includes(rows[0].city)) return [];
  const wantsList = /有哪些|有什么|推荐|哪些|哪里|哪条/.test(query);
  const normalizeName = value => String(value || '').replace(/[\s()（）]/g, '');
  const normalizedQuery = normalizeName(query);
  return rows.filter(row => row.id !== selectedId).map(row => {
    const name = normalizeName(row.name);
    const localName = name.replace(/^(?:天津|北京)(?:市)?/, '');
    const exactName = normalizedQuery.includes(name) || localName.length >= 3 && normalizedQuery.includes(localName);
    const entityLength = Math.max(0, ...(row.source_entity_names || []).map(normalizeName)
      .filter(name => name.length >= 2 && normalizedQuery.includes(name)).map(name => name.length));
    const campusName = (row.source_ids || []).includes('WALK-001') && /天津工业大学|天工大|畔湖/.test(query);
    const kindMatch = wantsList && requestedKinds.includes(row.kind);
    const categoryMatch = wantsList && /湿地/.test(query) && row.name.includes('湿地');
    return { row, score: exactName ? 100 + name.length : campusName ? 90 : entityLength ? 50 + entityLength : categoryMatch ? 15 : kindMatch ? 10 : 0 };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
    .slice(0, 3).map(hit => hit.row);
}

module.exports = { validReferenceId, referenceFor, referenceCitation, forRegion, searchReferences, reviewedMaterialsFor, materialContext, reviewedPoolFor };
