"""Validate declarations without logging credential values or probing providers."""
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured


def validate_cloud_configuration(config, env):
    errors = []
    if config['ENV'] != 'production' or config['DEBUG'] or config['ALLOW_DEV_AUTH']:
        errors.append('production mode with debug/dev-auth disabled')
    if env.get('ALLOW_DEV_AUTH', '0') != '0':
        errors.append('ALLOW_DEV_AUTH=0')
    if not env.get('DJANGO_ALLOWED_HOSTS') or '*' in config['ALLOWED_HOSTS']:
        errors.append('explicit allowed hosts without wildcard')
    database = config['DATABASES']['default']
    if database['ENGINE'] != 'django.db.backends.postgresql' or not env.get('DATABASE_URL'):
        errors.append('explicit PostgreSQL DATABASE_URL')
    if not database.get('USER') or not database.get('PASSWORD'):
        errors.append('PostgreSQL user and password')
    if not config['CLOUD_ENV_ID'] or config['CLOUD_ROLE'] not in {'combined', 'api'}:
        errors.append('cloud environment identifier and combined/api role')
    if env.get('HYHQ_CLOUD_PRIVATE_INGRESS_CONFIRMED') != '1' or env.get('HYHQ_CLOUD_TRUST_PROXY_HTTPS') != '1':
        errors.append('confirmed private ingress and trusted HTTPS proxy')
    root = config['CLOUD_MOUNT_ROOT']
    declared_root = env.get('HYHQ_CLOUD_MOUNT_ROOT', '')
    if not declared_root or not Path(declared_root).is_absolute() or root == Path('/'):
        errors.append('explicit absolute persistent mount distinct from container root')
    for setting, variable in [('MEDIA_ROOT', 'HYHQ_MEDIA_ROOT'), ('RECOGNITION_MODEL_ROOT', 'HYHQ_MODEL_ROOT'), ('ASSESSMENT_MODEL_ROOT', 'HYHQ_ASSESSMENT_MODEL_ROOT')]:
        value = Path(config[setting]).resolve()
        if not env.get(variable) or value == root or root not in value.parents:
            errors.append(f'{variable} below the declared persistent mount')
    lock = Path(config['RECOGNITION_LOCK_PATH']).resolve()
    if not env.get('HYHQ_RECOGNITION_LOCK_PATH') or root in lock.parents:
        errors.append('explicit local (not CFS) shared inference lock path')
    if config['LLM_ENABLED'] and not config['DEEPSEEK_API_KEY']:
        errors.append('DeepSeek key when LLM is enabled')
    if config['QWEATHER_ENABLED'] and (not config['QWEATHER_API_KEY'] or not config['QWEATHER_API_HOST']):
        errors.append('QWeather key and host when weather is enabled')
    if errors:
        raise ImproperlyConfigured('Cloud configuration requires: ' + '; '.join(errors))
