"""Server-only WeChat content checking; no request URLs/payloads are logged."""
import hashlib
import json
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

from django.conf import settings
from common.exceptions import ServiceError

_lock = threading.Lock()
_cached = None


def credential_digest():
    app_id = getattr(settings, 'WECHAT_APP_ID', '')
    secret = getattr(settings, 'WECHAT_APP_SECRET', '')
    return hashlib.sha256((app_id + '\0' + secret).encode()).hexdigest() if app_id and secret else ''


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post(url, payload):
    request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with build_opener(NoRedirect).open(request, timeout=8) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError
            data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        raise ServiceError('内容检查暂不可用，请稍后重试。', 'CONTENT_SAFETY_UNAVAILABLE', 503) from None


def _token():
    global _cached
    digest = credential_digest()
    if not digest:
        raise ServiceError('内容检查尚未配置。', 'CONTENT_SAFETY_UNAVAILABLE', 503)
    with _lock:
        if _cached and _cached[0] == digest and _cached[2] > time.monotonic():
            return _cached[1]
        data = _post('https://api.weixin.qq.com/cgi-bin/stable_token', {'grant_type': 'client_credential', 'appid': settings.WECHAT_APP_ID, 'secret': settings.WECHAT_APP_SECRET, 'force_refresh': False})
        token, expires = data.get('access_token'), data.get('expires_in')
        if data.get('errcode', 0) != 0 or not isinstance(token, str) or not token or len(token) > 1024 or type(expires) is not int or expires < 120:
            raise ServiceError('内容检查暂不可用，请稍后重试。', 'CONTENT_SAFETY_UNAVAILABLE', 503)
        _cached = (digest, token, time.monotonic() + min(expires - 60, 7100))
        return token


def check_text(user, text):
    if user.auth_kind != 'wechat' or not user.wechat_openid:
        raise ServiceError('请使用微信账号登录后发表评论。', 'WECHAT_REQUIRED', 403)
    data = _post('https://api.weixin.qq.com/wxa/msg_sec_check?' + urlencode({'access_token': _token()}),
                 {'openid': user.wechat_openid, 'scene': 2, 'version': 2, 'content': text})
    if data.get('errcode') == 61010:
        raise ServiceError('微信登录验证已过期，请重新登录后再试。', 'WECHAT_RELOGIN_REQUIRED', 409)
    result = data.get('result')
    if data.get('errcode') != 0 or not isinstance(result, dict) or result.get('suggest') not in ('pass', 'review', 'risky'):
        raise ServiceError('内容检查暂不可用，请稍后重试。', 'CONTENT_SAFETY_UNAVAILABLE', 503)
    trace = data.get('trace_id', '')
    if not isinstance(trace, str) or len(trace) > 128:
        raise ServiceError('内容检查暂不可用，请稍后重试。', 'CONTENT_SAFETY_UNAVAILABLE', 503)
    return {'suggest': result['suggest'], 'trace_id': trace}
