import io
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone as utc_timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from common.exceptions import ServiceError
from common.models import AuditLog
from . import provider
from .configuration import forecast_enabled, subscription_config
from .context import build_public_weather_context
from .models import WeatherCache, WeatherMonth, WeatherReminder, WeatherReminderAttempt, WeatherRequest
from .services import get_component, point_for, summary
from .subscription_provider import DeliveryError, access_token, send_once
from .subscriptions import cancel_reminder, consent_reminder, dispatch_reminder, prepare_reminder
from .tests import AIR, EMPTY_ALERTS, METADATA, TEST_SETTINGS, WEATHER, fixture_fetch, make_location

REAL_FETCH = provider.fetch

FORECAST_SETTINGS = {**TEST_SETTINGS, 'QWEATHER_FORECAST_ENABLED': True,
    'QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED': True, 'QWEATHER_FORECAST_TTL_SECONDS': 21600}
REMINDER_SETTINGS = {**FORECAST_SETTINGS, 'WEATHER_SUBSCRIPTIONS_ENABLED': True,
    'WEATHER_SUBSCRIPTIONS_CAPABILITY_CONFIRMED': True, 'WECHAT_APP_ID': 'wx-test-app',
    'WECHAT_APP_SECRET': 'test-private-secret', 'WEATHER_SUBSCRIPTION_TEMPLATE_ID': 'weather-template-test',
    'WEATHER_SUBSCRIPTION_FIELDS': {'location': 'thing1', 'condition': 'thing2', 'temperature': 'thing3', 'date': 'date4'}}
NOW = datetime(2026, 9, 23, 8, tzinfo=utc_timezone.utc)
DAY = {'forecastStartTime': '2026-09-23T22:00:00Z', 'forecastEndTime': '2026-09-24T22:00:00Z',
    'temperatureMin': {'value': 12, 'unit': '°C'}, 'temperatureMax': {'value': 23, 'unit': '°C'},
    'daytime': {'condition': {'text': '晴', 'code': '100'}, 'precipitation': {'probability': 0}},
    'nighttime': {'condition': {'text': '多云', 'code': '101'}, 'precipitation': {'probability': .5}}}
FORECAST = {'metadata': METADATA, 'days': [DAY]}


@override_settings(**FORECAST_SETTINGS)
class ForecastTests(TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        self.location = make_location()
        self.fetch = patch('weatherdata.services.provider.fetch', return_value=provider.normalize('forecast', FORECAST)).start()
        self.addCleanup(patch.stopall)

    def test_forecast_consumes_same_persistent_budget_and_cache(self):
        first = get_component(self.location, 'forecast')
        self.assertEqual(first['data']['days'][0]['daytime']['precipitation_probability_percent'], 0)
        self.assertEqual(first['attributions'], METADATA['attributions'])
        self.assertEqual(get_component(self.location, 'forecast'), first)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(WeatherMonth.objects.get().reserved, 1)
        self.assertGreaterEqual((first['expires_at']-first['fetched_at']).total_seconds(), 21600)
        with override_settings(QWEATHER_MONTHLY_LIMIT=1):
            self.assertEqual(get_component(self.location, 'weather')['reason'], 'budget_exhausted')
        self.assertEqual(self.fetch.call_count, 1)

    def test_existing_summary_does_not_implicitly_fetch_forecast(self):
        self.fetch.side_effect = fixture_fetch
        self.assertNotIn('forecast', summary(self.location))
        self.assertEqual(self.fetch.call_count, 3)
        self.assertFalse(WeatherRequest.objects.filter(kind='forecast').exists())

    def test_unconfirmed_forecast_does_not_spend(self):
        with override_settings(QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED=False):
            result = get_component(self.location, 'forecast')
            self.assertEqual(result['reason'], 'forecast_disabled')
            self.assertFalse(forecast_enabled())
            with self.assertRaises(provider.ProviderError):
                REAL_FETCH('forecast', '39.90/116.41')
        self.fetch.assert_not_called()
        self.assertFalse(WeatherRequest.objects.exists())

    def test_forecast_fetch_uses_only_fixed_daily_three_day_path(self):
        response = MagicMock(status=200)
        response.getheader.return_value = ''
        response.read1.side_effect = [json.dumps(FORECAST).encode(), b'']
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=connection):
            REAL_FETCH('forecast', '39.90/116.41')
        self.assertEqual(connection.request.call_args.args[:2], ('GET', '/weather/v1/daily/39.90/116.41?lang=zh&days=3'))

    def test_invalid_intervals_ranges_and_structure_rejected(self):
        mutations = [lambda b: b.update(days=[]), lambda b: b.update(days=[DAY]*4),
            lambda b: b['days'][0].update(forecastEndTime=DAY['forecastStartTime']),
            lambda b: b['days'][0].update(forecastStartTime='2026-09-24T00:00:00'),
            lambda b: b['days'][0]['temperatureMin'].update(value=24),
            lambda b: b['days'][0]['daytime']['precipitation'].update(probability=2),
            lambda b: b['days'][0]['daytime'].update(condition={}),
            lambda b: b['days'][0]['temperatureMin'].update(unit='K')]
        for mutation in mutations:
            body = deepcopy(FORECAST); mutation(body)
            with self.assertRaises(provider.ProviderError):
                provider.normalize('forecast', body)

    def test_forecast_api_requires_active_slug_and_rejects_arbitrary_arguments(self):
        client = APIClient()
        response = client.get('/api/v1/weather-data/beijing/forecast/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['location']['slug'], 'beijing')
        self.assertEqual(client.get('/api/v1/weather-data/beijing/forecast/?days=10').status_code, 400)
        self.assertEqual(client.get('/api/v1/weather-data/fake-campus/forecast/').status_code, 404)
        self.assertEqual(self.fetch.call_count, 1)


@override_settings(**FORECAST_SETTINGS)
class PublicWeatherContextTests(TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        self.location = make_location()
        self.cache = WeatherCache.objects.create(location=self.location, kind='weather', point=point_for(self.location),
            payload=provider.normalize('weather', WEATHER), fetched_at=NOW-timedelta(minutes=2), expires_at=NOW+timedelta(minutes=28))

    @patch('weatherdata.provider.fetch', side_effect=AssertionError('chat must not request weather'))
    def test_only_explicit_weather_slug_and_read_only_stable_context(self, fetch):
        for invalid in (None, '', 1, 'demo-campus'):
            self.assertEqual(build_public_weather_context(invalid, NOW)['status'], 'unavailable')
        first = build_public_weather_context('beijing', NOW)
        self.assertEqual(first, build_public_weather_context('beijing', NOW+timedelta(seconds=3)))
        json.dumps(first)
        self.assertEqual(first['components']['weather']['data']['temperature'], 21.5)
        self.assertEqual(first['components']['weather']['source_label'], '和风天气')
        self.assertIsInstance(first['components']['weather']['fetched_at'], str)
        self.assertFalse(WeatherRequest.objects.exists())
        self.assertFalse(WeatherMonth.objects.exists())
        self.assertEqual(WeatherCache.objects.count(), 1)
        fetch.assert_not_called()

    def test_expiration_withholds_stale_values_and_keeps_provenance(self):
        result = build_public_weather_context('beijing', NOW+timedelta(minutes=29))
        part = result['components']['weather']
        self.assertEqual(part['status'], 'stale')
        self.assertIsNone(part['data'])
        self.assertEqual(part['attributions'], METADATA['attributions'])
        self.assertEqual(result['status'], 'unavailable')

    def test_coordinate_change_or_disable_never_uses_old_cache(self):
        self.location.latitude = Decimal('39.91'); self.location.save()
        self.assertEqual(build_public_weather_context('beijing', NOW)['components']['weather']['reason'], 'not_cached')
        self.location.is_active = False; self.location.save()
        self.assertIsNone(build_public_weather_context('beijing', NOW)['location'])

    def test_future_missing_and_reversed_cache_times_withhold_values(self):
        for fetched, expires in ((NOW+timedelta(seconds=1), NOW+timedelta(hours=1)),
                                 (None, NOW+timedelta(hours=1)),
                                 (NOW-timedelta(minutes=2), NOW-timedelta(minutes=3))):
            self.cache.fetched_at, self.cache.expires_at = fetched, expires
            self.cache.save()
            part = build_public_weather_context('beijing', NOW)['components']['weather']
            self.assertEqual(part['status'], 'unavailable')
            self.assertEqual(part['reason'], 'invalid_cache_time')
            self.assertIsNone(part['data'])

    def test_weather_and_air_observation_times_fail_closed(self):
        cases = [(NOW-timedelta(hours=3), 'observation_too_old'),
                 (NOW+timedelta(minutes=10, seconds=1), 'invalid_observation_time'),
                 ('not-a-time', 'invalid_observation_time'),
                 ('2026-09-23T08:00:00', 'invalid_observation_time'),
                 ('', 'invalid_observation_time')]
        for kind, fixture in (('weather', WEATHER), ('air', AIR)):
            for observed, reason in cases:
                with self.subTest(kind=kind, observed=observed):
                    self.cache.kind = kind
                    self.cache.payload = provider.normalize(kind, fixture)
                    self.cache.payload['observed_at'] = observed.isoformat() if isinstance(observed, datetime) else observed
                    self.cache.save()
                    part = build_public_weather_context('beijing', NOW)['components'][kind]
                    self.assertEqual(part['reason'], reason)
                    self.assertIsNone(part['data'])
                    self.assertNotEqual(part['status'], 'fresh')

    def test_current_weather_and_air_maximum_age_applies_when_observation_is_unknown(self):
        for kind, fixture in (('weather', WEATHER), ('air', AIR)):
            self.cache.kind = kind
            self.cache.payload = provider.normalize(kind, fixture)
            self.cache.fetched_at, self.cache.expires_at = NOW-timedelta(hours=3), NOW+timedelta(hours=10)
            self.cache.save()
            part = build_public_weather_context('beijing', NOW)['components'][kind]
            self.assertEqual(part['reason'], 'cache_too_old')
            self.assertEqual(part['status'], 'stale')
            self.assertIsNone(part['data'])

    def test_missing_observation_and_small_clock_skew_are_explicit_and_stable(self):
        for observed in (None, (NOW-timedelta(minutes=40)).isoformat(), (NOW+timedelta(minutes=5)).isoformat()):
            self.cache.payload['observed_at'] = observed
            self.cache.save()
            first = build_public_weather_context('beijing', NOW)
            self.assertEqual(first, build_public_weather_context('beijing', NOW+timedelta(seconds=3)))
            self.assertEqual(first['components']['weather']['status'], 'fresh')
            self.assertEqual(first['components']['weather']['observed_at'], observed)
            json.dumps(first)

    def test_observation_age_boundary_invalidates_current_context_without_dynamic_age_fields(self):
        self.cache.payload['observed_at'] = (NOW-timedelta(hours=3, seconds=-1)).isoformat()
        self.cache.save()
        before = build_public_weather_context('beijing', NOW)
        after = build_public_weather_context('beijing', NOW+timedelta(seconds=1))
        self.assertEqual(before['components']['weather']['status'], 'fresh')
        self.assertEqual(after['components']['weather']['status'], 'stale')
        self.assertNotIn('age', after['components']['weather'])

    def test_forecast_removes_ended_periods_and_rejects_bad_intervals(self):
        self.cache.kind = 'forecast'
        self.cache.fetched_at = NOW-timedelta(hours=1)
        self.cache.payload = provider.normalize('forecast', FORECAST)
        self.cache.save()
        valid = build_public_weather_context('beijing', NOW)['components']['forecast']
        self.assertEqual(valid['status'], 'fresh')
        ended = deepcopy(valid['data']['days'][0])
        ended.update(starts_at=(NOW-timedelta(hours=12)).isoformat(), ends_at=NOW.isoformat())
        self.cache.payload['data']['days'] = [ended, valid['data']['days'][0]]
        self.cache.save()
        part = build_public_weather_context('beijing', NOW)['components']['forecast']
        self.assertTrue(part['expired_periods_omitted'])
        self.assertEqual(len(part['data']['days']), 1)
        self.cache.payload['data']['days'] = [ended]
        self.cache.save()
        part = build_public_weather_context('beijing', NOW)['components']['forecast']
        self.assertEqual(part['reason'], 'forecast_periods_ended')
        self.assertIsNone(part['data'])
        for changes in ({'starts_at': '2026-09-23T08:00:00'}, {'ends_at': 'invalid'},
                        {'starts_at': '2026-09-23T23:00:00Z', 'ends_at': '2026-09-23T22:00:00Z'},
                        {'starts_at': '2026-10-23T22:00:00Z', 'ends_at': '2026-10-24T22:00:00Z'},
                        {'starts_at': '2026-09-23T22:00:00Z', 'ends_at': '2026-09-26T22:00:00Z'}):
            self.cache.payload['data']['days'] = [{**valid['data']['days'][0], **changes}]
            self.cache.save()
            part = build_public_weather_context('beijing', NOW)['components']['forecast']
            self.assertEqual(part['reason'], 'invalid_forecast_period')
            self.assertIsNone(part['data'])

    def test_malformed_cache_and_alert_shapes_are_unavailable_not_runtime_errors(self):
        for kind, payload in (('weather', []), ('weather', {'data': 'wrong'}), ('alerts', {'data': {}})):
            self.cache.kind, self.cache.payload = kind, payload
            self.cache.save()
            part = build_public_weather_context('beijing', NOW)['components'][kind]
            self.assertEqual(part['status'], 'unavailable')
            self.assertEqual(part['reason'], 'invalid_cached_payload')
            self.assertIsNone(part['data'])


@override_settings(**REMINDER_SETTINGS)
class ReminderTests(TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        self.location = make_location()
        self.user = get_user_model().objects.create_user(username='wechat-reminder', auth_kind='wechat', wechat_openid='private-openid')
        self.now = patch('weatherdata.subscriptions.timezone.now', return_value=NOW).start()
        self.send = patch('weatherdata.subscriptions.send_once').start()
        self.fetch = patch('weatherdata.provider.fetch', side_effect=AssertionError('reminders must not fetch weather')).start()
        self.addCleanup(patch.stopall)

    def prepare(self):
        return prepare_reminder(self.user, 'beijing')

    def consent(self):
        row = self.prepare()
        return consent_reminder(self.user, row.pk, row.template_id, 'accept')

    def ready(self, row):
        self.now.return_value = row.scheduled_for
        WeatherCache.objects.create(location=self.location, kind='forecast', point=row.point,
            payload=provider.normalize('forecast', FORECAST), fetched_at=row.scheduled_for-timedelta(hours=1),
            expires_at=row.scheduled_for+timedelta(hours=5))

    def test_disabled_missing_capability_and_bad_template_fail_closed(self):
        for changes in ({'WEATHER_SUBSCRIPTIONS_ENABLED': False}, {'WEATHER_SUBSCRIPTIONS_CAPABILITY_CONFIRMED': False},
                        {'WEATHER_SUBSCRIPTION_FIELDS': {'location': []}}, {'WECHAT_APP_SECRET': ''}):
            with override_settings(**changes):
                self.assertFalse(subscription_config()['enabled'])
                with self.assertRaises(ServiceError): self.prepare()
        self.assertFalse(WeatherReminder.objects.exists())
        self.send.assert_not_called()

    def test_requires_real_wechat_account_and_only_explicit_acceptance(self):
        self.user.auth_kind = 'dev'; self.user.save()
        with self.assertRaises(ServiceError): self.prepare()
        self.user.auth_kind = 'wechat'; self.user.save()
        row = self.prepare()
        for acceptance in ('reject', 'ban', True, None):
            with self.assertRaises(ServiceError): consent_reminder(self.user, row.pk, row.template_id, acceptance)
        row.refresh_from_db(); self.assertIsNone(row.consented_at)
        self.assertEqual(row.state, 'prepared')

    def test_intent_and_acceptance_are_idempotent_and_only_one_active_date(self):
        row = self.consent()
        self.assertEqual(self.prepare().pk, row.pk)
        consent_reminder(self.user, row.pk, row.template_id, 'accept')
        self.assertEqual(WeatherReminder.objects.count(), 1)
        self.assertEqual(AuditLog.objects.filter(event='weather.reminder_consented').count(), 1)
        other = make_location('tianjin')
        with self.assertRaises(ServiceError): prepare_reminder(self.user, other.slug)

    def test_expired_consent_cannot_create_permission(self):
        row = self.prepare(); self.now.return_value = NOW+timedelta(minutes=11)
        with self.assertRaises(ServiceError): consent_reminder(self.user, row.pk, row.template_id, 'accept')
        replacement = self.prepare()
        self.assertNotEqual(row.pk, replacement.pk)
        row.refresh_from_db(); self.assertEqual(row.state, 'expired')

    def test_success_consumes_permission_once_and_records_no_secrets(self):
        row = self.consent(); self.ready(row)
        self.assertEqual(dispatch_reminder(row.pk), 'sent')
        self.assertEqual(dispatch_reminder(row.pk), 'sent')
        self.send.assert_called_once()
        self.assertEqual(WeatherReminderAttempt.objects.get().outcome, 'sent')
        args = self.send.call_args.args
        self.assertEqual(args[2]['thing3']['value'], '12~23°C')
        self.assertIn('和风天气', args[2]['thing2']['value'])
        self.assertEqual(args[3], 'pages/weather/index?location=beijing')
        self.assertNotIn('private-openid', json.dumps(list(AuditLog.objects.values('details'))))
        self.fetch.assert_not_called()
        self.assertFalse(WeatherRequest.objects.exists())

    def test_cancellation_is_owned_and_survives_disabled_gate(self):
        row = self.consent()
        other = get_user_model().objects.create_user(username='other')
        with self.assertRaises(ServiceError): cancel_reminder(other, row.pk)
        with override_settings(WEATHER_SUBSCRIPTIONS_ENABLED=False): cancel_reminder(self.user, row.pk)
        self.ready(row)
        self.assertEqual(dispatch_reminder(row.pk), 'cancelled')
        self.send.assert_not_called()

    def test_stale_missing_or_wrong_day_forecast_never_sends_or_spends(self):
        row = self.consent(); self.ready(row)
        WeatherCache.objects.update(expires_at=row.scheduled_for)
        self.assertEqual(dispatch_reminder(row.pk), 'waiting_cache')
        self.send.assert_not_called(); self.fetch.assert_not_called()
        self.assertEqual(WeatherReminderAttempt.objects.count(), 0)
        self.now.return_value = row.expires_at
        self.assertEqual(dispatch_reminder(row.pk), 'expired')

    def test_known_transient_failure_retries_bounded_and_success_stops(self):
        row = self.consent(); self.ready(row)
        self.send.side_effect = [DeliveryError('wechat_busy', retryable=True), None]
        self.assertEqual(dispatch_reminder(row.pk), 'retry')
        self.assertEqual(dispatch_reminder(row.pk), 'retry')
        self.assertEqual(self.send.call_count, 1)
        self.now.return_value += timedelta(minutes=5)
        self.assertEqual(dispatch_reminder(row.pk), 'sent')
        self.assertEqual(self.send.call_count, 2)

    def test_three_definite_failures_stop_without_fourth_attempt(self):
        row = self.consent(); self.ready(row)
        self.send.side_effect = DeliveryError('wechat_busy', retryable=True)
        for result, wait in (('retry', 5), ('retry', 10), ('failed', 10)):
            self.assertEqual(dispatch_reminder(row.pk), result)
            self.now.return_value += timedelta(minutes=wait)
        self.assertEqual(dispatch_reminder(row.pk), 'failed')
        self.assertEqual(self.send.call_count, 3)

    def test_provider_rejected_permission_does_not_retry(self):
        row = self.consent(); self.ready(row)
        self.send.side_effect = DeliveryError('permission_unavailable')
        self.assertEqual(dispatch_reminder(row.pk), 'failed')
        self.now.return_value += timedelta(minutes=10)
        self.assertEqual(dispatch_reminder(row.pk), 'failed')
        self.send.assert_called_once()

    def test_configuration_change_and_deleted_user_prevent_dispatch(self):
        row = self.consent(); self.ready(row)
        with override_settings(WEATHER_SUBSCRIPTION_TEMPLATE_ID='different-template'):
            self.assertEqual(dispatch_reminder(row.pk), 'expired')
        self.user.delete()
        self.assertEqual(dispatch_reminder(row.pk), 'missing')
        self.assertFalse(WeatherReminder.objects.exists())
        self.send.assert_not_called()

    def test_sending_lease_excludes_second_worker_and_cancel_does_not_claim_success(self):
        row = self.consent(); self.ready(row)
        WeatherReminder.objects.filter(pk=row.pk).update(state='sending', attempt_started_at=row.scheduled_for)
        self.assertEqual(dispatch_reminder(row.pk), 'sending')
        with self.assertRaises(ServiceError) as caught: cancel_reminder(self.user, row.pk)
        self.assertEqual(caught.exception.status_code, 409)
        self.send.assert_not_called()

    def test_ambiguous_or_crashed_send_is_never_retried(self):
        row = self.consent(); self.ready(row)
        self.send.side_effect = DeliveryError('network_unknown', ambiguous=True)
        self.assertEqual(dispatch_reminder(row.pk), 'unknown')
        self.assertEqual(dispatch_reminder(row.pk), 'unknown')
        self.send.assert_called_once()
        self.send.reset_mock()
        WeatherReminder.objects.filter(pk=row.pk).update(state='sending', attempt_started_at=row.scheduled_for-timedelta(minutes=3))
        self.assertEqual(dispatch_reminder(row.pk), 'unknown')
        self.send.assert_not_called()

    def test_changed_location_configuration_or_revoked_account_blocks_send(self):
        row = self.consent(); self.ready(row)
        self.location.latitude = Decimal('39.91'); self.location.save()
        self.assertEqual(dispatch_reminder(row.pk), 'expired')
        self.send.assert_not_called()

    def test_preview_command_never_sends(self):
        row = self.consent(); self.ready(row)
        output = io.StringIO(); call_command('weather_reminders', stdout=output)
        self.assertIn('未发送', output.getvalue())
        self.send.assert_not_called()
        self.fetch.assert_not_called()

    def test_private_api_cannot_read_or_mutate_another_users_grant(self):
        row = self.consent()
        client = APIClient()
        self.assertEqual(client.post('/api/v1/weather-data/reminders/intents/', {'location': 'beijing'}, format='json').status_code, 401)
        stranger = get_user_model().objects.create_user(username='stranger', auth_kind='wechat', wechat_openid='stranger-openid')
        client.force_authenticate(stranger)
        self.assertEqual(client.get('/api/v1/weather-data/reminders/').data['items'], [])
        response = client.post(f'/api/v1/weather-data/reminders/{row.pk}/consent/', {'template_id': row.template_id, 'acceptance': 'accept'}, format='json')
        self.assertEqual(response.status_code, 404)
        self.assertEqual(client.post('/api/v1/weather-data/reminders/intents/', [], format='json').status_code, 400)


@override_settings(**REMINDER_SETTINGS)
class ReminderTransportTests(TestCase):
    def setUp(self): cache.clear()

    @patch('weatherdata.subscription_provider._post')
    def test_token_is_cached_and_never_in_template_payload(self, post):
        post.side_effect = [{'access_token': 'private-token', 'expires_in': 7200}, {'errcode': 0}, {'errcode': 0}]
        for _ in range(2): send_once('private-openid', 'template', {'thing1': {'value': '北京'}}, 'pages/weather/index')
        self.assertEqual(post.call_count, 3)
        self.assertEqual(post.call_args_list[0].args[0], '/cgi-bin/stable_token')
        self.assertNotIn('private-token', json.dumps(post.call_args_list[-1].args[1]))

    @patch('weatherdata.subscription_provider._post')
    def test_explicit_expired_token_and_unknown_response_have_different_retry_rules(self, post):
        post.side_effect = [{'access_token': 'private-token', 'expires_in': 7200}, {'errcode': 42001}]
        with self.assertRaises(DeliveryError) as caught: send_once('openid', 'template', {}, 'pages/weather/index')
        self.assertTrue(caught.exception.retryable)
        self.assertFalse(caught.exception.ambiguous)
        post.side_effect = [{'access_token': 'private-token', 'expires_in': 7200}, {}]
        with self.assertRaises(DeliveryError) as caught: send_once('openid', 'template', {}, 'pages/weather/index')
        self.assertTrue(caught.exception.ambiguous)
        self.assertFalse(caught.exception.retryable)
