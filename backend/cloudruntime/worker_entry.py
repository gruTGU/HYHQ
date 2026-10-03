"""Supervisor-only worker loop with bounded termination and inherited gate pipe."""
import importlib
import os
import signal
import stat
import sys
import time


def run(kind):
    descriptor = os.getenv('HYHQ_CLOUD_WORKER_GATE_FD', '')
    try:
        # Supervisor owns the write end. There is no credential in this pipe.
        fd = int(descriptor)
        if not stat.S_ISFIFO(os.fstat(fd).st_mode):
            raise ValueError('Supervisor descriptor is not a pipe')
        os.set_blocking(fd, False)
        if os.read(fd, 1) == b'':
            raise ValueError('Supervisor pipe is closed')
    except BlockingIOError:
        pass
    except (ValueError, OSError):
        raise RuntimeError('This worker requires the live singleton supervisor.') from None
    if kind not in {'recognition', 'assessments', 'llm'}:
        raise RuntimeError('Unsupported worker kind')
    import django
    django.setup()
    from django.conf import settings
    if not getattr(settings, 'CLOUD_RUNTIME_ENABLED', False):
        raise RuntimeError('Cloud worker requires cloud production settings')
    process_one = importlib.import_module(f'{kind}.worker').process_one

    def terminate(signum, frame):
        # Raising allows the inference runner's finally to kill/wait its child.
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        while True:
            try:
                if os.read(fd, 1) == b'':
                    raise RuntimeError('Supervisor disappeared')
            except BlockingIOError:
                pass
            if not process_one():
                time.sleep(1)
    except KeyboardInterrupt:
        return
    finally:
        os.close(fd)


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) == 2 else '')
