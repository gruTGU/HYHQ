from datetime import timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import provider
from .models import CURRENT_KINDS, KINDS, WeatherCache, WeatherGate, WeatherLocation, WeatherMonth, WeatherRequest

BEIJING = ZoneInfo('Asia/Shanghai')


def location_data(location):
    return {'slug': location.slug, 'name': location.name, 'latitude': float(location.latitude),
            'longitude': float(location.longitude), 'coordinate_system': 'WGS84', 'scope_note': location.scope_note}


def point_for(location):
    return f'{location.latitude:.2f}/{location.longitude:.2f}'


def public_cache(cache, reason='', now=None):
    now = now or timezone.now()
    has_payload = cache.payload is not None
    stale = bool(has_payload and (not cache.expires_at or cache.expires_at <= now))
    status = 'stale' if stale else 'fresh' if has_payload else 'unavailable'
    if has_payload and not stale and cache.kind == 'alerts' and cache.payload['data']['zero_result']:
        status = 'empty'
    return {**(cache.payload or {'data': None, 'attributions': [], 'refer': {'sources': ['QWeather']}, 'observed_at': None}),
            'status': status, 'stale': stale, 'reason': reason or cache.last_reason,
            'fetched_at': cache.fetched_at, 'expires_at': cache.expires_at,
            'source_label': '和风天气', 'source_kind': 'api'}


def reserve(location, kind, now):
    """Reserve before sending. Crashes/failures retain spend; no refunds or resets."""
    if kind not in dict(KINDS):
        raise ValueError('Unsupported weather component')
    point = point_for(location)
    with transaction.atomic():
        WeatherGate.objects.get_or_create(pk=1)
        gate = WeatherGate.objects.select_for_update().get(pk=1)
        cache, _ = WeatherCache.objects.get_or_create(location=location, kind=kind, point=point)
        if kind == 'forecast':
            from .configuration import forecast_enabled
            if not forecast_enabled():
                return cache, None, 'forecast_disabled'
        if cache.payload is not None and cache.expires_at and cache.expires_at > now:
            return cache, None, ''
        if not provider.configured():
            return cache, None, 'not_configured'
        if not WeatherLocation.objects.filter(pk=location.pk, is_active=True, latitude=location.latitude, longitude=location.longitude).exists():
            return cache, None, 'location_unavailable'
        if cache.lease_until and cache.lease_until > now:
            return cache, None, 'refreshing'
        if cache.retry_at and cache.retry_at > now:
            return cache, None, cache.last_reason or 'cooldown'
        if gate.blocked_until and gate.blocked_until > now:
            return cache, None, gate.block_reason or 'upstream_cooldown'
        month, _ = WeatherMonth.objects.get_or_create(month=now.astimezone(BEIJING).strftime('%Y-%m'))
        limit = min(settings.QWEATHER_MONTHLY_LIMIT, 30000)
        recent = WeatherRequest.objects.filter(reserved_at__gte=now - timedelta(days=31))
        if month.reserved >= limit or recent.count() >= limit:
            return cache, None, 'budget_exhausted'
        if recent.filter(reserved_at__gte=now - timedelta(minutes=1)).count() >= min(settings.QWEATHER_MINUTE_LIMIT, 30):
            return cache, None, 'rate_limited'
        month.reserved += 1
        month.save(update_fields=['reserved'])
        reservation = WeatherRequest.objects.create(month=month, location=location, kind=kind, point=point)
        cache.lease_token = reservation.pk
        cache.lease_until = now + timedelta(seconds=60)
        cache.last_reason = 'refreshing'
        cache.save(update_fields=['lease_token', 'lease_until', 'last_reason'])
        return cache, reservation, ''


def get_component(location, kind):
    if kind not in dict(KINDS):
        raise ValueError('Unsupported weather component')
    cache, reservation, reason = reserve(location, kind, timezone.now())
    if reservation is None:
        return public_cache(cache, reason)
    error = None
    payload = None
    try:
        payload = provider.fetch(kind, reservation.point)
    except provider.ProviderError as exc:
        error = exc
    now = timezone.now()
    with transaction.atomic():
        gate = WeatherGate.objects.select_for_update().get(pk=1)
        WeatherRequest.objects.filter(pk=reservation.pk).update(completed_at=now, outcome=error.code if error else 'succeeded', http_status=error.status if error else 200)
        cache = WeatherCache.objects.get(pk=cache.pk)
        if cache.lease_token != reservation.pk:
            return public_cache(cache, 'refreshing', now)
        cache.lease_until = None
        cache.lease_token = None
        if error:
            cache.last_reason = error.code
            cache.retry_at = now + timedelta(seconds=max(60, settings.QWEATHER_FAILURE_COOLDOWN_SECONDS))
            if error.status in (401, 402, 403, 429):
                gate.blocked_until = now + timedelta(hours=1 if error.status == 429 else 24)
                gate.block_reason = 'upstream_rate_limited' if error.status == 429 else 'upstream_access_denied'
                gate.save(update_fields=['blocked_until', 'block_reason'])
        else:
            cache.payload = payload
            cache.fetched_at = now
            from .configuration import forecast_ttl
            ttl = forecast_ttl() if kind == 'forecast' else max(60, settings.QWEATHER_CACHE_SECONDS[kind])
            cache.expires_at = now + timedelta(seconds=ttl)
            cache.retry_at = None
            cache.last_reason = ''
        cache.save()
    # A changed/disabled target cannot publish data fetched using its old coordinates.
    if not WeatherLocation.objects.filter(pk=location.pk, is_active=True, latitude=location.latitude, longitude=location.longitude).exists():
        cache.payload = None
        cache.fetched_at = cache.expires_at = None
        return public_cache(cache, 'location_unavailable', now)
    return public_cache(cache, now=now)


def summary(location):
    return {'location': location_data(location), 'source_label': '和风天气', 'source_kind': 'api',
            **{kind: get_component(location, kind) for kind, _ in CURRENT_KINDS}}
