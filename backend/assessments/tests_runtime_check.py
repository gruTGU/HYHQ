import copy
import hashlib
import io
import json
from datetime import timedelta
from unittest.mock import patch

import numpy as np
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from accounts.models import User
from common.models import AuditLog
from recognition.models import QueueControl
from .artifacts import read_manifest
from .management.commands import check_assessment_runtime as diagnostic
from .models import AssessmentJob, DetectionModel, RuleSet
from .registry import snapshot_for
from .rules import RULE_V1, assess
from .tests_runtime import RuntimeFixture, synthetic_model


class RuntimeCheckTests(RuntimeFixture, TestCase):
    def setUp(self):
        super().setUp()
        # Keep all artifacts synthetic and local; no registration/inference is run.
        self.artifact.write_bytes(synthetic_model(np.zeros((1, 14, 2), dtype=np.float32)).SerializeToString())
        self.manifest_data.update(labels=[{'id': index, 'name': f'Fixture {index}', 'eval_category': 'floating_debris'} for index in range(10)],
                                  sha256=hashlib.sha256(self.artifact.read_bytes()).hexdigest())
        self.manifest_data['preprocessing']['supported_class_ids'] = [9]
        self.write_manifest()
        self.model = DetectionModel.objects.create(**read_manifest(self.root, self.manifest), enabled=True)
        self.rule = RuleSet.objects.create(version='fixture-rule', definition=copy.deepcopy(RULE_V1), is_active=True)
        self.owner = User.objects.create_user(username='PRIVATE_OWNER_DO_NOT_PRINT')

    def run_check(self, succeeds=True, **options):
        output = io.StringIO()
        if succeeds:
            call_command('check_assessment_runtime', stdout=output, **options)
        else:
            with self.assertRaises(CommandError) as caught:
                call_command('check_assessment_runtime', stdout=output, **options)
            self.assertEqual(caught.exception.returncode, 1)
            self.assertEqual(str(caught.exception), 'ASSESSMENT_NOT_READY')
        payload = json.loads(output.getvalue())
        self.assertEqual(payload['status'], 'ready' if succeeds else 'not_ready')
        self.assertFalse(payload['inference_executed'])
        self.assertFalse(payload['queue_consumed'])
        return payload

    def job(self, detections=None, reason=''):
        values = detections if detections is not None else [{'class_id': 9, 'label': 'Fixture 9', 'eval_category': 'floating_debris', 'confidence': .8, 'bbox': [0, 0, 20, 20]}]
        result = assess(values, RULE_V1, 100, 100, reason=reason)
        return AssessmentJob.objects.create(owner=self.owner, model_version=self.model,
            model_snapshot=snapshot_for(self.model), rule_set=self.rule, rule_snapshot=copy.deepcopy(RULE_V1),
            rule_version=self.rule.version, status='succeeded', image_width=100, image_height=100, detections=values,
            latitude=30.123456, longitude=120.654321, coordinate_system='GCJ02',
            expires_at=timezone.now() + timedelta(days=1),
            **{name: result[name] for name in ('score', 'grade', 'causes', 'issues', 'decision', 'reason')})

    def test_ready_report_has_only_selects_and_never_locks_registers_consumes_or_infers(self):
        forbidden = AssertionError('Forbidden mutation or inference')
        with patch('assessments.worker.process_one', side_effect=forbidden), \
                patch('assessments.registry.register_detector', side_effect=forbidden), \
                patch('assessments.registry.activate_detector', side_effect=forbidden), \
                patch('recognition.isolation.execution_lock', side_effect=forbidden), \
                patch('assessments.isolation.execution_lock', side_effect=forbidden), \
                patch('assessments.isolation.run_detection', side_effect=forbidden), \
                patch('assessments.detector.infer', side_effect=forbidden), \
                patch('assessments.detector.validate_model', side_effect=forbidden), \
                CaptureQueriesContext(connection) as queries:
            payload = self.run_check()
        self.assertTrue(all(query['sql'].lstrip().upper().startswith('SELECT') for query in queries))
        self.assertTrue(payload['checks']['model']['artifact_checksum_verified'])
        self.assertEqual(payload['verification_level'], 'static_configuration')
        self.assertEqual(payload['checks']['model']['manifest_contract'], 'registered_snapshot')
        self.assertFalse(self.lock.exists())
        self.assertFalse(AssessmentJob.objects.exists())
        self.assertFalse(QueueControl.objects.exists())
        self.assertFalse(AuditLog.objects.exists())
        self.model.refresh_from_db()
        self.assertTrue(self.model.enabled)

    def test_missing_model_or_rules_is_not_ready(self):
        DetectionModel.objects.update(enabled=False)
        RuleSet.objects.update(is_active=False)
        report = self.run_check(succeeds=False)
        self.assertEqual(report['checks']['model']['code'], 'MODEL_NOT_CONFIGURED')
        self.assertEqual(report['checks']['rules']['code'], 'RULE_NOT_CONFIGURED')

    def test_artifact_checksum_path_and_graph_are_checked(self):
        self.artifact.write_bytes(b'changed')
        self.assertEqual(self.run_check(succeeds=False)['checks']['model']['code'], 'MODEL_CHECKSUM_MISMATCH')
        self.artifact.unlink()
        self.assertEqual(self.run_check(succeeds=False)['checks']['model']['code'], 'MODEL_FILE_MISSING')
        # An otherwise self-consistent manifest still cannot bless an incompatible graph.
        bad = synthetic_model(np.zeros((1, 14, 2), dtype=np.float32))
        bad.graph.input[0].type.tensor_type.shape.dim[2].dim_value = 224
        self.artifact.write_bytes(bad.SerializeToString())
        self.manifest_data['sha256'] = hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        self.write_manifest()
        DetectionModel.objects.filter(pk=self.model.pk).update(**read_manifest(self.root, self.manifest))
        self.assertEqual(self.run_check(succeeds=False)['checks']['model']['code'], 'MODEL_IO_INVALID')

    def test_manifest_comparison_is_optional_contained_and_detects_drift(self):
        report = self.run_check(manifest=str(self.manifest))
        self.assertTrue(report['checks']['model']['manifest_file_checked'])
        self.manifest_data['threshold'] = .7
        self.write_manifest()
        self.assertEqual(self.run_check(succeeds=False, manifest=str(self.manifest))['checks']['model']['code'], 'MODEL_MANIFEST_MISMATCH')
        outside = self.root.parent / 'missing-private-manifest.json'
        report = self.run_check(succeeds=False, manifest=str(outside))
        self.assertEqual(report['checks']['model']['code'], 'MODEL_MANIFEST_INVALID')
        self.assertNotIn(str(outside), json.dumps(report))

    def test_invalid_runtime_or_missing_dependency_reports_fixed_codes_without_error_text(self):
        with override_settings(ASSESSMENT_RUN_TIMEOUT_SECONDS=0, RECOGNITION_LOCK_PATH=self.root / 'missing' / 'private.lock'):
            result = self.run_check(succeeds=False)
        self.assertEqual(result['checks']['configuration']['code'], 'RUNTIME_CONFIG_INVALID')
        original_import = diagnostic.importlib.import_module
        def missing(name):
            if name == 'onnxruntime':
                raise ImportError('PRIVATE_EXCEPTION_PATH')
            return original_import(name)
        with patch.object(diagnostic.importlib, 'import_module', side_effect=missing):
            report = self.run_check(succeeds=False)
        self.assertEqual(report['checks']['dependencies']['modules']['onnxruntime'], 'not_ready')
        self.assertNotIn('PRIVATE_EXCEPTION_PATH', json.dumps(report))

    def test_selected_job_is_private_read_only_and_reports_stored_summary(self):
        job = self.job()
        before = copy.deepcopy(job.detections)
        with patch('recognition.adapter.load_image', side_effect=AssertionError('Do not read private images')):
            report = self.run_check(job_id=str(job.pk))
        summary = report['checks']['job']['summary']
        self.assertEqual(summary['candidate_count'], 1)
        self.assertEqual(summary['box_area_ratio'], .04)
        raw = json.dumps(report)
        for private in [str(self.owner.pk), self.owner.username, '30.123456', '120.654321', str(self.image), 'latitude', 'longitude', 'bbox']:
            self.assertNotIn(private, raw)
        job.refresh_from_db()
        self.assertEqual(job.detections, before)
        self.assertEqual(job.status, 'succeeded')

    def test_unfinished_failed_expired_unknown_and_malformed_ids_are_not_successful_tests(self):
        job = self.job()
        for status in ['queued', 'running', 'failed']:
            AssessmentJob.objects.filter(pk=job.pk).update(status=status)
            result = self.run_check(succeeds=False, job_id=str(job.pk))
            self.assertEqual(result['checks']['job']['job_status'], status)
        AssessmentJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.run_check(succeeds=False, job_id=str(job.pk))['checks']['job']['code'], 'JOB_EXPIRED')
        self.assertEqual(self.run_check(succeeds=False, job_id='not-a-uuid')['checks']['job']['code'], 'JOB_ID_INVALID')
        identifier = str(job.pk)
        job.delete()
        self.assertEqual(self.run_check(succeeds=False, job_id=identifier)['checks']['job']['code'], 'JOB_NOT_FOUND')

    def test_rule_tampering_and_invalid_candidate_never_pass_as_historical_success(self):
        job = self.job()
        AssessmentJob.objects.filter(pk=job.pk).update(score=100)
        self.assertEqual(self.run_check(succeeds=False, job_id=str(job.pk))['checks']['job']['code'], 'JOB_RULE_RESULT_MISMATCH')
        AssessmentJob.objects.filter(pk=job.pk).update(detections=[{'class_id': 0, 'confidence': .9, 'eval_category': 'floating_debris', 'bbox': [0, 0, 20, 20]}])
        self.assertEqual(self.run_check(succeeds=False, job_id=str(job.pk))['checks']['job']['code'], 'JOB_RESULT_INVALID')

    def test_uncertain_result_is_valid_structure_without_claiming_clean_water(self):
        job = self.job(detections=[], reason='NO_SUPPORTED_DETECTIONS')
        report = self.run_check(job_id=str(job.pk))
        self.assertTrue(report['checks']['job']['stored_result_verified'])
        self.assertEqual(report['checks']['job']['summary']['status'], 'unavailable')
        self.assertIsNone(report['checks']['job']['summary']['candidate_count'])
        self.assertIsNone(report['checks']['job']['summary']['box_area_ratio'])

    def test_private_media_cannot_be_read_as_a_manifest_or_model_even_with_overlapping_roots(self):
        private_manifest = self.media / 'private.json'
        private_manifest.write_text(json.dumps(self.manifest_data), encoding='utf-8')
        with patch('assessments.management.commands.check_assessment_runtime.read_manifest', side_effect=AssertionError('Must not read media')):
            report = self.run_check(succeeds=False, manifest=str(private_manifest))
        self.assertEqual(report['checks']['model']['code'], 'MODEL_MANIFEST_INVALID')
        private_model = self.media / self.artifact.name
        self.artifact.rename(private_model)
        self.artifact.symlink_to(private_model)
        with patch('assessments.management.commands.check_assessment_runtime.verify_artifact', side_effect=AssertionError('Must not read media')):
            report = self.run_check(succeeds=False)
        self.assertEqual(report['checks']['model']['code'], 'MODEL_PATH_INVALID')
