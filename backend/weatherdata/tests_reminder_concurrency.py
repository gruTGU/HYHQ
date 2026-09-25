"""PostgreSQL delivery/withdrawal races; no external requests are made."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.core.cache import cache
from django.db import OperationalError, connection, connections, transaction
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from .models import WeatherCache, WeatherReminder, WeatherReminderAttempt
from . import provider, subscriptions
from .subscription_provider import DeliveryError
from .tests import make_location
from .tests_forecast import FORECAST, NOW, REMINDER_SETTINGS


@skipUnless(connection.vendor == 'postgresql', 'Requires real PostgreSQL row locks and independent transactions')
@override_settings(**REMINDER_SETTINGS)
class ReminderConcurrencyTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.location = make_location()
        self.user = User.objects.create_user(username='weather-concurrent-owner', auth_kind='wechat', wechat_openid='mock-concurrent-openid')
        self.clock = patch('weatherdata.subscriptions.timezone.now', return_value=NOW).start()
        self.send = patch('weatherdata.subscriptions.send_once').start()
        self.fetch = patch('weatherdata.provider.fetch', side_effect=AssertionError('Reminder cannot fetch weather')).start()
        self.addCleanup(patch.stopall)

    def ready(self):
        row = subscriptions.prepare_reminder(self.user, self.location.slug)
        row = subscriptions.consent_reminder(self.user, row.pk, row.template_id, 'accept')
        self.clock.return_value = row.scheduled_for
        WeatherCache.objects.create(location=self.location, kind='forecast', point=row.point, payload=provider.normalize('forecast', FORECAST), fetched_at=row.scheduled_for-timedelta(hours=1), expires_at=row.scheduled_for+timedelta(hours=3))
        return row

    def dispatch(self, reminder_id):
        connections.close_all()
        try:
            return subscriptions.dispatch_reminder(reminder_id)
        finally:
            connections['default'].close()

    def test_concurrent_prepare_and_consent_return_one_grant(self):
        barrier = threading.Barrier(5)
        def prepare(_):
            connections.close_all()
            try:
                user = User.objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                row = subscriptions.prepare_reminder(user, self.location.slug)
                return subscriptions.consent_reminder(user, row.pk, row.template_id, 'accept').pk
            finally:
                connections['default'].close()
        with ThreadPoolExecutor(max_workers=5) as pool:
            ids = list(pool.map(prepare, range(5)))
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(WeatherReminder.objects.count(), 1)
        self.assertEqual(WeatherReminder.objects.get().state, 'pending')
        self.send.assert_not_called(); self.fetch.assert_not_called()

    def test_competing_dispatchers_never_resend_an_ambiguous_delivery(self):
        row = self.ready()
        self.send.side_effect = DeliveryError('network_unknown', ambiguous=True)
        barrier = threading.Barrier(5)
        def dispatch(_):
            barrier.wait(timeout=10)
            return self.dispatch(row.pk)
        with ThreadPoolExecutor(max_workers=5) as pool:
            states = list(pool.map(dispatch, range(5)))
        self.assertTrue(all(state in ('sending', 'unknown') for state in states), states)
        row.refresh_from_db(); self.assertEqual(row.state, 'unknown')
        self.assertEqual(WeatherReminderAttempt.objects.count(), 1)
        self.send.assert_called_once(); self.fetch.assert_not_called()
        self.assertEqual(self.dispatch(row.pk), 'unknown')
        self.send.assert_called_once()

    def test_delivery_holds_real_account_lock_until_send_and_audit_finish(self):
        row = self.ready(); user_id = self.user.pk
        entered, release, probed = threading.Event(), threading.Event(), threading.Event()
        outcome = {}
        def sending(*args):
            entered.set()
            if not release.wait(10): raise AssertionError('Send was not released')
        self.send.side_effect = sending
        def delete():
            connections.close_all()
            try:
                snapshot = User.objects.get(pk=user_id)
                try:
                    with transaction.atomic():
                        User.objects.select_for_update(nowait=True).get(pk=user_id)
                        outcome['lock'] = 'not-held'
                except OperationalError as error:
                    if getattr(error.__cause__, 'sqlstate', None) != '55P03': raise
                    outcome['lock'] = 'held'
                finally:
                    probed.set()
                client = APIClient(); client.force_authenticate(snapshot)
                return client.delete('/api/v1/me/').status_code
            finally:
                probed.set(); connections['default'].close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            delivery = pool.submit(self.dispatch, row.pk)
            try:
                self.assertTrue(entered.wait(10), 'Sender did not reach mocked provider')
                deletion = pool.submit(delete)
                self.assertTrue(probed.wait(10), 'Account deletion did not probe the row lock')
                self.assertEqual(outcome.get('lock'), 'held')
                self.assertFalse(deletion.done(), 'Account deletion completed during the send')
            finally:
                release.set()
            self.assertEqual(delivery.result(timeout=10), 'sent')
            self.assertEqual(deletion.result(timeout=10), 204)
        self.assertFalse(User.objects.filter(pk=user_id).exists())
        self.assertFalse(WeatherReminder.objects.exists())
        self.assertFalse(WeatherReminderAttempt.objects.exists())
        self.send.assert_called_once()
