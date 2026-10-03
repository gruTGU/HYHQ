"""Real PostgreSQL tests for admission, retries and account-deletion races."""
import base64
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest import skipUnless

from django.core.cache import cache
from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from accounts.models import User
from accounts.views import MeView
from assets.models import Asset
from common.exceptions import ServiceError
from .models import Chunk, DailyBudget, Upload
from .services import begin, finish, put_chunk
from .tests import png


@skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL row locks')
@override_settings(CLOUD_TRANSFER_ENABLED=True)
class CloudFileConcurrencyTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        temporary = tempfile.TemporaryDirectory(prefix='hyhq-cloud-race-')
        self.addCleanup(temporary.cleanup)
        config = override_settings(MEDIA_ROOT=temporary.name)
        config.enable()
        self.addCleanup(config.disable)
        self.owner = User.objects.create_user(username='cloud-race-owner')

    def parallel(self, operations):
        barrier = threading.Barrier(len(operations))

        def run(operation):
            connections.close_all()
            try:
                barrier.wait(timeout=10)
                return operation()
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=len(operations)) as pool:
            futures = [pool.submit(run, operation) for operation in operations]
            return [future.result(timeout=15) for future in futures]

    def test_same_request_admitted_once_under_concurrent_retries(self):
        request_id = uuid.uuid4()

        def create():
            item, created = begin(self.owner, purpose='recognition', size=100, request_id=request_id)
            return str(item.pk), created

        results = self.parallel([create, create])
        self.assertEqual(results[0][0], results[1][0])
        self.assertEqual(sorted(item[1] for item in results), [False, True])
        self.assertEqual(Upload.objects.count(), 1)
        self.assertEqual(DailyBudget.objects.get().reserved_bytes, 100)

    @override_settings(CLOUD_UPLOAD_STAGING_BYTES=100)
    def test_different_owners_cannot_overbook_global_staging(self):
        other = User.objects.create_user(username='cloud-race-other')

        def create(owner):
            try:
                begin(owner, purpose='avatar', size=100, request_id=uuid.uuid4())
                return 201
            except ServiceError as error:
                return error.status_code

        results = self.parallel([lambda: create(self.owner), lambda: create(other)])
        self.assertEqual(sorted(results), [201, 429])
        self.assertEqual(Upload.objects.count(), 1)
        self.assertEqual(DailyBudget.objects.get().reserved_bytes, 100)

    def test_concurrent_completion_creates_one_asset(self):
        raw = png()
        item, _ = begin(self.owner, purpose='recognition', size=len(raw), request_id=uuid.uuid4())
        put_chunk(self.owner, item.pk, 0, base64.b64encode(raw).decode())

        def complete():
            asset, created = finish(self.owner, item.pk)
            return str(asset.pk), created

        results = self.parallel([complete, complete])
        self.assertEqual(results[0][0], results[1][0])
        self.assertEqual(sorted(item[1] for item in results), [False, True])
        self.assertEqual(Asset.objects.count(), 1)
        self.assertFalse(Chunk.objects.exists())

    def test_account_delete_waits_before_collecting_new_staging(self):
        owner_id = self.owner.pk
        reached = threading.Event()
        outcome = {}

        def observe(execute, sql, params, many, context):
            if '"accounts_user"' in sql and 'FOR UPDATE' in sql:
                reached.set()
            return execute(sql, params, many, context)

        def delete():
            connections.close_all()
            try:
                owner = User.objects.get(pk=owner_id)
                request = APIRequestFactory().delete('/api/v1/me/')
                force_authenticate(request, user=owner)
                with connections['default'].execute_wrapper(observe):
                    outcome['status'] = MeView.as_view()(request).status_code
            except Exception as error:
                outcome['error'] = error
            finally:
                connections.close_all()

        thread = threading.Thread(target=delete, daemon=True)
        with transaction.atomic():
            item, _ = begin(self.owner, purpose='recognition', size=100, request_id=uuid.uuid4())
            put_chunk(self.owner, item.pk, 0, base64.b64encode(b'X' * 100).decode())
            thread.start()
            blocked = reached.wait(10)
        thread.join(10)
        self.assertTrue(blocked)
        self.assertFalse(thread.is_alive())
        self.assertNotIn('error', outcome, repr(outcome.get('error')))
        self.assertEqual(outcome.get('status'), 204)
        self.assertFalse(Upload.objects.exists())
        self.assertFalse(Chunk.objects.exists())
        self.assertEqual(DailyBudget.objects.get().reserved_bytes, 100)
