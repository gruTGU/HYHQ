from django.core.cache import cache
import io
import json
from datetime import timedelta
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from weatherdata.models import WeatherCache, WeatherLocation, WeatherRequest
from weatherdata.services import point_for
from .context import build_messages, text_bytes
from .models import LLMSession
from .provider import ProviderError, _usage
from .public_context import build_public_context, revision_for
from .serializers import SessionSerializer, TurnSerializer
from .services import create_session, enqueue_turn
from .tests import RESPONSE
from .tests_scopes import PublicFixture
from .worker import process_one


class WeatherQualityTests(PublicFixture, TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        super().setUp()
        self.weather = WeatherLocation.objects.create(slug='tianjin-quality', name='天津市', latitude='39.10', longitude='117.20', coordinate_source='固定测试点')
        self.now = timezone.now()
        self.cache = WeatherCache.objects.create(location=self.weather, point=point_for(self.weather), kind='weather',
            payload={'data': {'temperature': 24, 'condition': '晴'}, 'observed_at': self.now.isoformat(), 'attributions': ['和风天气'], 'refer': {'sources': ['QWeather']}},
            fetched_at=self.now, expires_at=self.now + timedelta(hours=1))

    def weather_session(self):
        return create_session(self.user, {'scope': 'learn', 'source_type': 'content', 'source_id': self.content.pk, 'weather_location': self.weather.slug})

    def test_selected_weather_only_reads_cache_and_revision_is_stable(self):
        session = self.weather_session()
        with patch('weatherdata.provider.fetch') as fetch:
            context = build_public_context(session, self.content)
            second = build_public_context(session, self.content)
        self.assertEqual(context['weather']['location']['name'], '天津市')
        self.assertEqual(context['weather']['components']['weather']['status'], 'fresh')
        self.assertEqual(context['weather']['components']['weather']['data']['temperature'], 24)
        self.assertEqual(revision_for(context), revision_for(second))
        json.dumps(context)
        fetch.assert_not_called(); self.assertEqual(WeatherRequest.objects.count(), 0)

    def test_stale_missing_and_inactive_weather_never_supply_current_values(self):
        session = self.weather_session()
        WeatherCache.objects.filter(pk=self.cache.pk).update(fetched_at=self.now - timedelta(hours=2), expires_at=self.now - timedelta(seconds=1))
        context = build_public_context(session, self.content)['weather']
        self.assertEqual(context['components']['weather']['status'], 'stale')
        self.assertIsNone(context['components']['weather']['data'])
        self.assertEqual(context['components']['alerts']['status'], 'unavailable')
        self.weather.is_active = False; self.weather.save()
        self.assertEqual(build_public_context(session, self.content)['weather']['reason'], 'location_unavailable')

    def test_oversized_attribution_omits_component_without_breaking_primary_context(self):
        payload = dict(self.cache.payload, attributions=['完整归因' * 3000 for _ in range(31)])
        WeatherCache.objects.filter(pk=self.cache.pk).update(payload=payload)
        session = self.weather_session()
        context = build_public_context(session, self.content)
        self.assertLessEqual(len(json.dumps(context, ensure_ascii=False).encode()), 10000)
        self.assertEqual(context['current_page']['id'], str(self.content.pk))
        component = context['weather']['components']['weather']
        self.assertEqual(component['status'], 'unavailable')
        self.assertEqual(component['reason'], 'context_budget_exceeded')
        self.assertIsNone(component['data'])
        summary = SessionSerializer(session).data['weather_context']
        self.assertEqual(summary['status'], 'unavailable')
        self.assertLess(len(json.dumps(summary, ensure_ascii=False).encode()), 3500)
        self.assertNotIn('attributions', json.dumps(summary))

    def test_invalid_or_private_weather_selection_rejected_and_explicit_choice_round_trips(self):
        base = {'scope': 'learn', 'source_type': 'content', 'source_id': str(self.content.pk)}
        bad = self.api.post('/api/v1/llm/sessions/', dict(base, weather_location='unknown'))
        self.assertEqual(bad.status_code, 400)
        private = self.api.post('/api/v1/llm/sessions/', {'recognition_job_id': str(self.job().pk), 'weather_location': self.weather.slug})
        self.assertEqual(private.status_code, 400)
        valid = self.api.post('/api/v1/llm/sessions/', dict(base, weather_location=self.weather.slug))
        self.assertEqual(valid.status_code, 201)
        self.assertEqual(valid.json()['data']['weather_context']['location']['name'], '天津市')

    def test_weather_expiry_during_generation_discards_answer_but_keeps_provider_usage(self):
        turn = self.turn(self.weather_session())
        def respond(**kwargs):
            WeatherCache.objects.filter(pk=self.cache.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
            return RESPONSE
        with patch('llm.worker.provider.generate', side_effect=lambda *a, **kw: respond(**kw)):
            process_one()
        turn.refresh_from_db()
        self.assertEqual(turn.status, 'failed')
        self.assertEqual(turn.error_code, 'LLM_CONTEXT_CHANGED')
        self.assertEqual(turn.answer, '')
        self.assertEqual(turn.ledger.accounted_tokens, 160)

    def test_long_markdown_multiturn_and_current_source_buttons(self):
        session = self.weather_session()
        answer = '# 湿地观察\n\n' + ('- 结合已发布资料观察，保持适当距离。\n' * 120)
        first = self.turn(session)
        with patch('llm.worker.provider.generate', return_value={**RESPONSE, 'text': answer}):
            process_one()
        first.refresh_from_db()
        self.assertEqual(first.answer, answer)
        citations = TurnSerializer(first).data['citations']
        self.assertIn(str(self.content.pk), [row['id'] for row in citations])
        self.assertNotIn(str(self.draft.pk), [row['id'] for row in citations])
        second = self.turn(session, question='继续解释其中的观察方法')
        messages, _ = build_messages(second)
        self.assertTrue(any(row['role'] == 'assistant' for row in messages))
        self.assertLessEqual(text_bytes(messages), 16384)
        self.content.status = 'draft'; self.content.save()
        self.assertNotIn(str(self.content.pk), [row['id'] for row in TurnSerializer(first).data['citations']])

    def test_incomplete_response_has_no_partial_answer_and_idempotent_retry_does_not_redispatch(self):
        session = self.weather_session(); turn = self.turn(session)
        with patch('llm.worker.provider.generate', side_effect=ProviderError('LLM_RESPONSE_INCOMPLETE', '内容未完成', usage=RESPONSE['usage'], ambiguous=True)):
            process_one()
        turn.refresh_from_db(); self.assertEqual(turn.status, 'failed'); self.assertEqual(turn.answer, '')
        recovered, created = enqueue_turn(self.user, session.pk, {'request_id': turn.ledger.request_id, 'question': turn.question})
        self.assertFalse(created); self.assertEqual(recovered.pk, turn.pk)
        next_turn = self.turn(session, question='请简短说明')
        with patch('llm.worker.provider.generate', return_value=RESPONSE): process_one()
        next_turn.refresh_from_db(); self.assertEqual(next_turn.status, 'succeeded')

    def test_cache_receipts_and_aggregate_export_are_not_an_invoice(self):
        usage = dict(RESPONSE['usage'], prompt_cache_hit_tokens=100, prompt_cache_miss_tokens=20)
        self.assertEqual(_usage(usage), usage)
        self.assertIsNone(_usage(dict(usage, prompt_cache_hit_tokens=121)))
        self.assertIsNone(_usage(dict(usage, prompt_cache_hit_tokens=True)))
        turn = self.turn(self.weather_session())
        with patch('llm.worker.provider.generate', return_value=dict(RESPONSE, usage=usage)): process_one()
        out = io.StringIO(); call_command('llm_usage_report', day=turn.ledger.day.isoformat(), stdout=out)
        report = json.loads(out.getvalue())
        self.assertEqual(report['receipt_requests'], 1)
        self.assertEqual(report['prompt_cache_hit_tokens'], 100)
        self.assertFalse(report['invoice_verified'])
        self.assertNotIn(str(self.user.pk), out.getvalue())
        self.assertNotIn(turn.question, out.getvalue())
