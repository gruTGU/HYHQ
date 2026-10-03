"""Private platform probes. Public response contains no paths, identity or secrets."""
import json
import os
import tempfile
import time
from pathlib import Path

from django.conf import settings
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


def is_mount_root(root, mountinfo='/proc/self/mountinfo'):
    """ismount covers NFS; Linux mountinfo also recognizes same-device bind mounts."""
    if os.path.ismount(root):
        return True
    try:
        target = str(Path(root).resolve())
        for line in Path(mountinfo).read_text().splitlines():
            fields = line.split()
            if len(fields) < 6:
                continue
            mountpoint = fields[4]
            for encoded, decoded in [(r'\040', ' '), (r'\011', '\t'), (r'\012', '\n'), (r'\134', '\\')]:
                mountpoint = mountpoint.replace(encoded, decoded)
            if mountpoint == target:
                return True
    except OSError:
        pass
    return False


def mounted_storage_ready():
    root = Path(settings.CLOUD_MOUNT_ROOT)
    try:
        if not is_mount_root(root):
            return False
        if (root / '.hyhq-volume-id').read_text().strip() != settings.CLOUD_ENV_ID:
            return False
        for directory in (settings.MEDIA_ROOT, settings.RECOGNITION_MODEL_ROOT, settings.ASSESSMENT_MODEL_ROOT):
            path = Path(directory).resolve()
            if root.resolve() not in path.parents or not path.is_dir() or not os.access(path, os.R_OK | os.X_OK):
                return False
        with tempfile.TemporaryFile(dir=settings.MEDIA_ROOT) as probe:
            probe.write(b'ready')
            probe.flush()
        return True
    except (OSError, ValueError):
        return False


def database_ready():
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            if cursor.fetchone() != (1,):
                return False
        executor = MigrationExecutor(connection)
        return not executor.migration_plan(executor.loader.graph.leaf_nodes())
    except Exception:
        return False


def workers_ready():
    if settings.CLOUD_ROLE == 'api':
        # API-only topology is intentionally not a supported production rollout yet.
        return False
    try:
        record = json.loads(Path(settings.CLOUD_STATE_PATH).read_text())
        age = time.time() - record['updated_at']
        return record.get('ready') is True and record.get('environment') == settings.CLOUD_ENV_ID and 0 <= age <= 10
    except (OSError, ValueError, TypeError, KeyError):
        return False


def ready():
    identity = bool(settings.WECHAT_APP_ID and settings.WECHAT_APP_SECRET)
    return identity and mounted_storage_ready() and database_ready() and workers_ready()
