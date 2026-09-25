"""Independent external-API worker. It never acquires the image inference CPU lock."""
import time
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from common.exceptions import ServiceError
from common.models import TaskLog
from . import provider
from .context import build_messages
from .public_context import build_public_context, revision_for
from .models import LLMSession, LLMTurn, UsageLedger
from .services import (ACTIVE, _settle_locked, enabled, get_config, recover_locked,
                       validate_source, image_available)


@transaction.atomic
def recover_stale_jobs():
    get_config(locked=True)
    return recover_locked()


@transaction.atomic
def _claim():
    config = get_config(locked=True)
    recover_locked()
    if UsageLedger.objects.filter(status='running').count() >= config.max_concurrency:
        return None
    entry = UsageLedger.objects.filter(status='queued').order_by('created_at', 'id').first()
    if not entry:
        return None
    turn = LLMTurn.objects.select_related('session').filter(ledger=entry).first()
    if not turn:
        _settle_locked(entry, code='SESSION_DELETED')
        return None
    now = timezone.now()
    # Conditional writes also handle source/account cascades, which may run
    # without the gateway mutex. Never resurrect a cancelled/deleted row.
    claimed = UsageLedger.objects.filter(pk=entry.pk, status='queued').update(
        status='running', started_at=now, lease_until=now + timedelta(seconds=entry.timeout_seconds + 30))
    if not claimed:
        return None
    if not LLMTurn.objects.filter(pk=turn.pk, status='queued').update(status='running'):
        entry.refresh_from_db()
        _settle_locked(entry, code='SESSION_DELETED')
        return None
    turn.status = 'running'
    return turn


@transaction.atomic
def _before_dispatch(turn_id, used_image, context_revision='', citations=None):
    config = get_config(locked=True)
    turn = LLMTurn.objects.select_related('session', 'ledger').filter(pk=turn_id, status='running').first()
    if not turn or turn.ledger.status != 'running':
        raise ServiceError('会话已被删除或处理已超时。', 'SESSION_DELETED', 409)
    if not enabled(config):
        raise ServiceError('AI 解读暂未开放。', 'LLM_DISABLED', 503)
    job = validate_source(turn.session)
    if used_image and not image_available(turn.session, job):
        raise ServiceError('原图已过期或被删除，请稍后仅解读识别结果。', 'IMAGE_UNAVAILABLE', 409)
    if turn.session.scope != 'recognition':
        if not context_revision or revision_for(build_public_context(turn.session, job)) != context_revision:
            raise ServiceError('页面资料已更新，请重新提问以使用最新公开内容。', 'LLM_CONTEXT_CHANGED', 409)
        LLMTurn.objects.filter(pk=turn.pk, status='running').update(context_revision=context_revision, citations=citations or [])
    if turn.ledger.lease_until <= timezone.now():
        raise ServiceError('解读准备超时，请稍后重试。', 'LLM_WORKER_TIMEOUT', 409)
    UsageLedger.objects.filter(pk=turn.ledger_id, status='running').update(dispatched=True, used_image=used_image,
        lease_until=timezone.now() + timedelta(seconds=turn.ledger.timeout_seconds + 30))


@transaction.atomic
def _finish(entry_id, *, response=None, code='', message='', ambiguous=False, usage=None, duration_ms=0):
    get_config(locked=True)
    entry = UsageLedger.objects.filter(pk=entry_id).first()
    if not entry or entry.status not in ACTIVE:
        return
    turn = LLMTurn.objects.select_related('session').filter(ledger=entry).first()
    source_valid = False
    context_changed = False
    if turn and entry.owner_id:
        try:
            source = validate_source(turn.session)
            source_valid = True
            if turn.session.scope != 'recognition' and turn.context_revision:
                context_changed = revision_for(build_public_context(turn.session, source)) != turn.context_revision
        except ServiceError:
            pass
    if response:
        usage = response['usage']
    if not source_valid:
        code, message = 'SOURCE_UNAVAILABLE', '关联资料或会话已删除、下架或过期，解读结果不再保存。'
    elif context_changed:
        code, message = 'LLM_CONTEXT_CHANGED', '页面资料已更新，本次结果不再保存，请重新提问。'
    success = bool(response and not code and source_valid)
    if not _settle_locked(entry, success=success, code=code, usage=usage, ambiguous=ambiguous, duration_ms=duration_ms):
        return
    if turn:
        LLMTurn.objects.filter(pk=turn.pk, status='running').update(status='succeeded' if success else 'failed',
            answer=response['text'] if success else '', error_code=code, message=message if code else '',
            finished_at=timezone.now(), used_image=entry.used_image, usage=entry.usage)
    TaskLog.objects.create(task='llm', status='succeeded' if success else 'failed', error_code=code, count=1, duration_ms=duration_ms)


def process_one():
    turn = _claim()
    if turn is None:
        return False
    started = time.monotonic()
    response, error, message, usage, ambiguous = None, '', '', None, False
    entry = turn.ledger
    try:
        messages, used_image = build_messages(turn)
        _before_dispatch(turn.pk, used_image, turn.context_revision, turn.citations)
        response = provider.generate(messages, max_tokens=entry.max_output_tokens,
                                     timeout=entry.timeout_seconds, user_id=str(entry.pk))
    except provider.ProviderError as exc:
        error, message, usage, ambiguous = exc.code, str(exc), exc.usage, exc.ambiguous
    except ServiceError as exc:
        error, message = str(exc.get_codes()), str(exc.detail)
    except Exception:
        # Never persist raw exception text: it can include prompts or credentials.
        error, message = 'LLM_LOCAL_ERROR', 'AI 解读暂时失败，请稍后再试。'
        ambiguous = UsageLedger.objects.filter(pk=entry.pk, dispatched=True).exists()
    _finish(entry.pk, response=response, code=error, message=message[:200], usage=usage,
            ambiguous=ambiguous, duration_ms=int((time.monotonic() - started) * 1000))
    return True
