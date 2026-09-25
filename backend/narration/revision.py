import hashlib
import json


def source_revision(source):
    """Hash the public narrative inputs, including route stops and place wording."""
    if source._meta.model_name == 'content':
        payload = {key: getattr(source, key) for key in ('title', 'body', 'summary', 'category', 'source', 'is_demo')}
        if source.place_id:
            place = source.place
            payload['place'] = [str(place.pk), place.name, place.description, place.is_published, place.region.name]
    else:
        payload = {key: getattr(source, key) for key in ('title', 'description', 'source', 'is_demo')}
        payload['region'] = [str(source.region_id), source.region.name, source.region.is_demo]
        payload['stops'] = [
            [str(stop.pk), stop.order, stop.note, str(stop.place_id), stop.place.name, stop.place.description,
             str(stop.place.region_id), stop.place.is_published]
            for stop in source.stops.select_related('place').order_by('order', 'id')
        ]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_is_public(source):
    if source._meta.model_name == 'content':
        return source.status == 'published' and (not source.place_id or source.place.is_published)
    return source.published and not source.stops.filter(place__is_published=False).exists() and not source.stops.exclude(place__region_id=source.region_id).exists()
