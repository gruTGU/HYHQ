#!/usr/bin/env python3
"""Build public map reference markers; never publish Markdown bodies or navigation."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


def build(locations_path, markdown_path):
    raw = locations_path.read_bytes()
    markdown = markdown_path.read_bytes()
    source = json.loads(raw)
    if source.get('schema_version') != 'hyhq.geo-patch.v1' or source.get('crs') != 'GCJ-02':
        raise ValueError('仅支持已确认的 hyhq.geo-patch.v1 / GCJ-02 参考点格式')
    metadata = {}
    for block in re.findall(r'<!-- HYHQ_META_BEGIN -->\s*```json\s*(.*?)\s*```\s*<!-- HYHQ_META_END -->', markdown.decode('utf-8'), re.S):
        row = json.loads(block)
        if row['id'] in metadata:
            raise ValueError('参考文档存在重复 ID')
        metadata[row['id']] = row
    cities = {'天津': 'tianjin-nature', '北京': 'beijing-nature'}
    points = []
    ids, markers = set(), set()
    for row in source['locations']:
        record_id = row['record_id']
        original = metadata.get(record_id)
        if not original or any(original.get(key) != row.get(key) for key in ['entity_name', 'title', 'city', 'district', 'access_note']):
            raise ValueError(f'{record_id} 与参考文档身份字段不一致，需人工处理')
        if row['city'] not in cities or row.get('crs') != 'GCJ-02' or row.get('source', {}).get('review_status') != 'accepted' or row.get('usage_scope') != 'map_marker_reference_only':
            raise ValueError(f'{record_id} 不属于已接受的京津地图参考点')
        if record_id in ids or row['marker_id'] in markers:
            raise ValueError('参考点 ID 重复')
        ids.add(record_id)
        markers.add(row['marker_id'])
        for key, limit in [('latitude', 90), ('longitude', 180)]:
            value = row[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not -limit <= value <= limit:
                raise ValueError(f'{record_id} 经纬度无效')
        category = row.get('poi_category', '')
        kind = 'river' if original['category'] == 'rivers' else ('park' if '公园' in category or '公园' in row['entity_name'] else 'landmark')
        points.append({
            'id': 'reference-' + record_id.lower(), 'source_id': record_id,
            'marker_id': row['marker_id'], 'region_slug': cities[row['city']],
            'name': row['entity_name'], 'title': row['title'], 'kind': kind,
            'city': row['city'], 'district': row['district'],
            'latitude': row['latitude'], 'longitude': row['longitude'], 'coordinate_system': 'GCJ02',
            'address': row.get('address', ''), 'access_note': row.get('access_note', ''),
            'checked_at': row['source']['reviewed_on'], 'navigation_verified': False,
            'source_note': '用户提供并确认的腾讯地图 POI 查询参考点',
            'poi_category': category, 'poi_id': row.get('poi_id', ''),
            'editorial_status': 'draft_review_required',
        })
    return {
        'schema_version': 1, 'updated_on': source['created_on'], 'source': '腾讯地图 POI',
        'scope_note': '参考点，不代表入口、完整河道或导航路线。',
        'provenance': {'locations_sha256': hashlib.sha256(raw).hexdigest(), 'reference_md_sha256': hashlib.sha256(markdown).hexdigest()},
        'locations': points,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--locations', type=Path, required=True)
    parser.add_argument('--reference-md', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cloud-output', type=Path, help='Write the identical server-owned reference snapshot for AI context.')
    args = parser.parse_args()
    outputs = [args.output] + ([args.cloud_output] if args.cloud_output else [])
    if any(output.resolve() in (args.locations.resolve(), args.reference_md.resolve()) for output in outputs):
        parser.error('输出不可覆盖输入文件')
    data = build(args.locations, args.reference_md)
    encoded = '// Generated public map references. Rebuild with scripts/import-map-reference-points.py.\nmodule.exports = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    for output in outputs:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding='utf-8')
    print(f'已生成 {len(data["locations"])} 个静态参考点；未发布文章、未写入云数据库。')
