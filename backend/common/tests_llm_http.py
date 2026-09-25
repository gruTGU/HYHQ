"""Real localhost HTTP business flow; neither DeepSeek nor ML inference is run.

Only the already-completed local recognition result is a database fixture. Login,
private image upload, consent, conversations, polling, quota and deletion all go
through the live HTTP server. DeepSeek responses are explicitly synthetic.
"""
import base64
import io
import json
import socket
import tempfile
import uuid
from datetime import timedelta
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from unittest.mock import patch
from unittest import skipUnless

from django.core.cache import cache
from django.test import LiveServerTestCase, override_settings
from django.utils import timezone
from PIL import Image

from accounts.models import User
from assets.models import Asset
from llm.models import GatewayConfig, LLMSession, LLMTurn, UsageLedger
from llm.worker import process_one
from recognition.models import RecognitionJob


def localhost_listener_available():
    try:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
    except PermissionError:
        return False
    return True


@skipUnless(localhost_listener_available(), '当前沙箱禁止监听本地端口；真实 HTTP 流程需在允许本地套接字的环境补验。')
@override_settings(ENV='development', DEBUG=True, ALLOW_DEV_AUTH=True, LLM_ENABLED=True,
                   DEEPSEEK_API_KEY='synthetic-never-sent', DEEPSEEK_MODEL='deepseek-flash')
class LLMLocalHTTPTests(LiveServerTestCase):
    def setUp(self):
        cache.clear()
        directory = tempfile.TemporaryDirectory(prefix='hyhq-llm-http-')
        self.addCleanup(directory.cleanup)
        settings_override = override_settings(MEDIA_ROOT=directory.name)
        settings_override.enable()
        self.addCleanup(settings_override.disable)
        self.opener = build_opener(ProxyHandler({}))
        # A second guard ensures a mistaken patch target cannot make a paid call.
        transport_guard = patch('llm.provider._exchange', side_effect=AssertionError('External transport forbidden in HTTP tests'))
        transport_guard.start()
        self.addCleanup(transport_guard.stop)
        provider_patch = patch('llm.worker.provider.generate', side_effect=self.synthetic_reply)
        self.generate = provider_patch.start()
        self.addCleanup(provider_patch.stop)
        config, _ = GatewayConfig.objects.get_or_create(pk=1)
        config.enabled = True
        config.save()

    @staticmethod
    def synthetic_reply(*args, **kwargs):
        return {'text': '【本地 HTTP 集成测试模拟回复】这是候选解读，不能替代植物鉴定或水质实测。',
                'model': 'deepseek-flash', 'upstream_id': 'synthetic-http-only',
                'usage': {'prompt_tokens': 120, 'completion_tokens': 20, 'total_tokens': 140}}

    def http(self, method, path, *, token=None, data=None, body=None, content_type=None):
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            content_type = 'application/json'
        if content_type:
            headers['Content-Type'] = content_type
        request = Request(self.live_server_url + path, data=body, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None

    def login(self, device):
        code, payload = self.http('POST', '/api/v1/auth/dev/', data={'device_id': device})
        self.assertEqual(code, 200, payload)
        return payload['data']

    def upload_recognition_fixture(self, login):
        image = io.BytesIO()
        exif = Image.Exif()
        exif[270] = 'HTTP-TEST-PRIVATE-EXIF'
        Image.new('RGB', (800, 600), '#569872').save(image, 'JPEG', exif=exif)
        boundary = 'hyhq-http-' + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nrecognition\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="local-http.jpg"\r\n'
                'Content-Type: image/jpeg\r\n\r\n').encode()
        body += image.getvalue() + f'\r\n--{boundary}--\r\n'.encode()
        code, payload = self.http('POST', '/api/v1/uploads/', token=login['token'], body=body,
                                  content_type=f'multipart/form-data; boundary={boundary}')
        self.assertEqual(code, 201, payload)
        asset = Asset.objects.get(pk=payload['data']['id'])
        owner = User.objects.get(pk=login['user']['id'])
        # This is the sole precomputed ML fixture, not an assertion of live inference.
        job = RecognitionJob.objects.create(owner=owner, asset=asset, status='succeeded',
            result={'decision': 'recognized', 'candidates': [{'label': 'daisy', 'name': '雏菊类（测试预置）', 'score': 0.82}]},
            model_snapshot={'version': 'synthetic-local-ml-fixture'}, finished_at=timezone.now(),
            expires_at=timezone.now() + timedelta(days=30))
        return job

    def session(self, login, job):
        code, status = self.http('GET', '/api/v1/llm/status/', token=login['token'])
        self.assertEqual(code, 200, status)
        self.assertTrue(status['data']['enabled'])
        code, payload = self.http('POST', '/api/v1/llm/sessions/', token=login['token'], data={
            'recognition_job_id': str(job.pk), 'include_image': True,
            'consent_version': status['data']['consent_version'],
        })
        self.assertEqual(code, 201, payload)
        self.assertTrue(payload['data']['include_image'])
        self.assertTrue(payload['data']['image_available'])
        return payload['data']

    def enqueue(self, login, session, *, request_id=None, expected=201):
        values = {'request_id': request_id or str(uuid.uuid4()), 'question': '解释这次图片识别候选，并说明不确定性。'}
        code, payload = self.http('POST', f"/api/v1/llm/sessions/{session['id']}/turns/", token=login['token'], data=values)
        self.assertEqual(code, expected, payload)
        return payload, values

    def test_real_http_image_chat_five_turns_idempotency_ownership_and_deletion(self):
        login = self.login('llm-http-primary-device-0001')
        job = self.upload_recognition_fixture(login)
        # Registration explains external AI; starting a session needs no repeat
        # consent field and never implicitly includes an image or invokes AI.
        code, created = self.http('POST', '/api/v1/llm/sessions/', token=login['token'],
                                  data={'recognition_job_id': str(job.pk)})
        self.assertEqual(code, 201)
        self.assertFalse(created['data']['include_image'])
        self.generate.assert_not_called()
        code, _ = self.http('DELETE', f"/api/v1/llm/sessions/{created['data']['id']}/", token=login['token'])
        self.assertEqual(code, 204)
        session = self.session(login, job)
        other = self.login('llm-http-other-device-0002')
        for method, path in [('GET', f"/api/v1/llm/sessions/{session['id']}/"),
                             ('GET', f"/api/v1/llm/sessions/{session['id']}/turns/"),
                             ('DELETE', f"/api/v1/llm/sessions/{session['id']}/")]:
            code, _ = self.http(method, path, token=other['token'])
            self.assertEqual(code, 404)

        for index in range(5):
            payload, values = self.enqueue(login, session)
            turn = payload['data']
            self.assertEqual(turn['status'], 'queued')
            duplicate, _ = self.enqueue(login, session, request_id=values['request_id'], expected=200)
            self.assertEqual(duplicate['data']['id'], turn['id'])
            self.assertTrue(process_one())
            code, polled = self.http('GET', f"/api/v1/llm/turns/{turn['id']}/", token=login['token'])
            self.assertEqual(code, 200, polled)
            self.assertEqual(polled['data']['status'], 'succeeded')
            self.assertTrue(polled['data']['used_image'])
            self.assertIn('集成测试模拟回复', polled['data']['answer'])
            self.assertEqual(self.generate.call_count, index + 1)
            code, _ = self.http('GET', f"/api/v1/llm/turns/{turn['id']}/", token=other['token'])
            self.assertEqual(code, 404)

        # Confirm that the worker passed a small, metadata-free inline image.
        messages = self.generate.call_args.args[0]
        images = [part['image_url']['url'] for message in messages if isinstance(message['content'], list)
                  for part in message['content'] if part['type'] == 'image_url']
        self.assertEqual(len(images), 1)
        self.assertTrue(images[0].startswith('data:image/jpeg;base64,'))
        blob = base64.b64decode(images[0].split(',', 1)[1])
        self.assertNotIn(b'HTTP-TEST-PRIVATE-EXIF', blob)
        with Image.open(io.BytesIO(blob)) as processed:
            self.assertLessEqual(max(processed.size), 512)
            self.assertFalse(processed.getexif())
        self.assertNotIn('synthetic-never-sent', json.dumps(messages))

        rejected, _ = self.enqueue(login, session, expected=429)
        self.assertEqual(rejected['error']['code'], 'LLM_DAILY_LIMIT')
        self.assertEqual(self.generate.call_count, 5)
        code, status = self.http('GET', '/api/v1/llm/status/', token=login['token'])
        self.assertEqual(code, 200)
        self.assertEqual((status['data']['quota']['used'], status['data']['quota']['remaining']), (5, 0))

        code, _ = self.http('DELETE', f"/api/v1/llm/sessions/{session['id']}/", token=login['token'])
        self.assertEqual(code, 204)
        self.assertFalse(LLMSession.objects.filter(pk=session['id']).exists())
        self.assertEqual(UsageLedger.objects.filter(owner_id=login['user']['id'], status='succeeded').count(), 5)
        replacement = self.session(login, job)
        rejected, _ = self.enqueue(login, replacement, expected=429)
        self.assertEqual(rejected['error']['code'], 'LLM_DAILY_LIMIT')
        self.http('POST', '/api/v1/auth/logout/', token=login['token'])
        relogin = self.login('llm-http-primary-device-0001')
        _, status = self.http('GET', '/api/v1/llm/status/', token=relogin['token'])
        self.assertEqual(status['data']['quota']['remaining'], 0)
        self.assertEqual(self.generate.call_count, 5)

    def test_real_http_source_deleted_during_reply_keeps_cost_but_no_private_result(self):
        login = self.login('llm-http-delete-device-0003')
        job = self.upload_recognition_fixture(login)
        asset_id = job.asset_id
        session = self.session(login, job)
        payload, _ = self.enqueue(login, session)
        turn_id = payload['data']['id']
        ledger_id = LLMTurn.objects.get(pk=turn_id).ledger_id

        def reply_after_delete(*args, **kwargs):
            code, payload = self.http('DELETE', f'/api/v1/recognition-jobs/{job.pk}/', token=login['token'])
            self.assertEqual(code, 204, payload)
            return self.synthetic_reply()

        self.generate.side_effect = reply_after_delete
        self.assertTrue(process_one())
        self.assertEqual(self.generate.call_count, 1)
        code, _ = self.http('GET', f'/api/v1/llm/turns/{turn_id}/', token=login['token'])
        self.assertEqual(code, 404)
        self.assertFalse(LLMSession.objects.filter(pk=session['id']).exists())
        self.assertFalse(LLMTurn.objects.filter(pk=turn_id).exists())
        self.assertFalse(Asset.objects.filter(pk=asset_id).exists())
        entry = UsageLedger.objects.get(pk=ledger_id)
        self.assertEqual(entry.status, 'failed')
        self.assertIsNone(entry.session_id)
        self.assertEqual(entry.accounted_tokens, 140)
        self.assertFalse(entry.usage_estimated)
        _, status = self.http('GET', '/api/v1/llm/status/', token=login['token'])
        self.assertEqual((status['data']['quota']['used'], status['data']['quota']['remaining']), (0, 5))
