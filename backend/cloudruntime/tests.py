import io
import json
import os
import signal
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import CommandError
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, TransactionTestCase, override_settings

from .configuration import validate_cloud_configuration
from .gate import GateUnavailable, PostgresGate
from .guards import require_supervised_worker
from .health import database_ready, is_mount_root, mounted_storage_ready, ready, workers_ready
from .middleware import CloudBoundaryMiddleware
from .supervisor import descendants, stop_children, supervise, write_state


class ConfigurationTests(SimpleTestCase):
    def setUp(self):
        self.config = dict(ENV='production', DEBUG=False, ALLOW_DEV_AUTH=False,
            ALLOWED_HOSTS=['cloud.internal'], DATABASES={'default': {'ENGINE': 'django.db.backends.postgresql', 'USER': 'u', 'PASSWORD': 'fake'}},
            CLOUD_ENV_ID='test-env', CLOUD_ROLE='combined', CLOUD_MOUNT_ROOT=Path('/mnt/hyhq'),
            MEDIA_ROOT=Path('/mnt/hyhq/private'), RECOGNITION_MODEL_ROOT=Path('/mnt/hyhq/models'),
            ASSESSMENT_MODEL_ROOT=Path('/mnt/hyhq/models'), RECOGNITION_LOCK_PATH=Path('/tmp/runtime/cpu.lock'),
            LLM_ENABLED=False, DEEPSEEK_API_KEY='', QWEATHER_ENABLED=False, QWEATHER_API_KEY='', QWEATHER_API_HOST='')
        self.env = {'DJANGO_ALLOWED_HOSTS': 'cloud.internal', 'DATABASE_URL': 'placeholder-not-used-by-validator',
                    'HYHQ_CLOUD_PRIVATE_INGRESS_CONFIRMED': '1', 'HYHQ_CLOUD_TRUST_PROXY_HTTPS': '1',
                    'HYHQ_CLOUD_MOUNT_ROOT': '/mnt/hyhq',
                    'HYHQ_MEDIA_ROOT': '/mnt/hyhq/private', 'HYHQ_MODEL_ROOT': '/mnt/hyhq/models',
                    'HYHQ_ASSESSMENT_MODEL_ROOT': '/mnt/hyhq/models', 'HYHQ_RECOGNITION_LOCK_PATH': '/tmp/runtime/cpu.lock'}

    def test_optional_empty_provider_keys_are_disabled(self):
        validate_cloud_configuration(self.config, self.env)

    def test_development_rejected(self):
        for key, value in [('ENV', 'development'), ('DEBUG', True), ('ALLOW_DEV_AUTH', True)]:
            with self.subTest(key=key), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration({**self.config, key: value}, self.env)

    def test_development_flag_cannot_hide_behind_production_mode(self):
        with self.assertRaises(ImproperlyConfigured):
            validate_cloud_configuration(self.config, {**self.env, 'ALLOW_DEV_AUTH': '1'})

    def test_hosts_must_be_explicit_and_not_wildcard(self):
        for env, config in [({**self.env, 'DJANGO_ALLOWED_HOSTS': ''}, self.config), (self.env, {**self.config, 'ALLOWED_HOSTS': ['*']})]:
            with self.subTest(env=bool(env['DJANGO_ALLOWED_HOSTS'])), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration(config, env)

    def test_cloud_environment_and_role_required(self):
        for key, value in [('CLOUD_ENV_ID', ''), ('CLOUD_ROLE', 'workers')]:
            with self.subTest(key=key), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration({**self.config, key: value}, self.env)

    def test_pg_credentials_are_required_without_value_disclosure(self):
        database = {'ENGINE': 'django.db.backends.sqlite3', 'USER': '', 'PASSWORD': 'secret-sensitive'}
        with self.assertRaises(ImproperlyConfigured) as error:
            validate_cloud_configuration({**self.config, 'DATABASES': {'default': database}}, self.env)
        self.assertNotIn('secret-sensitive', str(error.exception))

    def test_trusted_private_ingress_is_explicit(self):
        for key in ['HYHQ_CLOUD_PRIVATE_INGRESS_CONFIRMED', 'HYHQ_CLOUD_TRUST_PROXY_HTTPS']:
            with self.subTest(key=key), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration(self.config, {**self.env, key: '0'})

    def test_media_and_models_must_be_below_mount(self):
        for key in ['MEDIA_ROOT', 'RECOGNITION_MODEL_ROOT', 'ASSESSMENT_MODEL_ROOT']:
            for value in ['/tmp/ephemeral', '/mnt/hyhq']:
                with self.subTest(key=key, value=value), self.assertRaises(ImproperlyConfigured):
                    validate_cloud_configuration({**self.config, key: Path(value)}, self.env)

    def test_mount_must_be_explicit_absolute_and_not_container_root(self):
        for value in ['', 'relative/mount', '/']:
            config = {**self.config, 'CLOUD_MOUNT_ROOT': Path(value or '/mnt/hyhq').resolve()}
            with self.subTest(value=value), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration(config, {**self.env, 'HYHQ_CLOUD_MOUNT_ROOT': value})

    def test_cloud_cpu_lock_must_remain_local(self):
        with self.assertRaises(ImproperlyConfigured):
            validate_cloud_configuration({**self.config, 'RECOGNITION_LOCK_PATH': Path('/mnt/hyhq/cpu.lock')}, self.env)

    def test_enabled_connectors_require_keys(self):
        for key in ['LLM_ENABLED', 'QWEATHER_ENABLED']:
            with self.subTest(key=key), self.assertRaises(ImproperlyConfigured):
                validate_cloud_configuration({**self.config, key: True}, self.env)


class HealthTests(SimpleTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'private').mkdir()
        (self.root / 'models').mkdir()
        (self.root / '.hyhq-volume-id').write_text('cloud-test')
        self.override = override_settings(CLOUD_MOUNT_ROOT=self.root, CLOUD_ENV_ID='cloud-test',
            MEDIA_ROOT=self.root / 'private', RECOGNITION_MODEL_ROOT=self.root / 'models',
            ASSESSMENT_MODEL_ROOT=self.root / 'models', CLOUD_ROLE='combined',
            CLOUD_STATE_PATH=self.root / 'state.json')
        self.override.enable()
        self.addCleanup(self.override.disable)

    @patch('cloudruntime.health.os.path.ismount', return_value=False)
    def test_linux_bind_mount_is_recognized_from_mountinfo(self, _):
        mountinfo = self.root / 'mountinfo'
        mountinfo.write_text('42 25 0:33 / /example/bind\\040mount rw - nfs server:/ rw\n')
        self.assertTrue(is_mount_root('/example/bind mount', mountinfo))
        self.assertFalse(is_mount_root('/example/bind mount/private', mountinfo))

    def test_real_directory_is_not_persistent_mount(self):
        self.assertFalse(mounted_storage_ready())

    @patch('cloudruntime.health.os.path.ismount', return_value=True)
    def test_mount_marker_directory_permissions_and_write_are_verified(self, _):
        self.assertTrue(mounted_storage_ready())
        (self.root / '.hyhq-volume-id').write_text('different-environment')
        self.assertFalse(mounted_storage_ready())

    @patch('cloudruntime.health.os.path.ismount', return_value=True)
    def test_missing_model_directory_is_not_ready(self, _):
        (self.root / 'models').rmdir()
        self.assertFalse(mounted_storage_ready())

    @patch('cloudruntime.health.os.path.ismount', return_value=True)
    def test_readonly_private_directory_is_not_ready(self, _):
        with patch('cloudruntime.health.tempfile.TemporaryFile', side_effect=PermissionError):
            self.assertFalse(mounted_storage_ready())

    def test_absent_or_stale_worker_state_not_ready(self):
        self.assertFalse(workers_ready())
        write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, True)
        self.assertTrue(workers_ready())
        with patch('cloudruntime.health.time.time', return_value=10**12):
            self.assertFalse(workers_ready())

    def test_wrong_environment_or_future_state_not_ready(self):
        write_state(settings.CLOUD_STATE_PATH, 'other-env', True)
        self.assertFalse(workers_ready())
        write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, True)
        with patch('cloudruntime.health.time.time', return_value=1):
            self.assertFalse(workers_ready())

    def test_failed_worker_and_api_only_state_not_ready(self):
        write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, False)
        self.assertFalse(workers_ready())
        with override_settings(CLOUD_ROLE='api'):
            self.assertFalse(workers_ready())

    def test_pending_migrations_not_ready(self):
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value.fetchone.return_value = (1,)
        executor = MagicMock()
        executor.migration_plan.return_value = ['pending']
        with patch('cloudruntime.health.connection', connection), patch('cloudruntime.health.MigrationExecutor', return_value=executor):
            self.assertFalse(database_ready())
            executor.migration_plan.return_value = []
            self.assertTrue(database_ready())

    def test_database_failure_is_redacted_and_not_ready(self):
        connection = MagicMock()
        connection.cursor.side_effect = RuntimeError('password-secret')
        with patch('cloudruntime.health.connection', connection):
            self.assertFalse(database_ready())

    def test_missing_wechat_credential_prevents_ready(self):
        with override_settings(WECHAT_APP_ID='wx-test', WECHAT_APP_SECRET=''), patch('cloudruntime.health.mounted_storage_ready') as check:
            self.assertFalse(ready())
            check.assert_not_called()

    def test_status_file_has_private_permissions(self):
        write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, True)
        self.assertEqual(Path(settings.CLOUD_STATE_PATH).stat().st_mode & 0o777, 0o600)


class BoundaryTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.downstream = MagicMock(return_value=HttpResponse(status=204))
        self.middleware = CloudBoundaryMiddleware(self.downstream)

    def test_liveness_http_does_not_redirect(self):
        response = self.middleware(self.factory.get('/_cloud/live'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content), {'ok': True})
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.downstream.assert_not_called()

    @patch('cloudruntime.middleware.ready', return_value=False)
    def test_unready_http_is_503_with_no_details(self, _):
        response = self.middleware(self.factory.get('/_cloud/ready'))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.content), {'ok': False})

    def test_only_safe_probe_methods_are_allowed(self):
        self.assertEqual(self.middleware(self.factory.post('/_cloud/live')).status_code, 405)

    def test_similar_paths_keep_normal_security(self):
        self.assertEqual(self.middleware(self.factory.get('/_cloud/live/anything')).status_code, 204)
        self.downstream.assert_called_once()

    def test_cloud_admin_always_hidden(self):
        for path in ['/admin', '/admin/', '/admin/login/']:
            with self.subTest(path=path):
                self.assertEqual(self.middleware(self.factory.get(path, HTTP_X_FORWARDED_FOR='127.0.0.1')).status_code, 404)
        self.downstream.assert_not_called()

    @override_settings(CLOUD_RUNTIME_ENABLED=True)
    def test_original_worker_cli_is_blocked_in_cloud(self):
        with self.assertRaises(CommandError):
            require_supervised_worker()

    @override_settings(CLOUD_RUNTIME_ENABLED=False)
    def test_original_deployment_worker_cli_unchanged(self):
        require_supervised_worker()


class GateUnitTests(SimpleTestCase):
    def setUp(self):
        self.connector = MagicMock()
        self.connection = self.connector.return_value
        self.connection.closed = False
        self.cursor = self.connection.cursor.return_value.__enter__.return_value
        self.cursor.fetchone.return_value = (True,)
        self.gate = PostgresGate({'NAME': 'test', 'USER': 'test', 'PASSWORD': 'fake', 'HOST': '127.0.0.1', 'PORT': 55438}, self.connector)

    def test_gate_heartbeat_does_not_reacquire_stacked_session_lock(self):
        self.assertTrue(self.gate.acquire())
        self.assertTrue(self.gate.check())
        queries = [call.args[0] for call in self.cursor.execute.call_args_list]
        self.assertEqual(sum('pg_try_advisory_lock' in query for query in queries), 1)
        self.assertIn('pg_locks', queries[1])

    def test_gate_cannot_acquire_twice(self):
        self.gate.acquire()
        with self.assertRaises(GateUnavailable):
            self.gate.acquire()

    def test_gate_failure_does_not_reconnect(self):
        self.gate.acquire()
        self.cursor.fetchone.return_value = (False,)
        with self.assertRaises(GateUnavailable):
            self.gate.check()
        self.connector.assert_called_once()

    def test_unheld_or_closed_gate_is_not_healthy(self):
        with self.assertRaises(GateUnavailable):
            self.gate.check()
        self.gate.acquire()
        self.connection.closed = True
        with self.assertRaises(GateUnavailable):
            self.gate.check()

    def test_gate_has_connection_and_statement_timeouts(self):
        kwargs = self.connector.call_args.kwargs
        self.assertEqual(kwargs['connect_timeout'], 5)
        self.assertEqual(kwargs['tcp_user_timeout'], 5000)
        self.assertIn('statement_timeout=4000', kwargs['options'])
        self.assertTrue(kwargs['autocommit'])


class SupervisorTests(SimpleTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = SimpleNamespace(CLOUD_STATE_PATH=Path(directory.name) / 'state.json',
            CLOUD_ENV_ID='unit-env', CLOUD_ROLE='combined', DATABASES={'default': {'fake': 'database'}})
        self.gate = MagicMock()
        self.gate.acquire.return_value = True
        self.popen = MagicMock()
        self.popen.return_value.poll.return_value = None
        self.stop = MagicMock()
        self.stderr = patch('sys.stderr', new_callable=io.StringIO)
        self.stderr.start()
        self.addCleanup(self.stderr.stop)

    def run_supervisor(self, **kwargs):
        return supervise(self.config, gate_factory=lambda _: self.gate, popen=self.popen,
                         stop=self.stop, sleep=kwargs.get('sleep', MagicMock(side_effect=KeyboardInterrupt)))

    def test_no_worker_starts_without_gate(self):
        self.gate.acquire.return_value = False
        self.assertEqual(self.run_supervisor(), 1)
        self.popen.assert_not_called()
        self.gate.close.assert_called_once()

    def test_gate_loss_before_start_prevents_worker_recovery(self):
        self.gate.check.side_effect = RuntimeError('disconnect')
        self.assertEqual(self.run_supervisor(), 1)
        self.popen.assert_not_called()

    def test_normal_shutdown_stops_children_before_releasing_gate(self):
        events = []
        self.stop.side_effect = lambda children: events.append(('stop', len(children)))
        self.gate.close.side_effect = lambda: events.append(('release', 0))
        self.assertEqual(self.run_supervisor(), 0)
        self.assertEqual(events, [('stop', 4), ('release', 0)])
        self.assertFalse(json.loads(self.config.CLOUD_STATE_PATH.read_text())['ready'])

    def test_disconnect_stops_all_children_and_exits_failure(self):
        self.gate.check.side_effect = [True, True, True, True, OSError('secret-connection-details')]
        self.assertEqual(self.run_supervisor(sleep=MagicMock()), 1)
        self.assertEqual(len(self.stop.call_args.args[0]), 4)
        self.assertNotIn('secret-connection-details', __import__('sys').stderr.getvalue())

    def test_any_child_exit_stops_whole_group(self):
        self.popen.return_value.poll.return_value = 1
        self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(len(self.stop.call_args.args[0]), 4)

    def test_state_write_failure_still_terminates_children(self):
        with patch('cloudruntime.supervisor.write_state', side_effect=[None, OSError('full disk'), OSError('full disk')]):
            self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(len(self.stop.call_args.args[0]), 4)
        self.gate.close.assert_called_once()

    def test_partial_spawn_failure_stops_started_workers(self):
        child = MagicMock()
        self.popen.side_effect = [child, OSError('spawn failed')]
        self.assertEqual(self.run_supervisor(), 1)
        self.stop.assert_called_once_with([child])

    def test_worker_pipe_is_inherited_only_by_workers(self):
        self.run_supervisor()
        calls = self.popen.call_args_list
        self.assertEqual(len(calls), 4)
        self.assertTrue(all('pass_fds' in call.kwargs for call in calls[:3]))
        self.assertNotIn('pass_fds', calls[-1].kwargs)

    def test_access_log_format_excludes_query_and_headers(self):
        self.run_supervisor()
        argv = self.popen.call_args_list[-1].args[0]
        log_format = argv[argv.index('--access-logformat') + 1]
        self.assertEqual(log_format, '%(m)s %(U)s %(s)s %(L)s')
        self.assertNotIn('%(r)', log_format)
        self.assertNotIn('%(q)', log_format)

    def test_api_only_scaling_fails_closed(self):
        self.config.CLOUD_ROLE = 'api'
        self.assertEqual(self.run_supervisor(), 1)
        self.popen.assert_not_called()

    def test_descendant_scan_includes_detached_grandchild(self):
        with tempfile.TemporaryDirectory() as directory:
            for pid, parent in [(200, 100), (300, 200), (400, 999)]:
                path = Path(directory) / str(pid)
                path.mkdir()
                (path / 'stat').write_text(f'{pid} (name with ) spaces) S {parent} 0 0')
            self.assertEqual(descendants(100, directory), {200, 300})

    @patch('cloudruntime.supervisor.os.waitpid', side_effect=ChildProcessError)
    @patch('cloudruntime.supervisor.os.kill')
    @patch('cloudruntime.supervisor.os.killpg')
    @patch('cloudruntime.supervisor.descendants', return_value={10002})
    def test_shutdown_escalates_to_kill_detached_children(self, scan, killpg, kill, waitpid):
        child = MagicMock(pid=10001)
        child.poll.return_value = None
        stop_children([child], grace=0)
        killpg.assert_called_once_with(10001, signal.SIGTERM)
        kill.assert_called_once_with(10002, signal.SIGKILL)
        child.wait.assert_called_once_with(timeout=2)


class PostgreSQLGateTests(TransactionTestCase):
    def setUp(self):
        from django.db import connection
        if connection.vendor != 'postgresql':
            self.skipTest('Requires isolated PostgreSQL test database')
        self.database = dict(connection.settings_dict)
        self.gates = []
        self.addCleanup(lambda: [gate.close() for gate in self.gates])

    def gate(self):
        result = PostgresGate(self.database)
        self.gates.append(result)
        return result

    def test_real_sessions_exclude_and_release_successor(self):
        first, second = self.gate(), self.gate()
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        self.assertTrue(first.check())
        first.close()
        self.assertTrue(second.acquire())
        self.assertTrue(second.check())

    def test_real_session_loss_is_detected_without_reconnect(self):
        first, second = self.gate(), self.gate()
        self.assertTrue(first.acquire())
        with second.connection.cursor() as cursor:
            cursor.execute('SELECT pg_terminate_backend(%s)', (first.connection.info.backend_pid,))
        with self.assertRaises(Exception):
            first.check()
        self.assertTrue(second.acquire())
