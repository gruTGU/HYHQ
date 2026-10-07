#!/usr/bin/env python3
"""Merge the approved Tianjin supplement as distinct POIs and private guide context.

Only converts local data. Does not publish catalog articles, write a database,
call a map provider, or treat historical lookup failures as missing places.
The input's old draft/candidate flags are superseded by the current approval;
the caller must explicitly select --reviewed-on for that approval.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import re


def read_module(path):
    text = path.read_text(encoding='utf-8')
    match = re.fullmatch(r'\s*(?://[^\n]*\n)*module\.exports\s*=\s*(\{.*\})\s*;?\s*', text, re.S)
    if not match:
        raise ValueError('基础数据必须是只含 JSON 对象的静态 CommonJS 模块')
    return json.loads(match.group(1))


def coordinate(value):
    if not isinstance(value, dict) or value.get('crs') not in ('GCJ-02', 'GCJ02'):
        return None
    lat, lng = value.get('latitude'), value.get('longitude')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in (lat, lng)):
        return None
    if not (-90 < lat < 90 and -180 < lng < 180) or lat == 0 or lng == 0:
        return None
    return {'latitude': lat, 'longitude': lng}


def clean_text(value, limit=None):
    text = str(value or '').strip()
    return text[:limit] if limit else text


def identity(poi_id, coord, name):
    fallback = json.dumps([coord['longitude'], coord['latitude'], name], ensure_ascii=False, separators=(',', ':'))
    return ('poi:' + str(poi_id)) if poi_id else ('point:' + fallback)


def position_name(coord, name):
    return (coord['longitude'], coord['latitude'], name)


def concrete_points(record):
    """Yield only coordinates attached to each specific POI or explicit map point."""
    geo = record.get('geo') or {}
    accepted = geo.get('accepted')
    if accepted:
        point = coordinate(accepted)
        if point:
            yield {
                'coordinate': point, 'poi_id': clean_text(accepted.get('poi_id')),
                'name': clean_text(accepted.get('poi_title') or accepted.get('entity_name')),
                'address': clean_text(accepted.get('address')),
                'district': clean_text(accepted.get('district')),
                'poi_category': clean_text(accepted.get('poi_category')),
                'manual': False,
            }
    for candidate in geo.get('candidates') or []:
        point = coordinate(candidate.get('coordinate'))
        name = clean_text(candidate.get('title'))
        if not point or not name:
            continue
        yield {
            'coordinate': point, 'poi_id': clean_text(candidate.get('poi_id')),
            'name': name, 'address': clean_text(candidate.get('address')),
            'district': clean_text((candidate.get('ad_info') or {}).get('district')),
            'poi_category': clean_text(candidate.get('category')), 'manual': False,
        }
    manual = geo.get('manual')
    if manual:
        point = coordinate(manual)
        if point:
            yield {
                'coordinate': point, 'poi_id': '',
                'name': '天津工业大学' if record['id'] == 'WALK-001' else clean_text(manual.get('entity_name') or record.get('entity_name')),
                'address': '天津市西青区天津工业大学' if record['id'] == 'WALK-001' else '',
                'district': clean_text(record.get('district')), 'poi_category': '教育学校:大学' if record.get('is_campus') else '',
                'manual': True,
            }
    # A future explicit coordinate may have no accepted/manual wrapper. Never
    # borrow a candidate's coordinate for the parent record, or invent zeroes.
    if not accepted and not manual and geo.get('coordinate'):
        point = coordinate(geo['coordinate'])
        if point:
            yield {
                'coordinate': point, 'poi_id': '', 'name': clean_text(record.get('entity_name')),
                'address': '', 'district': clean_text(record.get('district')),
                'poi_category': '', 'manual': True,
            }


def kind_for(record, item):
    if record['id'] == 'WALK-001' or record.get('is_campus'):
        return 'campus'
    if record['id'] == 'RIV-001':
        return 'landmark'
    category = item['poi_category']
    # A bridge/plaza returned by a river search stays a concrete landmark.
    if '河流' in category or (not category and record.get('category') == 'rivers'):
        return 'river'
    if '公园' in category or '公园' in item['name']:
        return 'park'
    return 'landmark'


def write_module(path, data, comment):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('// ' + comment + '\nmodule.exports = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')


def build(base, source, source_bytes, reviewed_on):
    if source.get('schema_version') != 'hyhq.tianjin-places-with-geo.v1':
        raise ValueError('不支持的天津地点补充格式')
    result = copy.deepcopy(base)
    points = result['locations']
    base_count = len(points)
    by_poi, by_position = {}, {}
    used_ids, used_markers = set(), set()
    for point in points:
        point['source_note'] = '腾讯地图 POI'
        point['source_ids'] = sorted(set(point.get('source_ids') or [point['source_id']]))
        used_ids.add(point['id'])
        used_markers.add(point['marker_id'])
        if point.get('poi_id'):
            by_poi[str(point['poi_id'])] = point
        by_position[position_name(point, point['name'])] = point
    reviewed_records, coordinate_entries, duplicate_entries = [], 0, 0
    unmapped = []
    for record in sorted(source['records'], key=lambda row: row['id']):
        source_id = record['id']
        if not re.fullmatch(r'(?:RIV|PARK|WALK|SCEN|WET)-\d{3}', source_id) or record.get('city') != '天津':
            raise ValueError('补充资料 ID 或城市不符合本次范围')
        linked_ids = set()
        candidates = sorted(concrete_points(record), key=lambda item: identity(item['poi_id'], item['coordinate'], item['name']))
        for item in candidates:
            coordinate_entries += 1
            coord = item['coordinate']
            point = by_poi.get(item['poi_id']) if item['poi_id'] else None
            point = point or by_position.get(position_name(coord, item['name']))
            if point:
                duplicate_entries += 1
            else:
                stable_key = identity(item['poi_id'], coord, item['name'])
                suffix = hashlib.sha256(stable_key.encode('utf-8')).hexdigest()
                point_id = 'reference-' + source_id.lower() + '-poi-' + suffix[:12]
                marker_id = 100000 + int(suffix[:7], 16)
                if marker_id in used_markers:
                    raise ValueError('新增 marker ID 哈希冲突，需明确分配固定 ID 后再导入')
                if point_id in used_ids:
                    raise ValueError('新增参考点 ID 冲突，请人工处理')
                description = clean_text(record.get('summary'), 96) if item['name'] == record.get('entity_name') else clean_text(record.get('entity_name')) + '相关点位'
                point = {
                    'id': point_id, 'source_id': source_id, 'source_ids': [],
                    'marker_id': marker_id, 'region_slug': 'tianjin-nature',
                    'name': item['name'], 'title': item['name'], 'description': description,
                    'kind': kind_for(record, item), 'city': '天津', 'district': item['district'],
                    'latitude': coord['latitude'], 'longitude': coord['longitude'], 'coordinate_system': 'GCJ02',
                    'address': item['address'], 'access_note': clean_text(record.get('access_note'), 160),
                    'checked_at': reviewed_on, 'navigation_verified': False,
                    'source_note': '地图点位资料' if item['manual'] else '腾讯地图 POI',
                    'point_type': 'manual_reference' if item['manual'] else 'tencent_poi_reference',
                    'poi_category': item['poi_category'], 'poi_id': item['poi_id'],
                    'editorial_status': 'reviewed',
                }
                points.append(point)
                used_ids.add(point_id)
                used_markers.add(marker_id)
                if item['poi_id']:
                    by_poi[item['poi_id']] = point
                by_position[position_name(coord, item['name'])] = point
            point['source_ids'] = sorted(set(point.get('source_ids', []) + [source_id]))
            point['source_entity_names'] = sorted(set(point.get('source_entity_names', []) + [clean_text(record.get('entity_name'))]))
            point['editorial_status'] = 'reviewed'
            # Explicit taxonomy overrides apply even when this POI was first
            # encountered under another reviewed record.
            if 'RIV-001' in point['source_ids']:
                point['kind'] = 'landmark'
            if source_id == 'WALK-001':
                point.update(name='天津工业大学', title='天津工业大学', description='畔湖',
                             kind='campus', access_note='', source_note='地图点位资料',
                             point_type='manual_reference',
                             source_entity_names=['天津工业大学'])
            linked_ids.add(point['id'])
        fields = ['id', 'title', 'entity_name', 'parent_entity', 'category', 'city', 'district', 'institution', 'is_campus',
                  'tags', 'summary', 'observation_task', 'access_note', 'source_urls', 'source_scope',
                  'verification_date', 'body_md', 'related_ids', 'related_place_names', 'route_nodes', 'related_plants']
        guide = {key: copy.deepcopy(record[key]) for key in fields if key in record}
        guide.update(editorial_status='reviewed', reviewed_on=reviewed_on, map_reference_ids=sorted(linked_ids),
                     provider='reviewed_reference_material', source_note='天津地点与地理位置资料')
        if source_id == 'WALK-001':
            guide.update(title='天津工业大学', entity_name='天津工业大学', parent_entity='',
                         summary='畔湖', description='畔湖', body_md='畔湖', observation_task='', access_note='',
                         tags=['校园'], related_place_names=['天津工业大学'], related_ids=[], route_nodes=[], related_plants='',
                         source_urls=[], source_scope='校园地点名称与地图参考点资料。')
        reviewed_records.append(guide)
        if not linked_ids:
            unmapped.append({'id': source_id, 'lookup_status': clean_text((record.get('geo', {}).get('lookup') or {}).get('lookup_status')),
                             'reason': 'no_concrete_coordinate'})
    # The accepted base rows retain their positions and all existing IDs;
    # appended rows are ordered by stable public IDs for deterministic output.
    result['locations'] = points[:base_count] + sorted(points[base_count:], key=lambda point: point['id'])
    result['updated_on'] = reviewed_on
    result['source'] = '地图点位资料'
    result.setdefault('provenance', {})['tianjin_supplement_sha256'] = hashlib.sha256(source_bytes).hexdigest()
    result['provenance']['tianjin_reviewed_on'] = reviewed_on
    guide_data = {
        'schema_version': 1, 'reviewed_on': reviewed_on, 'scope': 'tianjin_reviewed_reference',
        'review_basis': '天津补充资料本轮审阅确认；具体 POI 分别落点，无坐标记录不落点。',
        'source_note': '天津地点与地理位置资料',
        'provenance': {'source_sha256': hashlib.sha256(source_bytes).hexdigest()},
        'records': reviewed_records,
        'unmapped_records': unmapped,
    }
    stats = {'base': base_count, 'added': len(points) - base_count, 'total': len(points),
             'tianjin': sum(point.get('city') == '天津' for point in points),
             'beijing': sum(point.get('city') == '北京' for point in points),
             'coordinate_entries': coordinate_entries, 'merged_entries': duplicate_entries,
             'guide_records': len(reviewed_records), 'unmapped_records': len(unmapped)}
    return result, guide_data, stats


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True, help='Original 74-point snapshot, retained separately from generated output.')
    parser.add_argument('--supplement', type=Path, required=True)
    parser.add_argument('--reviewed-on', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cloud-output', type=Path, required=True)
    parser.add_argument('--guide-output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.reviewed_on):
        parser.error('审阅日期须为 YYYY-MM-DD')
    inputs = {args.base.resolve(), args.supplement.resolve()}
    outputs = [args.output, args.cloud_output, args.guide_output]
    if any(path.resolve() in inputs for path in outputs) or len({path.resolve() for path in outputs}) != len(outputs):
        parser.error('输出不可覆盖输入或彼此覆盖')
    raw = args.supplement.read_bytes()
    data, guide, counts = build(read_module(args.base), json.loads(raw), raw, args.reviewed_on)
    for output in (args.output, args.cloud_output):
        write_module(output, data, 'Generated map references. Rebuild with scripts/import-tianjin-map-supplement.py and the retained base snapshot.')
    write_module(args.guide_output, guide, 'Server-only reviewed Tianjin guide context. Does not publish catalog articles.')
    print(json.dumps(counts, ensure_ascii=False))
    print('已转换静态地图与云端导览资料；无云数据库写入、无正文发布、无网络调用。')
