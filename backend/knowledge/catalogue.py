"""Validated, attributed offline catalogue; importing never fetches arbitrary URLs."""
from datetime import date
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.core.validators import URLValidator

DATA_DIR = Path(__file__).resolve().parent / 'data'
FILES = ('eco_notes_part1.json', 'eco_notes_part2.json', 'walking_routes.json')
CATEGORIES = {'plants', 'water', 'green', 'travel'}
PLANT_LABELS = {'', 'daisy', 'dandelion', 'roses', 'sunflowers', 'tulips'}
PLACE_KINDS = {'river', 'lake', 'park', 'plant', 'waste', 'trail', 'campus', 'landmark'}


class CatalogueError(ValueError):
    pass


def text(row, key, limit, *, optional=False):
    value = row.get(key, '')
    if not isinstance(value, str) or (not optional and not value.strip()) or len(value) > limit:
        raise CatalogueError(f'{key} 须为非空文字且不超过 {limit} 字符。')
    if '\x00' in value:
        raise CatalogueError(f'{key} 不能包含空字符。')
    return value.strip()


def slug(row):
    value = text(row, 'slug', 50)
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value):
        raise CatalogueError(f'无效 slug: {value}')
    return value


def sources(row):
    entries = row.get('sources')
    if not isinstance(entries, list) or not 1 <= len(entries) <= 3:
        raise CatalogueError('每条资料须有 1–3 个已核对的公开来源。')
    seen, result = set(), []
    for entry in entries:
        if not isinstance(entry, dict):
            raise CatalogueError('来源格式错误。')
        title = text(entry, 'title', 180)
        publisher = text(entry, 'publisher', 100)
        url = text(entry, 'url', 350)
        parts = urlsplit(url)
        try:
            URLValidator(schemes=['https'])(url)
            day = date.fromisoformat(text(entry, 'accessed_on', 10))
        except (ValueError, ValidationError) as exc:
            raise CatalogueError('来源须有有效 HTTPS 链接与查阅日期。') from exc
        if parts.username or parts.password or parts.hostname in {'localhost', '127.0.0.1', '::1'} or url in seen:
            raise CatalogueError('来源须为不含凭据的唯一公开链接。')
        if day > date.today():
            raise CatalogueError('查阅日期不能在未来。')
        seen.add(url)
        result.append(f'{publisher}｜{title} {url}（查阅 {day.isoformat()}）')
    result = '\n'.join(result)
    if len(result) > 500:
        raise CatalogueError('来源说明超过数据库 500 字符限制，请减少重复信息。')
    return result


def unique(rows, label, *, name_key='title', scoped=False):
    if not isinstance(rows, list) or not rows:
        raise CatalogueError(f'{label} 列表不能为空。')
    result = {}
    titles = set()
    for row in rows:
        if not isinstance(row, dict):
            raise CatalogueError(f'{label} 条目格式错误。')
        key = slug(row)
        if key in result:
            raise CatalogueError(f'{label} slug 重复: {key}')
        title = text(row, name_key, 180)
        identity = re.sub(r'\s+', '', unicodedata.normalize('NFKC', title)).casefold()
        if scoped:
            identity = (row.get('region'), identity)
        if identity in titles:
            raise CatalogueError(f'{label} 名称重复: {title}')
        titles.add(identity)
        result[key] = row
    return result


def validate_catalogue(notes, route_bundle, *, expected_count=30):
    if not isinstance(route_bundle, dict):
        raise CatalogueError('路线数据包须为对象。')
    articles = unique(notes, '科普手记')
    routes = unique(route_bundle.get('items'), '漫步路线')
    regions = unique(route_bundle.get('regions'), '区域', name_key='name')
    places = unique(route_bundle.get('places'), '地点', name_key='name', scoped=True)
    if expected_count is not None and (len(articles) != expected_count or len(routes) != expected_count):
        raise CatalogueError(f'本批须各 {expected_count} 条手记和路线。')
    for row in regions.values():
        text(row, 'name', 120)
        text(row, 'description', 2000)
    for row in places.values():
        text(row, 'name', 120)
        text(row, 'description', 2000)
        if row.get('region') not in regions or row.get('kind') not in PLACE_KINDS:
            raise CatalogueError('地点须关联本批真实区域并使用已支持类型。')
        if any(row.get(key) is not None for key in ('latitude', 'longitude', 'map_layout', 'x_ratio', 'y_ratio')):
            raise CatalogueError('本批不导入未经实测核对的坐标或地图。')
        sources(row)
    for row in articles.values():
        text(row, 'title', 180)
        text(row, 'summary', 500)
        body = text(row, 'body', 8000)
        if len(body) < 150 or body.count('## ') < 2:
            raise CatalogueError('手记正文须有实质内容及至少两个小节。')
        if row.get('category') not in CATEGORIES or row.get('plant_label', '') not in PLANT_LABELS:
            raise CatalogueError('手记分类或植物标签无效。')
        sources(row)
    used_places = set()
    signatures = set()
    for row in routes.values():
        text(row, 'title', 180)
        text(row, 'description', 3000)
        sources(row)
        if row.get('region') not in regions:
            raise CatalogueError('路线区域无效。')
        stops = row.get('stops')
        if not isinstance(stops, list) or not 2 <= len(stops) <= 8:
            raise CatalogueError('路线须有 2–8 个有来源的真实节点。')
        signature = []
        for stop in stops:
            if not isinstance(stop, dict) or stop.get('place') not in places:
                raise CatalogueError('路线节点引用不存在的地点。')
            place = places[stop['place']]
            if place['region'] != row['region']:
                raise CatalogueError('路线节点不能跨所属区域。')
            if stop['place'] in signature:
                raise CatalogueError('同一路线节点重复。')
            text(stop, 'note', 300)
            signature.append(stop['place'])
            used_places.add(stop['place'])
        # Reversing the same set of places does not create another route.
        signature = tuple(sorted(signature))
        if signature in signatures:
            raise CatalogueError('存在节点相同、仅调换顺序的重复路线。')
        signatures.add(signature)
    if used_places != set(places):
        raise CatalogueError('地点清单含未被任何路线引用的项目。')
    return {'articles': articles, 'routes': routes, 'regions': regions, 'places': places}


def load_catalogue(directory=DATA_DIR):
    directory = Path(directory)
    bundles = []
    for filename in FILES:
        path = directory / filename
        if path.stat().st_size > 2 * 1024 * 1024:
            raise CatalogueError('采集文件过大。')
        bundle = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(bundle, dict) or bundle.get('schema_version') != 1:
            raise CatalogueError('不支持的数据包版本。')
        try:
            day = date.fromisoformat(bundle['collected_on'])
        except (KeyError, TypeError, ValueError) as exc:
            raise CatalogueError('数据包缺少有效采集日期。') from exc
        if day > date.today():
            raise CatalogueError('采集日期不能在未来。')
        bundles.append(bundle)
    if any(not isinstance(item.get('items'), list) for item in bundles):
        raise CatalogueError('数据包缺少条目数组。')
    return validate_catalogue(bundles[0]['items'] + bundles[1]['items'], bundles[2])
