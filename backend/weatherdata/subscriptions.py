"""One explicit user consent, one reminder; cached forecast only, no weather fetch."""
from datetime import datetime, time, timedelta
import math
from urllib.parse import urlencode

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from common.audit import audit
from common.exceptions import ServiceError
from .configuration import subscription_config
from .models import WeatherCache, WeatherLocation, WeatherReminder, WeatherReminderAttempt
from .services import BEIJING, point_for
from .subscription_provider import DeliveryError, send_once

ACTIVE = ('prepared', 'pending', 'sending', 'retry')
CANCELLABLE = ('prepared', 'pending', 'retry')


def require_enabled(user):
    config = subscription_config()
    if not config['enabled']:
        raise ServiceError('天气提醒暂未开放。', 'WEATHER_REMINDERS_DISABLED', 503)
    if not user.is_active or user.auth_kind != 'wechat' or not user.wechat_openid:
        raise ServiceError('天气提醒需要使用微信账号登录。', 'WECHAT_LOGIN_REQUIRED', 403)
    return config


def locked_active_user(user):
    current = get_user_model().objects.select_for_update().filter(pk=user.pk, is_active=True).first()
    if current is None:
        raise ServiceError('登录已过期，请重新登录。', 'AUTH_REQUIRED', 401)
    return current


def locked_delivery(reminder_id):
    # Account deletion locks the user first. Keep this order in both dispatch
    # phases to avoid reminder→user / user→reminder deadlocks on PostgreSQL.
    user_id = WeatherReminder.objects.filter(pk=reminder_id).values_list('user_id', flat=True).first()
    if user_id is None or not get_user_model().objects.select_for_update().filter(pk=user_id).exists():
        return None
    return WeatherReminder.objects.select_for_update(of=('self',)).select_related('location', 'user').filter(pk=reminder_id, user_id=user_id).first()


def public_reminder(reminder):
    return {'id': str(reminder.pk), 'location': reminder.location.slug, 'location_name': reminder.location.name,
            'target_date': reminder.target_date.isoformat(), 'scheduled_for': reminder.scheduled_for,
            'state': reminder.state, 'consented_at': reminder.consented_at, 'completed_at': reminder.completed_at,
            'can_cancel': reminder.state in CANCELLABLE, 'last_code': reminder.last_code,
            'template_id': reminder.template_id if reminder.state == 'prepared' else ''}


@transaction.atomic
def prepare_reminder(user, location_slug, now=None):
    now = now or timezone.now()
    user = locked_active_user(user)
    config = require_enabled(user)
    location = WeatherLocation.objects.filter(slug=location_slug, is_active=True).first()
    if location is None:
        raise ServiceError('天气地点不存在。', 'WEATHER_LOCATION_NOT_FOUND', 404)
    target = now.astimezone(BEIJING).date() + timedelta(days=1)
    scheduled = datetime.combine(target, time(8), tzinfo=BEIJING)
    expired = WeatherReminder.objects.select_for_update().filter(user=user, state='prepared', consent_expires_at__lte=now)
    for row in expired:
        row.state, row.completed_at, row.last_code = 'expired', now, 'consent_expired'
        row.save(update_fields=['state', 'completed_at', 'last_code'])
        audit('weather.reminder_expired', user, row.pk, code='consent_expired')
    existing = WeatherReminder.objects.select_for_update(of=('self',)).filter(user=user, target_date=target, state__in=ACTIVE).select_related('location').first()
    if existing and existing.state != 'sending':
        reason = ''
        if existing.config_fingerprint != config['fingerprint'] or existing.template_id != config['template_id']:
            reason = 'configuration_changed'
        elif not existing.location.is_active or point_for(existing.location) != existing.point:
            reason = 'location_changed'
        if reason:
            # Do not ask the user to authorize a template that the consent
            # endpoint will reject, or silently reuse a relocated weather point.
            existing.state, existing.last_code, existing.completed_at = 'expired', reason, now
            existing.save(update_fields=['state', 'last_code', 'completed_at'])
            audit('weather.reminder_expired', user, existing.pk, code=reason)
            existing = None
    if existing:
        if existing.location_id == location.pk:
            return existing
        raise ServiceError('明早已有其他地点的提醒，请先取消后重新选择。', 'WEATHER_REMINDER_EXISTS', 409)
    if WeatherReminder.objects.filter(user=user, created_at__gte=now-timedelta(days=1)).count() >= 10:
        raise ServiceError('操作较频繁，请稍后再试。', 'WEATHER_REMINDER_RATE_LIMITED', 429)
    row = WeatherReminder.objects.create(user=user, location=location, point=point_for(location),
        template_id=config['template_id'], config_fingerprint=config['fingerprint'], target_date=target,
        scheduled_for=scheduled, expires_at=scheduled+timedelta(hours=2), consent_expires_at=now+timedelta(minutes=10))
    audit('weather.reminder_prepared', user, row.pk, status='prepared')
    return row


@transaction.atomic
def consent_reminder(user, reminder_id, template_id, acceptance, now=None):
    now = now or timezone.now()
    user = locked_active_user(user)
    config = require_enabled(user)
    row = WeatherReminder.objects.select_for_update().select_related('location').filter(pk=reminder_id, user=user).first()
    if row is None:
        raise ServiceError('提醒记录不存在。', 'NOT_FOUND', 404)
    if (acceptance != 'accept' or template_id != row.template_id or row.config_fingerprint != config['fingerprint']):
        raise ServiceError('本次提醒授权无效，请重新操作。', 'WEATHER_CONSENT_INVALID')
    # Replaying the same acknowledgement never creates another delivery permission.
    if row.consented_at is not None:
        return row
    if row.state != 'prepared' or row.consent_expires_at <= now or row.scheduled_for <= now:
        raise ServiceError('本次提醒设置已失效，请重新操作。', 'WEATHER_CONSENT_EXPIRED', 409)
    if not row.location.is_active or point_for(row.location) != row.point:
        raise ServiceError('天气地点已变化，请重新设置。', 'WEATHER_LOCATION_CHANGED', 409)
    row.state, row.consented_at = 'pending', now
    row.save(update_fields=['state', 'consented_at'])
    audit('weather.reminder_consented', user, row.pk, status='pending')
    return row


@transaction.atomic
def cancel_reminder(user, reminder_id):
    user = locked_active_user(user)
    row = WeatherReminder.objects.select_for_update().select_related('location').filter(pk=reminder_id, user=user).first()
    if row is None:
        raise ServiceError('提醒记录不存在。', 'NOT_FOUND', 404)
    if row.state == 'sending':
        raise ServiceError('提醒正在发送，请稍后查看结果。', 'WEATHER_REMINDER_SENDING', 409)
    if row.state in CANCELLABLE:
        row.state, row.completed_at = 'cancelled', timezone.now()
        row.save(update_fields=['state', 'completed_at'])
        audit('weather.reminder_cancelled', user, row.pk, status='cancelled')
    return row


def _forecast_message(row, config, now):
    cached = WeatherCache.objects.filter(location=row.location, point=row.point, kind='forecast',
        fetched_at__lte=now, expires_at__gt=now).first()
    if not cached or not cached.payload:
        return None
    # Cache rows can survive schema changes or an interrupted maintenance edit.
    # Reject malformed evidence without stopping the whole reminder batch.
    try:
        days = cached.payload['data']['days']
        if not isinstance(days, list) or not 1 <= len(days) <= 3:
            return None
        day, previous_end = None, None
        for entry in days:
            start, end = parse_datetime(entry['starts_at']), parse_datetime(entry['ends_at'])
            low, high = entry['temperature_min'], entry['temperature_max']
            condition = entry['daytime']['condition']
            if (not start or not end or timezone.is_naive(start) or timezone.is_naive(end) or end <= start
                    or (previous_end is not None and start < previous_end)
                    or any(type(value) not in (float, int) or not math.isfinite(value) for value in (low, high))
                    or low > high or entry['temperature_unit'] not in ('°C', '°F')
                    or not isinstance(condition, str) or not condition.strip()):
                return None
            previous_end = end
            if start.astimezone(BEIJING).date() == row.target_date and end > now:
                day = entry
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return None
    if not day:
        return None
    values = {'location': row.location.name, 'condition': day['daytime']['condition'][:13] + ' · 和风天气',
        'temperature': f"{day['temperature_min']:g}~{day['temperature_max']:g}{day['temperature_unit']}",
        'date': row.target_date.isoformat()}
    # The configured template is intentionally restricted to three thing fields
    # (20 characters each) and one date field. No arbitrary user text is forwarded.
    return {config['fields'][name]: {'value': value[:20] if name != 'date' else value} for name, value in values.items()}


def dispatch_reminder(reminder_id, now=None):
    now = now or timezone.now()
    config = subscription_config()
    if not config['enabled']:
        return 'disabled'
    with transaction.atomic():
        row = locked_delivery(reminder_id)
        if row is None:
            return 'missing'
        if row.state == 'sending':
            if row.attempt_started_at and row.attempt_started_at <= now-timedelta(minutes=2):
                # A crashed worker could have completed the provider call: hold it.
                row.state, row.last_code, row.completed_at = 'unknown', 'worker_interrupted', now
                row.save(update_fields=['state', 'last_code', 'completed_at'])
                row.delivery_attempts.filter(number=row.attempts).update(outcome='worker_interrupted', completed_at=now)
                audit('weather.reminder_unknown', row.user, row.pk, code=row.last_code)
            return row.state
        if row.state not in ('pending', 'retry') or row.scheduled_for > now or (row.next_attempt_at and row.next_attempt_at > now):
            return row.state
        reason = ''
        if row.expires_at <= now:
            reason = 'delivery_window_expired'
        elif not row.consented_at or not row.user.is_active or row.user.auth_kind != 'wechat' or not row.user.wechat_openid:
            reason = 'consent_unavailable'
        elif not row.location.is_active or point_for(row.location) != row.point:
            reason = 'location_changed'
        elif row.config_fingerprint != config['fingerprint']:
            reason = 'configuration_changed'
        if reason:
            row.state, row.last_code, row.completed_at = 'expired', reason, now
            row.save(update_fields=['state', 'last_code', 'completed_at'])
            audit('weather.reminder_expired', row.user, row.pk, code=reason)
            return row.state
        message = _forecast_message(row, config, now)
        if message is None:
            row.last_code, row.next_attempt_at = 'fresh_forecast_required', now+timedelta(minutes=10)
            row.save(update_fields=['last_code', 'next_attempt_at'])
            return 'waiting_cache'
        row.state, row.attempt_started_at, row.attempts = 'sending', now, row.attempts+1
        row.save(update_fields=['state', 'attempt_started_at', 'attempts'])
        attempt = WeatherReminderAttempt.objects.create(reminder=row, number=row.attempts)
        audit('weather.reminder_dispatching', row.user, row.pk, count=row.attempts)
    # The durable claim survives a crash. Reacquire the account before sending;
    # a deletion/revocation that won the intervening race prevents the API call.
    return deliver_claim(reminder_id, row.attempts)


@transaction.atomic
def deliver_claim(reminder_id, attempt_number):
    current = locked_delivery(reminder_id)
    if current is None:
        return 'removed'
    if current.state != 'sending' or current.attempts != attempt_number:
        return current.state
    now = timezone.now()
    config = subscription_config()
    reason = ''
    if not config['enabled'] or current.config_fingerprint != config['fingerprint']:
        reason = 'configuration_changed'
    elif not current.user.is_active or current.user.auth_kind != 'wechat' or not current.user.wechat_openid or not current.consented_at:
        reason = 'consent_unavailable'
    elif current.expires_at <= now:
        reason = 'delivery_window_expired'
    elif not current.location.is_active or point_for(current.location) != current.point:
        reason = 'location_changed'
    message = _forecast_message(current, config, now) if not reason else None
    if not reason and message is None:
        reason = 'fresh_forecast_required'
    if reason:
        current.state, current.last_code, current.completed_at = 'expired', reason, now
        current.save(update_fields=['state', 'last_code', 'completed_at'])
        current.delivery_attempts.filter(number=attempt_number).update(outcome=reason, completed_at=now)
        audit('weather.reminder_expired', current.user, current.pk, code=reason)
        return current.state
    error = None
    try:
        # Hold the user lock across the bounded network operation. The existing
        # account-deletion transaction therefore completes entirely before this
        # check or after this send, never between the check and the API request.
        send_once(current.user.wechat_openid, current.template_id, message,
                  'pages/weather/index?' + urlencode({'location': current.location.slug}))
    except DeliveryError as exc:
        error = exc
    completed = timezone.now()
    if error is None:
        current.state, current.last_code = 'sent', ''
    elif error.ambiguous:
        current.state, current.last_code = 'unknown', error.code
    elif error.retryable and current.attempts < 3 and completed+timedelta(minutes=5 * current.attempts) < current.expires_at:
        current.state, current.last_code = 'retry', error.code
        current.next_attempt_at = completed+timedelta(minutes=5 * current.attempts)
    else:
        current.state, current.last_code = 'failed', error.code
    if current.state != 'retry':
        current.completed_at = completed
    current.save(update_fields=['state', 'last_code', 'next_attempt_at', 'completed_at'])
    current.delivery_attempts.filter(number=attempt_number).update(completed_at=completed, outcome=current.last_code or 'sent')
    audit('weather.reminder_' + current.state, current.user, current.pk, code=current.last_code, count=current.attempts)
    return current.state
