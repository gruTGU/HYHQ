"""Read-only adaptation of upstream smoke acceptance; never run the queue/inference."""
import copy
import importlib
import json
import math
import os
import signal
import sys
import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError
from django.utils import timezone

from assessments.artifacts import ModelError, read_manifest, safe_path, validate_config, verify_artifact
from assessments.models import AssessmentJob, DetectionModel, RuleSet
from assessments.registry import snapshot_for
from assessments.rules import assess, validate_definition
from assessments.summary import observation_summary


def dependencies():
    required = {'numpy': ('asarray', 'float32'), 'onnx': ('load_model_from_string', 'checker'),
                'onnxruntime': ('get_available_providers',), 'PIL.Image': ('open',),
                'fcntl': ('flock', 'LOCK_EX', 'LOCK_NB'), 'resource': ('setrlimit', 'RLIMIT_CORE', 'RLIMIT_FSIZE')}
    checks = {}
    for name, attributes in required.items():
        try:
            module = importlib.import_module(name)
            ready = all(hasattr(module, attribute) for attribute in attributes)
            if name == 'onnxruntime':
                ready = ready and 'CPUExecutionProvider' in module.get_available_providers()
            checks[name] = 'ready' if ready else 'not_ready'
        except Exception:
            checks[name] = 'not_ready'
    checks['process_controls'] = 'ready' if (hasattr(os, 'killpg') and hasattr(signal, 'setitimer')
        and hasattr(signal, 'SIGALRM') and hasattr(signal, 'ITIMER_REAL')) else 'not_ready'
    return {'status': 'ready' if all(value == 'ready' for value in checks.values()) else 'not_ready',
            'code': '' if all(value == 'ready' for value in checks.values()) else 'DEPENDENCY_UNAVAILABLE', 'modules': checks}


def configuration():
    checks = {}
    for name, maximum in [('ASSESSMENT_RUN_TIMEOUT_SECONDS', 60), ('RECOGNITION_QUEUE_LIMIT', None),
                          ('RECOGNITION_QUEUE_TIMEOUT_SECONDS', None), ('RECORD_RETENTION_DAYS', None)]:
        value = getattr(settings, name, None)
        checks[name] = type(value) is int and value > 0 and (maximum is None or value <= maximum)
    for name in ('ASSESSMENT_MODEL_ROOT', 'MEDIA_ROOT'):
        path = Path(getattr(settings, name))
        checks[name] = path.is_dir() and os.access(path, os.R_OK | (os.W_OK if name == 'MEDIA_ROOT' else 0))
    lock = Path(settings.RECOGNITION_LOCK_PATH)
    # Check the location only: do not create a lock file, acquire flock, or recover jobs.
    checks['lock_location'] = (not lock.is_symlink() and lock.parent.is_dir() and os.access(lock.parent, os.W_OK)
                               and (not lock.exists() or (lock.is_file() and os.access(lock, os.R_OK | os.W_OK))))
    child = Path(__file__).resolve().parents[2] / 'child.py'
    checks['worker_entrypoint'] = child.is_file() and os.access(child, os.R_OK)
    checks['python_executable'] = Path(sys.executable).is_file() and os.access(sys.executable, os.X_OK)
    ready = all(checks.values())
    return {'status': 'ready' if ready else 'not_ready', 'code': '' if ready else 'RUNTIME_CONFIG_INVALID', 'checks': checks}


def model_check(manifest=None):
    models = list(DetectionModel.objects.filter(enabled=True)[:2])
    if len(models) != 1:
        return {'status': 'not_ready', 'code': 'MODEL_NOT_CONFIGURED' if not models else 'MULTIPLE_ACTIVE_MODELS'}
    snapshot = snapshot_for(models[0])
    # The immutable registry snapshot is the manifest contract used by the worker.
    media = Path(settings.MEDIA_ROOT).resolve()
    if safe_path(settings.ASSESSMENT_MODEL_ROOT, snapshot['artifact']).is_relative_to(media):
        raise ModelError('MODEL_PATH_INVALID')
    blob = verify_artifact(settings.ASSESSMENT_MODEL_ROOT, snapshot, return_bytes=True)
    from assessments.detector import validate_graph
    validate_graph(blob, len(snapshot['labels']))
    if manifest:
        if Path(manifest).suffix.lower() != '.json' or Path(manifest).resolve().is_relative_to(media):
            raise ModelError('MODEL_MANIFEST_INVALID')
        candidate = read_manifest(settings.ASSESSMENT_MODEL_ROOT, manifest)
        if candidate['config_digest'] != snapshot['config_digest']:
            raise ModelError('MODEL_MANIFEST_MISMATCH')
    return {'status': 'ready', 'code': '', 'artifact_checksum_verified': True, 'graph_contract_verified': True,
            'manifest_contract': 'registered_snapshot', 'manifest_file_checked': bool(manifest),
            'supported_class_count': len(snapshot['preprocessing']['supported_class_ids'])}


def rules_check():
    rules = list(RuleSet.objects.filter(is_active=True)[:2])
    if len(rules) != 1:
        return {'status': 'not_ready', 'code': 'RULE_NOT_CONFIGURED' if not rules else 'MULTIPLE_ACTIVE_RULES'}
    validate_definition(rules[0].definition)
    return {'status': 'ready', 'code': '', 'definition_verified': True}


def job_check(identifier):
    try:
        pk = uuid.UUID(identifier)
    except (ValueError, AttributeError, TypeError):
        return {'status': 'not_ready', 'code': 'JOB_ID_INVALID'}
    # Never fetch the owner, asset, coordinates, message, or image from this command.
    job = AssessmentJob.objects.only('status', 'expires_at', 'image_width', 'image_height', 'detections',
        'model_snapshot', 'rule_snapshot', 'score', 'grade', 'causes', 'issues', 'decision', 'reason').filter(pk=pk).first()
    if not job:
        return {'status': 'not_ready', 'code': 'JOB_NOT_FOUND'}
    if job.expires_at <= timezone.now():
        return {'status': 'not_ready', 'code': 'JOB_EXPIRED'}
    if job.status != 'succeeded':
        known = job.status in {'queued', 'running', 'failed'}
        return {'status': 'not_ready', 'code': 'JOB_NOT_FINISHED' if job.status in {'queued', 'running'} else 'JOB_NOT_SUCCEEDED',
                'job_status': job.status if known else 'unknown'}
    validate_config(job.model_snapshot)
    validate_definition(job.rule_snapshot)
    if (type(job.image_width) is not int or type(job.image_height) is not int
            or not 1 <= job.image_width <= 2048 or not 1 <= job.image_height <= 2048
            or not isinstance(job.detections, list) or len(job.detections) > 300):
        raise ModelError('JOB_RESULT_INVALID')
    supported = job.model_snapshot['preprocessing']['supported_class_ids']
    for detection in job.detections:
        if not isinstance(detection, dict):
            raise ModelError('JOB_RESULT_INVALID')
        class_id, confidence = detection.get('class_id'), detection.get('confidence')
        if (type(class_id) is not int or class_id not in supported
                or detection.get('eval_category') != 'floating_debris'
                or type(confidence) not in (float, int) or not math.isfinite(confidence)
                or not job.model_snapshot['threshold'] <= confidence <= 1):
            raise ModelError('JOB_RESULT_INVALID')
    if (job.reason not in {'', 'NO_SUPPORTED_DETECTIONS', 'LOW_IMAGE_QUALITY'}
            or (job.detections and (job.decision != 'assessed' or job.reason))
            or (not job.detections and (job.decision != 'uncertain' or not job.reason))):
        raise ModelError('JOB_RESULT_INVALID')
    expected = assess(copy.deepcopy(job.detections), job.rule_snapshot, job.image_width, job.image_height, reason=job.reason)
    if any(getattr(job, field) != expected[field] for field in ('score', 'grade', 'decision', 'reason', 'causes', 'issues')):
        raise ModelError('JOB_RULE_RESULT_MISMATCH')
    summary = observation_summary(job)
    return {'status': 'ready', 'code': '', 'job_status': 'succeeded', 'stored_result_verified': True,
            'summary': {'status': summary['status'], 'candidate_count': summary['candidate_count'],
                        'excluded_count': summary['excluded_count'], 'box_area_ratio': summary['box_area_ratio']}}


def guarded_check(check):
    try:
        return check()
    except ModelError as error:
        return {'status': 'not_ready', 'code': error.code}
    except DatabaseError:
        return {'status': 'not_ready', 'code': 'DATABASE_UNAVAILABLE'}
    except (ImportError, ModuleNotFoundError):
        return {'status': 'not_ready', 'code': 'DEPENDENCY_UNAVAILABLE'}
    except ValidationError:
        return {'status': 'not_ready', 'code': 'RULE_DEFINITION_INVALID'}
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return {'status': 'not_ready', 'code': 'CHECK_INPUT_INVALID'}
    except Exception:
        # Error strings may contain local paths or user data. Only emit fixed codes.
        return {'status': 'not_ready', 'code': 'CHECK_FAILED'}


class Command(BaseCommand):
    help = '只读检查河道观察配置与可选历史结果；不创建任务、不锁队列、不推理。'
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument('--job-id', help='仅检查指定已有任务的状态、结果与摘要')
        parser.add_argument('--manifest', help='可选：核对模型根目录内的 manifest 与已登记配置一致')

    def handle(self, *args, **options):
        checks = {'dependencies': guarded_check(dependencies), 'configuration': guarded_check(configuration),
                  'model': guarded_check(lambda: model_check(options.get('manifest'))), 'rules': guarded_check(rules_check)}
        if options.get('job_id'):
            checks['job'] = guarded_check(lambda: job_check(options['job_id']))
        ready = all(check['status'] == 'ready' for check in checks.values())
        self.stdout.write(json.dumps({'schema_version': 1, 'status': 'ready' if ready else 'not_ready',
            'verification_level': 'static_configuration', 'inference_executed': False,
            'queue_consumed': False, 'checks': checks}, ensure_ascii=False, allow_nan=False, sort_keys=True))
        if not ready:
            raise CommandError('ASSESSMENT_NOT_READY', returncode=1)
