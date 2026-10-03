import gzip
import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.management import call_command
from django.db import close_old_connections, connection
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from . import provider
from .models import WeatherCache, WeatherGate, WeatherLocation, WeatherMonth, WeatherRequest
from .services import BEIJING, get_component, point_for, reserve, summary

TEST_SETTINGS = dict(QWEATHER_ENABLED=True, QWEATHER_API_KEY='weather-unit-test-secret',
                     QWEATHER_API_HOST='test-account.qweatherapi.com', QWEATHER_MONTHLY_LIMIT=100,
                     QWEATHER_MINUTE_LIMIT=15, QWEATHER_CACHE_SECONDS={'weather': 1800, 'air': 3600, 'alerts': 900})
METADATA = {'tag': 'fixture', 'attributions': ['https://developer.qweather.com/attribution.html']}
WEATHER = {'metadata': METADATA, 'condition': {'text': '晴', 'code': '100'}, 'temperature': {'value': 21.5, 'unit': '°C'},
           'humidity': .52, 'wind': {'speed': {'value': 1.2, 'unit': 'm/s'}, 'direction': {'compass': 'n'}}}
AIR = {'metadata': METADATA, 'indexes': [{'code': 'chn-mee', 'name': 'AQI (CN)', 'aqi': 42, 'aqiDisplay': '42', 'category': '优'}],
       'pollutants': [{'code': 'pm2p5', 'name': 'PM 2.5', 'concentration': {'value': 10, 'unit': 'μg/m3'}}]}
EMPTY_ALERTS = {'metadata': {**METADATA, 'zeroResult': True}, 'alerts': []}


def make_location(slug='beijing'):
    return WeatherLocation.objects.create(slug=slug, name=slug, latitude=Decimal('39.90'), longitude=Decimal('116.41'), coordinate_source='test fixture')


def fixture_fetch(kind, point):
    return provider.normalize(kind, {'weather': WEATHER, 'air': AIR, 'alerts': EMPTY_ALERTS}[kind])


@override_settings(**TEST_SETTINGS)
class WeatherServiceTests(TestCase):
    def setUp(self):
        self.location = make_location()
        self.fetch = patch('weatherdata.services.provider.fetch', side_effect=fixture_fetch).start()
        self.addCleanup(patch.stopall)

    def test_summary_accounts_three_outbound_requests_and_hits_persistent_cache(self):
        first = summary(self.location)
        self.assertEqual(self.fetch.call_count, 3)
        self.assertEqual(WeatherMonth.objects.get().reserved, 3)
        self.assertEqual(WeatherRequest.objects.filter(outcome='succeeded').count(), 3)
        self.assertEqual(first['alerts']['status'], 'empty')
        self.assertEqual(first['weather']['data']['humidity_percent'], 52)
        self.assertIsNone(first['weather']['observed_at'])
        self.assertEqual(first['air']['data']['index_code'], 'chn-mee')
        self.assertEqual(summary(self.location), first)
        self.assertEqual(self.fetch.call_count, 3)

    @override_settings(QWEATHER_ENABLED=False)
    def test_disabled_does_not_spend_or_claim_empty_alerts(self):
        result = summary(self.location)
        self.assertEqual(result['alerts']['status'], 'unavailable')
        self.assertIsNone(result['alerts']['data'])
        self.assertFalse(WeatherRequest.objects.exists())
        self.fetch.assert_not_called()

    @override_settings(QWEATHER_MONTHLY_LIMIT=0, QWEATHER_FORECAST_ENABLED=True, QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED=True)
    def test_zero_allocation_blocks_all_reservations_even_with_valid_enabled_provider(self):
        self.assertTrue(provider.configured())
        for kind in ('weather', 'air', 'alerts', 'forecast'):
            _, reservation, reason = reserve(self.location, kind, timezone.now())
            self.assertIsNone(reservation)
            self.assertEqual(reason, 'budget_exhausted')
            self.assertEqual(get_component(self.location, kind)['reason'], 'budget_exhausted')
        output = io.StringIO()
        call_command('weather_refresh', location=self.location.slug, fetch=True, stdout=output)
        self.assertIn('本部署封顶 0', output.getvalue())
        self.assertEqual(WeatherMonth.objects.get().reserved, 0)
        self.assertFalse(WeatherRequest.objects.exists())
        self.fetch.assert_not_called()

    def test_zero_allocation_retains_old_spend_and_cache_without_refreshing(self):
        original = get_component(self.location, 'weather')
        self.assertEqual(self.fetch.call_count, 1)
        self.fetch.reset_mock()
        with override_settings(QWEATHER_MONTHLY_LIMIT=0):
            self.assertEqual(get_component(self.location, 'weather')['data'], original['data'])
            WeatherCache.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
            stale = get_component(self.location, 'weather')
            self.assertEqual(stale['status'], 'stale')
            self.assertEqual(stale['reason'], 'budget_exhausted')
            self.assertEqual(stale['data'], original['data'])
        self.assertEqual(WeatherMonth.objects.get().reserved, 1)
        self.assertEqual(WeatherRequest.objects.count(), 1)
        self.fetch.assert_not_called()

    @override_settings(QWEATHER_ENABLED=False, QWEATHER_MONTHLY_LIMIT=0)
    def test_disabled_zero_allocation_keeps_all_outbound_closed(self):
        result = summary(self.location)
        self.assertTrue(all(result[kind]['reason'] == 'not_configured' for kind in ('weather', 'air', 'alerts')))
        self.assertFalse(WeatherRequest.objects.exists())
        self.assertFalse(WeatherMonth.objects.exists())
        self.fetch.assert_not_called()

    @override_settings(QWEATHER_MONTHLY_LIMIT=1)
    def test_month_budget_stops_after_last_reservation_even_failure(self):
        self.fetch.side_effect = provider.ProviderError('timeout')
        result = summary(self.location)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(result['air']['reason'], 'budget_exhausted')
        self.assertEqual(WeatherMonth.objects.get().reserved, 1)
        self.assertEqual(WeatherRequest.objects.get().outcome, 'timeout')

    def test_cache_expiration_is_distinct_from_successful_empty_alerts(self):
        get_component(self.location, 'alerts')
        old = timezone.now() - timedelta(minutes=16)
        WeatherCache.objects.update(expires_at=old)
        self.fetch.side_effect = provider.ProviderError('upstream_http', 500)
        stale = get_component(self.location, 'alerts')
        self.assertEqual(stale['status'], 'stale')
        self.assertTrue(stale['stale'])
        self.assertEqual(stale['expires_at'], old)
        self.assertTrue(stale['data']['zero_result'])
        again = get_component(self.location, 'alerts')
        self.assertEqual(again['status'], 'stale')
        self.assertEqual(self.fetch.call_count, 2)

    def test_access_failure_opens_shared_circuit(self):
        self.fetch.side_effect = provider.ProviderError('upstream_http', 403)
        result = summary(self.location)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(result['air']['reason'], 'upstream_access_denied')
        self.assertGreater(WeatherGate.objects.get().blocked_until, timezone.now() + timedelta(hours=23))

    def test_rate_limit_circuit_and_all_attempts_count(self):
        self.fetch.side_effect = provider.ProviderError('upstream_http', 429)
        summary(self.location)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(WeatherMonth.objects.get().reserved, 1)

    @override_settings(QWEATHER_MINUTE_LIMIT=1)
    def test_minute_limit_serializes_different_services(self):
        result = summary(self.location)
        self.assertEqual(self.fetch.call_count, 1)
        self.assertEqual(result['air']['reason'], 'rate_limited')

    def test_active_lease_prevents_duplicate_dispatch(self):
        cache, reservation, reason = reserve(self.location, 'weather', timezone.now())
        self.assertIsNotNone(reservation)
        self.assertEqual(get_component(self.location, 'weather')['reason'], 'refreshing')
        self.assertEqual(WeatherRequest.objects.count(), 1)
        self.fetch.assert_not_called()

    def test_crashed_reservation_is_charged_and_expires_lease(self):
        reserve(self.location, 'weather', timezone.now())
        WeatherCache.objects.update(lease_until=timezone.now() - timedelta(seconds=1))
        get_component(self.location, 'weather')
        self.assertEqual(WeatherMonth.objects.get().reserved, 2)
        self.assertEqual(WeatherRequest.objects.filter(outcome='reserved').count(), 1)

    def test_coordinate_edit_never_reuses_old_cache(self):
        get_component(self.location, 'weather')
        self.location.latitude = Decimal('39.91')
        self.location.save()
        get_component(self.location, 'weather')
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(WeatherCache.objects.count(), 2)

    def test_inflight_location_disable_withholds_old_response(self):
        def disable(kind, point):
            WeatherLocation.objects.filter(pk=self.location.pk).update(is_active=False)
            return fixture_fetch(kind, point)
        self.fetch.side_effect = disable
        result = get_component(self.location, 'weather')
        self.assertIsNone(result['data'])
        self.assertEqual(result['reason'], 'location_unavailable')

    def test_unknown_kind_has_no_request_or_budget(self):
        for kind in ('cyclone', 'marine', 'solar', '../weather'):
            with self.assertRaises(ValueError):
                get_component(self.location, kind)
        self.assertFalse(WeatherRequest.objects.exists())

    @override_settings(QWEATHER_MONTHLY_LIMIT=1)
    def test_beijing_month_boundary_keeps_rolling_cap(self):
        before = datetime(2026, 9, 30, 15, 59, tzinfo=datetime_timezone.utc)
        after = before + timedelta(minutes=2)
        with patch('django.utils.timezone.now', return_value=before):
            reserve(self.location, 'weather', before)
        with patch('django.utils.timezone.now', return_value=after):
            _, reservation, reason = reserve(self.location, 'air', after)
        self.assertEqual(WeatherMonth.objects.get(month='2026-09').reserved, 1)
        self.assertIsNone(reservation)
        self.assertEqual(reason, 'budget_exhausted')
        self.assertEqual(WeatherMonth.objects.get(month='2026-10').reserved, 0)

    @override_settings(QWEATHER_MONTHLY_LIMIT=1)
    def test_rolling_cap_releases_only_after_31_days(self):
        before = datetime(2026, 8, 1, tzinfo=datetime_timezone.utc)
        with patch('django.utils.timezone.now', return_value=before):
            reserve(self.location, 'weather', before)
        after = before + timedelta(days=32)
        with patch('django.utils.timezone.now', return_value=after):
            _, request, reason = reserve(self.location, 'air', after)
        self.assertIsNotNone(request)
        self.assertEqual(reason, '')


@override_settings(**TEST_SETTINGS)
class WeatherProviderTests(TestCase):
    def response(self, data, status=200, encoding=''):
        content = json.dumps(data).encode()
        if encoding == 'gzip':
            content = gzip.compress(content)
        response = MagicMock(status=status)
        response.getheader.return_value = encoding
        response.read1.side_effect = [content, b'']
        conn = MagicMock()
        conn.getresponse.return_value = response
        return conn

    def test_fixed_https_header_secret_without_query_key(self):
        conn = self.response(WEATHER)
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=conn) as constructor:
            result = provider.fetch('weather', '39.90/116.41')
        self.assertEqual(result['data']['temperature'], 21.5)
        self.assertEqual(constructor.call_args.args[0], 'test-account.qweatherapi.com')
        args, kwargs = conn.request.call_args
        self.assertEqual(args, ('GET', '/weather/v1/current/39.90/116.41?lang=zh'))
        self.assertEqual(kwargs['headers']['X-QW-Api-Key'], 'weather-unit-test-secret')
        conn.request.assert_called_once()

    def test_gzip_and_attribution_preserved(self):
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=self.response(AIR, encoding='gzip')):
            result = provider.fetch('air', '39.90/116.41')
        self.assertEqual(result['attributions'], METADATA['attributions'])
        self.assertEqual(result['data']['pollutants'][0]['unit'], 'μg/m3')

    @override_settings(QWEATHER_API_HOST='mj2k5qy66r.re.qweatherapi.com')
    def test_regional_dedicated_host_is_valid(self):
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=self.response(WEATHER)) as constructor:
            provider.fetch('weather', '39.90/116.41')
        self.assertEqual(constructor.call_args.args[0], 'mj2k5qy66r.re.qweatherapi.com')

    def test_complete_attributions_and_long_official_warning_are_not_truncated(self):
        attribution = '声明' * 1500
        statements = [attribution] * 31
        result = provider.normalize('weather', {**WEATHER, 'metadata': {'attributions': statements}})
        self.assertEqual(result['attributions'], statements)
        description = '完整公告' * 2000
        warning = {'metadata': {**METADATA, 'zeroResult': False}, 'alerts': [{'id': 'warning', 'headline': '官方公告', 'description': description}]}
        self.assertEqual(provider.normalize('alerts', warning)['data']['items'][0]['description'], description)
        with self.assertRaises(provider.ProviderError):
            provider.normalize('weather', {**WEATHER, 'metadata': {'attributions': ['x' * 32001]}})

    def test_redirect_is_not_followed_and_does_not_read_body(self):
        conn = self.response(WEATHER, status=302)
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=conn):
            with self.assertRaises(provider.ProviderError) as caught:
                provider.fetch('weather', '39.90/116.41')
        self.assertEqual(caught.exception.status, 302)
        conn.request.assert_called_once()
        conn.getresponse.return_value.read1.assert_not_called()

    def test_host_injection_and_forbidden_endpoints_fail_before_http(self):
        with patch('weatherdata.provider.http.client.HTTPSConnection') as constructor:
            for host in ('https://test.qweatherapi.com', 'test.qweatherapi.com.evil.test', '127.0.0.1', 'test.qweatherapi.com/path', 'a@b.qweatherapi.com'):
                with override_settings(QWEATHER_API_HOST=host):
                    with self.assertRaises(provider.ProviderError):
                        provider.fetch('weather', '39.90/116.41')
            for kind in ('cyclone', 'marine', 'solar', 'https://evil.test'):
                with self.assertRaises(provider.ProviderError):
                    provider.fetch(kind, '39.90/116.41')
            for point in ('91.00/116.41', '39.90/181.00', '39.90/116.41?key=x', 'NaN/116.41'):
                with self.assertRaises(provider.ProviderError):
                    provider.fetch('weather', point)
        constructor.assert_not_called()

    def test_payload_cannot_claim_empty_on_malformed_warning(self):
        for body in ({'metadata': METADATA, 'alerts': []}, {'metadata': {**METADATA, 'zeroResult': False}, 'alerts': []},
                     {'metadata': {**METADATA, 'zeroResult': True}, 'alerts': [{'id': 'contradiction'}]},
                     {'metadata': {**METADATA, 'zeroResult': True}, 'alerts': {}},
                     {'metadata': {'zeroResult': True, 'attributions': 'wrong type'}},
                     {'metadata': {**METADATA, 'zeroResult': False}}, {'metadata': {'zeroResult': 'true'}}):
            with self.assertRaises(provider.ProviderError):
                provider.normalize('alerts', body)

    def test_explicit_zero_result_accepts_omitted_or_null_alerts(self):
        for body in ({'metadata': {**METADATA, 'zeroResult': True}},
                     {'metadata': {**METADATA, 'zeroResult': True}, 'alerts': None},
                     {'metadata': {'zeroResult': True}}):
            result = provider.normalize('alerts', body)
            self.assertEqual(result['data'], {'items': [], 'zero_result': True})
        self.assertEqual(provider.normalize('alerts', {'metadata': {**METADATA, 'zeroResult': True}})['attributions'], METADATA['attributions'])

    def test_alert_message_type_and_expiry_are_retained(self):
        result = provider.normalize('alerts', {'metadata': {**METADATA, 'zeroResult': False}, 'alerts': [{
            'id': 'x', 'headline': '预警取消', 'messageType': {'code': 'cancel'}, 'expireTime': '2026-09-21T10:00+08:00',
        }]})
        self.assertEqual(result['data']['items'][0]['message_type'], 'cancel')
        self.assertEqual(result['data']['items'][0]['expires_at'], '2026-09-21T10:00+08:00')

    def test_upstream_secret_echo_is_not_persisted(self):
        body = {**WEATHER, 'condition': {'text': 'weather-unit-test-secret'}}
        self.assertNotIn('weather-unit-test-secret', json.dumps(provider.normalize('weather', body)))

    def test_oversized_compressed_response_fails_closed(self):
        body = {**WEATHER, 'ignored': 'a' * (provider.MAX_BYTES + 100)}
        with patch('weatherdata.provider.http.client.HTTPSConnection', return_value=self.response(body, encoding='gzip')):
            with self.assertRaises(provider.ProviderError):
                provider.fetch('weather', '39.90/116.41')


@override_settings(**TEST_SETTINGS)
class WeatherAPITests(TestCase):
    def setUp(self):
        self.location = make_location()
        self.client = APIClient()

    @patch('weatherdata.services.provider.fetch', side_effect=fixture_fetch)
    def test_public_only_accepts_registered_locations(self, fetch):
        result = self.client.get('/api/v1/weather-data/locations/').json()['data']
        self.assertEqual(result['items'][0]['coordinate_system'], 'WGS84')
        self.assertNotIn('coordinate_source', result['items'][0])
        for suffix in ('', '?location=nope', '?location=beijing&lat=10', '?location=beijing&force=1', '?location=beijing&location=beijing'):
            self.assertIn(self.client.get('/api/v1/weather-data/summary/' + suffix).status_code, (400, 404))
        fetch.assert_not_called()
        response = self.client.get('/api/v1/weather-data/summary/?location=beijing')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('weather-unit-test-secret', response.content.decode())
        self.assertEqual(fetch.call_count, 3)

    def test_admin_budget_and_request_cannot_be_modified_even_by_superuser(self):
        request = RequestFactory().get('/admin/')
        request.user = get_user_model().objects.create_superuser(username='weathertest', password='safe-unit-test-password')
        for model in (WeatherMonth, WeatherRequest, WeatherCache):
            model_admin = admin.site._registry[model]
            self.assertFalse(model_admin.has_add_permission(request))
            self.assertFalse(model_admin.has_change_permission(request))
            self.assertFalse(model_admin.has_delete_permission(request))
        location_admin = admin.site._registry[WeatherLocation]
        self.assertTrue(location_admin.has_change_permission(request))
        request.user.is_superuser = False
        self.assertFalse(location_admin.has_change_permission(request))

    def test_configuration_command_rounds_upstream_precision_without_fetch(self):
        with patch('weatherdata.services.provider.fetch') as fetch:
            call_command('weather_location', slug='tianjin', name='天津', latitude='39.0851', longitude='117.1994', source='verified fixture', stdout=io.StringIO())
            call_command('weather_refresh', location='tianjin', stdout=io.StringIO())
        self.assertEqual(point_for(WeatherLocation.objects.get(slug='tianjin')), '39.09/117.20')
        fetch.assert_not_called()


@override_settings(**{**TEST_SETTINGS, 'QWEATHER_MONTHLY_LIMIT': 1})
class WeatherConcurrencyTests(TransactionTestCase):
    def test_last_budget_slot_is_reserved_once_across_database_connections(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Production quota lock requires PostgreSQL')
        locations = [make_location('place-' + str(index)) for index in range(6)]
        barrier = threading.Barrier(6)
        def attempt(location_id):
            close_old_connections()
            try:
                location = WeatherLocation.objects.get(pk=location_id)
                barrier.wait(timeout=10)
                _, reservation, reason = reserve(location, 'weather', timezone.now())
                return bool(reservation), reason
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=6) as pool:
            result = list(pool.map(attempt, [item.pk for item in locations]))
        self.assertEqual(sum(sent for sent, reason in result), 1)
        self.assertEqual(WeatherMonth.objects.get().reserved, 1)
        self.assertEqual(WeatherRequest.objects.count(), 1)

    @override_settings(QWEATHER_MONTHLY_LIMIT=100)
    def test_singleflight_same_location_kind_has_one_reservation(self):
        if connection.vendor != 'postgresql':
            self.skipTest('Production cache lock requires PostgreSQL')
        location = make_location()
        barrier = threading.Barrier(5)
        def attempt(index):
            close_old_connections()
            try:
                item = WeatherLocation.objects.get(pk=location.pk)
                barrier.wait(timeout=10)
                return bool(reserve(item, 'weather', timezone.now())[1])
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=5) as pool:
            result = list(pool.map(attempt, range(5)))
        self.assertEqual(sum(result), 1)
        self.assertEqual(WeatherRequest.objects.count(), 1)
