import base64
import io
import os
import tempfile
import uuid
import wave
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from PIL import Image, PngImagePlugin
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from accounts.models import User
from accounts.services import issue_session
from assets.models import Asset
from knowledge.models import Content
from narration.services import import_narration
from .models import Chunk, DailyBudget, OwnerBudget, Upload
from .services import CHUNK_SIZE
from .views import UploadStart

PREFIX = '/api/v1/cloud-files/'


def png(large=False):
    output = io.BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('Description', 'private-GPS-marker')
    image = Image.frombytes('RGB', (512, 160), os.urandom(512 * 160 * 3)) if large else Image.new('RGB', (48, 32), 'green')
    with image:
        image.save(output, format='PNG', pnginfo=metadata)
    return output.getvalue()


@override_settings(CLOUD_TRANSFER_ENABLED=True)
class CloudFileTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        temporary = tempfile.TemporaryDirectory(prefix='hyhq-cloud-files-')
        self.directory = Path(temporary.name)
        self.addCleanup(temporary.cleanup)
        config = override_settings(MEDIA_ROOT=self.directory / 'images', NARRATION_STORAGE_ROOT=self.directory / 'audio')
        config.enable()
        self.addCleanup(config.disable)
        self.owner = User.objects.create_user(username='cloud-owner')
        self.other = User.objects.create_user(username='cloud-other')
        self.client = self.client_for(self.owner)
        self.raw = png()

    def client_for(self, owner):
        api = APIClient()
        token, _ = issue_session(owner)
        api.credentials(HTTP_AUTHORIZATION='Bearer ' + token)
        return api

    def begin(self, *, raw=None, request_id=None, purpose='recognition', **extra):
        body = {'purpose': purpose, 'size': len(raw if raw is not None else self.raw), 'request_id': str(request_id or uuid.uuid4())}
        body.update(extra)
        return self.client.post(PREFIX + 'uploads/', body, format='json')

    def put(self, pk, index, raw):
        return self.client.put(f'{PREFIX}uploads/{pk}/chunks/{index}/', {'data_base64': base64.b64encode(raw).decode()}, format='json')

    def staged(self, raw=None, purpose='recognition'):
        raw = self.raw if raw is None else raw
        response = self.begin(raw=raw, purpose=purpose)
        self.assertEqual(response.status_code, 201, response.content)
        pk = response.json()['data']['id']
        for index, offset in enumerate(range(0, len(raw), CHUNK_SIZE)):
            response = self.put(pk, index, raw[offset:offset + CHUNK_SIZE])
            self.assertEqual(response.status_code, 200, response.content)
        return pk

    def complete(self, pk):
        return self.client.post(f'{PREFIX}uploads/{pk}/complete/', {}, format='json')

    def download(self, pk, **params):
        return self.client.get(PREFIX + 'download/', {'path': f'/api/v1/uploads/{pk}/content/', **params})

    def asset(self, raw=None, purpose='recognition'):
        response = self.complete(self.staged(raw=raw, purpose=purpose))
        self.assertEqual(response.status_code, 201, response.content)
        return Asset.objects.get(pk=response.json()['data']['id'])

    @override_settings(CLOUD_TRANSFER_ENABLED=False)
    def test_disabled_by_default_gate(self):
        self.assertEqual(self.begin().status_code, 404)
        self.assertEqual(self.client.get(PREFIX + 'download/', {'path': '/etc/passwd'}).status_code, 404)

    def test_auth_required_and_cloud_identity_headers_not_trusted(self):
        api = APIClient()
        response = api.post(PREFIX + 'uploads/', {'purpose': 'recognition', 'size': 10, 'request_id': str(uuid.uuid4())}, format='json', HTTP_X_WX_OPENID='fake')
        self.assertEqual(response.status_code, 401)
        self.assertFalse(Upload.objects.exists())

    def test_input_size_purpose_and_request_id_are_bounded(self):
        for extra in [{'size': 0}, {'size': 5 * 1024 * 1024 + 1}, {'purpose': 'filesystem'}, {'request_id': 'bad'}]:
            with self.subTest(extra=extra):
                self.assertEqual(self.begin(**extra).status_code, 400)
        self.assertFalse(Upload.objects.exists())

    def test_complete_strips_metadata_and_retries_are_idempotent(self):
        raw, request_id = png(large=True), uuid.uuid4()
        self.assertGreater(len(raw), CHUNK_SIZE)
        first = self.begin(raw=raw, request_id=request_id)
        pk = first.json()['data']['id']
        self.assertEqual(first.json()['data']['chunk_size'], CHUNK_SIZE)
        again = self.begin(raw=raw, request_id=request_id)
        self.assertEqual(again.json()['data']['id'], pk)
        self.assertEqual(DailyBudget.objects.get().requests, 1)
        for index, offset in enumerate(range(0, len(raw), CHUNK_SIZE)):
            chunk = raw[offset:offset + CHUNK_SIZE]
            self.assertEqual(self.put(pk, index, chunk).status_code, 200)
            self.assertEqual(self.put(pk, index, chunk).status_code, 200)
        done, repeated = self.complete(pk), self.complete(pk)
        self.assertEqual((done.status_code, repeated.status_code), (201, 200))
        self.assertEqual(done.json()['data'], repeated.json()['data'])
        self.assertEqual(Asset.objects.count(), 1)
        self.assertFalse(Chunk.objects.exists())
        asset = Asset.objects.get()
        with asset.original.open('rb') as stream:
            clean = stream.read()
        self.assertNotIn(b'private-GPS-marker', clean)
        with Image.open(io.BytesIO(clean)) as image:
            self.assertEqual(image.format, 'JPEG')
            self.assertFalse(image.getexif())
        self.assertEqual(done.json()['data']['thumbnail_url'], f'/api/v1/uploads/{asset.pk}/content/?variant=thumbnail')

    def test_reusing_request_id_with_changed_metadata_rejected(self):
        pk = uuid.uuid4()
        self.begin(request_id=pk)
        response = self.begin(request_id=pk, size=len(self.raw) + 1)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(DailyBudget.objects.get().requests, 1)

    def test_chunk_encoding_length_order_and_conflict_are_checked(self):
        pk = self.begin().json()['data']['id']
        for value in ['***', 'eA==\n', '', 'A' * (CHUNK_SIZE * 2), 42, 'Zh==']:
            response = self.client.put(f'{PREFIX}uploads/{pk}/chunks/0/', {'data_base64': value}, format='json')
            self.assertEqual(response.status_code, 400, repr(value)[:40])
        self.assertEqual(self.put(pk, 1, self.raw).status_code, 409)
        self.assertEqual(self.put(pk, 0, self.raw[:-1]).status_code, 400)
        self.assertEqual(self.put(pk, 0, self.raw).status_code, 200)
        self.assertEqual(self.put(pk, 0, self.raw[:-1] + b'!').status_code, 409)
        self.assertEqual(Chunk.objects.count(), 1)

    def test_owner_is_required_for_every_upload_operation(self):
        pk = self.staged()
        self.client = self.client_for(self.other)
        self.assertEqual(self.put(pk, 0, self.raw).status_code, 404)
        self.assertEqual(self.complete(pk).status_code, 404)
        self.assertEqual(self.client.delete(f'{PREFIX}uploads/{pk}/').status_code, 204)
        self.assertTrue(Upload.objects.filter(pk=pk).exists())

    def test_incomplete_corrupt_and_nonimage_cannot_complete(self):
        pk = self.begin().json()['data']['id']
        self.assertEqual(self.complete(pk).status_code, 409)
        self.put(pk, 0, self.raw)
        Chunk.objects.filter(upload_id=pk).update(data=b'!' * len(self.raw))
        self.assertEqual(self.complete(pk).status_code, 409)
        self.client.delete(f'{PREFIX}uploads/{pk}/')
        invalid = self.staged(b'<html>not an image</html>')
        self.assertEqual(self.complete(invalid).status_code, 400)
        self.assertFalse(Asset.objects.exists())

    def test_cancel_is_idempotent_and_never_refunds_daily_budget(self):
        pk = self.staged()
        for _ in range(2):
            self.assertEqual(self.client.delete(f'{PREFIX}uploads/{pk}/').status_code, 204)
        self.assertFalse(Upload.objects.exists())
        self.assertFalse(Chunk.objects.exists())
        self.assertEqual(DailyBudget.objects.get().reserved_bytes, len(self.raw))
        self.assertEqual(OwnerBudget.objects.get().reserved_bytes, len(self.raw))

    def test_cancel_after_completion_keeps_asset_and_retry_receipt(self):
        pk = self.staged()
        self.complete(pk)
        self.client.delete(f'{PREFIX}uploads/{pk}/')
        self.assertEqual(Asset.objects.count(), 1)
        self.assertEqual(self.complete(pk).status_code, 200)

    def test_expired_or_deleted_completed_asset_cannot_be_replayed(self):
        pk = self.staged(purpose='avatar')
        self.complete(pk)
        asset = Asset.objects.get()
        asset.expires_at = timezone.now() - timedelta(seconds=1)
        asset.save(update_fields=['expires_at'])
        self.assertEqual(self.complete(pk).status_code, 410)
        # An error during an idempotent replay must not delete pre-existing files.
        self.assertTrue(asset.original.storage.exists(asset.original.name))
        asset.delete()
        self.assertEqual(self.complete(pk).status_code, 410)

    def test_active_upload_limit_and_global_staging_limit(self):
        self.begin()
        self.begin()
        self.assertEqual(self.begin().status_code, 429)
        self.client = self.client_for(self.other)
        with override_settings(CLOUD_UPLOAD_STAGING_BYTES=2 * len(self.raw)):
            self.assertEqual(self.begin().status_code, 429)
        self.assertEqual(DailyBudget.objects.get().requests, 2)

    def test_daily_personal_and_global_limits_persist_after_cancel(self):
        for setting in ['CLOUD_UPLOAD_USER_DAILY_BYTES', 'CLOUD_UPLOAD_DAILY_BYTES']:
            with self.subTest(setting=setting), override_settings(**{setting: len(self.raw)}):
                DailyBudget.objects.all().delete()
                OwnerBudget.objects.all().delete()
                pk = self.staged()
                self.client.delete(f'{PREFIX}uploads/{pk}/')
                self.assertEqual(self.begin().status_code, 429)
                self.assertEqual(DailyBudget.objects.get().requests, 1)

    @override_settings(CLOUD_UPLOAD_USER_DAILY_REQUESTS=1)
    def test_tiny_files_cannot_bypass_daily_request_budget(self):
        pk = self.begin(size=1).json()['data']['id']
        self.client.delete(f'{PREFIX}uploads/{pk}/')
        self.assertEqual(self.begin(size=1).status_code, 429)

    def test_expiry_cleanup_preserves_budget_and_business_assets(self):
        open_pk = self.staged()
        finished_pk = self.staged()
        self.complete(finished_pk)
        Upload.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.put(open_pk, 0, self.raw).status_code, 410)
        self.assertEqual(self.complete(open_pk).status_code, 410)
        output = io.StringIO()
        call_command('cleanup_cloud_uploads', dry_run=True, stdout=output)
        self.assertEqual(Upload.objects.count(), 2)
        call_command('cleanup_cloud_uploads', stdout=output)
        self.assertFalse(Upload.objects.exists())
        self.assertFalse(Chunk.objects.exists())
        self.assertTrue(Asset.objects.exists())
        self.assertEqual(DailyBudget.objects.get().requests, 2)

    def test_account_deletion_cascades_staging_but_keeps_anonymous_reservations(self):
        self.staged()
        self.assertEqual(self.client.delete('/api/v1/me/').status_code, 204)
        self.assertFalse(Upload.objects.exists())
        self.assertFalse(Chunk.objects.exists())
        self.assertFalse(OwnerBudget.objects.exists())
        self.assertEqual(DailyBudget.objects.get().requests, 1)

    def test_deleted_or_disabled_authenticated_snapshot_cannot_mutate(self):
        for action in ['disabled', 'deleted']:
            with self.subTest(action=action):
                owner = User.objects.create_user(username='stale-' + action)
                snapshot = User.objects.get(pk=owner.pk)
                if action == 'disabled':
                    User.objects.filter(pk=owner.pk).update(is_active=False)
                else:
                    owner.delete()
                request = APIRequestFactory().post(PREFIX + 'uploads/', {'purpose': 'avatar', 'size': 10, 'request_id': str(uuid.uuid4())}, format='json')
                force_authenticate(request, user=snapshot)
                response = UploadStart.as_view()(request)
                self.assertEqual(response.status_code, 401)

    def test_failure_after_asset_creation_cleans_nontransactional_files(self):
        pk = self.staged()
        with patch('cloudtransfer.services.audit', side_effect=RuntimeError('audit failed')):
            with self.assertRaises(RuntimeError):
                self.complete(pk)
        self.assertFalse(Asset.objects.exists())
        self.assertTrue(Chunk.objects.exists())
        self.assertEqual(list(self.directory.rglob('*.jpg')), [])

    def test_download_image_reuses_owner_expiry_and_missing_file_checks(self):
        asset = self.asset()
        response = self.download(asset.pk)
        data = response.json()['data']
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['extension'], 'jpg')
        self.assertEqual(data['content_type'], 'image/jpeg')
        with asset.thumbnail.open('rb') as file:
            self.assertEqual(base64.b64decode(data['data_base64']), file.read())
        self.assertTrue(data['complete'])
        self.assertEqual(data['next_offset'], data['total_size'])
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(self.client_for(self.other).get(PREFIX + 'download/', {'path': f'/api/v1/uploads/{asset.pk}/content/'}).status_code, 404)
        self.assertEqual(APIClient().get(PREFIX + 'download/', {'path': f'/api/v1/uploads/{asset.pk}/content/'}).status_code, 401)
        asset.original_expires_at = timezone.now() - timedelta(seconds=1)
        asset.save(update_fields=['original_expires_at'])
        self.assertEqual(self.download(asset.pk, path=f'/api/v1/uploads/{asset.pk}/content/?variant=original').status_code, 410)
        self.assertEqual(self.download(asset.pk).status_code, 200)
        asset.expires_at = timezone.now() - timedelta(seconds=1)
        asset.save(update_fields=['expires_at'])
        self.assertEqual(self.download(asset.pk).status_code, 410)

    def test_deleted_asset_during_multichunk_download_is_not_replayed(self):
        asset = self.asset(raw=png(large=True))
        path = f'/api/v1/uploads/{asset.pk}/content/?variant=original'
        response = self.download(asset.pk, path=path)
        self.assertEqual(response.status_code, 200)
        asset.delete()
        self.assertEqual(self.download(asset.pk, path=path, offset=CHUNK_SIZE).status_code, 404)

    def test_download_rejects_urls_paths_query_smuggling_and_offsets(self):
        asset = self.asset()
        path = f'/api/v1/uploads/{asset.pk}/content/'
        bad = ['/etc/passwd', 'https://example.com' + path, '//example.com' + path, '/api/v1/me/', path + '../',
               path + '?variant=original&variant=thumbnail', path + '?variant=original&url=file:///etc/passwd',
               path + '#fragment', path + '\n', '/api/v1/uploads/%2e%2e/content/']
        for value in bad:
            with self.subTest(value=value):
                self.assertEqual(self.download(asset.pk, path=value).status_code, 400)
        for value, status in [('-1', 400), ('1.5', 400), ('9999999999999', 400), ('1', 416), (str(CHUNK_SIZE), 416)]:
            self.assertEqual(self.download(asset.pk, offset=value).status_code, status)

    def test_public_audio_preserves_rights_revision_and_hash_checks_per_chunk(self):
        reviewer = User.objects.create_superuser(username='audio-reviewer')
        content = Content.objects.create(title='讲解文章', slug='cloud-narration', body='可核对正文', status='published')
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b'\0\0' * CHUNK_SIZE)
        raw = output.getvalue()
        item = import_narration(source=content, filename='test.wav', data=raw, reviewer=reviewer,
                                rights_note='本地测试生成无声片段', reviewed=True, copyright_confirmed=True, publish=True)
        path = f'/api/v1/narrations/{item.pk}/audio/'
        api = APIClient()
        api.credentials(HTTP_AUTHORIZATION='Bearer stale-invalid')
        response = api.get(PREFIX + 'download/', {'path': path}, HTTP_RANGE='bytes=0-9')
        data = response.json()['data']
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data['total_size'], len(raw))
        self.assertEqual(base64.b64decode(data['data_base64']), raw[:CHUNK_SIZE])
        self.assertFalse(data['complete'])
        response = api.get(PREFIX + 'download/', {'path': path, 'offset': CHUNK_SIZE})
        self.assertEqual(response.status_code, 200)
        Path(item.audio.path).write_bytes(raw[:-1] + b'!')
        self.assertEqual(api.get(PREFIX + 'download/', {'path': path, 'offset': CHUNK_SIZE}).status_code, 404)
        Path(item.audio.path).write_bytes(raw)
        content.body = '正文已修订'
        content.save()
        self.assertEqual(api.get(PREFIX + 'download/', {'path': path}).status_code, 404)
