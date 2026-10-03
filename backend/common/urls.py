"""Business paths for domain-free transport; HTTP deployments retain their URLs."""
from urllib.parse import urlsplit

from django.conf import settings


def api_uri(request, path):
    return path if settings.CLOUD_TRANSFER_ENABLED else request.build_absolute_uri(path)


def pagination_uri(url):
    if not url or not settings.CLOUD_TRANSFER_ENABLED:
        return url
    parts = urlsplit(url)
    return parts.path + ('?' + parts.query if parts.query else '')
