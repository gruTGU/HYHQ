from django.core.cache import cache
import io
import tempfile
import wave
from pathlib import Path
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.contrib.auth.models import Permission
from django.core.exceptions import ImproperlyConfigured, PermissionDenied, ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import RequestFactory, TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from common.models import AuditLog
from ecology.models import Place, Region
from knowledge.models import Content, Route, RouteStop
from .admin import NarrationAdmin
from .formats import validate_audio
from .models import MAX_AUDIO_BYTES, Narration
from .services import import_narration
from .storage import private_storage


def sample_wav():
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\x00\x00' * 80)
    return stream.getvalue()


class NarrationTests(TestCase):
    def setUp(self):
        # Test databases are isolated; Django cache otherwise persists across cases.
        cache.clear()
        self.addCleanup(cache.clear)
        self.temp = tempfile.TemporaryDirectory(prefix='hyhq-narration-test-')
        self.addCleanup(self.temp.cleanup)
        override = override_settings(NARRATION_STORAGE_ROOT=self.temp.name + '/private', MEDIA_ROOT=self.temp.name + '/media')
        override.enable()
        self.addCleanup(override.disable)
        self.reviewer = User.objects.create_superuser(username='narration-reviewer', password=None)
        self.content = Content.objects.create(title='临时测试文章', slug='test-narration', body='临时正文', status='published')
        self.region = Region.objects.create(name='临时区域', slug='test-narration-region')
        self.place = Place.objects.create(name='临时公园', slug='test-narration-place', kind='park', region=self.region)
        self.route = Route.objects.create(region=self.region, title='临时路线', slug='test-narration-route', published=True)
        self.stop = RouteStop.objects.create(route=self.route, place=self.place, order=1, note='临时节点')
        self.audio = sample_wav()
        self.api = APIClient()

    def create(self, **extra):
        values = dict(source=self.content, filename='sample.wav', data=self.audio, reviewer=self.reviewer,
                      rights_note='测试专用临时无声 WAV，不作正式讲解。', reviewed=True, copyright_confirmed=True, publish=True)
        values.update(extra)
        return import_narration(**values)

    def metadata(self, kind='content', source=None):
        return self.api.get('/api/v1/narrations/', {kind: str((source or self.content).pk)})

    def audio_response(self, item, **extra):
        return self.api.get(f'/api/v1/narrations/{item.pk}/audio/', **extra)

    def test_no_audio_has_no_public_entry_and_parameters_are_strict(self):
        self.assertIsNone(self.metadata().json()['data'])
        for params in [{}, {'content': 'bad'}, {'content': str(self.content.pk), 'route': str(self.route.pk)}, {'url': 'https://invalid/audio.mp3'}]:
            self.assertEqual(self.api.get('/api/v1/narrations/', params).status_code, 400)

    def test_only_reviewed_authorized_published_audio_is_public_even_without_login(self):
        draft = self.create(publish=False)
        self.assertIsNone(self.metadata().json()['data'])
        self.assertEqual(self.audio_response(draft).status_code, 404)
        item = self.create()
        self.api.credentials(HTTP_AUTHORIZATION='Bearer expired-invalid')
        data = self.metadata().json()['data']
        self.assertEqual(set(data), {'id', 'title', 'mime_type', 'revision', 'audio_path'})
        self.assertEqual(data['id'], str(item.pk))
        response = self.audio_response(item)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.audio)
        self.assertEqual(response['Content-Type'], 'audio/wav')
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        with self.assertRaises(ValueError):
            _ = item.audio.url
        self.assertFalse(str(Path(item.audio.path)).startswith(str(Path(self.temp.name) / 'media')))

    def test_missing_review_rights_or_administrator_permissions_reject_import(self):
        staff = User.objects.create_user(username='narration-viewer', is_staff=True)
        for extra in [{'reviewed': False}, {'copyright_confirmed': False}, {'rights_note': ' '}]:
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                self.create(**extra)
        with self.assertRaises(PermissionDenied):
            self.create(reviewer=staff)
        staff.user_permissions.add(Permission.objects.get(codename='add_narration', content_type__app_label='narration'))
        staff = User.objects.get(pk=staff.pk)
        with self.assertRaises(PermissionDenied):
            self.create(reviewer=staff)
        self.assertEqual(Narration.objects.count(), 0)

    def test_magic_size_mismatch_and_truncation_rejected(self):
        for data, name in [(b'<html>not audio</html>', 'file.mp3'), (self.audio, 'file.mp3'),
                           (b'ID3' + b'\0' * 20, 'file.mp3'), (b'\0\0\0\x14ftypM4A ' + b'\0' * 8, 'file.m4a'),
                           (self.audio[:-2], 'file.wav'), (b'', 'file.wav'),
                           (b'\0' * (MAX_AUDIO_BYTES + 1), 'file.wav')]:
            with self.subTest(name=name, size=len(data)), self.assertRaises(ValidationError):
                validate_audio(data, name)
        self.assertEqual(validate_audio(self.audio, 'test.WAV'), ('wav', 'audio/wav'))

    def test_article_revision_and_publication_gate_stop_metadata_and_bytes(self):
        item = self.create()
        self.content.body = '已修改正文'
        self.content.save()
        self.assertIsNone(self.metadata().json()['data'])
        self.assertEqual(self.audio_response(item).status_code, 404)
        replacement = self.create()
        item.refresh_from_db()
        self.assertEqual(item.status, 'withdrawn')
        self.assertEqual(self.audio_response(replacement).status_code, 200)
        self.content.status = 'draft'
        self.content.save()
        self.assertEqual(self.audio_response(replacement).status_code, 404)

    def test_route_stop_wording_place_visibility_and_place_wording_invalidate_audio(self):
        item = self.create(source=self.route)
        self.assertEqual(self.metadata('route', self.route).json()['data']['id'], str(item.pk))
        self.stop.note = '修改节点说明'
        self.stop.save()
        self.assertEqual(self.audio_response(item).status_code, 404)
        current = self.create(source=self.route)
        self.place.description = '修改地点介绍'
        self.place.save()
        self.assertEqual(self.audio_response(current).status_code, 404)
        current = self.create(source=self.route)
        self.place.is_published = False
        self.place.save()
        self.assertIsNone(self.metadata('route', self.route).json()['data'])
        self.assertEqual(self.audio_response(current).status_code, 404)
        with self.assertRaises(ValidationError):
            self.create(source=self.route)

    def test_range_requests_and_invalid_ranges(self):
        item = self.create()
        for header, expected in [('bytes=0-9', self.audio[:10]), ('bytes=-8', self.audio[-8:]), ('bytes=10-', self.audio[10:])]:
            response = self.audio_response(item, HTTP_RANGE=header)
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, expected)
            self.assertEqual(int(response['Content-Length']), len(expected))
        for header in ['bytes=999999-', 'bytes=9-1', 'bytes=-0', 'bytes=0-2,4-5', 'bytes=--', 'bytes=' + '9' * 4500 + '-']:
            self.assertEqual(self.audio_response(item, HTTP_RANGE=header).status_code, 416)

    def test_missing_tampered_and_withdrawn_files_are_not_served(self):
        item = self.create()
        Path(item.audio.path).write_bytes(self.audio[:-1] + b'X')
        self.assertEqual(self.audio_response(item).status_code, 404)
        Path(item.audio.path).unlink()
        self.assertIsNone(self.metadata().json()['data'])
        self.assertEqual(self.audio_response(item).status_code, 404)
        item.status = 'withdrawn'
        item.save()
        self.assertEqual(self.audio_response(item).status_code, 404)

    def test_immutable_source_and_audio_and_cascade_file_cleanup(self):
        item = self.create()
        item.source_revision = '0' * 64
        with self.assertRaises(ValidationError):
            item.save()
        item.refresh_from_db()
        path = Path(item.audio.path)
        with self.captureOnCommitCallbacks(execute=True):
            self.content.delete()
        self.assertFalse(path.exists())
        self.assertFalse(Narration.objects.exists())

    def test_failed_audit_rolls_back_record_file_and_prior_publication(self):
        old = self.create()
        with patch('narration.services.audit_admin', side_effect=RuntimeError('audit failed')):
            with self.assertRaises(RuntimeError):
                self.create()
        old.refresh_from_db()
        self.assertEqual(old.status, 'published')
        self.assertEqual(Narration.objects.count(), 1)
        self.assertEqual(len(list(Path(private_storage.location).rglob('*.wav'))), 1)
        self.assertEqual(AuditLog.objects.filter(event='narration.imported').count(), 1)
        # Without withdrawing an old publication, fail after the new file was saved.
        with patch('narration.services.audit_admin', side_effect=RuntimeError('audit failed')):
            with self.assertRaises(RuntimeError):
                self.create(publish=False)
        self.assertEqual(Narration.objects.count(), 1)
        self.assertEqual(len(list(Path(private_storage.location).rglob('*.wav'))), 1)

    def test_command_requires_explicit_confirmation_and_admin_can_withdraw(self):
        fixture = Path(self.temp.name) / 'test.wav'
        fixture.write_bytes(self.audio)
        base = dict(content=self.content.slug, file=str(fixture), reviewer=self.reviewer.username, rights_note='临时测试授权', publish=True, stdout=io.StringIO())
        with self.assertRaises(CommandError):
            call_command('import_narration', **base)
        call_command('import_narration', **base, reviewed=True, copyright_confirmed=True)
        item = Narration.objects.get()
        request = RequestFactory().get('/admin/')
        request.user = self.reviewer
        model_admin = NarrationAdmin(Narration, AdminSite())
        self.assertFalse(model_admin.has_add_permission(request))
        model_admin.withdraw_selected(request, Narration.objects.all())
        self.assertEqual(self.audio_response(item).status_code, 404)
        self.assertTrue(AuditLog.objects.filter(event='narration.withdrawn').exists())

    def test_view_only_admin_cannot_withdraw_and_storage_cannot_be_public(self):
        viewer = User.objects.create_user(username='narration-readonly', is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(codename='view_narration', content_type__app_label='narration'))
        request = RequestFactory().get('/admin/')
        request.user = viewer
        self.assertNotIn('withdraw_selected', NarrationAdmin(Narration, AdminSite()).get_actions(request))
        with override_settings(NARRATION_STORAGE_ROOT=self.temp.name + '/media/audio'):
            with self.assertRaises(ImproperlyConfigured):
                _ = private_storage.location

    def test_forged_storage_path_and_two_source_links_are_rejected(self):
        item = self.create()
        item.audio = '../outside.wav'
        with self.assertRaises(ValidationError):
            item.save()
        item.refresh_from_db()
        item.route = self.route
        with self.assertRaises(ValidationError):
            item.save()
