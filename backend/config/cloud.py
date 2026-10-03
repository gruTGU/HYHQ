"""Strict, explicit settings for the isolated CloudBase deployment."""
from .settings import *  # noqa: F401,F403
from cloudruntime.configuration import validate_cloud_configuration

CLOUD_RUNTIME_ENABLED = True
CLOUD_ENV_ID = os.getenv('HYHQ_CLOUD_ENV_ID', '').strip()
CLOUD_ROLE = os.getenv('HYHQ_CLOUD_ROLE', 'combined')
CLOUD_MOUNT_ROOT = Path(os.getenv('HYHQ_CLOUD_MOUNT_ROOT', '/mnt/hyhq')).resolve()
CLOUD_STATE_PATH = Path(os.getenv('HYHQ_CLOUD_STATE_PATH', '/tmp/hyhq-runtime/state.json'))
CLOUD_TRANSFER_ENABLED = True
DATABASES['default']['OPTIONS'].setdefault('connect_timeout', 5)
# Cloud connections fail in a bounded time instead of hanging platform probes.
DATABASES['default']['OPTIONS']['options'] = '-c statement_timeout=4000'
validate_cloud_configuration(globals(), os.environ)
# This opt-in is allowed only after confirming the platform overwrites this header
# and disabling the service's public ingress. It does not authenticate end users.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_SSL_REDIRECT = True
MIDDLEWARE = ['cloudruntime.middleware.CloudBoundaryMiddleware', *MIDDLEWARE]
# Readiness/liveness is handled before SecurityMiddleware, at these exact paths.
# All normal endpoints retain redirect, secure cookies and existing Bearer auth.
