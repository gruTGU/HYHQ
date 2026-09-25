"""Explicit development settings; production fails closed on missing secrets."""
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
env_file = BASE_DIR / '.env'
if env_file.is_file():
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('\"\''))

ENV = os.getenv('ENV', 'development')
if ENV not in {'development', 'production', 'test'}:
    raise ImproperlyConfigured('ENV must be development, test or production')
DEBUG = os.getenv('DJANGO_DEBUG', '0') == '1'
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', 'local-development-only-not-for-deployment')
ALLOW_DEV_AUTH = ENV == 'development' and DEBUG and os.getenv('ALLOW_DEV_AUTH', '0') == '1'
ALLOWED_HOSTS = [x.strip() for x in os.getenv('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1],testserver').split(',') if x.strip()]
CSRF_TRUSTED_ORIGINS = [x.strip() for x in os.getenv('DJANGO_CSRF_TRUSTED_ORIGINS', '').split(',') if x.strip()]
USE_SQLITE = os.getenv('HYHQ_USE_SQLITE', '0') == '1'
if ENV == 'production':
    if DEBUG or len(SECRET_KEY) < 32 or SECRET_KEY.startswith('local-development'):
        raise ImproperlyConfigured('Production requires DEBUG=0 and a unique DJANGO_SECRET_KEY (32+ characters)')
    if USE_SQLITE or '*' in ALLOWED_HOSTS or not os.getenv('DATABASE_URL'):
        raise ImproperlyConfigured('Production requires explicit PostgreSQL DATABASE_URL and allowed hosts')

if USE_SQLITE:
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'var' / 'dev.sqlite3', 'OPTIONS': {'timeout': 20}}}
else:
    url = urlparse(os.getenv('DATABASE_URL', 'postgresql://hyhq:hyhq-dev-only@127.0.0.1:5432/hyhq'))
    if url.scheme not in {'postgres', 'postgresql'} or not url.path.strip('/'):
        raise ImproperlyConfigured('Invalid PostgreSQL DATABASE_URL')
    options = {}
    if 'sslmode' in parse_qs(url.query):
        options['sslmode'] = parse_qs(url.query)['sslmode'][0]
    DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': unquote(url.path.lstrip('/')), 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''), 'HOST': url.hostname or '127.0.0.1', 'PORT': url.port or 5432, 'CONN_MAX_AGE': 60, 'OPTIONS': options}}

INSTALLED_APPS = [
    'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
    'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles',
    'rest_framework', 'common', 'accounts', 'ecology', 'knowledge', 'assets', 'recognition', 'activity', 'assessments', 'llm', 'weatherdata', 'community', 'narration',
]
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware', 'common.middleware.RequestLogMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'DIRS': [BASE_DIR / 'templates'], 'APP_DIRS': True, 'OPTIONS': {'context_processors': ['django.template.context_processors.request', 'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages']}}]
AUTH_USER_MODEL = 'accounts.User'
AUTH_PASSWORD_VALIDATORS = [{'NAME': f'django.contrib.auth.password_validation.{name}'} for name in ['UserAttributeSimilarityValidator', 'MinimumLengthValidator', 'CommonPasswordValidator', 'NumericPasswordValidator']]
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'Asia/Shanghai'
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
MEDIA_ROOT = BASE_DIR / 'var' / 'private'
MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
# No public MEDIA_URL route: all user files pass through the ownership-checked API.
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = ENV == 'production'
CSRF_COOKIE_SECURE = ENV == 'production'
SECURE_SSL_REDIRECT = ENV == 'production'
SECURE_HSTS_SECONDS = 3600 if ENV == 'production' else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'
# Enable only with a trusted reverse proxy that overwrites the header.
if os.getenv('TRUST_PROXY_HTTPS', '0') == '1':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['accounts.authentication.BearerAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
    'DEFAULT_RENDERER_CLASSES': ['common.renderers.EnvelopeJSONRenderer'],
    'DEFAULT_PAGINATION_CLASS': 'common.pagination.StandardPagination',
    'PAGE_SIZE': 20, 'EXCEPTION_HANDLER': 'common.exceptions.exception_handler',
    'DEFAULT_THROTTLE_CLASSES': ['rest_framework.throttling.AnonRateThrottle', 'rest_framework.throttling.UserRateThrottle'],
    'DEFAULT_THROTTLE_RATES': {'anon': '120/min', 'user': '180/min', 'login': '20/min', 'upload': '10/min'},
    'NUM_PROXIES': 1 if os.getenv('TRUST_PROXY_HTTPS', '0') == '1' else 0,
    'TEST_REQUEST_DEFAULT_FORMAT': 'json',
}
AUTH_SESSION_DAYS = 7
WECHAT_APP_ID = os.getenv('WECHAT_APP_ID', '')
WECHAT_APP_SECRET = os.getenv('WECHAT_APP_SECRET', '')
# External LLM access requires this gate, a credential, and an enabled admin config.
# Only backend processes read these values; never return the key through an API.
LLM_ENABLED = os.getenv('LLM_ENABLED', '0') == '1'
DEEPSEEK_API_KEY = os.getenv('DEEPSEEK_API_KEY', '').strip()
DEEPSEEK_MODEL = os.getenv('DEEPSEEK_MODEL', 'deepseek-flash').strip()
if DEEPSEEK_MODEL != 'deepseek-flash':
    raise ImproperlyConfigured('DEEPSEEK_MODEL must be deepseek-flash for this gateway')
LLM_DAILY_TURN_LIMIT = int(os.getenv('LLM_DAILY_TURN_LIMIT', '5'))
if not 1 <= LLM_DAILY_TURN_LIMIT <= 5:
    raise ImproperlyConfigured('LLM_DAILY_TURN_LIMIT must be between 1 and 5')
LLM_QUEUE_TIMEOUT_SECONDS = 300
LLM_RETENTION_DAYS = 30
# Separate real-weather connector. Credentials never enter the database or client.
QWEATHER_ENABLED = os.getenv('QWEATHER_ENABLED', '0') == '1'
QWEATHER_API_KEY = os.getenv('QWEATHER_API_KEY', '').strip()
QWEATHER_API_HOST = os.getenv('QWEATHER_API_HOST', '').strip().lower()
QWEATHER_MONTHLY_LIMIT = int(os.getenv('QWEATHER_MONTHLY_LIMIT', '100'))
if not 1 <= QWEATHER_MONTHLY_LIMIT <= 30000:
    raise ImproperlyConfigured('QWEATHER_MONTHLY_LIMIT must be between 1 and 30000')
QWEATHER_TIMEOUT_SECONDS = 5
QWEATHER_MINUTE_LIMIT = 15
QWEATHER_CACHE_SECONDS = {
    'weather': int(os.getenv('QWEATHER_WEATHER_TTL_SECONDS', '1800')),
    'air': int(os.getenv('QWEATHER_AIR_TTL_SECONDS', '3600')),
    'alerts': int(os.getenv('QWEATHER_ALERT_TTL_SECONDS', '900')),
}
if any(not minimum <= QWEATHER_CACHE_SECONDS[kind] <= 86400 for kind, minimum in [('weather', 1800), ('air', 3600), ('alerts', 900)]):
    raise ImproperlyConfigured('QWeather cache lifetimes must be at least 30/60/15 minutes and at most 24 hours')
QWEATHER_FAILURE_COOLDOWN_SECONDS = 600
DATA_MODE = 'simulation'
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 6 * 1024 * 1024
ORIGINAL_RETENTION_HOURS = 24
RECORD_RETENTION_DAYS = 30
RECOGNITION_QUEUE_LIMIT = 20
RECOGNITION_QUEUE_TIMEOUT_SECONDS = 300
RECOGNITION_RUN_TIMEOUT_SECONDS = int(os.getenv('HYHQ_RECOGNITION_TIMEOUT_SECONDS', '10'))
if not 1 <= RECOGNITION_RUN_TIMEOUT_SECONDS <= 60:
    raise ImproperlyConfigured('HYHQ_RECOGNITION_TIMEOUT_SECONDS must be between 1 and 60')
RECOGNITION_MODEL_ROOT = Path(os.getenv('HYHQ_MODEL_ROOT', str(BASE_DIR.parent / 'inference' / 'artifacts'))).resolve()
RECOGNITION_LOCK_PATH = BASE_DIR / 'var' / 'recognition.lock'
ASSESSMENT_MODEL_ROOT = Path(os.getenv('HYHQ_ASSESSMENT_MODEL_ROOT', str(RECOGNITION_MODEL_ROOT))).resolve()
ASSESSMENT_RUN_TIMEOUT_SECONDS = int(os.getenv('HYHQ_ASSESSMENT_TIMEOUT_SECONDS', '10'))
if not 1 <= ASSESSMENT_RUN_TIMEOUT_SECONDS <= 60:
    raise ImproperlyConfigured('HYHQ_ASSESSMENT_TIMEOUT_SECONDS must be between 1 and 60')
LOGGING = {
    'version': 1, 'disable_existing_loggers': False,
    'filters': {'redact': {'()': 'common.logging.RedactFilter'}},
    'formatters': {'simple': {'format': '{asctime} {levelname} {name} {message}', 'style': '{'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'simple', 'filters': ['redact']}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
    'loggers': {'django.server': {'handlers': ['console'], 'level': 'WARNING', 'propagate': False}},
}

# Optional capabilities stay closed until account entitlements are verified.
COMMUNITY_ENABLED = os.getenv('COMMUNITY_ENABLED', '0') == '1'
QWEATHER_FORECAST_ENABLED = os.getenv('QWEATHER_FORECAST_ENABLED', '0') == '1'
QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED = os.getenv('QWEATHER_FORECAST_ENTITLEMENT_CONFIRMED', '0') == '1'
QWEATHER_FORECAST_TTL_SECONDS = int(os.getenv('QWEATHER_FORECAST_TTL_SECONDS', '21600'))
WEATHER_SUBSCRIPTIONS_ENABLED = os.getenv('WEATHER_SUBSCRIPTIONS_ENABLED', '0') == '1'
WEATHER_SUBSCRIPTIONS_CAPABILITY_CONFIRMED = os.getenv('WEATHER_SUBSCRIPTIONS_CAPABILITY_CONFIRMED', '0') == '1'
WEATHER_SUBSCRIPTION_TEMPLATE_ID = os.getenv('WEATHER_SUBSCRIPTION_TEMPLATE_ID', '').strip()
# JSON maps the four supported values to approved WeChat template keys.
import json as _json
try:
    WEATHER_SUBSCRIPTION_FIELDS = _json.loads(os.getenv('WEATHER_SUBSCRIPTION_FIELDS', '{}'))
except (TypeError, ValueError):
    raise ImproperlyConfigured('WEATHER_SUBSCRIPTION_FIELDS must be valid JSON') from None
