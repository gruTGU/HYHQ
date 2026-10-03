#!/usr/bin/env python3
"""Run a bounded cloud-protocol/real-CPU integration test on an isolated local DB.

Requires an empty/disposable PostgreSQL database named hyhq_cloud_validation on
127.0.0.1:55438. Never reads production environment files or calls providers.
CloudBase SDK is replaced by the explicitly labelled local HTTP bridge.
"""
import argparse
import io
import json
import logging
import os
from pathlib import Path
import random
import signal
import socket
import subprocess
import sys
import time
import uuid
import wave
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', required=True)
    parser.add_argument('--flower-image', required=True)
    parser.add_argument('--river-image', required=True)
    args = parser.parse_args()
    if (ROOT / 'backend/.env').exists():
        raise SystemExit('Use an isolated checkout without backend/.env for this validation.')
    base = ROOT / '.runtime/cloud-migration/live'
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    base.chmod(0o700)
    os.environ.update({
        'DJANGO_SETTINGS_MODULE': 'config.settings', 'ENV': 'test', 'DJANGO_DEBUG': '0',
        'ALLOW_DEV_AUTH': '0', 'HYHQ_USE_SQLITE': '0',
        'DATABASE_URL': 'postgresql://hyhq_cloud_test@127.0.0.1:55438/hyhq_cloud_validation',
        'DJANGO_ALLOWED_HOSTS': 'localhost,127.0.0.1,testserver', 'TRUST_PROXY_HTTPS': '0',
        'CLOUD_TRANSFER_ENABLED': '1', 'LLM_ENABLED': '0', 'QWEATHER_ENABLED': '0',
        'DEEPSEEK_API_KEY': '', 'QWEATHER_API_KEY': '', 'WECHAT_APP_ID': '', 'WECHAT_APP_SECRET': '',
        'COMMUNITY_ENABLED': '0', 'WEATHER_SUBSCRIPTIONS_ENABLED': '0',
        'QWEATHER_FORECAST_ENABLED': '0', 'HYHQ_MEDIA_ROOT': str(base / 'private'),
        'HYHQ_MODEL_ROOT': str(Path(args.model_root).resolve()),
        'HYHQ_ASSESSMENT_MODEL_ROOT': str(Path(args.model_root).resolve()),
        'HYHQ_RECOGNITION_LOCK_PATH': str(base / 'cpu.lock'),
    })
    # Fail before creating fixtures if the fixed listener is occupied.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 18083))
    sys.path.insert(0, str(ROOT / 'backend'))
    import django
    django.setup()
    logging.getLogger().setLevel(logging.WARNING)
    from django.core.management import call_command
    from django.utils import timezone
    from accounts.models import User
    from accounts.services import issue_session
    from knowledge.models import Content
    from narration.services import import_narration
    from PIL import Image

    output = io.StringIO()
    call_command('migrate', interactive=False, stdout=output)
    call_command('seed_demo', stdout=output)
    call_command('seed_assessment_rules', activate=True, stdout=output)
    call_command('register_model', str(Path(args.model_root).resolve() / 'flowers-efficientnet-b0-v1.manifest.json'), activate=True, stdout=output)
    call_command('register_detector', str(Path(args.model_root).resolve() / 'river-floating-debris-v1.manifest.json'), activate=True, stdout=output)
    users, children, streams = [], [], []
    source = None
    fixture_file = base / 'fixture.private.json'
    try:
        for label in ('owner', 'other', 'reviewer'):
            users.append(User.objects.create_user(username='cloud-smoke-' + label + '-' + uuid.uuid4().hex,
                         is_staff=label == 'reviewer', is_superuser=label == 'reviewer'))
        source = Content.objects.create(title='Cloud transfer local verification', slug='cloud-smoke-' + uuid.uuid4().hex,
            body='Generated verification content. Not production narration.', status='published', published_at=timezone.now())
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
            wav.writeframes(b'\0\0' * 8000 * 15)
        audio_file = base / 'generated-silence.wav'
        audio_file.write_bytes(audio.getvalue())
        narration = import_narration(source=source, filename='generated-silence.wav', data=audio.getvalue(), reviewer=users[2],
            rights_note='Original generated PCM silence for isolated protocol testing only.',
            reviewed=True, copyright_confirmed=True, publish=True)
        noisy = Image.frombytes('RGB', (512, 512), random.Random(41).randbytes(512 * 512 * 3))
        image_file = base / 'multichunk.png'
        noisy.save(image_file)
        fixture = {'origin': 'http://127.0.0.1:18083', 'owner': issue_session(users[0])[0], 'other': issue_session(users[1])[0],
            'multichunk_image': str(image_file), 'flower_image': str(Path(args.flower_image).resolve()),
            'river_image': str(Path(args.river_image).resolve()), 'audio_path': f'/api/v1/narrations/{narration.pk}/audio/',
            'audio_file': str(audio_file)}
        fixture_file.write_text(json.dumps(fixture)); fixture_file.chmod(0o600)
        for name, arguments in (
            ('api', ['runserver', '127.0.0.1:18083', '--noreload']),
            ('flower', ['run_recognition_worker']), ('river', ['run_assessment_worker']),
        ):
            stream = (base / (name + '.log')).open('wb'); streams.append(stream)
            children.append(subprocess.Popen([sys.executable, 'manage.py', *arguments], cwd=ROOT / 'backend',
                env=os.environ.copy(), stdout=stream, stderr=subprocess.STDOUT, start_new_session=True))
        opener = build_opener(ProxyHandler({}))
        for _ in range(50):
            if any(child.poll() is not None for child in children):
                raise RuntimeError('Local validation process exited; inspect private logs')
            try:
                with opener.open('http://127.0.0.1:18083/api/v1/health/', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError('Local API did not become ready')
        result = subprocess.run(['node', str(ROOT / 'scripts/cloud-local-smoke.mjs'), str(fixture_file)],
            cwd=ROOT, capture_output=True, text=True, timeout=120)
        (base / 'bridge-stderr.log').write_text(result.stderr)
        if result.returncode:
            raise RuntimeError('Local cloud bridge failed; inspect private bridge-stderr.log')
        report = json.loads(result.stdout)
        report.update({'external_provider_calls': 0, 'actual_cloud_sdk': False, 'actual_cloud_mount': False})
        (base / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
        for stream in streams:
            stream.close()
        fixture_file.unlink(missing_ok=True)
        if source is not None:
            source.delete()
        for user in users:
            User.objects.filter(pk=user.pk).delete()


if __name__ == '__main__':
    main()
