from django.core.cache import cache
import io
import uuid
from datetime import timedelta
from unittest.mock import patch
from django.contrib.auth.models import Permission
from django.core.management import call_command
from django.core.management.base import CommandError
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate
from accounts.models import User
from common.models import AuditLog
from common.exceptions import ServiceError
from ecology.models import Region, Place
from knowledge.models import Content, Route
from . import safety
from .models import Comment, Configuration, Report, SubmissionAttempt, SafetyDay
from .services import gate, moderate
from .views import CommentsView


@override_settings(ROOT_URLCONF='community.test_urls', COMMUNITY_ENABLED=True, WECHAT_APP_ID='test-app', WECHAT_APP_SECRET='test-only-secret')
class CommunityTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user(username='comment-owner', auth_kind='wechat', wechat_openid='test-owner-openid')
        cls.other = User.objects.create_user(username='comment-other', auth_kind='wechat', wechat_openid='test-other-openid')
        cls.manager = User.objects.create_user(username='comment-manager', is_staff=True)
        cls.reader = User.objects.create_user(username='comment-reader', is_staff=True)
        for model in ('comment', 'report'):
            cls.manager.user_permissions.add(*Permission.objects.filter(content_type__app_label='community', codename__in=['view_' + model, 'change_' + model]))
            cls.reader.user_permissions.add(*Permission.objects.filter(content_type__app_label='community', codename='view_' + model))
        cls.region = Region.objects.create(slug='community-region', name='社区测试区域')
        cls.place = Place.objects.create(region=cls.region, slug='community-place', name='公开地点', kind='park', is_published=True)
        cls.content = Content.objects.create(slug='community-content', title='公开文章', body='正文', status='published')
        cls.route = Route.objects.create(region=cls.region, slug='community-route', title='公开路线', published=True)

    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        # Stable midday avoids a two-minute quota fixture crossing midnight.
        patch('django.utils.timezone.now', return_value=timezone.now().replace(hour=4, minute=0, second=0, microsecond=0)).start()
        self.api = APIClient(); self.api.force_authenticate(self.owner)
        self.config = Configuration.objects.create(enabled=True, personal_eligibility_confirmed=True, eligibility_evidence='平台核实工单测试依据', eligibility_confirmed_on=timezone.localdate(), moderation_ready=True, moderator=self.manager, safety_verified_at=timezone.now(), safety_credential_digest=safety.credential_digest())
        self.safety = patch('community.safety.check_text', return_value={'suggest': 'pass', 'trace_id': 'test-trace'}).start()
        self.addCleanup(patch.stopall)

    def post_comment(self, **extra):
        data = {'kind': 'content', 'target_id': str(self.content.pk), 'body': '  一条生态观察  ', 'request_id': str(uuid.uuid4())}; data.update(extra)
        return self.api.post('/api/v1/community/comments/', data)

    def post_report(self, **extra):
        data = {'kind': 'content', 'target_id': str(self.content.pk), 'reason': 'inaccurate', 'detail': '描述需要核对', 'request_id': str(uuid.uuid4())}; data.update(extra)
        return self.api.post('/api/v1/community/reports/', data)

    def row(self, owner=None, **extra):
        values = {'owner': owner or self.owner, 'content': self.content, 'body': '观察记录', 'safety_status': 'pass'}; values.update(extra)
        return Comment.objects.create(**values)

    def get_comments(self, **extra):
        return self.api.get('/api/v1/community/comments/', {'kind': 'content', 'target_id': str(self.content.pk), **extra})

    def test_each_independent_gate_must_be_ready_and_public_status_does_not_leak_evidence(self):
        self.assertTrue(gate())
        for field, value in [('enabled', False), ('personal_eligibility_confirmed', False), ('eligibility_evidence', ''), ('eligibility_confirmed_on', None), ('moderation_ready', False), ('moderator', None), ('safety_verified_at', None), ('safety_credential_digest', 'old')]:
            with self.subTest(field=field):
                old = getattr(self.config, field); setattr(self.config, field, value)
                Configuration.objects.filter(pk=1).update(**{field: value})
                self.assertFalse(gate())
                self.assertEqual(self.post_comment().status_code, 403)
                self.assertEqual(self.get_comments().status_code, 403)
                self.assertEqual(self.post_report().status_code, 403)
                Configuration.objects.filter(pk=1).update(**{field: old})
        with override_settings(COMMUNITY_ENABLED=False): self.assertFalse(gate())
        with override_settings(WECHAT_APP_SECRET='changed'): self.assertFalse(gate())
        response = self.api.get('/api/v1/community/status/')
        self.assertEqual(set(response.data), {'enabled', 'reason', 'max_comment_length'})
        self.assertFalse(SubmissionAttempt.objects.exists()); self.safety.assert_not_called()

    def test_expired_future_verification_future_eligibility_and_inactive_or_unqualified_moderator_close_gate(self):
        for stamp in [timezone.now() - timedelta(days=8), timezone.now() + timedelta(days=1)]:
            Configuration.objects.filter(pk=1).update(safety_verified_at=stamp); self.assertFalse(gate())
        Configuration.objects.filter(pk=1).update(safety_verified_at=timezone.now(), eligibility_confirmed_on=timezone.localdate() + timedelta(days=1)); self.assertFalse(gate())
        Configuration.objects.filter(pk=1).update(eligibility_confirmed_on=timezone.localdate(), moderator=self.reader); self.assertFalse(gate())
        Configuration.objects.filter(pk=1).update(moderator=self.manager)
        User.objects.filter(pk=self.manager.pk).update(is_active=False); self.assertFalse(gate())

    def test_submit_trims_and_forced_identity_status_fields_are_ignored(self):
        response = self.post_comment(owner=str(self.other.pk), status='approved', safety_status='pass', moderation_note='伪造', reviewed_by=str(self.manager.pk))
        self.assertEqual(response.status_code, 201, response.data)
        row = Comment.objects.get(pk=response.data['id'])
        self.assertEqual(row.body, '一条生态观察'); self.assertEqual(row.owner, self.owner); self.assertEqual(row.status, 'pending'); self.assertEqual(row.moderation_note, '')
        self.assertEqual(set(response.data), {'id', 'body', 'status', 'created_at', 'is_owner', 'author'})
        self.assertEqual(AuditLog.objects.get(event='community.comment_submitted').details, {'status': 'pending', 'source': 'wechat'})

    def test_invalid_text_and_invalid_targets_do_not_reach_provider(self):
        for body in ['', '  ', '字' * 501, '<script>x</script>', '暗\u202e文字', '二\x00字']:
            self.assertEqual(self.post_comment(body=body).status_code, 400, body)
        self.assertEqual(self.post_comment(kind='comment').status_code, 400)
        self.assertEqual(self.post_comment(target_id='invalid').status_code, 400)
        self.assertEqual(self.post_comment(target_id=str(uuid.uuid4())).status_code, 404)
        self.safety.assert_not_called()

    def test_content_route_place_supported_and_hidden_targets_never_reveal_rows(self):
        for kind, obj, field in [('content', self.content, 'status'), ('route', self.route, 'published'), ('place', self.place, 'is_published')]:
            with self.subTest(kind=kind):
                SubmissionAttempt.objects.all().delete()
                response = self.post_comment(kind=kind, target_id=str(obj.pk)); self.assertEqual(response.status_code, 201)
                obj.__class__.objects.filter(pk=obj.pk).update(**{field: 'draft' if kind == 'content' else False})
                self.assertEqual(self.post_comment(kind=kind, target_id=str(obj.pk)).status_code, 404)
                self.assertEqual(self.api.get('/api/v1/community/comments/', {'kind': kind, 'target_id': obj.pk}).status_code, 404)
                self.assertEqual(self.post_report(kind=kind, target_id=str(obj.pk)).status_code, 404)
                self.assertEqual(self.api.get('/api/v1/community/comments/mine/').data['meta']['count'], 0)
                Comment.objects.all().delete()

    def test_pending_rejected_private_approved_public_and_unchecked_profiles_never_leak(self):
        approved = self.row(self.other, status='approved'); own = self.row(status='pending'); self.row(self.other, status='pending', body='PRIVATE_PENDING'); self.row(self.other, status='rejected', body='PRIVATE_REJECTED')
        User.objects.filter(pk=self.other.pk).update(nickname='<script>unsafe</script>')
        response = self.get_comments(); self.assertEqual({r['id'] for r in response.data['data']}, {str(approved.pk), str(own.pk)})
        self.assertEqual(next(r['author'] for r in response.data['data'] if r['id'] == str(approved.pk)), '生态同行者')
        self.api.force_authenticate(None)
        self.assertEqual([r['id'] for r in self.get_comments().data['data']], [str(approved.pk)])
        self.assertEqual(self.post_comment().status_code, 401)

    def test_provider_review_risky_cannot_be_approved_even_by_admin(self):
        for suggestion in ('review', 'risky'):
            SubmissionAttempt.objects.all().delete(); self.safety.return_value = {'suggest': suggestion, 'trace_id': 'test'}
            response = self.post_comment(); self.assertEqual(response.status_code, 201)
            row = Comment.objects.get(pk=response.data['id']); self.assertEqual(row.status, 'rejected')
            with self.assertRaises(Exception): moderate(self.manager, Comment, row.pk, 'approved')
            row.refresh_from_db(); self.assertEqual(row.status, 'rejected')
            with self.assertRaises(IntegrityError), transaction.atomic(): Comment.objects.filter(pk=row.pk).update(status='approved')

    def test_external_failure_fails_closed_consumes_attempt_and_keeps_no_comment(self):
        self.safety.side_effect = ServiceError('暂不可用', 'CONTENT_SAFETY_UNAVAILABLE', 503)
        response = self.post_comment(); self.assertEqual(response.status_code, 503)
        self.assertFalse(Comment.objects.exists()); self.assertEqual(SubmissionAttempt.objects.get().state, 'failed')
        self.assertEqual(self.post_comment().status_code, 429)

    def test_idempotent_replay_does_not_call_provider_twice_and_conflict_is_rejected(self):
        key = str(uuid.uuid4()); first = self.post_comment(request_id=key)
        replay = self.post_comment(request_id=key); self.assertEqual(replay.status_code, 200); self.assertEqual(first.data['id'], replay.data['id'])
        self.assertEqual(self.safety.call_count, 1)
        self.assertEqual(self.post_comment(request_id=key, body='changed').status_code, 409)

    def test_unknown_inflight_attempt_and_deleted_result_do_not_resubmit(self):
        key = uuid.uuid4(); SubmissionAttempt.objects.create(owner=self.owner, kind='comment', request_id=key)
        self.assertEqual(self.post_comment(request_id=str(key)).status_code, 409); self.safety.assert_not_called()

    def test_deleting_comment_does_not_reset_posting_rate_limit(self):
        row = self.post_comment(); self.assertEqual(self.api.delete('/api/v1/community/comments/' + row.data['id'] + '/').status_code, 204)
        self.assertEqual(self.post_comment().status_code, 429)
        self.assertTrue(SubmissionAttempt.objects.exists())

    def test_daily_and_global_limits_are_reserved_before_external_calls(self):
        for _ in range(10): SubmissionAttempt.objects.create(owner=self.owner, kind='comment', request_id=uuid.uuid4())
        SubmissionAttempt.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        self.assertEqual(self.post_comment().status_code, 429)
        SubmissionAttempt.objects.all().delete()
        SafetyDay.objects.create(day=timezone.localdate(), calls=80)
        self.assertEqual(self.post_comment().status_code, 429); self.safety.assert_not_called()

    def test_stale_user_and_hidden_target_rechecked_after_external_request(self):
        def check(*args):
            Content.objects.filter(pk=self.content.pk).update(status='draft')
            return {'suggest': 'pass', 'trace_id': 't'}
        self.safety.side_effect = check; self.assertEqual(self.post_comment().status_code, 404); self.assertFalse(Comment.objects.exists())

    def test_deleted_account_during_safety_check_cannot_recreate_private_records(self):
        def check(*args):
            User.objects.get(pk=self.owner.pk).delete()
            return {'suggest': 'pass', 'trace_id': 't'}
        self.safety.side_effect = check; self.assertEqual(self.post_comment().status_code, 401)
        self.assertFalse(Comment.objects.exists()); self.assertFalse(SubmissionAttempt.objects.exists())
        self.assertEqual(SafetyDay.objects.get().calls, 1)

    def test_disabled_account_snapshot_or_dev_user_cannot_submit(self):
        User.objects.filter(pk=self.owner.pk).update(is_active=False)
        self.assertEqual(self.post_comment().status_code, 401)
        User.objects.filter(pk=self.owner.pk).update(is_active=True, auth_kind='dev')
        self.assertEqual(self.post_comment().status_code, 403); self.safety.assert_not_called()

    def test_report_dedup_private_listing_and_target_visibility(self):
        first = self.post_report(); replay = self.post_report(reason='spam')
        self.assertEqual(first.status_code, 201); self.assertEqual(replay.status_code, 200); self.assertEqual(first.data['id'], replay.data['id'])
        self.assertEqual(Report.objects.count(), 1); self.assertEqual(SubmissionAttempt.objects.count(), 1)
        self.api.force_authenticate(self.other); self.assertEqual(self.api.get('/api/v1/community/reports/').data['meta']['count'], 0)
        self.api.force_authenticate(None); self.assertEqual(self.api.get('/api/v1/community/reports/').status_code, 401)

    def test_reports_reject_nonpublic_comments_and_hidden_parents(self):
        row = self.row(self.other); self.assertEqual(self.post_report(kind='comment', target_id=str(row.pk)).status_code, 404)
        Comment.objects.filter(pk=row.pk).update(status='approved'); self.assertEqual(self.post_report(kind='comment', target_id=str(row.pk)).status_code, 201)
        Content.objects.filter(pk=self.content.pk).update(status='draft'); self.assertEqual(self.post_report(kind='comment', target_id=str(row.pk)).status_code, 404)

    def test_report_validation_rate_limit_and_forged_moderation(self):
        self.assertEqual(self.post_report(reason='bad').status_code, 400)
        self.assertEqual(self.post_report(detail='<script>').status_code, 400)
        response = self.post_report(status='resolved', reviewed_by=str(self.manager.pk)); self.assertEqual(response.status_code, 201)
        self.assertEqual(Report.objects.get().status, 'pending')
        self.assertEqual(self.post_report(kind='route', target_id=str(self.route.pk)).status_code, 429)

    def test_owner_delete_other_cannot_delete_and_all_cleanup_cascades_on_account_deletion(self):
        own = self.row(); other = self.row(self.other, status='approved')
        self.assertEqual(self.api.delete(f'/api/v1/community/comments/{other.pk}/').status_code, 404)
        report = self.post_report(kind='comment', target_id=str(other.pk)); self.assertEqual(report.status_code, 201)
        self.assertEqual(self.api.delete('/api/v1/me/').status_code, 204)
        self.assertFalse(Comment.objects.filter(pk=own.pk).exists()); self.assertTrue(Comment.objects.filter(pk=other.pk).exists())
        self.assertFalse(Report.objects.exists()); self.assertFalse(SubmissionAttempt.objects.exists())

    def test_owner_can_delete_and_read_own_published_parent_records_when_service_closed(self):
        row = self.row(); Configuration.objects.filter(pk=1).update(enabled=False)
        self.assertEqual(self.api.get('/api/v1/community/comments/mine/').data['meta']['count'], 1)
        self.assertEqual(self.api.delete(f'/api/v1/community/comments/{row.pk}/').status_code, 204)

    def test_manual_review_requires_permission_and_audits_without_content(self):
        row = self.row()
        with self.assertRaises(Exception): moderate(self.reader, Comment, row.pk, 'approved')
        moderate(self.manager, Comment, row.pk, 'approved', '私密备注')
        row.refresh_from_db(); self.assertEqual(row.status, 'approved'); self.assertEqual(row.reviewed_by, self.manager)
        event = AuditLog.objects.get(event='community.comment_moderated'); self.assertEqual(event.details, {'status': 'approved'})
        self.assertNotIn('私密', str(event.details)); moderate(self.manager, Comment, row.pk, 'rejected')
        self.api.force_authenticate(self.other); self.assertEqual(self.get_comments().data['meta']['count'], 0)

    def test_audit_failure_rolls_back_comment_and_report_mutations(self):
        with patch('community.services.audit', side_effect=RuntimeError('audit offline')):
            with self.assertRaises(RuntimeError): self.post_comment()
            with self.assertRaises(RuntimeError): self.post_report()
        self.assertFalse(Comment.objects.exists()); self.assertFalse(Report.objects.exists())

    def test_admin_only_status_and_note_are_editable_and_no_failed_form_approval(self):
        row = self.row(); self.client.force_login(self.manager)
        path = reverse('admin:community_comment_change', args=[row.pk])
        response = self.client.post(path, {'status': 'approved', 'moderation_note': '审核通过', 'body': '伪造正文', 'owner': self.other.pk, '_save': '保存'})
        self.assertEqual(response.status_code, 302); row.refresh_from_db(); self.assertEqual(row.status, 'approved'); self.assertEqual(row.body, '观察记录')
        Configuration.objects.filter(pk=1).update(enabled=False)
        response = self.client.post(path, {'status': 'approved', 'moderation_note': '', '_save': '保存'}); self.assertEqual(response.status_code, 200)
        self.client.force_login(self.reader); self.assertEqual(self.client.post(path, {'status': 'rejected'}).status_code, 403)

    def test_verify_command_updates_only_runtime_proof_and_never_autoenables(self):
        Configuration.objects.filter(pk=1).update(enabled=False, safety_verified_at=None, safety_credential_digest='')
        call_command('verify_community_safety', user_id=str(self.owner.pk), stdout=io.StringIO())
        self.config.refresh_from_db(); self.assertFalse(self.config.enabled); self.assertIsNotNone(self.config.safety_verified_at)
        self.safety.side_effect = ServiceError('不可用', 'CHECK_FAILED', 503)
        with self.assertRaises(CommandError): call_command('verify_community_safety', user_id=str(self.owner.pk), stdout=io.StringIO())
        with self.assertRaises(CommandError): call_command('verify_community_safety', user_id='bad', stdout=io.StringIO())


@override_settings(WECHAT_APP_ID='test-app', WECHAT_APP_SECRET='test-secret')
class SafetyAdapterTests(TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        safety._cached = None
        self.user = User(username='test', auth_kind='wechat', wechat_openid='test-openid')

    def test_official_payload_cached_stable_token_and_only_safe_result_returned(self):
        responses = [{'access_token': 'mock-token', 'expires_in': 7200}, {'errcode': 0, 'result': {'suggest': 'pass'}, 'trace_id': 'mock-trace', 'detail': [{'keyword': 'secret-detail'}]}, {'errcode': 0, 'result': {'suggest': 'review'}}]
        with patch('community.safety._post', side_effect=responses) as post:
            self.assertEqual(safety.check_text(self.user, '观察'), {'suggest': 'pass', 'trace_id': 'mock-trace'})
            self.assertEqual(safety.check_text(self.user, '观察2')['suggest'], 'review')
            self.assertEqual(post.call_count, 3)
            self.assertEqual(post.call_args_list[1].args[1], {'openid': 'test-openid', 'scene': 2, 'version': 2, 'content': '观察'})
            self.assertFalse(post.call_args_list[0].args[1]['force_refresh'])

    def test_invalid_or_error_result_never_counts_as_pass(self):
        for data in [{}, {'errcode': 1}, {'errcode': 0, 'result': {}}, {'errcode': 0, 'result': {'suggest': 'invented'}}, {'errcode': 0, 'result': {'suggest': 'pass'}, 'trace_id': []}]:
            with patch('community.safety._token', return_value='mock'), patch('community.safety._post', return_value=data), self.assertRaises(ServiceError): safety.check_text(self.user, '观察')

    def test_expired_wechat_visit_requires_relogin(self):
        with patch('community.safety._token', return_value='mock'), patch('community.safety._post', return_value={'errcode': 61010}), self.assertRaises(ServiceError) as error:
            safety.check_text(self.user, '观察')
        self.assertEqual(error.exception.get_codes(), 'WECHAT_RELOGIN_REQUIRED')

    def test_network_errors_are_redacted_and_redirects_refused(self):
        with patch('community.safety.build_opener') as opener:
            opener.return_value.open.side_effect = OSError('SECRET URL AND TOKEN')
            with self.assertRaises(ServiceError) as error: safety._post('https://api.weixin.qq.com/x', {})
            self.assertNotIn('SECRET', str(error.exception))
        self.assertIsNone(safety.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://attacker.invalid'))
