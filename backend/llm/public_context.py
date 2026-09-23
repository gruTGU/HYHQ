"""Bounded public page material. IDs are resolved on every use; no client prompt data."""
import hashlib
import json
import math

from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from ecology.models import Metric, Place
from ecology.series import public_stations, select_provenance
from knowledge.models import Content, Route
from .sources import reference

MAX_PUBLIC_CONTEXT_BYTES = 10000


def clip(value, limit):
    return str(value or '').encode('utf-8')[:limit].decode('utf-8', errors='ignore')


def excerpt(field, value, limit):
    text = str(value or '')
    return {field: clip(text, limit), field + '_truncated': len(text.encode('utf-8')) > limit}


def region_card(region):
    return {'id': str(region.pk), 'name': clip(region.name, 180), **excerpt('description', region.description, 600),
            'is_demo': region.is_demo, 'source_path': '/api/v1/regions/'}


def place_card(place):
    return {'id': str(place.pk), 'name': clip(place.name, 180), 'kind': place.kind,
            **excerpt('description', place.description, 500), **excerpt('source', place.source_note, 250),
            'region_id': str(place.region_id), 'source_path': f'/api/v1/places/{place.pk}/'}


def article_card(content, body_limit=1200):
    result = {'id': str(content.pk), 'title': clip(content.title, 240), 'category': content.category,
              **excerpt('summary', content.summary, 500), **excerpt('body', content.body, body_limit),
              **excerpt('source', content.source, 500), 'is_demo': content.is_demo,
              'source_path': f'/api/v1/contents/{content.pk}/'}
    if content.place_id and content.place.is_published:
        result['place'] = {'id': str(content.place_id), 'name': clip(content.place.name, 180)}
    return result


def route_card(route):
    return {'id': str(route.pk), 'title': clip(route.title, 240), **excerpt('description', route.description, 700),
            **excerpt('source', route.source, 400), 'is_demo': route.is_demo, 'region_id': str(route.region_id),
            'source_path': f'/api/v1/routes/{route.pk}/'}


def measurement_samples(stations):
    """Match public charts: active source and a single successful simulation batch."""
    samples = []
    for station in stations[:2]:
        try:
            observations, _, source, run = select_provenance({'source_type': 'simulation'}, station)
        except ValidationError:
            samples.append({'station': clip(station.name, 180), 'status': 'ambiguous_source',
                            'notice': '来源不唯一，未自动合并指标。'})
            continue
        if not source or not run:
            continue
        metrics = []
        for metric in Metric.objects.filter(station_kind=station.kind).order_by('code')[:4]:
            value = observations.filter(metric=metric, observed_at__lte=timezone.now()).order_by('-observed_at', '-pk').first()
            if value:
                finite = value.value is not None and math.isfinite(value.value)
                metrics.append({'metric': clip(metric.name, 120), 'code': metric.code, 'unit': clip(metric.unit, 40),
                                'value': value.value if finite else None, 'quality': value.quality_status,
                                'observed_at': value.observed_at.isoformat()})
        if metrics:
            samples.append({'station': clip(station.name, 180), 'station_id': str(station.pk),
                'source': clip(source.name, 200), 'source_kind': source.kind, 'is_simulated': True,
                'simulation_run_id': str(run.pk), 'metrics': metrics,
                'notice': '模拟历史数据，非实时实测；不能判定水质等级、官方 AQI 或饮用安全。'})
    return samples


def build_public_context(session, source):
    source_type, _ = reference(session)
    context = {'scope': session.scope, 'source_type': source_type, 'image_supplied_this_turn': False,
               'notice': '本次对话只使用当前页面及关联公开资料；预设路线不提供实时导航。平台首页已提供部分地点的天气与预警查询，但本次对话上下文不包含实时天气或预警，不能据此回答当前天气或是否存在预警。实际出行请在首页选择支持地点并核对更新时间，必要时查询官方气象渠道。'}
    articles = Content.objects.filter(status='published').filter(Q(place__isnull=True) | Q(place__is_published=True)).select_related('place')
    if source_type == 'region':
        context['current_page'] = region_card(source)
        context['places'] = [place_card(place) for place in Place.objects.filter(region=source, is_published=True).order_by('name', 'id')[:6]]
        context['routes'] = [route_card(route) for route in Route.objects.filter(region=source, published=True).order_by('title', 'id')[:3]]
        context['articles'] = [article_card(item, 650) for item in articles.filter(Q(place__region=source) | Q(place__isnull=True))[:3]]
        if session.scope == 'explore':
            context['measurements'] = measurement_samples(public_stations().filter(region=source).order_by('code'))
    elif source_type == 'place':
        context['current_page'] = place_card(source)
        context['region'] = region_card(source.region)
        context['articles'] = [article_card(item, 900) for item in articles.filter(place=source)[:3]]
        context['measurements'] = measurement_samples(public_stations().filter(Q(place=source) | Q(water_body__place=source)).order_by('code'))
    elif source_type == 'water':
        context['current_page'] = {'id': str(source.pk), **excerpt('water_description', source.description, 800), 'place': place_card(source.place)}
        context['region'] = region_card(source.place.region)
        context['articles'] = [article_card(item, 900) for item in articles.filter(place=source.place)[:3]]
        context['measurements'] = measurement_samples(public_stations().filter(water_body=source).order_by('code'))
    elif source_type == 'content':
        context['current_page'] = article_card(source, 4200)
        if source.place_id and source.place.is_published:
            context['place'] = place_card(source.place)
            context['region'] = region_card(source.place.region)
    elif source_type == 'route':
        context['current_page'] = route_card(source)
        context['region'] = region_card(source.region)
        stops = list(source.stops.filter(place__is_published=True, place__region_id=source.region_id).select_related('place').order_by('order', 'id')[:12])
        context['stops'] = [{'order': stop.order, **excerpt('note', stop.note, 300), 'place': place_card(stop.place)} for stop in stops]
        context['articles'] = [article_card(item, 700) for item in articles.filter(place_id__in=[stop.place_id for stop in stops])[:2]]
    # Keep the primary page and remove supplemental entries rather than cutting JSON.
    supplemental = ['measurements', 'articles', 'routes', 'places', 'stops']
    while len(json.dumps(context, ensure_ascii=False).encode('utf-8')) > MAX_PUBLIC_CONTEXT_BYTES:
        for field in supplemental:
            if context.get(field):
                context[field].pop()
                context['supplemental_material_truncated'] = True
                break
        else:
            # Escaping quotes/backslashes can expand JSON beyond raw text bytes.
            candidates = []
            def collect(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if isinstance(child, str) and len(child.encode('utf-8')) > 300 and key not in {'id', 'source_path'}:
                            candidates.append((len(child.encode('utf-8')), value, key))
                        elif isinstance(child, (dict, list)):
                            collect(child)
                elif isinstance(value, list):
                    for child in value:
                        collect(child)
            collect(context)
            if not candidates:
                raise ValueError('Public context exceeds its hard byte limit')
            length, container, key = max(candidates, key=lambda item: item[0])
            container[key] = clip(container[key], length // 2)
            container[key + '_truncated'] = True
            context['primary_material_truncated'] = True
    return context


def revision_for(context):
    return hashlib.sha256(json.dumps(context, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()
