"""Transport compatibility and PostgreSQL TLS preservation (no network calls)."""
import uuid
from types import SimpleNamespace

from django.core.exceptions import ImproperlyConfigured
from django.test import RequestFactory, SimpleTestCase, override_settings
from rest_framework.request import Request

from accounts.serializers import UserSerializer
from assets.serializers import AssetSerializer
from config.database import postgres_database
from .pagination import StandardPagination


class DatabaseConfigurationTests(SimpleTestCase):
    def test_tls_and_timeout_reach_driver_and_credentials_are_decoded(self):
        config = postgres_database('postgresql://user:p%40ss@db.internal:6432/hyhq?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem&connect_timeout=5&application_name=hyhq-cloud')
        self.assertEqual(config['PASSWORD'], 'p@ss')
        self.assertEqual(config['PORT'], 6432)
        self.assertEqual(config['OPTIONS'], {'sslmode': 'verify-full', 'sslrootcert': '/certs/ca.pem',
                                           'connect_timeout': 5, 'application_name': 'hyhq-cloud'})

    def test_typo_duplicate_invalid_and_blank_options_fail_without_leaking(self):
        for suffix in ('sslmod=require', 'sslmode=require&sslmode=disable', 'sslmode=', 'sslmode=invalid',
                       'connect_timeout=0', 'connect_timeout=90', 'connect_timeout=bad', 'sslmode', '#fragment'):
            with self.subTest(suffix=suffix), self.assertRaises(ImproperlyConfigured) as failure:
                postgres_database('postgres://user:private-db-password@db/hyhq?' + suffix)
            self.assertNotIn('private-db-password', str(failure.exception))

    def test_legacy_connection_and_client_certificates(self):
        config = postgres_database('postgres://user:pw@127.0.0.1/hyhq')
        self.assertEqual(config['OPTIONS'], {})
        config = postgres_database('postgres://user:pw@db/hyhq?sslcert=%2Fcerts%2Fclient.pem&sslkey=%2Fcerts%2Fclient.key')
        self.assertEqual(config['OPTIONS']['sslcert'], '/certs/client.pem')
        self.assertEqual(config['OPTIONS']['sslkey'], '/certs/client.key')


class CloudResponsePathsTests(SimpleTestCase):
    def setUp(self):
        self.request = RequestFactory().get('/api/v1/places/?page_size=1', HTTP_HOST='testserver')

    def test_asset_and_avatar_urls_follow_explicit_transport_setting(self):
        key = uuid.uuid4()
        asset = SimpleNamespace(pk=key)
        user = SimpleNamespace(avatar_id=key, avatar=SimpleNamespace(expires_at=None))
        for enabled, prefix in ((False, 'http://testserver'), (True, '')):
            with self.subTest(enabled=enabled), override_settings(CLOUD_TRANSFER_ENABLED=enabled):
                expected = prefix + f'/api/v1/uploads/{key}/content/?variant=thumbnail'
                self.assertEqual(AssetSerializer(context={'request': self.request}).get_thumbnail_url(asset), expected)
                self.assertEqual(UserSerializer(context={'request': self.request}).get_avatar_url(user), expected)

    def test_cloud_pagination_has_no_container_hostname(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled), override_settings(CLOUD_TRANSFER_ENABLED=enabled):
                paginator = StandardPagination()
                records = paginator.paginate_queryset([1, 2], Request(self.request))
                response = paginator.get_paginated_response(records)
                next_url = response.data['meta']['next']
                self.assertEqual(next_url.startswith('/api/v1/'), enabled)
                self.assertIn('page=2', next_url)
                self.assertIsNone(response.data['meta']['previous'])
