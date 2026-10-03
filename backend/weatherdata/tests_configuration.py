"""Reload real settings with isolated environment and no local credential reads."""
import importlib.util
import os
from pathlib import Path
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase


class WeatherBudgetConfigurationTests(SimpleTestCase):
    def load_settings(self, limit, enabled='0'):
        filename = Path(__file__).resolve().parent.parent / 'config' / 'settings.py'
        spec = importlib.util.spec_from_file_location('config._weather_budget_test', filename)
        module = importlib.util.module_from_spec(spec)
        environment = {
            'ENV': 'production', 'DJANGO_DEBUG': '0',
            'DJANGO_SECRET_KEY': 'unit-test-only-secret-with-at-least-32-characters',
            'DJANGO_ALLOWED_HOSTS': 'unit.invalid',
            'DATABASE_URL': 'postgresql://unit:unit-only@127.0.0.1:1/unit',
            'QWEATHER_MONTHLY_LIMIT': str(limit), 'QWEATHER_ENABLED': enabled,
        }
        # settings' .env loader and directory initialization must not touch any
        # operator configuration or runtime files during this import-only test.
        with patch.dict(os.environ, environment, clear=True), patch.object(Path, 'is_file', return_value=False), patch.object(Path, 'mkdir'):
            spec.loader.exec_module(module)
        return module

    def test_production_zero_allocation_loads_with_gate_off_or_on(self):
        for enabled in ('0', '1'):
            with self.subTest(enabled=enabled):
                settings = self.load_settings(0, enabled)
                self.assertEqual(settings.QWEATHER_MONTHLY_LIMIT, 0)
                self.assertEqual(settings.QWEATHER_ENABLED, enabled == '1')

    def test_positive_allocation_boundaries_remain_supported(self):
        for limit in (1, 1000, 25000, 30000):
            with self.subTest(limit=limit):
                self.assertEqual(self.load_settings(limit).QWEATHER_MONTHLY_LIMIT, limit)

    def test_negative_excessive_and_noninteger_allocations_fail(self):
        for value in (-1, 30001, '1.5', 'invalid'):
            with self.subTest(value=value), self.assertRaises((ImproperlyConfigured, ValueError)):
                self.load_settings(value)
