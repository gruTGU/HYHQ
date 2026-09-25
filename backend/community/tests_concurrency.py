"""Real PostgreSQL connection races; all content safety calls are mocked."""
from concurrent.futures import ThreadPoolExecutor
import threading
import uuid
from unittest import skipUnless
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection, connections
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from knowledge.models import Content
from .models import Comment, Configuration, SafetyDay, SubmissionAttempt
from .safety import credential_digest


@skipUnless(connection.vendor == 'postgresql', 'Requires independent PostgreSQL connections and row locks')
@override_settings(ROOT_URLCONF='community.test_urls', COMMUNITY_ENABLED=True, WECHAT_APP_ID='mock-community-app', WECHAT_APP_SECRET='mock-community-secret')
class CommunityConcurrencyTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.clock = patch('django.utils.timezone.now', return_value=timezone.now().replace(hour=4, minute=0, second=0, microsecond=0)).start()
        self.check = patch('community.safety.check_text', return_value={'suggest': 'pass', 'trace_id': 'mock-trace'}).start()
        self.addCleanup(patch.stopall)
        self.owner = User.objects.create_user(username='community-race-owner', auth_kind='wechat', wechat_openid='mock-race-openid')
        manager = User.objects.create_user(username='community-race-manager', is_staff=True, is_superuser=True)
        self.content = Content.objects.create(slug='community-race-content', title='并发公开文章', body='原文', status='published')
        Configuration.objects.create(enabled=True, personal_eligibility_confirmed=True, eligibility_evidence='测试用平台核实记录', eligibility_confirmed_on=timezone.localdate(), moderation_ready=True, moderator=manager, safety_verified_at=timezone.now(), safety_credential_digest=credential_digest())

    def post(self, owner_id, request_id):
        connections.close_all()
        try:
            client = APIClient(); client.force_authenticate(User.objects.get(pk=owner_id))
            response = client.post('/api/v1/community/comments/', {'kind': 'content', 'target_id': str(self.content.pk), 'body': '并发观察', 'request_id': str(request_id)}, format='json')
            return response.status_code
        finally:
            connections['default'].close()

    def test_same_request_across_six_connections_checks_and_creates_once(self):
        barrier, request_id = threading.Barrier(6), uuid.uuid4()
        def submit(_):
            barrier.wait(timeout=10)
            return self.post(self.owner.pk, request_id)
        with ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(submit, range(6)))
        self.assertEqual(statuses.count(201), 1)
        self.assertTrue(all(status in (200, 201, 409) for status in statuses), statuses)
        self.assertEqual(Comment.objects.count(), 1)
        self.assertEqual(SubmissionAttempt.objects.count(), 1)
        self.assertEqual(SafetyDay.objects.get().calls, 1)
        self.check.assert_called_once()

    def test_last_global_safety_slot_is_reserved_once_across_users(self):
        SafetyDay.objects.create(day=timezone.localdate(), calls=79)
        users = [User.objects.create_user(username=f'community-slot-{number}', auth_kind='wechat', wechat_openid=f'mock-slot-{number}') for number in range(5)]
        barrier = threading.Barrier(len(users))
        def submit(owner):
            barrier.wait(timeout=10)
            return self.post(owner.pk, uuid.uuid4())
        with ThreadPoolExecutor(max_workers=5) as pool:
            statuses = list(pool.map(submit, users))
        self.assertEqual(statuses.count(201), 1)
        self.assertEqual(statuses.count(429), 4)
        self.assertEqual(SafetyDay.objects.get().calls, 80)
        self.assertEqual(Comment.objects.count(), 1)
        self.check.assert_called_once()

    def test_account_deletion_during_external_check_cannot_recreate_personal_rows(self):
        checking, release = threading.Event(), threading.Event()
        def blocked_check(*args):
            checking.set()
            if not release.wait(10): raise AssertionError('Content check was not released')
            return {'suggest': 'pass', 'trace_id': 'mock-trace'}
        self.check.side_effect = blocked_check
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(self.post, self.owner.pk, uuid.uuid4())
            try:
                self.assertTrue(checking.wait(10), 'Comment did not reach mocked external check')
                client = APIClient(); client.force_authenticate(self.owner)
                self.assertEqual(client.delete('/api/v1/me/').status_code, 204)
            finally:
                release.set()
            self.assertEqual(result.result(timeout=10), 401)
        self.assertFalse(Comment.objects.exists())
        self.assertFalse(SubmissionAttempt.objects.exists())
        self.assertEqual(SafetyDay.objects.get().calls, 1)
