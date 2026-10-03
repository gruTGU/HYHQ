"""Parse explicit PostgreSQL URLs without silently dropping TLS settings."""
from urllib.parse import parse_qs, unquote, urlparse

from django.core.exceptions import ImproperlyConfigured


def postgres_database(value):
    try:
        url = urlparse(value)
        query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
        allowed = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connect_timeout', 'application_name'}
        if (url.scheme not in {'postgres', 'postgresql'} or not url.path.strip('/')
                or url.fragment or set(query) - allowed
                or any(len(values) != 1 or not values[0] for values in query.values())):
            raise ValueError
        options = {key: values[0] for key, values in query.items()}
        if options.get('sslmode', 'prefer') not in {'disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'}:
            raise ValueError
        if 'connect_timeout' in options:
            options['connect_timeout'] = int(options['connect_timeout'])
            if not 1 <= options['connect_timeout'] <= 60:
                raise ValueError
        return {'ENGINE': 'django.db.backends.postgresql', 'NAME': unquote(url.path.lstrip('/')),
                'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''),
                'HOST': url.hostname or '127.0.0.1', 'PORT': url.port or 5432,
                'CONN_MAX_AGE': 60, 'OPTIONS': options}
    except (ValueError, TypeError, AttributeError):
        # Never include the input: it normally contains a password.
        raise ImproperlyConfigured('Invalid PostgreSQL DATABASE_URL or unsupported connection option') from None
