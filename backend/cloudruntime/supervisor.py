"""Fail-closed, one-container API/worker supervisor. Never performs migrations."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .gate import PostgresGate

WORKERS = ('recognition', 'assessments', 'llm')


def descendants(root, proc_root='/proc'):
    """Include detached inference grandchildren; process groups alone miss them."""
    parent_map = {}
    try:
        entries = Path(proc_root).iterdir()
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                # comm can contain spaces and parentheses; fields after last ')'.
                rest = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                parent_map[int(entry.name)] = int(rest[1])
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return set()
    found = set()
    while True:
        new = {pid for pid, parent in parent_map.items() if parent in found | {root}} - found
        if not new:
            return found
        found.update(new)


def enable_subreaper():
    # Linux PID1 automatically adopts orphan children; PR_SET_CHILD_SUBREAPER also
    # handles a platform that inserts its own init before this supervisor.
    if sys.platform.startswith('linux'):
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError('Cannot establish child process supervision')


def stop_children(children, grace=8, *, clock=time.monotonic, sleep=time.sleep):
    tracked = descendants(os.getpid())
    for child in children:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = clock() + grace
    while clock() < deadline:
        if all(child.poll() is not None for child in children) and not descendants(os.getpid()):
            break
        sleep(0.05)
    # Native inference runs in a new session, so explicitly reap descendants.
    tracked.update(descendants(os.getpid()))
    for pid in tracked:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for child in children:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
    if sys.platform.startswith('linux'):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    break
            except ChildProcessError:
                break


def write_state(path, environment, ready):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as handle:
        json.dump({'environment': environment, 'ready': ready, 'updated_at': time.time()}, handle)
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def supervise(settings, *, gate_factory=PostgresGate, popen=subprocess.Popen, sleep=time.sleep, stop=stop_children):
    children = []
    gate = None
    pipe = None
    exit_code = 1
    write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, False)
    try:
        if settings.CLOUD_ROLE != 'combined':
            raise RuntimeError('API-only scaling is not enabled in this release')
        gate = gate_factory(settings.DATABASES['default'])
        if not gate.acquire():
            raise RuntimeError('Another cloud worker supervisor holds the database gate')
        pipe = os.pipe()
        environment = dict(os.environ)
        environment['HYHQ_CLOUD_WORKER_GATE_FD'] = str(pipe[0])
        environment['DJANGO_SETTINGS_MODULE'] = 'config.cloud'
        for worker in WORKERS:
            gate.check()
            children.append(popen([sys.executable, '-m', 'cloudruntime.worker_entry', worker],
                                  env=environment, pass_fds=(pipe[0],), start_new_session=True))
        os.close(pipe[0])
        pipe = (None, pipe[1])
        # Strictly one Gunicorn worker keeps first-release memory predictable.
        children.append(popen([sys.executable, '-m', 'gunicorn', 'config.wsgi:application',
                               '--bind', '0.0.0.0:8000', '--workers', '1', '--threads', '2',
                               '--timeout', '35', '--graceful-timeout', '8', '--access-logfile', '-',
                               '--access-logformat', '%(m)s %(U)s %(s)s %(L)s',
                               '--error-logfile', '-'], env=environment, start_new_session=True))
        while True:
            gate.check()  # Any exception stops the full group; never reconnect.
            if any(child.poll() is not None for child in children):
                raise RuntimeError('A required child process exited')
            write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, True)
            sleep(1)
    except KeyboardInterrupt:
        exit_code = 0
    except Exception as error:
        # Exceptions from libpq may contain addresses/credentials: only type name.
        print(f'Cloud runtime stopped: {type(error).__name__}', file=sys.stderr, flush=True)
    finally:
        # A full local filesystem must not skip child termination or retain a
        # falsely healthy heartbeat. Its age expires even if this write fails.
        try:
            write_state(settings.CLOUD_STATE_PATH, settings.CLOUD_ENV_ID, False)
        except OSError:
            pass
        if pipe:
            for descriptor in pipe:
                if descriptor is not None:
                    os.close(descriptor)
        # Gate stays held until children stop. On DB failure, best effort bounded
        # termination is necessary but is NOT a fencing/split-brain proof.
        try:
            stop(children)
        finally:
            if gate is not None:
                gate.close()
    return exit_code


def main():
    os.umask(0o077)
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.cloud')
    enable_subreaper()
    import django
    django.setup()
    from django.conf import settings
    from .health import mounted_storage_ready, database_ready
    if not getattr(settings, 'CLOUD_RUNTIME_ENABLED', False):
        raise RuntimeError('Cloud supervisor requires config.cloud')
    if not mounted_storage_ready() or not database_ready():
        print('Cloud storage/database readiness failed; migrate and provision explicitly.', file=sys.stderr)
        return 1
    if not settings.WECHAT_APP_ID or not settings.WECHAT_APP_SECRET:
        print('Cloud WeChat login credentials are not configured.', file=sys.stderr)
        return 1

    def terminate(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    return supervise(settings)


if __name__ == '__main__':
    sys.exit(main())
