"""WeChat transport. No credentials, token, openid or response body in errors/logs."""
import hashlib
import http.client
import json
import ssl
import time
from urllib.parse import urlencode

from django.conf import settings
from django.core.cache import cache


class DeliveryError(Exception):
    def __init__(self, code, *, retryable=False, ambiguous=False):
        self.code, self.retryable, self.ambiguous = code, retryable, ambiguous
        super().__init__(code)


def _post(path, payload, *, sending=False):
    connection = http.client.HTTPSConnection('api.weixin.qq.com', timeout=5, context=ssl.create_default_context())
    try:
        deadline = time.monotonic() + 15
        connection.request('POST', path, body=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        chunks, size = [], 0
        while size <= 32768:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            if connection.sock:
                connection.sock.settimeout(min(5, remaining))
            chunk = response.read1(min(8192, 32769-size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        raw = b''.join(chunks)
        if response.status != 200 or len(raw) > 32768:
            raise DeliveryError('wechat_http', retryable=not sending, ambiguous=sending)
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError
        return body
    except DeliveryError:
        raise
    except (OSError, http.client.HTTPException, ValueError, TypeError):
        # With no provider idempotency key, a timed-out send might have succeeded.
        # Never retry this case automatically using the same once-only permission.
        raise DeliveryError('wechat_unavailable', retryable=not sending, ambiguous=sending) from None
    finally:
        connection.close()


def token_key():
    return 'weather:wechat-token:' + hashlib.sha256((settings.WECHAT_APP_ID + '\0' + settings.WECHAT_APP_SECRET).encode()).hexdigest()


def access_token():
    token = cache.get(token_key())
    if isinstance(token, str) and 0 < len(token) <= 1024:
        return token
    body = _post('/cgi-bin/stable_token', {'grant_type': 'client_credential',
        'appid': settings.WECHAT_APP_ID, 'secret': settings.WECHAT_APP_SECRET, 'force_refresh': False})
    token, expires = body.get('access_token'), body.get('expires_in')
    if (body.get('errcode', 0) != 0 or not isinstance(token, str) or not token or len(token) > 1024
            or type(expires) is not int or expires < 120):
        raise DeliveryError('token_rejected', retryable=body.get('errcode') == -1)
    cache.set(token_key(), token, min(expires - 60, 7000))
    return token


def send_once(openid, template_id, data, page):
    token = access_token()  # A failure here is safe to retry: no message was sent.
    body = _post('/cgi-bin/message/subscribe/send?' + urlencode({'access_token': token}),
        {'touser': openid, 'template_id': template_id, 'page': page,
         'miniprogram_state': 'formal', 'lang': 'zh_CN', 'data': data}, sending=True)
    code = body.get('errcode')
    if type(code) is int and code == 0:
        return
    if type(code) is not int:
        raise DeliveryError('invalid_send_response', ambiguous=True)
    if code in (40014, 42001):
        cache.delete(token_key())
        raise DeliveryError('token_expired', retryable=True)
    if code == -1:
        raise DeliveryError('wechat_busy', retryable=True)
    if code == 43101:
        raise DeliveryError('permission_unavailable')
    if code in (40037, 47003, 41030):
        raise DeliveryError('template_or_page_invalid')
    # Unknown failures are not retried without checking the provider contract.
    raise DeliveryError('wechat_rejected')
