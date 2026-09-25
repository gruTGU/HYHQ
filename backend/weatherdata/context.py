"""Public weather facts for chat: no provider calls, cache writes or location guesses."""
from copy import deepcopy
from datetime import datetime, timedelta

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import KINDS, WeatherCache, WeatherLocation
from .services import location_data, point_for, public_cache

MAX_CURRENT_AGE = timedelta(hours=3)
OBSERVATION_CLOCK_SKEW = timedelta(minutes=10)


def aware_datetime(value):
    if isinstance(value, str):
        try:
            value = parse_datetime(value)
        except (ValueError, TypeError):
            return None
    return value if isinstance(value, datetime) and timezone.is_aware(value) else None


def withhold(public, reason, *, stale=False):
    public.update(status='stale' if stale else 'unavailable', stale=stale, reason=reason, data=None)
    return public


def component_context(cache, now):
    # Normalized provider payloads are objects. Fail closed if a legacy/imported
    # cache has another shape rather than exposing arbitrary malformed data.
    if cache.payload is not None and (not isinstance(cache.payload, dict) or not isinstance(cache.payload.get('data'), dict)):
        return {'status': 'unavailable', 'stale': False, 'reason': 'invalid_cached_payload', 'data': None,
                'source_label': '和风天气', 'source_kind': 'api', 'fetched_at': None, 'expires_at': None}
    if cache.kind == 'alerts' and cache.payload is not None and not isinstance(cache.payload['data'].get('zero_result'), bool):
        return {'status': 'unavailable', 'stale': False, 'reason': 'invalid_cached_payload', 'data': None,
                'source_label': '和风天气', 'source_kind': 'api', 'fetched_at': None, 'expires_at': None}
    public = deepcopy(public_cache(cache, now=now))
    raw_observed = public.get('observed_at')
    observed = aware_datetime(raw_observed)
    public['observed_at'] = observed.isoformat() if observed else None
    for key in ('fetched_at', 'expires_at'):
        value = aware_datetime(public[key])
        public[key] = value.isoformat() if value else None
    if public['data'] is None:
        return public
    fetched, expires = aware_datetime(cache.fetched_at), aware_datetime(cache.expires_at)
    if not fetched or not expires or fetched > now or expires <= fetched:
        return withhold(public, 'invalid_cache_time')
    if expires <= now:
        return withhold(public, 'cache_expired', stale=True)
    if cache.kind in ('weather', 'air'):
        # Even a mistakenly long cache TTL cannot turn old observations into
        # current facts. Null observed_at is allowed: this API may not supply it.
        if fetched <= now - MAX_CURRENT_AGE:
            return withhold(public, 'cache_too_old', stale=True)
        if raw_observed is not None:
            if not observed or observed > now + OBSERVATION_CLOCK_SKEW:
                return withhold(public, 'invalid_observation_time')
            if observed <= now - MAX_CURRENT_AGE:
                return withhold(public, 'observation_too_old', stale=True)
    elif cache.kind == 'forecast':
        days = public['data'].get('days')
        if not isinstance(days, list) or not 1 <= len(days) <= 3:
            return withhold(public, 'invalid_forecast_period')
        active_days, previous_end = [], None
        for day in days:
            start = aware_datetime(day.get('starts_at')) if isinstance(day, dict) else None
            end = aware_datetime(day.get('ends_at')) if isinstance(day, dict) else None
            if (not start or not end or end <= start or end-start > timedelta(hours=36)
                    or start < fetched-timedelta(days=1) or start > fetched+timedelta(days=3)
                    or (previous_end and start < previous_end)):
                return withhold(public, 'invalid_forecast_period')
            previous_end = end
            if end > now:
                active_days.append(day)
        if not active_days:
            return withhold(public, 'forecast_periods_ended', stale=True)
        if len(active_days) < len(days):
            public['data']['days'] = active_days
            public['expired_periods_omitted'] = True
    return public


def build_public_weather_context(weather_location_slug, now=None):
    now = now or timezone.now()
    base = {'source_label': '和风天气', 'source_kind': 'api', 'cache_only': True,
            'location': None, 'components': {},
            'notice': '只读已缓存的真实地点气象资料；不得视为校园内实测，也不对应示范河湖。过期资料不能表述为当前天气。'}
    if not isinstance(weather_location_slug, str) or not weather_location_slug or len(weather_location_slug) > 50:
        return {**base, 'status': 'unavailable', 'reason': 'weather_location_required'}
    location = WeatherLocation.objects.filter(slug=weather_location_slug, is_active=True).first()
    if location is None:
        return {**base, 'status': 'unavailable', 'reason': 'location_unavailable'}
    caches = {row.kind: row for row in WeatherCache.objects.filter(location=location, point=point_for(location))}
    components = {}
    for kind, _ in KINDS:
        cache = caches.get(kind)
        if cache is None:
            components[kind] = {'status': 'unavailable', 'data': None, 'reason': 'not_cached',
                                'source_label': '和风天气', 'fetched_at': None, 'expires_at': None}
            continue
        components[kind] = component_context(cache, now)
    status = 'available' if any(value['status'] in ('fresh', 'empty') for value in components.values()) else 'unavailable'
    return {**base, 'status': status, 'reason': '' if status == 'available' else 'no_fresh_cache',
            'location': location_data(location), 'components': components}
