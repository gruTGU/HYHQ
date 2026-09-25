"""Fixed QWeather v1 allowlist; no cyclone, marine or radiation endpoints."""
import http.client
import json
import math
import re
import socket
import ssl
import time
import zlib

from django.conf import settings
from django.utils.dateparse import parse_datetime
from django.utils import timezone

PATHS = {
    'weather': '/weather/v1/current/',
    'air': '/airquality/v1/current/',
    'alerts': '/weatheralert/v1/current/',
    'forecast': '/weather/v1/daily/',
}
HOST_PATTERN = re.compile(r'\A(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,3}qweatherapi\.com\Z')
MAX_BYTES = 256 * 1024


class ProviderError(Exception):
    def __init__(self, code, status=None):
        self.code = code
        self.status = status
        super().__init__(code)


def configured():
    return bool(settings.QWEATHER_ENABLED and settings.QWEATHER_API_KEY and HOST_PATTERN.fullmatch(settings.QWEATHER_API_HOST))


def clean_text(value, limit=500, *, complete=False):
    if not isinstance(value, str):
        return ''
    key = settings.QWEATHER_API_KEY
    if key:
        value = value.replace(key, '[redacted]')
    value = ''.join(c for c in value if c in '\n\t' or ord(c) >= 32)
    if complete and len(value) > limit:
        raise ProviderError('response_too_large')
    return value[:limit]


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def obj(value):
    return value if isinstance(value, dict) else {}


def texts(value):
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ProviderError('invalid_response')
    return [clean_text(item, 32000, complete=True) for item in value]


def forecast_days(body):
    days = body.get('days')
    if not isinstance(days, list) or not 1 <= len(days) <= 3:
        raise ProviderError('invalid_response')
    normalized = []
    previous_end = None
    for raw in days:
        raw = obj(raw)
        try:
            start = parse_datetime(raw.get('forecastStartTime', ''))
            end = parse_datetime(raw.get('forecastEndTime', ''))
        except (TypeError, ValueError):
            raise ProviderError('invalid_response') from None
        if (not start or not end or timezone.is_naive(start) or timezone.is_naive(end) or end <= start
                or (previous_end and start < previous_end)):
            raise ProviderError('invalid_response')
        previous_end = end
        low, high = obj(raw.get('temperatureMin')), obj(raw.get('temperatureMax'))
        if (number(low.get('value')) is None or number(high.get('value')) is None
                or low['value'] > high['value'] or low.get('unit') != high.get('unit')
                or low.get('unit') not in ('°C', '°F')):
            raise ProviderError('invalid_response')
        entry = {'starts_at': start.isoformat(), 'ends_at': end.isoformat(),
                 'temperature_min': low['value'], 'temperature_max': high['value'], 'temperature_unit': low['unit']}
        for period in ('daytime', 'nighttime'):
            part = obj(raw.get(period))
            condition = obj(part.get('condition'))
            if not isinstance(condition.get('text'), str) or not condition['text'].strip():
                raise ProviderError('invalid_response')
            rain = obj(part.get('precipitation'))
            probability = number(rain.get('probability'))
            if probability is not None and not 0 <= probability <= 1:
                raise ProviderError('invalid_response')
            entry[period] = {'condition': clean_text(condition['text'], 80),
                'condition_code': clean_text(condition.get('code'), 10),
                'precipitation_probability_percent': round(probability * 100) if probability is not None else None,
                'wind_speed': number(obj(obj(part.get('wind')).get('speed')).get('value')),
                'wind_unit': clean_text(obj(obj(part.get('wind')).get('speed')).get('unit'), 20)}
        normalized.append(entry)
    return normalized


def normalize(kind, body):
    if not isinstance(body, dict):
        raise ProviderError('invalid_response')
    metadata = obj(body.get('metadata'))
    zero_alerts = kind == 'alerts' and metadata.get('zeroResult') is True
    attribution_values = metadata.get('attributions')
    # A successful zeroResult response may omit data fields entirely. Only this
    # explicit flag permits absent arrays; malformed/non-zero responses fail closed.
    if zero_alerts and attribution_values is None:
        attribution_values = []
    if not metadata or not isinstance(attribution_values, list):
        raise ProviderError('invalid_response')
    attributions = texts(attribution_values)
    # v1 supplies source statements as metadata.attributions, not legacy refer.
    base = {'attributions': attributions, 'refer': {'sources': ['QWeather']}, 'observed_at': None}
    if kind == 'weather':
        temperature = obj(body.get('temperature'))
        humidity = number(body.get('humidity'))
        condition = obj(body.get('condition'))
        if number(temperature.get('value')) is None or not condition.get('text'):
            raise ProviderError('invalid_response')
        wind = obj(body.get('wind'))
        speed = obj(wind.get('speed'))
        data = {'temperature': number(temperature.get('value')), 'temperature_unit': clean_text(temperature.get('unit'), 20),
                'humidity_percent': round(humidity * 100, 1) if humidity is not None and 0 <= humidity <= 1 else None,
                'condition': clean_text(condition.get('text'), 80), 'wind_speed': number(speed.get('value')),
                'wind_unit': clean_text(speed.get('unit'), 20), 'wind_direction': clean_text(obj(wind.get('direction')).get('compass'), 10)}
    elif kind == 'air':
        indexes = body.get('indexes')
        if not isinstance(indexes, list) or not indexes or not all(isinstance(item, dict) for item in indexes):
            raise ProviderError('invalid_response')
        # Never label a foreign index as China's AQI. Preserve its exact name/code.
        preferred = next((item for item in indexes if item.get('code') == 'chn-mee'), indexes[0])
        if number(preferred.get('aqi')) is None:
            raise ProviderError('invalid_response')
        pollutants = []
        pollutants_body = body.get('pollutants', [])
        if not isinstance(pollutants_body, list):
            raise ProviderError('invalid_response')
        for item in pollutants_body[:30]:
            item = obj(item)
            concentration = obj(item.get('concentration'))
            pollutants.append({'code': clean_text(item.get('code'), 30), 'name': clean_text(item.get('name'), 50),
                               'value': number(concentration.get('value')), 'unit': clean_text(concentration.get('unit'), 30)})
        data = {'aqi': number(preferred.get('aqi')), 'aqi_display': clean_text(preferred.get('aqiDisplay'), 30),
                'category': clean_text(preferred.get('category'), 100), 'index_name': clean_text(preferred.get('name'), 80),
                'index_code': clean_text(preferred.get('code'), 30), 'primary_pollutant': clean_text(obj(preferred.get('primaryPollutant')).get('name'), 80),
                'pollutants': pollutants, 'advice': clean_text(obj(obj(preferred.get('health')).get('advice')).get('generalPopulation'), 1500)}
    elif kind == 'forecast':
        data = {'days': forecast_days(body)}
    elif kind == 'alerts':
        entries = body.get('alerts')
        zero = metadata.get('zeroResult')
        if zero is True and entries is None:
            entries = []
        if not isinstance(entries, list) or len(entries) > 100 or not isinstance(zero, bool) or (zero and entries) or (not zero and not entries):
            raise ProviderError('invalid_response')
        items = []
        for entry in entries:
            entry = obj(entry)
            if not entry.get('id') or not entry.get('headline'):
                raise ProviderError('invalid_response')
            items.append({'id': clean_text(entry.get('id'), 100, complete=True), 'title': clean_text(entry.get('headline'), 3000, complete=True),
                          'description': clean_text(entry.get('description'), 120000, complete=True), 'instruction': clean_text(entry.get('instruction'), 120000, complete=True),
                          'sender': clean_text(entry.get('senderName'), 1500, complete=True), 'issued_at': clean_text(entry.get('issuedTime'), 50),
                          'effective_at': clean_text(entry.get('effectiveTime'), 50), 'expires_at': clean_text(entry.get('expireTime'), 50),
                          'severity': clean_text(entry.get('severity'), 30), 'color': clean_text(obj(entry.get('color')).get('code'), 30),
                          'message_type': clean_text(obj(entry.get('messageType')).get('code'), 30)})
        data = {'items': items, 'zero_result': zero}
    else:
        raise ProviderError('unsupported_kind')
    return {**base, 'data': data}


def fetch(kind, point):
    if kind not in PATHS:
        raise ProviderError('unsupported_kind')
    if kind == 'forecast':
        from .configuration import forecast_enabled
        if not forecast_enabled():
            raise ProviderError('forecast_disabled')
    if not configured() or not re.fullmatch(r'-?\d{1,2}\.\d{2}/-?\d{1,3}\.\d{2}', point):
        raise ProviderError('not_configured')
    latitude, longitude = map(float, point.split('/'))
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ProviderError('invalid_point')
    timeout = min(5, max(1, settings.QWEATHER_TIMEOUT_SECONDS))
    connection = http.client.HTTPSConnection(settings.QWEATHER_API_HOST, timeout=timeout, context=ssl.create_default_context())
    try:
        deadline = time.monotonic() + timeout * 3
        query = '?lang=zh&days=3' if kind == 'forecast' else '?lang=zh'
        connection.request('GET', PATHS[kind] + point + query, headers={
            'X-QW-Api-Key': settings.QWEATHER_API_KEY,
            'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'User-Agent': 'HYHQ-Weather/1.0',
        })
        response = connection.getresponse()
        status = response.status
        # http.client has no redirect or retry machinery: Location is never followed.
        if status != 200:
            raise ProviderError('upstream_http', status)
        chunks = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError('timeout')
            if connection.sock:
                connection.sock.settimeout(min(timeout, remaining))
            chunk = response.read1(min(16384, MAX_BYTES + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise ProviderError('response_too_large')
            chunks.append(chunk)
        raw = b''.join(chunks)
        encoding = response.getheader('Content-Encoding', '').lower()
        if encoding == 'gzip':
            decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
            raw = decompressor.decompress(raw, MAX_BYTES + 1)
            if len(raw) > MAX_BYTES or not decompressor.eof or decompressor.unused_data:
                raise ProviderError('response_too_large')
        elif encoding not in ('', 'identity'):
            raise ProviderError('invalid_response')
        body = json.loads(raw)
        return normalize(kind, body)
    except ProviderError:
        raise
    except (socket.timeout, TimeoutError):
        raise ProviderError('timeout') from None
    except (OSError, http.client.HTTPException, ValueError, TypeError, zlib.error):
        # Never log the upstream body, exception, request headers, or credentials.
        raise ProviderError('upstream_unavailable') from None
    finally:
        connection.close()
