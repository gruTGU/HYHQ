"""Fail-closed feature gates; importing this module never reads credentials out."""
import hashlib
import json
import re

from django.conf import settings

from .provider import configured


def forecast_enabled():
    return bool(configured() and getattr(settings, 'QWEATHER_FORECAST_ENABLED', False)
                and getattr(settings, 'QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED', False))


def forecast_ttl():
    return min(86400, max(21600, int(getattr(settings, 'QWEATHER_FORECAST_TTL_SECONDS', 21600))))


def subscription_config():
    template = getattr(settings, 'WEATHER_SUBSCRIPTION_TEMPLATE_ID', '')
    fields = getattr(settings, 'WEATHER_SUBSCRIPTION_FIELDS', {})
    valid_fields = (isinstance(fields, dict) and set(fields) == {'location', 'condition', 'temperature', 'date'}
                    and all(isinstance(value, str) for value in fields.values()) and len(set(fields.values())) == 4
                    and all(isinstance(fields[key], str) and re.fullmatch(r'thing[1-9]\d*', fields[key])
                            for key in ('location', 'condition', 'temperature'))
                    and isinstance(fields['date'], str) and re.fullmatch(r'date[1-9]\d*', fields['date']))
    reason = ''
    if not getattr(settings, 'WEATHER_SUBSCRIPTIONS_ENABLED', False):
        reason = 'disabled'
    elif not getattr(settings, 'WEATHER_SUBSCRIPTIONS_CAPABILITY_CONFIRMED', False):
        reason = 'capability_unverified'
    elif not forecast_enabled():
        reason = 'forecast_disabled'
    elif not settings.WECHAT_APP_ID or not settings.WECHAT_APP_SECRET:
        reason = 'wechat_not_configured'
    elif not isinstance(template, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,128}', template) or not valid_fields:
        reason = 'template_not_configured'
    fingerprint = hashlib.sha256(json.dumps({'template': template, 'fields': fields,
        'appid': settings.WECHAT_APP_ID}, sort_keys=True).encode()).hexdigest() if not reason else ''
    return {'enabled': not reason, 'reason': reason, 'template_id': template if not reason else '',
            'fields': fields if not reason else {}, 'fingerprint': fingerprint}


def public_subscription_config():
    config = subscription_config()
    return {'enabled': config['enabled'], 'reason': config['reason'], 'template_id': config['template_id'],
            'mode': 'once', 'notice': '每次主动授权仅安排一次次日 08:00 天气提醒，可在发送前取消。'
            if config['enabled'] else '天气提醒暂未开放。'}
