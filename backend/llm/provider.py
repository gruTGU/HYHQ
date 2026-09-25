"""Bounded, non-streaming DeepSeek transport; never logs prompts or credentials.

The network exchange runs in a short-lived subprocess so the parent can enforce
a wall-clock deadline even during DNS resolution or a slow, trickling response.
Credentials are passed over stdin, never in argv or the child's environment.
"""
import base64
import binascii
import hashlib
import hmac
import http.client
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import sys
import time


MODEL = 'deepseek-flash'
HOST = 'api.deepseek.com'
PATH = '/chat/completions'
MAX_TEXT_BYTES = 16384
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 3 * 1024 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_OUTPUT_TOKENS = 4096
MAX_TIMEOUT = 120


class ProviderError(Exception):
    """Safe public failure; ambiguous means upstream billing may have occurred."""

    def __init__(self, code, message, ambiguous=False, usage=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.ambiguous = ambiguous
        self.usage = usage


class _ChildDeadlineExceeded(BaseException):
    """Escape transport exception handlers if the parent is no longer alive."""


def _child_deadline(signum, frame):
    raise _ChildDeadlineExceeded


def _error(code, *, ambiguous=False, usage=None):
    messages = {
        'LLM_DISABLED': 'AI 解读暂未开放。',
        'LLM_NOT_CONFIGURED': 'AI 解读服务尚未配置。',
        'LLM_CONFIG_INVALID': 'AI 解读服务配置无效。',
        'LLM_INPUT_INVALID': '解读内容格式不正确，请重新提交。',
        'LLM_REQUEST_TOO_LARGE': '解读内容过长，请缩短问题或重新选择图片。',
        'LLM_TIMEOUT': 'AI 解读等待超时，请稍后查看记录。',
        'LLM_TRANSPORT_ERROR': 'AI 解读连接中断，请稍后查看记录。',
        'LLM_PROVIDER_AUTH': 'AI 解读服务认证失败，请联系管理员。',
        'LLM_PROVIDER_BALANCE': 'AI 解读服务余额不足，请联系管理员。',
        'LLM_PROVIDER_RATE_LIMIT': 'AI 解读服务繁忙，请稍后再试。',
        'LLM_PROVIDER_UNAVAILABLE': 'AI 解读服务暂时不可用。',
        'LLM_PROVIDER_REDIRECT': 'AI 解读服务返回了不支持的跳转。',
        'LLM_PROVIDER_REJECTED': 'AI 解读服务未接受本次请求。',
        'LLM_RESPONSE_INVALID': 'AI 解读结果格式异常，未保存为完整回答。',
        'LLM_RESPONSE_TOO_LARGE': 'AI 解读结果超过限制，未保存为完整回答。',
        'LLM_RESPONSE_INCOMPLETE': 'AI 解读未完整生成，请稍后再试。',
        'LLM_LOCAL_ERROR': 'AI 解读任务暂时无法启动。',
    }
    return ProviderError(code, messages[code], ambiguous=ambiguous, usage=usage)


def _validate_messages(messages):
    if not isinstance(messages, list) or not 1 <= len(messages) <= 24:
        raise _error('LLM_INPUT_INVALID')
    text_bytes, images = 0, 0
    clean = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {'role', 'content'}:
            raise _error('LLM_INPUT_INVALID')
        role, content = message['role'], message['content']
        if role not in ('system', 'user', 'assistant') or (role == 'system' and index != 0):
            raise _error('LLM_INPUT_INVALID')
        if isinstance(content, str):
            if not content.strip():
                raise _error('LLM_INPUT_INVALID')
            text_bytes += len(content.encode('utf-8'))
            clean.append({'role': role, 'content': content})
        elif role == 'user' and isinstance(content, list) and 1 <= len(content) <= 4:
            parts = []
            for part in content:
                if not isinstance(part, dict):
                    raise _error('LLM_INPUT_INVALID')
                if part.get('type') == 'text' and set(part) == {'type', 'text'}:
                    if not isinstance(part['text'], str) or not part['text'].strip():
                        raise _error('LLM_INPUT_INVALID')
                    text_bytes += len(part['text'].encode('utf-8'))
                    parts.append({'type': 'text', 'text': part['text']})
                elif part.get('type') == 'image_url' and set(part) == {'type', 'image_url'}:
                    image = part['image_url']
                    if not isinstance(image, dict) or not set(image) <= {'url', 'detail'}:
                        raise _error('LLM_INPUT_INVALID')
                    url = image.get('url')
                    prefix = 'data:image/jpeg;base64,'
                    if not isinstance(url, str) or not url.startswith(prefix):
                        raise _error('LLM_INPUT_INVALID')
                    encoded = url[len(prefix):]
                    if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
                        raise _error('LLM_REQUEST_TOO_LARGE')
                    try:
                        blob = base64.b64decode(encoded, validate=True)
                    except (ValueError, binascii.Error):
                        raise _error('LLM_INPUT_INVALID') from None
                    if len(blob) > MAX_IMAGE_BYTES:
                        raise _error('LLM_REQUEST_TOO_LARGE')
                    if not blob.startswith(b'\xff\xd8\xff') or not blob.endswith(b'\xff\xd9'):
                        raise _error('LLM_INPUT_INVALID')
                    if image.get('detail', 'low') not in ('low', 'auto'):
                        raise _error('LLM_INPUT_INVALID')
                    images += 1
                    if images > 1:
                        raise _error('LLM_INPUT_INVALID')
                    parts.append({'type': 'image_url', 'image_url': {'url': url, 'detail': 'low'}})
                else:
                    raise _error('LLM_INPUT_INVALID')
            clean.append({'role': role, 'content': parts})
        else:
            raise _error('LLM_INPUT_INVALID')
        if text_bytes > MAX_TEXT_BYTES:
            raise _error('LLM_REQUEST_TOO_LARGE')
    if clean[-1]['role'] != 'user':
        raise _error('LLM_INPUT_INVALID')
    return clean


def _usage(value):
    if not isinstance(value, dict):
        return None
    keys = ('prompt_tokens', 'completion_tokens', 'total_tokens')
    if any(type(value.get(key)) is not int or not 0 <= value[key] <= 10_000_000 for key in keys):
        return None
    if value['prompt_tokens'] + value['completion_tokens'] != value['total_tokens']:
        return None
    result = {key: value[key] for key in keys}
    cache_keys = ('prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')
    if any(key in value for key in cache_keys):
        if any(type(value.get(key)) is not int or not 0 <= value[key] <= value['prompt_tokens'] for key in cache_keys):
            return None
        if sum(value[key] for key in cache_keys) != value['prompt_tokens']:
            return None
        result.update({key: value[key] for key in cache_keys})
    return result


def _decode_response(raw, max_tokens):
    try:
        data = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeError, RecursionError):
        raise _error('LLM_RESPONSE_INVALID', ambiguous=True) from None
    if not isinstance(data, dict):
        raise _error('LLM_RESPONSE_INVALID', ambiguous=True)
    usage = _usage(data.get('usage'))
    fail = lambda code='LLM_RESPONSE_INVALID': _error(code, ambiguous=True, usage=usage)
    if usage is None or usage['completion_tokens'] > max_tokens:
        raise fail()
    choices = data.get('choices')
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise fail()
    choice = choices[0]
    if choice.get('finish_reason') != 'stop':
        raise fail('LLM_RESPONSE_INCOMPLETE')
    message = choice.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant' or message.get('tool_calls'):
        raise fail()
    text = message.get('content')
    if not isinstance(text, str) or not text.strip() or usage['completion_tokens'] == 0:
        raise fail()
    try:
        text_size = len(text.encode('utf-8'))
    except UnicodeError:
        raise fail() from None
    if text_size > 64 * 1024:
        raise fail('LLM_RESPONSE_TOO_LARGE')
    model, upstream_id = data.get('model'), data.get('id')
    if (model != MODEL or not isinstance(upstream_id, str)
            or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', upstream_id)):
        raise fail()
    return {'text': text.strip(), 'model': model, 'usage': usage, 'upstream_id': upstream_id}


def _http_request(payload, key, timeout):
    """Child-only network operation. HTTPSConnection never follows redirects."""
    deadline = time.monotonic() + timeout
    connection = http.client.HTTPSConnection(HOST, timeout=timeout, context=ssl.create_default_context())
    try:
        connection.request('POST', PATH, body=payload, headers={
            'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
            'Accept': 'application/json', 'Accept-Encoding': 'identity',
        })
        response = connection.getresponse()
        status = response.status
        # Do not read or forward upstream error bodies, headers, or redirect URLs.
        if status != 200:
            return {'status': status}
        size = response.getheader('Content-Length')
        if size is not None and (not size.isdigit() or int(size) > MAX_RESPONSE_BYTES):
            return {'error': 'LLM_RESPONSE_TOO_LARGE'}
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            return {'error': 'LLM_RESPONSE_INVALID'}
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                return {'error': 'LLM_TIMEOUT'}
            chunk = response.read1(min(8192, MAX_RESPONSE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                return {'error': 'LLM_RESPONSE_TOO_LARGE'}
        return {'status': 200, 'body': base64.b64encode(b''.join(chunks)).decode('ascii')}
    except (TimeoutError, socket.timeout):
        return {'error': 'LLM_TIMEOUT'}
    except Exception:
        return {'error': 'LLM_TRANSPORT_ERROR'}
    finally:
        connection.close()


def _exchange(payload, key, timeout):
    deadline = time.monotonic() + timeout
    child_input = json.dumps({'payload': payload.decode('utf-8'), 'key': key, 'timeout': timeout}).encode('utf-8')
    try:
        child = subprocess.Popen(
            [sys.executable, '-m', 'llm.provider'], cwd=Path(__file__).resolve().parent.parent,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': os.defpath, 'LANG': 'C.UTF-8', 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'},
        )
    except (OSError, ValueError):
        raise _error('LLM_LOCAL_ERROR') from None
    try:
        output, _ = child.communicate(input=child_input, timeout=max(0.001, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        child.kill()
        child.communicate()
        raise _error('LLM_TIMEOUT', ambiguous=True) from None
    if child.returncode != 0 or len(output) > MAX_RESPONSE_BYTES * 2:
        raise _error('LLM_TRANSPORT_ERROR', ambiguous=True)
    try:
        envelope = json.loads(output.decode('utf-8'))
    except (ValueError, UnicodeError, RecursionError):
        raise _error('LLM_TRANSPORT_ERROR', ambiguous=True) from None
    if not isinstance(envelope, dict):
        raise _error('LLM_TRANSPORT_ERROR', ambiguous=True)
    code = envelope.get('error')
    if code:
        if code not in ('LLM_TIMEOUT', 'LLM_TRANSPORT_ERROR', 'LLM_RESPONSE_TOO_LARGE', 'LLM_RESPONSE_INVALID'):
            code = 'LLM_TRANSPORT_ERROR'
        raise _error(code, ambiguous=True)
    status = envelope.get('status')
    if type(status) is not int:
        raise _error('LLM_TRANSPORT_ERROR', ambiguous=True)
    if status != 200:
        errors = {401: 'LLM_PROVIDER_AUTH', 402: 'LLM_PROVIDER_BALANCE', 429: 'LLM_PROVIDER_RATE_LIMIT'}
        if status in errors:
            raise _error(errors[status])
        if status == 408:
            raise _error('LLM_TIMEOUT', ambiguous=True)
        if 300 <= status < 400:
            raise _error('LLM_PROVIDER_REDIRECT')
        if 400 <= status < 500:
            raise _error('LLM_PROVIDER_REJECTED')
        raise _error('LLM_PROVIDER_UNAVAILABLE', ambiguous=True)
    try:
        body = base64.b64decode(envelope['body'], validate=True)
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise _error('LLM_TRANSPORT_ERROR', ambiguous=True) from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise _error('LLM_RESPONSE_TOO_LARGE', ambiguous=True)
    return body


def generate(messages, *, max_tokens, timeout, user_id):
    """Perform one attempt only. Safe failures never include upstream details."""
    from django.conf import settings

    if not getattr(settings, 'LLM_ENABLED', False):
        raise _error('LLM_DISABLED')
    key = getattr(settings, 'DEEPSEEK_API_KEY', '')
    if not key:
        raise _error('LLM_NOT_CONFIGURED')
    if (not isinstance(key, str) or not re.fullmatch(r'[\x21-\x7e]{8,512}', key)
            or getattr(settings, 'DEEPSEEK_MODEL', MODEL) != MODEL):
        raise _error('LLM_CONFIG_INVALID')
    if (type(max_tokens) is not int or not 1 <= max_tokens <= MAX_OUTPUT_TOKENS
            or type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= MAX_TIMEOUT):
        raise _error('LLM_CONFIG_INVALID')
    identity = str(user_id)
    if user_id is None or not 1 <= len(identity) <= 128:
        raise _error('LLM_INPUT_INVALID')
    try:
        anonymous_id = hmac.new(str(settings.SECRET_KEY).encode(), ('hyhq-llm:' + identity).encode(), hashlib.sha256).hexdigest()
        clean = _validate_messages(messages)
        payload = json.dumps({
            'model': MODEL, 'messages': clean, 'thinking': {'type': 'disabled'},
            'stream': False, 'max_tokens': max_tokens, 'user_id': 'hyhq_' + anonymous_id,
        }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    except UnicodeError:
        raise _error('LLM_INPUT_INVALID') from None
    if len(payload) > MAX_REQUEST_BYTES:
        raise _error('LLM_REQUEST_TOO_LARGE')
    raw = _exchange(payload, key, float(timeout))
    return _decode_response(raw, max_tokens)


def _child_main():
    timer_armed = False
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES * 2 + 1)
        if len(raw) > MAX_REQUEST_BYTES * 2:
            raise ValueError
        data = json.loads(raw)
        timeout = data['timeout']
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= MAX_TIMEOUT:
            raise ValueError
        # Mac/Linux deployment: this clock survives parent worker termination.
        # Socket timeouts alone cannot bound a peer trickling HTTP headers. A
        # separate BaseException bypasses the transport's generic failure catch.
        signal.signal(signal.SIGALRM, _child_deadline)
        signal.setitimer(signal.ITIMER_REAL, timeout)
        timer_armed = True
        result = _http_request(data['payload'].encode('utf-8'), data['key'], data['timeout'])
    except _ChildDeadlineExceeded:
        result = {'error': 'LLM_TIMEOUT'}
    except Exception:
        result = {'error': 'LLM_TRANSPORT_ERROR'}
    finally:
        if timer_armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
    sys.stdout.buffer.write(json.dumps(result, separators=(',', ':')).encode('utf-8'))


if __name__ == '__main__':
    _child_main()
