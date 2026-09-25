"""Source buttons come from server-resolved context, never model-generated URLs."""
import re
from .sources import public_queryset

PATH = re.compile(r'^/api/v1/(contents|routes|places)/([0-9a-f-]{36})/$')
KINDS = {'contents': 'content', 'routes': 'route', 'places': 'place'}


def context_citations(context):
    found, seen = [], set()
    def visit(value):
        if isinstance(value, dict):
            match = PATH.fullmatch(value.get('source_path', ''))
            if match and match[0] not in seen and len(found) < 8:
                seen.add(match[0])
                found.append({'kind': KINDS[match[1]], 'id': match[2], 'title': value.get('title') or value.get('name', '资料'),
                              'source': value.get('source', ''), 'source_path': match[0]})
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(context)
    return found


def visible_citations(citations):
    result = []
    for row in citations[:8] if isinstance(citations, list) else []:
        if not isinstance(row, dict) or row.get('kind') not in KINDS.values():
            continue
        match = PATH.fullmatch(row.get('source_path', ''))
        if not match or row.get('id') != match[2] or row['kind'] != KINDS[match[1]]:
            continue
        query = public_queryset(row['kind'])
        if row['kind'] == 'content':
            from django.db.models import Q
            query = query.filter(Q(place__isnull=True) | Q(place__is_published=True))
        if query.filter(pk=row['id']).exists():
            result.append(row)
    return result
