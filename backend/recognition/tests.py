"""Real tiny ONNX fixtures test the runtime, not flower-recognition accuracy."""
import copy
import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from PIL import Image
from django.contrib.auth.models import Permission
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from accounts.services import issue_session
from assets.models import Asset
from assets.services import create_asset
from knowledge.models import Content
from .adapter import infer, low_image_quality, preprocess, validate_graph
from .artifacts import ModelError, config_digest, read_manifest, verify_artifact
from .isolation import execution_lock, run_child
from .models import ModelVersion, RecognitionJob
from .registry import activate_model, public_status, register_model, snapshot_for
from .worker import _claim, process_one, recover_stale_jobs


def tiny_model():
    weights = np.zeros((3, 5), dtype=np.float32)
    weights[0, 0] = 0.5
    bias = np.array([4, 1, 0, -1, -2], dtype=np.float32)
    graph = helper.make_graph([
        helper.make_node('ReduceMean', ['image'], ['pooled'], axes=[2, 3], keepdims=0),
        helper.make_node('MatMul', ['pooled', 'weights'], ['features']),
        helper.make_node('Add', ['features', 'bias'], ['logits']),
    ], 'synthetic-test-only', [helper.make_tensor_value_info('image', TensorProto.FLOAT, ['batch', 3, 224, 224])],
       [helper.make_tensor_value_info('logits', TensorProto.FLOAT, ['batch', 5])],
       [numpy_helper.from_array(weights, 'weights'), numpy_helper.from_array(bias, 'bias')])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 10
    return model


def gradient_image(size=(96, 64)):
    width, height = size
    y, x = np.indices((height, width))
    pixels = np.stack((x * 255 // max(1, width - 1), y * 255 // max(1, height - 1), (x + y) * 255 // max(1, width + height - 2)), axis=-1).astype(np.uint8)
    return Image.fromarray(pixels)


class FixtureMixin:
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory(prefix='hyhq-m3-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'models'
        self.media = self.root / 'media'
        self.artifacts.mkdir()
        self.media.mkdir()
        self.lock = self.root / 'execution.lock'
        self.settings_override = override_settings(RECOGNITION_MODEL_ROOT=self.artifacts, MEDIA_ROOT=self.media,
                                                   RECOGNITION_LOCK_PATH=self.lock, RECOGNITION_RUN_TIMEOUT_SECONDS=10)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.manifest = self.write_manifest()
        self.image = self.media / 'gradient.jpg'
        gradient_image().save(self.image)

    def write_manifest(self, version='v1', threshold=0.8):
        model_path = self.artifacts / f'{version}.onnx'
        model_path.write_bytes(tiny_model().SerializeToString())
        manifest = {
            'model_name': 'tiny-test-only', 'model_version': version, 'artifact': model_path.name,
            'sha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
            'labels': [{'id': label, 'name': label, 'knowledge_slug': f'flower-{label}'} for label in ('daisy', 'dandelion', 'roses', 'sunflowers', 'tulips')],
            'preprocessing': {'resize_shorter': 256, 'crop_size': 224, 'interpolation': 'bilinear', 'mean': [0.485, 0.456, 0.406], 'std': [0.229, 0.224, 0.225]},
            'threshold': threshold, 'scope': '五类花卉测试契约；此制品仅用于软件测试。',
            'license': 'CC0 test fixture', 'source_url': 'https://example.org/test-fixture', 'evaluation': {'fixture': True},
        }
        path = self.artifacts / f'{version}.json'
        path.write_text(json.dumps(manifest), encoding='utf-8')
        return path

    def snapshot(self):
        return dict(read_manifest(self.artifacts, self.manifest), id='test-id')


class AdapterTests(FixtureMixin, SimpleTestCase):
    def test_real_onnx_cpu_inference_has_ordered_finite_scores(self):
        result = infer(self.snapshot(), self.image, self.artifacts, self.media)
        self.assertEqual(result['decision'], 'recognized')
        self.assertEqual(len(result['candidates']), 3)
        self.assertEqual(result['candidates'][0]['label'], 'daisy')
        scores = [candidate['score'] for candidate in result['candidates']]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertTrue(all(0 <= score <= 1 for score in scores))
        self.assertNotIn('artifact', result['model'])

    def test_threshold_returns_uncertain_without_changing_scores(self):
        snapshot = self.snapshot()
        snapshot['threshold'] = 1.0
        snapshot['config_digest'] = config_digest(snapshot)
        result = infer(snapshot, self.image, self.artifacts, self.media)
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'LOW_CONFIDENCE')
        self.assertEqual(len(result['candidates']), 3)

    def test_quality_gate_handles_size_and_spatial_variance(self):
        self.assertTrue(low_image_quality(gradient_image((31, 80))))
        self.assertFalse(low_image_quality(gradient_image((32, 80))))
        self.assertTrue(low_image_quality(Image.new('RGB', (80, 80), 'red')))
        pixels = np.ones((80, 80, 3), dtype=np.uint8) * 100
        pixels[0] += 1
        self.assertTrue(low_image_quality(Image.fromarray(pixels)))
        Image.new('RGB', (1, 1), 'green').save(self.image)
        result = infer(self.snapshot(), self.image, self.artifacts, self.media)
        self.assertEqual(result['reason'], 'LOW_IMAGE_QUALITY')
        self.assertEqual(result['candidates'], [])

    def test_preprocessing_matches_declared_rounding(self):
        image = gradient_image((89, 67))
        prep = self.snapshot()['preprocessing']
        actual = preprocess(image, prep)
        reference = image.resize((int(256 * 89 / 67), 256), Image.Resampling.BILINEAR)
        left = round((reference.width - 224) / 2)
        top = round((reference.height - 224) / 2)
        pixels = np.asarray(reference.crop((left, top, left + 224, top + 224)), dtype=np.float32) / np.float32(255)
        expected = ((pixels - np.array(prep['mean'], dtype=np.float32)) / np.array(prep['std'], dtype=np.float32)).transpose(2, 0, 1)[None]
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.shape, (1, 3, 224, 224))
        self.assertEqual(actual.dtype, np.float32)

    def test_checksum_config_and_path_escape_fail_closed(self):
        snapshot = self.snapshot()
        (self.artifacts / snapshot['artifact']).write_bytes(b'changed')
        with self.assertRaises(ModelError) as caught:
            verify_artifact(self.artifacts, snapshot)
        self.assertEqual(caught.exception.code, 'MODEL_CHECKSUM_MISMATCH')
        snapshot['threshold'] = 0.1
        with self.assertRaises(ModelError) as caught:
            verify_artifact(self.artifacts, snapshot)
        self.assertEqual(caught.exception.code, 'MODEL_CONFIG_MISMATCH')
        self.manifest = self.write_manifest()
        snapshot = self.snapshot()
        outside = self.root / 'outside.onnx'
        outside.write_bytes((self.artifacts / snapshot['artifact']).read_bytes())
        link = self.artifacts / 'link.onnx'
        link.symlink_to(outside)
        snapshot['artifact'] = 'link.onnx'
        snapshot['config_digest'] = config_digest(snapshot)
        with self.assertRaises(ModelError) as caught:
            verify_artifact(self.artifacts, snapshot)
        self.assertEqual(caught.exception.code, 'MODEL_PATH_INVALID')
        snapshot['artifact'] = '../outside.onnx'
        snapshot['config_digest'] = config_digest(snapshot)
        with self.assertRaises(ModelError):
            verify_artifact(self.artifacts, snapshot)

    def test_external_weights_and_incompatible_io_are_rejected(self):
        model = tiny_model()
        tensor = model.graph.initializer[0]
        tensor.data_location = TensorProto.EXTERNAL
        tensor.external_data.add(key='location', value='../external.bin')
        with self.assertRaises(ModelError) as caught:
            validate_graph(model.SerializeToString())
        self.assertEqual(caught.exception.code, 'MODEL_EXTERNAL_DATA_FORBIDDEN')
        model = tiny_model()
        model.graph.output[0].type.tensor_type.shape.dim[1].dim_value = 6
        with self.assertRaises(ModelError) as caught:
            validate_graph(model.SerializeToString())
        self.assertEqual(caught.exception.code, 'MODEL_IO_INVALID')

    def test_actual_child_exec_has_no_django_or_database_dependency(self):
        with execution_lock(self.lock) as fd:
            result = run_child(self.snapshot(), self.image, self.artifacts, self.media, 10, fd)
        self.assertEqual(result['decision'], 'recognized')

    def test_non_object_child_json_is_rejected_as_invalid_output(self):
        real_popen = subprocess.Popen
        for raw in ('[]', '42', 'null', '"unexpected"'):
            with self.subTest(raw=raw):
                def malformed_child(command, **kwargs):
                    return real_popen([sys.executable, '-c', 'import sys; sys.stdout.write(sys.argv[1])', raw], **kwargs)
                with execution_lock(self.lock) as fd, patch('recognition.isolation.subprocess.Popen', side_effect=malformed_child):
                    with self.assertRaises(ModelError) as caught:
                        run_child(self.snapshot(), self.image, self.artifacts, self.media, 10, fd)
                self.assertEqual(caught.exception.code, 'MODEL_OUTPUT_INVALID')

    def test_timeout_kills_real_child_and_releases_lock(self):
        real_popen = subprocess.Popen
        children = []
        def slow_child(command, **kwargs):
            child = real_popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
            children.append(child)
            return child
        with execution_lock(self.lock) as fd, patch('recognition.isolation.subprocess.Popen', side_effect=slow_child):
            started = time.monotonic()
            with self.assertRaises(ModelError) as caught:
                run_child(self.snapshot(), self.image, self.artifacts, self.media, 0.2, fd)
            self.assertEqual(caught.exception.code, 'INFERENCE_TIMEOUT')
            self.assertLess(time.monotonic() - started, 3)
            self.assertIsNotNone(children[0].poll())
        with execution_lock(self.lock) as fd:
            self.assertIsNotNone(fd)

    def test_inherited_fd_serializes_after_parent_releases_handle(self):
        code = "import signal,time; signal.signal(signal.SIGALRM,signal.SIG_DFL); signal.setitimer(signal.ITIMER_REAL,0.5); print('ready',flush=True); time.sleep(30)"
        with execution_lock(self.lock) as fd:
            child = subprocess.Popen([sys.executable, '-c', code], pass_fds=(fd,), stdout=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.poll() is None and child.kill())
            self.assertEqual(child.stdout.readline().strip(), 'ready')
        with execution_lock(self.lock) as contender:
            self.assertIsNone(contender)
        child.wait(timeout=3)
        child.stdout.close()
        self.assertEqual(child.returncode, -signal.SIGALRM)
        with execution_lock(self.lock) as contender:
            self.assertIsNotNone(contender)


class RegistryWorkerTests(FixtureMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user(username='m3-test-user', password=None)
        self.model = register_model(self.manifest, activate=True)

    def job(self, image=None):
        stream = io.BytesIO()
        (gradient_image() if image is None else image).save(stream, 'JPEG')
        asset = create_asset(self.user, SimpleUploadedFile('test.jpg', stream.getvalue(), content_type='image/jpeg'), 'recognition')
        return RecognitionJob.objects.create(owner=self.user, asset=asset, expires_at=timezone.now() + timedelta(days=30))

    def test_worker_runs_real_model_and_preserves_private_snapshot(self):
        content = Content.objects.create(title='雏菊', slug='test-daisy', body='测试', status='published', plant_label='daisy')
        job = self.job()
        self.assertTrue(process_one())
        job.refresh_from_db()
        self.assertEqual(job.status, 'succeeded')
        self.assertEqual(job.result['candidates'][0]['content_id'], str(content.pk))
        self.assertEqual(job.model_snapshot['checksum'], self.model.checksum)
        self.assertEqual(job.model_snapshot['artifact'], self.model.artifact)
        token, _ = issue_session(self.user)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        response = client.get(f'/api/v1/recognition-jobs/{job.pk}/')
        public = response.json()['data']
        self.assertNotIn('model_snapshot', public)
        self.assertNotIn('artifact', public['result']['model'])

    def test_low_quality_is_successful_uncertain_not_invented_prediction(self):
        job = self.job(Image.new('RGB', (1, 1), 'red'))
        self.assertTrue(process_one())
        job.refresh_from_db()
        self.assertEqual(job.status, 'succeeded')
        self.assertEqual(job.error_code, '')
        self.assertEqual(job.result['reason'], 'LOW_IMAGE_QUALITY')
        self.assertEqual(job.result['candidates'], [])

    def test_register_idempotent_activate_disable_rollback_and_history_immutable(self):
        self.assertEqual(register_model(self.manifest).pk, self.model.pk)
        job = self.job()
        process_one()
        job.refresh_from_db()
        historical = copy.deepcopy(job.model_snapshot)
        second = register_model(self.write_manifest('v2', threshold=1), activate=True)
        self.assertEqual(ModelVersion.objects.filter(enabled=True).get().pk, second.pk)
        activate_model(self.model.pk)
        self.assertEqual(ModelVersion.objects.filter(enabled=True).get().pk, self.model.pk)
        self.model.refresh_from_db()
        self.model.threshold = 0.2
        with self.assertRaises(ValidationError):
            self.model.save()
        activate_model(None)
        self.assertFalse(public_status()['enabled'])
        job.refresh_from_db()
        self.assertEqual(job.model_snapshot, historical)
        self.assertEqual(job.result['model']['version'], 'v1')

    def test_enabled_unique_constraint_and_manifest_version_conflict(self):
        second = register_model(self.write_manifest('v2'))
        with self.assertRaises(IntegrityError), transaction.atomic():
            ModelVersion.objects.filter(pk=second.pk).update(enabled=True)
        manifest = json.loads(self.manifest.read_text())
        manifest['threshold'] = 0.1
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaises(ModelError) as caught:
            register_model(self.manifest)
        self.assertEqual(caught.exception.code, 'MODEL_VERSION_EXISTS')

    def test_health_contract_and_missing_artifact(self):
        data = APIClient().get('/api/v1/health/').json()['data']
        self.assertEqual(data['version'], 'm5')
        self.assertTrue(data['features']['recognition'])
        self.assertFalse(data['features']['llm'])
        self.assertEqual(len(data['recognition']['labels']), 5)
        self.assertNotIn('artifact', data['recognition'])
        (self.artifacts / self.model.artifact).unlink()
        self.assertFalse(public_status()['enabled'])

    def test_busy_worker_leaves_queued_job_untouched(self):
        job = self.job()
        with execution_lock(self.lock):
            self.assertFalse(process_one())
            self.assertEqual(recover_stale_jobs(), 0)
        job.refresh_from_db()
        self.assertEqual(job.status, 'queued')

    def test_orphan_recovery_expired_asset_and_no_model_compatibility(self):
        orphan = self.job()
        RecognitionJob.objects.filter(pk=orphan.pk).update(status='running', started_at=timezone.now())
        self.assertEqual(recover_stale_jobs(), 1)
        orphan.refresh_from_db()
        self.assertEqual(orphan.error_code, 'WORKER_INTERRUPTED')
        expired = self.job()
        expired.asset.original_expires_at = timezone.now() - timedelta(seconds=1)
        expired.asset.save(update_fields=['original_expires_at'])
        process_one()
        expired.refresh_from_db()
        self.assertEqual(expired.error_code, 'ASSET_EXPIRED')
        activate_model(None)
        disabled = self.job()
        process_one()
        disabled.refresh_from_db()
        self.assertEqual(disabled.error_code, 'MODEL_NOT_CONFIGURED')

    def test_deleted_job_is_not_resurrected_when_child_returns(self):
        job = self.job()
        def delete_during_inference(*args, **kwargs):
            job.delete()
            return {'decision': 'uncertain', 'candidates': []}
        with patch('recognition.worker.run_child', side_effect=delete_during_inference):
            self.assertTrue(process_one())
        self.assertFalse(RecognitionJob.objects.exists())

    def test_asset_deleted_during_inference_discards_result(self):
        job = self.job()

        def delete_during_inference(*args, **kwargs):
            Asset.objects.filter(pk=job.asset_id).delete()
            return {'decision': 'recognized', 'candidates': [{'label': 'daisy', 'name': '雏菊', 'score': 0.9}]}

        with patch('recognition.worker.run_child', side_effect=delete_during_inference):
            self.assertTrue(process_one())
        job.refresh_from_db()
        self.assertIsNone(job.asset_id)
        self.assertEqual((job.status, job.error_code, job.result), ('failed', 'ASSET_EXPIRED', {}))

    def test_original_expiring_during_inference_discards_result(self):
        job = self.job()

        def expire_during_inference(*args, **kwargs):
            Asset.objects.filter(pk=job.asset_id).update(original_expires_at=timezone.now() - timedelta(seconds=1))
            return {'decision': 'recognized', 'candidates': [{'label': 'daisy', 'name': '雏菊', 'score': 0.9}]}

        with patch('recognition.worker.run_child', side_effect=expire_during_inference):
            self.assertTrue(process_one())
        job.refresh_from_db()
        self.assertEqual((job.status, job.error_code, job.result), ('failed', 'ASSET_EXPIRED', {}))

    def test_asset_deleted_after_claim_fails_job_without_stopping_worker(self):
        job = self.job()

        def claim_then_delete_asset():
            claimed = _claim()
            Asset.objects.filter(pk=claimed.asset_id).delete()
            return claimed

        with patch('recognition.worker._claim', side_effect=claim_then_delete_asset):
            self.assertTrue(process_one())
        job.refresh_from_db()
        self.assertEqual(job.status, 'failed')
        self.assertEqual(job.error_code, 'ASSET_EXPIRED')
        self.assertIsNone(job.asset_id)
        next_job = self.job()
        self.assertTrue(process_one())
        next_job.refresh_from_db()
        self.assertEqual(next_job.status, 'succeeded')

    def test_view_only_staff_cannot_activate_or_disable_models(self):
        staff = User.objects.create_user(username='model-viewer', is_staff=True)
        staff.user_permissions.add(Permission.objects.get(content_type__app_label='recognition', codename='view_modelversion'))
        self.client.force_login(staff)
        second = register_model(self.write_manifest('v2'))
        for action, selected in [('activate_selected', second), ('disable_selected', self.model)]:
            response = self.client.post('/admin/recognition/modelversion/', {
                'action': action, '_selected_action': [str(selected.pk)], 'index': '0',
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(ModelVersion.objects.get(enabled=True).pk, self.model.pk)

    def test_change_staff_can_activate_and_disable_models(self):
        staff = User.objects.create_user(username='model-editor', is_staff=True)
        staff.user_permissions.add(Permission.objects.get(content_type__app_label='recognition', codename='change_modelversion'))
        self.client.force_login(staff)
        second = register_model(self.write_manifest('v2'))
        response = self.client.post('/admin/recognition/modelversion/', {
            'action': 'activate_selected', '_selected_action': [str(second.pk)], 'index': '0',
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(ModelVersion.objects.get(enabled=True).pk, second.pk)
        response = self.client.post('/admin/recognition/modelversion/', {
            'action': 'disable_selected', '_selected_action': [str(second.pk)], 'index': '0',
        })
        self.assertEqual(response.status_code, 302)
        self.assertFalse(ModelVersion.objects.filter(enabled=True).exists())

    def test_cli_registration_activation_and_disable(self):
        output = io.StringIO()
        call_command('register_model', str(self.manifest), stdout=output)
        self.assertIn(str(self.model.pk), output.getvalue())
        call_command('activate_model', disable=True, stdout=io.StringIO())
        self.assertFalse(public_status()['enabled'])
        call_command('activate_model', str(self.model.pk), stdout=io.StringIO())
        self.assertTrue(public_status()['enabled'])


class LegacyUpgradeTests(TransactionTestCase):
    migrate_from = [('recognition', '0002_queuecontrol')]
    migrate_to = [('recognition', '0003_modelversion_artifact_modelversion_config_digest_and_more')]

    def test_m1_multiple_enabled_rows_are_disabled_before_unique_index(self):
        executor = MigrationExecutor(connection)
        executor.migrate(self.migrate_from)
        try:
            apps = executor.loader.project_state(self.migrate_from).apps
            old_model = apps.get_model('recognition', 'ModelVersion')
            old_model.objects.create(name='legacy', version='one', enabled=True)
            old_model.objects.create(name='legacy', version='two', enabled=True)
            executor = MigrationExecutor(connection)
            executor.migrate(self.migrate_to)
            new_model = executor.loader.project_state(self.migrate_to).apps.get_model('recognition', 'ModelVersion')
            self.assertEqual(new_model.objects.count(), 2)
            self.assertFalse(new_model.objects.filter(enabled=True).exists())
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
