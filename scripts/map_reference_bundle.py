"""Lossless map snapshot packing for the mini-program; cloud snapshots stay explicit.

The column format keeps every source field, so a generated frontend snapshot can
still be reused as an import baseline without losing provenance or POI identity.
"""
import copy
import json
from pathlib import Path
import re

FORMAT = 'hyhq.map-columns.v1'


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def pack_frontend(data):
    data = unpack_frontend(data)
    points = data['locations']
    metadata = {key: copy.deepcopy(value) for key, value in data.items() if key != 'locations'}
    fields, defaults, dictionaries = [], {}, {}
    all_fields = list(dict.fromkeys(key for point in points for key in point))
    for key in all_fields:
        if points and key in points[0] and all(key in point and point[key] == points[0][key] for point in points):
            defaults[key] = copy.deepcopy(points[0][key])
        else:
            fields.append(key)
    rows = [[point.get(key) for key in fields] for point in points]
    for index, key in enumerate(fields):
        values, lookup, encoded = [], {}, []
        for point in points:
            if key not in point:
                encoded.append(-1)
                continue
            identity = compact_json(point[key])
            if identity not in lookup:
                lookup[identity] = len(values)
                values.append(copy.deepcopy(point[key]))
            encoded.append(lookup[identity])
        raw = [row[index] for row in rows]
        # A raw null represents an absent property. Explicit null values use a
        # dictionary to retain the distinction and make the format reversible.
        must_encode = any(key in point and point[key] is None for point in points)
        dictionary_cost = len(compact_json(values).encode()) + len(compact_json(encoded).encode()) + len(str(index)) + 4
        if must_encode or dictionary_cost < len(compact_json(raw).encode()):
            dictionaries[str(index)] = values
            for row, value in zip(rows, encoded):
                row[index] = value
    metadata.update(format=FORMAT, fields=fields, defaults=defaults, dictionaries=dictionaries, rows=rows)
    return metadata


def unpack_frontend(data):
    if 'locations' in data:
        return copy.deepcopy(data)
    if data.get('format') != FORMAT:
        raise ValueError('不支持的地图数据打包格式')
    metadata = {key: copy.deepcopy(value) for key, value in data.items()
                if key not in {'format', 'fields', 'defaults', 'dictionaries', 'rows'}}
    points = []
    for row in data['rows']:
        if len(row) != len(data['fields']):
            raise ValueError('地图点位列数不匹配')
        point = copy.deepcopy(data['defaults'])
        for index, key in enumerate(data['fields']):
            value = row[index]
            dictionary = data['dictionaries'].get(str(index))
            if dictionary is not None:
                if value == -1:
                    continue
                if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < len(dictionary):
                    raise ValueError('地图点位字典索引无效')
                point[key] = copy.deepcopy(dictionary[value])
            elif value is not None:
                point[key] = copy.deepcopy(value)
        points.append(point)
    metadata['locations'] = points
    return metadata


def read_module(path):
    text = Path(path).read_text(encoding='utf-8')
    match = re.fullmatch(r'\s*(?://[^\n]*\n)*module\.exports\s*=\s*(\{.*\})\s*;?\s*', text, re.S)
    if not match:
        raise ValueError('基础数据必须是只含 JSON 对象的静态 CommonJS 模块')
    return unpack_frontend(json.loads(match.group(1)))


def write_module(path, data, comment, *, frontend=False):
    encoded = pack_frontend(data) if frontend else data
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('// ' + comment + '\nmodule.exports = ' + compact_json(encoded) + ';\n', encoding='utf-8')
