from django.conf import settings
from django.core.management.base import CommandError


def require_supervised_worker():
    """Cloud workers must enter through the singleton supervisor, never a CLI loop."""
    if getattr(settings, 'CLOUD_RUNTIME_ENABLED', False):
        raise CommandError('Cloud workers must run through python -m cloudruntime.supervisor.')
