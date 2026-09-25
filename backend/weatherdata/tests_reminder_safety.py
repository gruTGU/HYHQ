"""Adversarial reminder lifecycle tests; never call WeChat or QWeather."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone

from common.exceptions import ServiceError
from . import provider, subscriptions
from .models import WeatherCache, WeatherReminder, WeatherReminderAttempt, WeatherRequest
from .services import get_component
from .subscription_provider import DeliveryError, access_token, token_key
from .tests import make_location
from .tests_forecast import FORECAST, NOW, REMINDER_SETTINGS


@override_settings(**REMINDER_SETTINGS)
class ReminderSafetyTests(TestCase):
    def setUp(self):
        self.location = make_location()
        self.user = get_user_model().objects.create_user(username='reminder-race', auth_kind='wechat', wechat_openid='mock-openid')
        self.clock = patch('weatherdata.subscriptions.timezone.now', return_value=NOW).start()
        self.send = patch('weatherdata.subscriptions.send_once').start()
        self.fetch = patch('weatherdata.provider.fetch', side_effect=AssertionError('reminder must not fetch weather')).start()
        self.addCleanup(patch.stopall)

    def prepared(self):
        return subscriptions.prepare_reminder(self.user, self.location.slug)

    def ready(self):
        row = self.prepared()
        subscriptions.consent_reminder(self.user, row.pk, row.template_id, 'accept')
        self.clock.return_value = row.scheduled_for
        WeatherCache.objects.create(location=self.location, kind='forecast', point=row.point,
            payload=provider.normalize('forecast', FORECAST), fetched_at=row.scheduled_for - timedelta(hours=1),
            expires_at=row.scheduled_for + timedelta(hours=3))
        return row

    def test_preparing_after_template_change_never_reuses_old_template_authorization(self):
        old = self.prepared()
        with override_settings(WEATHER_SUBSCRIPTION_TEMPLATE_ID='replacement-template-test'):
            new = self.prepared()
        old.refresh_from_db()
        self.assertEqual(old.state, 'expired')
        self.assertEqual(old.last_code, 'configuration_changed')
        self.assertNotEqual(new.pk, old.pk)
        self.assertEqual(new.template_id, 'replacement-template-test')
        self.send.assert_not_called()

    def test_authentication_snapshot_cannot_prepare_or_consent_after_account_revocation(self):
        prepared = self.prepared()
        get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
        for action in [lambda: subscriptions.prepare_reminder(self.user, self.location.slug),
                       lambda: subscriptions.consent_reminder(self.user, prepared.pk, prepared.template_id, 'accept')]:
            with self.assertRaises(ServiceError) as error: action()
            self.assertEqual(error.exception.status_code, 401)
        prepared.refresh_from_db(); self.assertEqual(prepared.state, 'prepared'); self.assertIsNone(prepared.consented_at)
        self.send.assert_not_called()

    def test_deleted_authentication_snapshot_returns_auth_error_without_recreating_data(self):
        snapshot = get_user_model().objects.get(pk=self.user.pk)
        self.user.delete()
        with self.assertRaises(ServiceError) as error: subscriptions.prepare_reminder(snapshot, self.location.slug)
        self.assertEqual(error.exception.status_code, 401)
        self.assertFalse(WeatherReminder.objects.exists())

    def test_account_deleted_after_durable_claim_but_before_delivery_prevents_send(self):
        row = self.ready(); deliver = subscriptions.deliver_claim
        def deleted_before_send(*args):
            get_user_model().objects.get(pk=self.user.pk).delete()
            return deliver(*args)
        with patch('weatherdata.subscriptions.deliver_claim', side_effect=deleted_before_send):
            self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'removed')
        self.send.assert_not_called(); self.assertFalse(WeatherReminderAttempt.objects.exists())

    def test_revocation_after_durable_claim_is_rechecked_before_outbound_request(self):
        row = self.ready(); deliver = subscriptions.deliver_claim
        def disabled_before_send(*args):
            get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
            return deliver(*args)
        with patch('weatherdata.subscriptions.deliver_claim', side_effect=disabled_before_send):
            self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'expired')
        self.send.assert_not_called(); row.refresh_from_db(); self.assertEqual(row.last_code, 'consent_unavailable')

    def test_gate_disabled_between_claim_and_send_blocks_outbound_request(self):
        row = self.ready(); deliver = subscriptions.deliver_claim
        def disable_gate(*args):
            with override_settings(WEATHER_SUBSCRIPTIONS_ENABLED=False): return deliver(*args)
        with patch('weatherdata.subscriptions.deliver_claim', side_effect=disable_gate):
            self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'expired')
        self.send.assert_not_called(); self.fetch.assert_not_called()

    def test_cached_evidence_is_rechecked_between_claim_and_send(self):
        row = self.ready(); deliver = subscriptions.deliver_claim
        def expire_cache(*args):
            WeatherCache.objects.update(expires_at=self.clock.return_value)
            return deliver(*args)
        with patch('weatherdata.subscriptions.deliver_claim', side_effect=expire_cache):
            self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'expired')
        self.send.assert_not_called()

    def test_malformed_cached_forecast_never_crashes_batch_or_calls_a_provider(self):
        row = self.ready(); good = WeatherCache.objects.get().payload
        for mutate in [lambda p: p.update(data=[]), lambda p: p['data'].update(days=[{}]),
                       lambda p: p['data']['days'][0].update(starts_at='bad'),
                       lambda p: p['data']['days'][0].update(starts_at='2026-09-24T08:00:00'),
                       lambda p: p['data']['days'][0].update(temperature_min='SECRET'),
                       lambda p: p['data']['days'][0].update(temperature_max=False)]:
            body = deepcopy(good); mutate(body)
            WeatherCache.objects.update(payload=body)
            WeatherReminder.objects.filter(pk=row.pk).update(next_attempt_at=None)
            self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'waiting_cache')
        self.send.assert_not_called(); self.fetch.assert_not_called(); self.assertFalse(WeatherReminderAttempt.objects.exists())

    def test_zero_weather_budget_never_fetches_forecast(self):
        with override_settings(QWEATHER_MONTHLY_LIMIT=0):
            result = get_component(self.location, 'forecast')
        self.assertEqual(result['reason'], 'budget_exhausted')
        self.fetch.assert_not_called(); self.send.assert_not_called()
        self.assertFalse(WeatherRequest.objects.exists())

    def test_worker_interruption_after_message_may_have_sent_is_not_retried(self):
        row = self.ready()
        self.send.side_effect = RuntimeError('simulated worker crash after network')
        with self.assertRaises(RuntimeError): subscriptions.dispatch_reminder(row.pk)
        row.refresh_from_db(); self.assertEqual(row.state, 'sending')
        self.clock.return_value += timedelta(minutes=3)
        self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'unknown')
        self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'unknown'); self.send.assert_called_once()

    def test_second_retry_is_not_scheduled_outside_its_actual_ten_minute_window(self):
        row = self.ready()
        WeatherReminder.objects.filter(pk=row.pk).update(attempts=1, expires_at=self.clock.return_value + timedelta(minutes=8))
        self.send.side_effect = DeliveryError('wechat_busy', retryable=True)
        self.assertEqual(subscriptions.dispatch_reminder(row.pk), 'failed')
        self.send.assert_called_once()


@override_settings(**REMINDER_SETTINGS)
class ReminderTokenSafetyTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_appsecret_rotation_does_not_reuse_token_for_old_credentials(self):
        with patch('weatherdata.subscription_provider._post', side_effect=[{'access_token': 'mock-first', 'expires_in': 7200}, {'access_token': 'mock-second', 'expires_in': 7200}]) as post:
            first_key = token_key(); self.assertEqual(access_token(), 'mock-first')
            with override_settings(WECHAT_APP_SECRET='rotated-test-secret'):
                self.assertNotEqual(token_key(), first_key); self.assertEqual(access_token(), 'mock-second')
            self.assertEqual(post.call_count, 2)
            self.assertNotIn('rotated-test-secret', token_key())

    def test_token_error_or_wrong_type_never_becomes_cached_authorization(self):
        for result in [{'access_token': 'invalid', 'expires_in': 7200, 'errcode': 40013},
                       {'access_token': 'invalid', 'expires_in': True},
                       {'access_token': 'x' * 1025, 'expires_in': 7200}]:
            with patch('weatherdata.subscription_provider._post', return_value=result), self.assertRaises(DeliveryError): access_token()
            self.assertIsNone(cache.get(token_key()))
