"""Three daily quota buckets and server-owned public-page interpretation contexts."""
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone as dt_timezone
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.db import close_old_connections, connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from common.exceptions import ServiceError
from ecology.models import DataSource, Metric, Observation, Place, Region, SimulationRun, SimulationScenario, Station, WaterBody
from knowledge.models import Content, Route, RouteStop
from .context import build_messages, text_bytes
from .models import LLMSession, LLMTurn, UsageLedger
from .provider import ProviderError
from .public_context import MAX_PUBLIC_CONTEXT_BYTES, build_public_context
from .services import cleanup_expired, create_session, delete_session, enqueue_turn, quota
from .tests import Fixture, RESPONSE
from .worker import process_one


class PublicFixture(Fixture):
    def setUp(self):
        super().setUp()
        self.region = Region.objects.create(slug='scope-campus', name='公开区域', description='虚构示范环境', is_demo=True)
        self.place = Place.objects.create(region=self.region, slug='scope-place', name='公开河流', kind='river', description='最新公开地点介绍')
        self.water = WaterBody.objects.create(place=self.place, description='当前水体描述')
        self.hidden_place = Place.objects.create(region=self.region, slug='scope-hidden', name='隐藏点位秘密', kind='park', description='不应外发的地点正文', is_published=False)
        self.content = Content.objects.create(slug='scope-content', title='当前科普文章', body='新的公开生态正文', summary='公开文章摘要', status='published', place=self.place, source='教师已发布资料')
        self.draft = Content.objects.create(slug='scope-draft', title='未发布文章秘密', body='隐藏草稿正文', status='draft', place=self.place)
        self.hidden_linked = Content.objects.create(slug='scope-hidden-linked', title='隐藏地点关联文章', body='不属于区域通用资料', status='published', place=self.hidden_place)
        self.route = Route.objects.create(region=self.region, slug='scope-route', title='公开学习路线', published=True, description='从水体开始学习')
        RouteStop.objects.create(route=self.route, place=self.place, order=1, note='观察公开水体')
        RouteStop.objects.create(route=self.route, place=self.hidden_place, order=2, note='隐藏节点不得转发')

    def public_session(self, scope='explore', source_type='region', source=None, owner=None):
        source = source or self.region
        return create_session(owner or self.user, {'scope': scope, 'source_type': source_type, 'source_id': source.pk})


class ScopeBehaviorTests(PublicFixture, TestCase):
    def test_new_contract_defaults_and_legacy_consent_no_longer_gate(self):
        job = self.job()
        response = self.api.post('/api/v1/llm/sessions/', {'recognition_job_id': str(job.pk)})
        self.assertEqual(response.status_code, 201)
        data = response.json()['data']
        self.assertEqual((data['scope'], data['source_type'], data['source_id']), ('recognition', 'recognition_job', str(job.pk)))
        self.assertFalse(data['include_image'])
        legacy = self.api.post('/api/v1/llm/sessions/', {'recognition_job_id': str(job.pk), 'consent_version': 'old'})
        self.assertEqual(legacy.status_code, 201)
        self.complete(self.turn(LLMSession.objects.get(pk=legacy.json()['data']['id'])))
        public = self.api.post('/api/v1/llm/sessions/', {'scope': 'learn', 'source_type': 'content', 'source_id': str(self.content.pk)})
        self.assertEqual(public.status_code, 201)
        data = public.json()['data']
        self.assertEqual((data['kind'], data['scope'], data['source_type']), ('learn', 'learn', 'content'))
        self.assertEqual(data['source_region_id'], str(self.region.pk))
        self.assertFalse(data['include_image'])
        self.assertFalse(data['image_available'])

    def test_input_cannot_inject_context_identity_or_switch_source_bucket(self):
        original = {'scope': 'explore', 'source_type': 'place', 'source_id': str(self.place.pk)}
        invalid = [dict(original, prompt='冒充系统提示'), dict(original, context={'body': '伪造'}),
                   dict(original, owner=str(self.other.pk)), dict(original, include_image=True),
                   dict(original, scope='learn'), dict(original, source_type='route', source_id=str(self.route.pk)),
                   dict(original, recognition_job_id=str(self.job().pk)), {'scope': 'learn', 'source_type': 'region'},
                   {'scope': 'invalid', 'source_type': 'region', 'source_id': str(self.region.pk)}]
        for payload in invalid:
            self.assertEqual(self.api.post('/api/v1/llm/sessions/', payload).status_code, 400)
        self.assertFalse(LLMSession.objects.exists())

    def test_status_accepts_scope_and_returns_model_without_private_public_quota(self):
        self.complete(self.turn(self.public_session(scope='learn')))
        for scope, used in [('recognition', 0), ('explore', 0), ('learn', 1)]:
            response = self.api.get('/api/v1/llm/status/?scope=' + scope)
            data = response.json()['data']
            self.assertEqual((data['scope'], data['model'], data['quota']['used']), (scope, 'deepseek-flash', used))
            self.assertNotIn('5', data['notice'])
            public = APIClient().get('/api/v1/llm/status/?scope=' + scope).json()['data']
            self.assertIsNone(public['quota'])
        for query in ['scope=bad', 'scope=learn&scope=explore']:
            self.assertEqual(self.api.get('/api/v1/llm/status/?' + query).status_code, 400)

    def test_each_scope_allows_five_rounds_for_fifteen_total(self):
        sessions = {'recognition': self.session(), 'explore': self.public_session(), 'learn': self.public_session(scope='learn')}
        for scope, session in sessions.items():
            for _ in range(5):
                self.complete(self.turn(session))
            self.assertEqual(quota(self.user, scope=scope)['used'], 5)
            with self.assertRaises(ServiceError) as caught:
                self.turn(session)
            self.assertEqual(caught.exception.get_codes(), 'LLM_DAILY_LIMIT')
        self.assertEqual(UsageLedger.objects.filter(status='succeeded').count(), 15)
        self.assertEqual(set(UsageLedger.objects.values_list('scope', flat=True)), set(sessions))

    def test_flower_and_river_share_recognition_bucket(self):
        sessions = [self.session(), self.session(kind='assessment')]
        for index in range(5):
            self.complete(self.turn(sessions[index % 2]))
        for session in sessions:
            with self.assertRaises(ServiceError) as caught:
                self.turn(session)
            self.assertEqual(caught.exception.get_codes(), 'LLM_DAILY_LIMIT')
        self.assertEqual(quota(self.user, scope='explore')['remaining'], 5)
        self.assertEqual(quota(self.user, scope='learn')['remaining'], 5)

    def test_three_buckets_keep_admission_day_when_completion_crosses_beijing_midnight(self):
        before = datetime(2026, 9, 20, 15, 59, 50, tzinfo=dt_timezone.utc)
        after = before + timedelta(seconds=20)
        with patch('llm.services.timezone.now', return_value=before):
            for scope in ['recognition', 'explore']:
                session = self.session() if scope == 'recognition' else self.public_session()
                self.complete(self.turn(session))
            pending = self.turn(self.public_session(scope='learn'))
        with patch('llm.services.timezone.now', return_value=after):
            self.complete(pending)
            for scope in ['recognition', 'explore', 'learn']:
                self.assertEqual(quota(self.user, scope=scope)['used'], 0)
                self.assertEqual(quota(self.user, now=before, scope=scope)['used'], 1)

    def test_account_deletion_retains_scope_in_content_free_global_ledger(self):
        for scope in ['explore', 'learn']:
            self.complete(self.turn(self.public_session(scope=scope)))
        self.user.delete()
        self.assertFalse(LLMSession.objects.exists())
        self.assertFalse(LLMTurn.objects.exists())
        self.assertEqual(set(UsageLedger.objects.values_list('scope', flat=True)), {'explore', 'learn'})
        self.assertFalse(UsageLedger.objects.exclude(owner=None, session=None).exists())

    def test_reservation_and_attempt_limit_scoped_but_user_concurrency_global(self):
        explore = self.public_session()
        turn = self.turn(explore)
        self.assertEqual(quota(self.user, scope='explore')['reserved'], 1)
        self.assertEqual(quota(self.user, scope='learn')['reserved'], 0)
        with self.assertRaises(ServiceError) as caught:
            self.turn(self.public_session(scope='learn'))
        self.assertEqual(caught.exception.get_codes(), 'LLM_USER_BUSY')
        with patch('llm.worker.provider.generate', side_effect=ProviderError('LLM_PROVIDER_RATE_LIMIT', '稍后重试')):
            process_one()
            for _ in range(9):
                self.turn(explore)
                process_one()
        with self.assertRaises(ServiceError) as caught:
            self.turn(explore)
        self.assertEqual(caught.exception.get_codes(), 'LLM_ATTEMPT_LIMIT')
        self.complete(self.turn(self.public_session(scope='learn')))
        self.assertEqual(quota(self.user, scope='learn')['used'], 1)
        self.assertEqual(quota(self.user, scope='explore')['used'], 0)

    def test_ledger_scope_survives_session_and_source_deletion(self):
        session = self.public_session(scope='learn', source_type='content', source=self.content)
        turn, _ = self.complete(self.turn(session))
        entry_id = turn.ledger_id
        self.content.delete()
        entry = UsageLedger.objects.get(pk=entry_id)
        self.assertEqual(entry.scope, 'learn')
        self.assertIsNone(entry.session_id)
        self.assertEqual(quota(self.user, scope='learn')['used'], 1)
        self.assertEqual(quota(self.user, scope='recognition')['used'], 0)
        recognition, _ = self.complete()
        delete_session(self.user, recognition.session_id)
        self.assertEqual(quota(self.user, scope='recognition')['used'], 1)

    def test_cross_scope_request_id_cannot_replay_into_another_bucket(self):
        first = self.public_session()
        second = self.public_session(scope='learn')
        request_id = uuid.uuid4()
        turn = self.turn(first, request_id=request_id)
        self.complete(turn)
        with self.assertRaises(ServiceError) as caught:
            self.turn(second, request_id=request_id)
        self.assertEqual(caught.exception.get_codes(), 'REQUEST_ID_CONFLICT')
        self.assertEqual(UsageLedger.objects.count(), 1)

    def test_private_session_and_turn_stay_owner_only_and_history_filters_scope(self):
        own = self.public_session(scope='learn')
        self.public_session(scope='explore')
        other = self.public_session(scope='learn', owner=self.other)
        other_turn = self.turn(other, owner=self.other)
        data = self.api.get('/api/v1/llm/sessions/?scope=learn').json()['data']
        self.assertEqual([item['id'] for item in data], [str(own.pk)])
        self.assertEqual(self.api.get(f'/api/v1/llm/turns/{other_turn.pk}/').status_code, 404)
        self.assertEqual(self.api.delete(f'/api/v1/llm/sessions/{other.pk}/').status_code, 404)

    def test_source_region_id_hides_hidden_content_association(self):
        public = self.public_session(scope='learn', source_type='content', source=self.hidden_linked)
        data = self.api.get(f'/api/v1/llm/sessions/{public.pk}/').json()['data']
        self.assertIsNone(data['source_region_id'])
        messages, _ = build_messages(self.turn(public))
        self.assertNotIn(str(self.hidden_place.pk), json.dumps(messages))

    def test_scope_prompt_and_current_server_material_with_hidden_nodes_excluded(self):
        for scope, source_type, source, phrase in [('explore', 'place', self.place, '生态导览助手'),
                ('explore', 'water', self.water, '生态导览助手'), ('learn', 'content', self.content, '科普智游助手'),
                ('learn', 'route', self.route, '科普智游助手')]:
            session = self.public_session(scope, source_type, source)
            turn = self.turn(session)
            messages, used_image = build_messages(turn)
            wire = json.dumps(messages, ensure_ascii=False)
            self.assertIn(phrase, messages[0]['content'])
            self.assertIn('公开', wire)
            self.assertNotIn('隐藏点位秘密', wire)
            self.assertNotIn('未发布文章秘密', wire)
            self.assertFalse(used_image)
            self.assertLessEqual(text_bytes(messages), 16384)
            with patch('llm.worker.provider.generate', return_value=RESPONSE):
                process_one()

    def test_public_context_distinguishes_home_weather_from_missing_live_ai_weather(self):
        for scope, source_type, source in [
            ('explore', 'region', self.region), ('explore', 'place', self.place),
            ('explore', 'water', self.water), ('learn', 'content', self.content),
            ('learn', 'route', self.route),
        ]:
            with self.subTest(source_type=source_type):
                session = self.public_session(scope, source_type, source)
                context = build_public_context(session, source)
                self.assertIn('首页已提供部分地点的天气与预警查询', context['notice'])
                self.assertIn('本次对话上下文不包含实时天气或预警', context['notice'])
                self.assertNotIn('未接入真实气象预警', context['notice'])
                self.assertNotIn('weather', context)
                self.assertNotIn('alerts', context)

    def test_public_data_reloaded_after_create_and_no_client_snapshot(self):
        session = self.public_session('learn', 'content', self.content)
        Content.objects.filter(pk=self.content.pk).update(body='改稿后必须采用的新正文')
        turn, mocked = self.complete(self.turn(session))
        wire = json.dumps(mocked.call_args.args[0], ensure_ascii=False)
        self.assertIn('改稿后必须采用的新正文', wire)
        self.assertNotIn('新的公开生态正文', wire)
        self.assertEqual(LLMTurn.objects.get(pk=turn.pk).context_revision.__len__(), 64)

    def test_measurement_context_preserves_source_batch_quality_and_visibility(self):
        station = Station.objects.create(region=self.region, water_body=self.water, code='llm-water', name='模拟水站', kind='water')
        metric = Metric.objects.create(code='llm-ph', name='pH', unit='pH', station_kind='water')
        scenario = SimulationScenario.objects.create(code='normal', name='正常演示')
        now = timezone.now()
        sources = [DataSource.objects.create(code=f'llm-source-{i}', name=f'演示源 {i}', kind='simulation') for i in range(2)]
        runs = []
        for index, source in enumerate(sources):
            run = SimulationRun.objects.create(key=f'llm-run-{index}', scenario=scenario, source=source,
                start=now-timedelta(hours=2), end=now+timedelta(hours=1), seed=1, status='succeeded')
            Observation.objects.create(station=station, metric=metric, value=None, quality_status='missing',
                observed_at=now-timedelta(minutes=5), source=source, simulation_run=run, dedupe_key=f'llm-observation-{index}')
            runs.append(run)
        session = self.public_session('explore', 'water', self.water)
        ambiguous = build_public_context(session, self.water)['measurements'][0]
        self.assertEqual(ambiguous['status'], 'ambiguous_source')
        self.assertNotIn('metrics', ambiguous)
        DataSource.objects.filter(pk=sources[1].pk).update(is_active=False)
        sample = build_public_context(session, self.water)['measurements'][0]
        self.assertEqual(sample['simulation_run_id'], str(runs[0].pk))
        self.assertTrue(sample['is_simulated'])
        self.assertIsNone(sample['metrics'][0]['value'])
        self.assertEqual(sample['metrics'][0]['quality'], 'missing')
        self.assertIn('非实时实测', sample['notice'])
        Station.objects.filter(pk=station.pk).update(is_active=False)
        self.assertEqual(build_public_context(session, self.water)['measurements'], [])

    def test_large_quoted_public_material_still_fits_request(self):
        Content.objects.filter(pk=self.content.pk).update(body='"\\' * 10000, summary='"' * 2000, source='"' * 500)
        source = Content.objects.get(pk=self.content.pk)
        session = self.public_session('learn', 'content', source)
        context = build_public_context(session, source)
        self.assertLessEqual(len(json.dumps(context, ensure_ascii=False).encode()), MAX_PUBLIC_CONTEXT_BYTES)
        messages, _ = build_messages(self.turn(session))
        self.assertLessEqual(text_bytes(messages), 16384)

    def test_long_primary_body_and_descriptions_are_explicit_excerpts(self):
        self.content.body = '生态正文' * 1000
        self.content.save(update_fields=['body'])
        session = self.public_session('learn', 'content', self.content)
        context = build_public_context(session, self.content)
        self.assertTrue(context['current_page']['body_truncated'])
        self.assertLessEqual(len(context['current_page']['body'].encode()), 4200)
        self.assertFalse(context['current_page']['summary_truncated'])
        self.assertNotIn('primary_material_truncated', context)
        messages, _ = build_messages(self.turn(session))
        self.assertIn('不得声称读完全文', messages[0]['content'])
        self.place.description = '地点描述' * 500
        self.route.description = '路线描述' * 500
        for scope, kind, source in [('explore', 'place', self.place), ('learn', 'route', self.route)]:
            context = build_public_context(self.public_session(scope, kind, source), source)
            self.assertTrue(context['current_page']['description_truncated'])

    def test_unpublished_primary_source_hidden_and_cannot_dispatch(self):
        session = self.public_session('learn', 'content', self.content)
        turn = self.turn(session)
        Content.objects.filter(pk=self.content.pk).update(status='draft')
        with patch('llm.worker.provider.generate') as mocked:
            process_one()
        mocked.assert_not_called()
        turn.refresh_from_db()
        self.assertEqual(turn.error_code, 'SOURCE_UNAVAILABLE')
        self.assertEqual(self.api.get(f'/api/v1/llm/sessions/{session.pk}/').status_code, 404)
        self.assertEqual(quota(self.user, scope='learn')['used'], 0)
        self.assertEqual(cleanup_expired(dry_run=True)['sessions'], 1)

    def test_source_deleted_during_provider_does_not_restore_content(self):
        session = self.public_session('learn', 'content', self.content)
        turn = self.turn(session)
        entry_id = turn.ledger_id
        def remove(*args, **kwargs):
            self.content.delete()
            return RESPONSE
        with patch('llm.worker.provider.generate', side_effect=remove):
            process_one()
        self.assertFalse(LLMTurn.objects.filter(pk=turn.pk).exists())
        entry = UsageLedger.objects.get(pk=entry_id)
        self.assertEqual((entry.scope, entry.status, entry.accounted_tokens), ('learn', 'failed', 160))

    def test_child_withdrawn_between_context_and_dispatch_blocks_external_call(self):
        session = self.public_session('learn', 'route', self.route)
        turn = self.turn(session)
        def change_after_build(current):
            result = build_messages(current)
            Place.objects.filter(pk=self.place.pk).update(is_published=False)
            return result
        with patch('llm.worker.build_messages', side_effect=change_after_build), patch('llm.worker.provider.generate') as mocked:
            process_one()
        mocked.assert_not_called()
        turn.refresh_from_db()
        self.assertEqual(turn.error_code, 'LLM_CONTEXT_CHANGED')

    def test_child_withdrawn_during_provider_discards_answer_and_bills_known_usage(self):
        session = self.public_session('learn', 'route', self.route)
        turn = self.turn(session)
        def hide_child(*args, **kwargs):
            Place.objects.filter(pk=self.place.pk).update(is_published=False)
            return RESPONSE
        with patch('llm.worker.provider.generate', side_effect=hide_child):
            process_one()
        turn.refresh_from_db()
        self.assertEqual(turn.error_code, 'LLM_CONTEXT_CHANGED')
        self.assertEqual(turn.answer, '')
        self.assertEqual(UsageLedger.objects.get(pk=turn.ledger_id).accounted_tokens, 160)
        self.assertEqual(quota(self.user, scope='learn')['used'], 0)

    def test_changed_public_material_history_is_not_sent_again(self):
        session = self.public_session('learn', 'content', self.content)
        first = self.turn(session, question='历史旧问题')
        response = {**RESPONSE, 'text': '旧正文生成的历史回答'}
        with patch('llm.worker.provider.generate', return_value=response):
            process_one()
        Content.objects.filter(pk=self.content.pk).update(body='完全不同的新公开正文')
        second = self.turn(session, question='请解释新资料')
        messages, _ = build_messages(second)
        text = json.dumps(messages, ensure_ascii=False)
        self.assertIn('完全不同的新公开正文', text)
        self.assertNotIn('旧正文生成的历史回答', text)
        self.assertNotIn('历史旧问题', text)

    def test_unknown_or_unpublished_source_ids_rejected(self):
        for scope, source_type, source_id in [('explore', 'place', self.hidden_place.pk), ('learn', 'content', self.draft.pk),
                                            ('explore', 'region', uuid.uuid4())]:
            response = self.api.post('/api/v1/llm/sessions/', {'scope': scope, 'source_type': source_type, 'source_id': str(source_id)})
            self.assertEqual(response.status_code, 404)


@skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL row locks')
class ScopeConcurrencyTests(PublicFixture, TransactionTestCase):
    def test_parallel_last_round_of_explore_cannot_overdraw_or_charge_learn(self):
        session = self.public_session()
        for _ in range(4):
            self.complete(self.turn(session))
        barrier = Barrier(6)
        def send(_):
            close_old_connections()
            try:
                owner = User.objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                try:
                    return enqueue_turn(owner, session.pk, {'request_id': uuid.uuid4(), 'question': '第五轮'})[0].status
                except ServiceError as exc:
                    return str(exc.get_codes())
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(send, range(6)))
        self.assertEqual(results.count('queued'), 1)
        self.assertEqual(quota(self.user, scope='explore')['remaining'], 0)
        self.assertEqual(quota(self.user, scope='learn')['remaining'], 5)
        self.assertEqual(quota(self.user, scope='recognition')['remaining'], 5)


class ScopeMigrationTests(TransactionTestCase):
    def test_legacy_flower_river_and_detached_ledger_all_keep_recognition_quota(self):
        executor = MigrationExecutor(connection)
        executor.migrate([('llm', '0001_initial')])
        try:
            old = executor.loader.project_state([('llm', '0001_initial')]).apps
            UserModel = old.get_model('accounts', 'User')
            owner = UserModel.objects.create(username='legacy-scopes')
            Session = old.get_model('llm', 'LLMSession')
            Ledger = old.get_model('llm', 'UsageLedger')
            expires = timezone.now() + timedelta(days=30)
            for kind, model in [('recognition', 'RecognitionJob'), ('assessment', 'AssessmentJob')]:
                app = 'recognition' if kind == 'recognition' else 'assessments'
                job = old.get_model(app, model).objects.create(owner_id=owner.pk, status='succeeded', expires_at=expires)
                session = Session.objects.create(owner_id=owner.pk, **{kind + '_job_id': job.pk}, kind=kind, title='旧会话', context_summary='旧资料', consent_version='deepseek-v1', expires_at=expires)
                Ledger.objects.create(owner_id=owner.pk, session_id=session.pk, request_id=uuid.uuid4(), fingerprint='a'*64, day=timezone.localdate(), status='succeeded', reserved_tokens=33000, max_output_tokens=600, timeout_seconds=45)
            detached = Ledger.objects.create(owner_id=owner.pk, session_id=None, request_id=uuid.uuid4(), fingerprint='b'*64, day=timezone.localdate(), status='succeeded', reserved_tokens=33000, max_output_tokens=600, timeout_seconds=45)
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
            self.assertEqual(set(LLMSession.objects.values_list('scope', flat=True)), {'recognition'})
            self.assertEqual(set(UsageLedger.objects.values_list('scope', flat=True)), {'recognition'})
            self.assertEqual(UsageLedger.objects.get(pk=detached.pk).scope, 'recognition')
            current_owner = User.objects.get(pk=owner.pk)
            self.assertEqual(quota(current_owner, scope='recognition')['used'], 3)
            self.assertEqual(quota(current_owner, scope='explore')['used'], 0)
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
