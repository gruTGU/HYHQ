"""Deterministic, source-backed retrieval. Never calls a language model or the web."""
import re
from functools import reduce
from operator import or_

from django.db.models import Case, F, IntegerField, Q, Value, When
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from ecology.models import Place, Region
from ecology.series import single_params
from ecology.views import by_identifier
from .models import Content, Route


class SearchInput(serializers.Serializer):
    q = serializers.CharField(max_length=100, required=False, default='', allow_blank=True)
    kind = serializers.ChoiceField(choices=['all', 'content', 'route', 'place'], default='all')
    category = serializers.ChoiceField(choices=['', 'plants', 'water', 'green', 'travel'], default='')
    plant_label = serializers.RegexField(r'^[-a-zA-Z0-9_]{1,50}$', required=False, default='', allow_blank=True)
    place = serializers.CharField(max_length=50, required=False, default='', allow_blank=True)
    region = serializers.CharField(max_length=50, required=False, default='', allow_blank=True)
    page = serializers.IntegerField(min_value=1, max_value=1000, default=1)
    page_size = serializers.IntegerField(min_value=1, max_value=20, default=10)

    def validate(self, attrs):
        if not any(attrs[key] for key in ['q', 'category', 'plant_label', 'place', 'region']):
            raise serializers.ValidationError('请输入关键词，或选择标签、地点、区域后检索。')
        if len(attrs['q'].split()) > 5:
            raise serializers.ValidationError('一次最多检索 5 个关键词，用空格分隔。')
        if (attrs['category'] or attrs['plant_label']) and attrs['kind'] not in ['all', 'content']:
            raise serializers.ValidationError('分类和植物标签仅适用于科普手记。')
        for key, queryset in [('place', Place.objects.filter(is_published=True)), ('region', Region.objects.all())]:
            if attrs[key]:
                obj = by_identifier(queryset, attrs[key]).first()
                if obj is None:
                    raise serializers.ValidationError({key: '未找到公开的地点或区域。'})
                attrs[key] = str(obj.pk)
        return attrs


def excerpt(text, terms, limit=360):
    """Return a contiguous plain-text excerpt, not an invented answer."""
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    offsets = [text.lower().find(term.lower()) for term in terms]
    found = [pos for pos in offsets if pos >= 0]
    start = max(0, min(found) - 55) if found else 0
    return ('…' if start else '') + text[start:start + limit] + ('…' if len(text) > start + limit else '')


def ranked(queryset, title_field, fields, terms):
    score = Value(0, output_field=IntegerField())
    for term in terms:
        queryset = queryset.filter(reduce(or_, (Q(**{field + '__icontains': term}) for field in fields)))
        score = score + Case(When(**{title_field + '__icontains': term}, then=Value(4)), default=Value(1), output_field=IntegerField())
    return queryset.annotate(search_score=score).distinct().order_by('-search_score', 'pk')


def retrieve(values):
    terms = values['q'].split()
    contents = Content.objects.filter(status='published').filter(Q(place__isnull=True) | Q(place__is_published=True)).select_related('place__region')
    routes = Route.objects.filter(published=True).select_related('region')
    places = Place.objects.filter(is_published=True).select_related('region')
    if values['region']:
        contents = contents.filter(Q(place__isnull=True) | Q(place__region_id=values['region']))
        routes = routes.filter(region_id=values['region'])
        places = places.filter(region_id=values['region'])
    if values['place']:
        contents = contents.filter(place_id=values['place'])
        routes = routes.filter(stops__place_id=values['place'], stops__place__is_published=True, stops__place__region_id=F('region_id'))
        places = places.filter(pk=values['place'])
    if values['category']:
        contents = contents.filter(category=values['category'])
    if values['plant_label']:
        contents = contents.filter(plant_label=values['plant_label'])
    scoped = [
        ('content', ranked(contents, 'title', ['title', 'summary', 'body', 'plant_label', 'place__name'], terms)),
        ('route', ranked(routes, 'title', ['title', 'description', 'region__name'], terms)),
        ('place', ranked(places, 'name', ['name', 'description', 'region__name'], terms)),
    ]
    if values['category'] or values['plant_label']:
        scoped = scoped[:1]
    if values['kind'] != 'all':
        scoped = [(kind, qs) for kind, qs in scoped if kind == values['kind']]
    total = sum(qs.count() for _, qs in scoped)
    start = (values['page'] - 1) * values['page_size']
    end = start + values['page_size']
    # Fetch at most the requested prefix from each indexed public queryset.
    candidates = [(kind, obj) for kind, qs in scoped for obj in qs[:end]]
    # UUID ordering agrees between PostgreSQL/SQLite and Python. Locale-based
    # title ordering does not: mixing it with Python Unicode ordering could
    # exclude a globally earlier row from a queryset's paginated prefix.
    candidates.sort(key=lambda pair: (-pair[1].search_score, pair[0], str(pair[1].pk)))
    results = []
    for kind, obj in candidates[start:end]:
        text = obj.body if kind == 'content' else obj.description
        title = obj.title if kind != 'place' else obj.name
        source = obj.source if kind != 'place' else obj.source_note
        region = obj.place.region if kind == 'content' and obj.place_id else obj.region if kind != 'content' else None
        results.append({
            'id': str(obj.pk), 'kind': kind, 'title': title,
            'excerpt': excerpt(text or getattr(obj, 'summary', ''), terms),
            'source': source or '平台管理员整理，未提供外部来源',
            'source_path': f'/api/v1/{ {"content": "contents", "route": "routes", "place": "places"}[kind]}/{obj.pk}/',
            'updated_at': obj.updated_at.isoformat(), 'is_demo': obj.is_demo if kind != 'place' else bool(obj.region.is_demo),
            'region_name': region.name if region else '', 'category': getattr(obj, 'category', ''),
            'plant_label': getattr(obj, 'plant_label', ''),
        })
    return {'query': values, 'count': total, 'page': values['page'], 'has_more': total > end, 'results': results,
            'answer_kind': 'published_excerpts' if total else 'no_evidence',
            'answer': f'检索到 {total} 份已发布资料，以下为原文片段，请打开来源核对。' if total else '没有找到匹配的已发布资料，无法依据本站资料回答。可尝试更短的关键词或减少筛选条件。',
            'notice': '这里只检索本站已发布资料，按关键词匹配，不联网搜索，不生成实时天气、水质或安全结论。模拟资料会单独标注。'}


class KnowledgeSearch(APIView):
    permission_classes = [AllowAny]
    throttle_scope = 'knowledge_search'

    def get(self, request):
        single_params(request.query_params, tuple(SearchInput().fields))
        if set(request.query_params) - set(SearchInput().fields):
            raise serializers.ValidationError('不支持的检索参数。')
        values = SearchInput(data=request.query_params)
        values.is_valid(raise_exception=True)
        return Response(retrieve(values.validated_data))
