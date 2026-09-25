"""Atomic admission and accounting; no HTTP call is made while holding a DB lock."""
import hashlib
import json
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import User
from assessments.models import AssessmentJob
from common.audit import audit
from common.exceptions import ServiceError
from recognition.models import RecognitionJob
from .models import GatewayConfig, LLMSession, LLMTurn, UsageLedger
from .sources import ALLOWED_SOURCES, SCOPE_NAMES, SOURCE_FIELDS, public_queryset, public_source, visible_sources_filter

CONSENT_VERSION = 'deepseek-v1'
SHANGHAI = ZoneInfo('Asia/Shanghai')
ACTIVE = ('queued', 'running')
INPUT_TOKEN_RESERVATION = 32768
NOTICE = 'AI 助手将问题、当前页面公开资料、相关识别结果及你主动选择附带的图片发送给 DeepSeek。不会附带用户精确定位。AI 可能出错，请结合资料来源核实，不能替代植物鉴定、水质检测或实际导航。'


def lock_owner(owner):
    if not User.objects.select_for_update().filter(pk=owner.pk, is_active=True).exists():
        raise ServiceError('登录已失效，请重新登录。', 'AUTH_REQUIRED', 401)


def get_config(locked=False):
    GatewayConfig.objects.get_or_create(pk=1)
    query = GatewayConfig.objects.select_for_update() if locked else GatewayConfig.objects
    return query.get(pk=1)


def enabled(config=None):
    config = config or get_config()
    return bool(getattr(settings, 'LLM_ENABLED', False) and getattr(settings, 'DEEPSEEK_API_KEY', '').strip() and config.enabled)


def effective_limit(config):
    return min(config.daily_turn_limit, getattr(settings, 'LLM_DAILY_TURN_LIMIT', 5), 5)


def quota(owner, config=None, now=None, scope='recognition'):
    now = now or timezone.now()
    config = config or get_config()
    day = now.astimezone(SHANGHAI).date()
    entries = UsageLedger.objects.filter(owner=owner, scope=scope, day=day)
    used = entries.filter(status='succeeded').count()
    reserved = entries.filter(status__in=ACTIVE).count()
    limit = effective_limit(config)
    return {'scope': scope, 'date': day.isoformat(), 'limit': limit, 'used': used, 'reserved': reserved,
            'remaining': max(0, limit - used - reserved),
            'reset_at': datetime.combine(day + timedelta(days=1), time(), tzinfo=SHANGHAI).isoformat()}


def status(owner=None, scope='recognition'):
    config = get_config()
    return {'enabled': enabled(config), 'scope': scope, 'model': 'deepseek-flash', 'notice': NOTICE, 'consent_version': CONSENT_VERSION,
            'daily_limit': effective_limit(config),
            'quota': quota(owner, config, scope=scope) if owner is not None and owner.is_authenticated else None}


def require_enabled(config):
    if not enabled(config):
        raise ServiceError('AI 解读暂未开放，请稍后再试。', 'LLM_DISABLED', 503)


def source_job(session):
    if session.recognition_job_id:
        return RecognitionJob.objects.filter(pk=session.recognition_job_id, owner_id=session.owner_id).select_related('asset').first()
    return AssessmentJob.objects.filter(pk=session.assessment_job_id, owner_id=session.owner_id).select_related('asset', 'water_body__place').first()


def validate_source(session, now=None):
    now = now or timezone.now()
    if session.expires_at <= now or not User.objects.filter(pk=session.owner_id, is_active=True).exists():
        raise ServiceError('会话已过期或账号不可用，请重新开始。', 'SOURCE_UNAVAILABLE', 409)
    if session.scope == 'recognition':
        source = source_job(session)
        if not source or source.status != 'succeeded' or source.expires_at <= now:
            raise ServiceError('原识别记录已过期、删除或不可用，请重新识别。', 'SOURCE_UNAVAILABLE', 409)
    else:
        source = public_source(session)
        if not source:
            raise ServiceError('关联资料已下架、删除或不可用，请选择当前公开页面。', 'SOURCE_UNAVAILABLE', 409)
    return source


def image_available(session, job=None, now=None):
    if session.scope != 'recognition':
        return False
    now = now or timezone.now()
    job = job or source_job(session)
    asset = job.asset if job and job.asset_id else None
    if not (job and job.expires_at > now and asset and asset.owner_id == session.owner_id and asset.original
            and asset.original_expires_at > now and (not asset.expires_at or asset.expires_at > now)):
        return False
    try:
        return asset.original.storage.exists(asset.original.name)
    except OSError:
        return False


def visible_sessions(owner):
    now = timezone.now()
    private = Q(scope='recognition') & (
        Q(recognition_job__status='succeeded', recognition_job__expires_at__gt=now, recognition_job__owner_id=F('owner_id')) |
        Q(assessment_job__status='succeeded', assessment_job__expires_at__gt=now, assessment_job__owner_id=F('owner_id')))
    public = Q(scope__in=['explore', 'learn']) & visible_sources_filter()
    return LLMSession.objects.filter(owner=owner, expires_at__gt=now).filter(private | public)


@transaction.atomic
def create_session(owner, data):
    lock_owner(owner)
    config = get_config(locked=True)
    require_enabled(config)
    now = timezone.now()
    if visible_sessions(owner).count() >= 50:
        raise ServiceError('会话数量已达到上限，请先删除不再需要的会话。', 'SESSION_LIMIT', 429)
    scope = data.get('scope', 'recognition')
    expires = now + timedelta(days=getattr(settings, 'LLM_RETENTION_DAYS', 30))
    if scope == 'recognition':
        kind, model, field = (('recognition', RecognitionJob, 'recognition_job') if data.get('recognition_job_id')
                              else ('assessment', AssessmentJob, 'assessment_job'))
        source = get_object_or_404(model, pk=data[f'{field}_id'], owner=owner)
        if source.status != 'succeeded' or source.expires_at <= now:
            raise ServiceError('请先完成识别，并选择仍在有效期内的记录。', 'SOURCE_UNAVAILABLE', 409)
        expires = min(expires, source.expires_at)
        title = '花卉识别解读' if kind == 'recognition' else '河道图像解读'
        summary = ('基于五类花卉模型的候选与不确定性进行解读，不能代替专业植物鉴定。' if kind == 'recognition'
                   else '基于实验漂浮物检测和教学规则分进行解读，不能据此判定真实水质或污染程度。')
    else:
        source_type = data.get('source_type')
        if source_type not in ALLOWED_SOURCES.get(scope, set()):
            raise ServiceError('此板块不支持所选资料类型。', 'LLM_SOURCE_INVALID', 400)
        kind, field = scope, SOURCE_FIELDS[source_type]
        source = get_object_or_404(public_queryset(source_type), pk=data['source_id'])
        title = SCOPE_NAMES[scope] + '助手'
        summary = ('结合当前公开地点、水体与标明来源的环境资料，帮助理解生态导览。' if scope == 'explore'
                   else '结合当前已发布的科普文章和预设路线，帮助理解知识与安排学习顺序。')
    weather_location = data.get('weather_location', '')
    if weather_location:
        from weatherdata.models import WeatherLocation
        if scope == 'recognition' or not WeatherLocation.objects.filter(slug=weather_location, is_active=True).exists():
            raise ServiceError('请选择平台支持的真实天气地点。', 'WEATHER_LOCATION_INVALID', 400)
    session = LLMSession(owner=owner, **{field: source}, scope=scope, kind=kind, title=title, context_summary=summary,
                         weather_location=weather_location,
                         consent_version=data.get('consent_version', ''), include_image=data.get('include_image', False),
                         expires_at=expires)
    if session.include_image and not image_available(session, source, now):
        raise ServiceError('原图已过期或无法读取；请取消附带图片，仅解读识别结果，或重新上传。', 'IMAGE_UNAVAILABLE', 409)
    session.save()
    audit('llm.session_created', owner, session.pk)
    return session


def fingerprint(session_id, question):
    return hashlib.sha256(json.dumps([str(session_id), question], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def _settle_locked(entry, *, success=False, code='', usage=None, ambiguous=False, duration_ms=0):
    """Terminal ledger entries are immutable; late/stale workers cannot settle twice."""
    if entry.status not in ACTIVE:
        return False
    from .provider import _usage
    valid_usage = _usage(usage)
    entry.status = 'succeeded' if success else 'failed'
    entry.error_code = code
    entry.usage = valid_usage or {}
    entry.usage_estimated = valid_usage is None and ambiguous
    entry.accounted_tokens = valid_usage['total_tokens'] if valid_usage else (entry.reserved_tokens if ambiguous else 0)
    entry.duration_ms = duration_ms
    entry.finished_at = timezone.now()
    entry.save(update_fields=['status', 'error_code', 'usage', 'usage_estimated', 'accounted_tokens', 'duration_ms', 'finished_at'])
    return True


def recover_locked(now=None):
    now = now or timezone.now()
    queued_cutoff = now - timedelta(seconds=getattr(settings, 'LLM_QUEUE_TIMEOUT_SECONDS', 300))
    entries = UsageLedger.objects.filter(Q(status='queued', created_at__lt=queued_cutoff) |
                                        Q(status='running', lease_until__lt=now))
    count = 0
    for entry in entries:
        code = 'LLM_QUEUE_TIMEOUT' if entry.status == 'queued' else 'LLM_WORKER_TIMEOUT'
        _settle_locked(entry, code=code, ambiguous=entry.dispatched)
        LLMTurn.objects.filter(ledger=entry, status__in=ACTIVE).update(status='failed', error_code=code,
            message='解读已超时，本次不扣成功回合，请稍后重新提问。', finished_at=now)
        count += 1
    return count


@transaction.atomic
def enqueue_turn(owner, session_id, data):
    lock_owner(owner)
    config = get_config(locked=True)
    recover_locked()
    session = get_object_or_404(visible_sessions(owner), pk=session_id)
    existing = UsageLedger.objects.filter(owner=owner, request_id=data['request_id']).first()
    digest = fingerprint(session.pk, data['question'])
    if existing:
        if existing.fingerprint != digest:
            raise ServiceError('此请求编号已用于不同内容，请使用新的请求编号。', 'REQUEST_ID_CONFLICT', 409)
        turn = LLMTurn.objects.filter(ledger=existing, session=session).first()
        if not turn:
            raise ServiceError('此请求已经处理且记录已删除，不能再次执行。', 'REQUEST_ALREADY_CONSUMED', 409)
        return turn, False
    require_enabled(config)
    validate_source(session)
    now = timezone.now()
    day = now.astimezone(SHANGHAI).date()
    if UsageLedger.objects.filter(owner=owner, status__in=ACTIVE).exists():
        raise ServiceError('你已有一条解读正在处理，请等待完成后再提问。', 'LLM_USER_BUSY', 409)
    today = UsageLedger.objects.filter(day=day)
    user_today = today.filter(owner=owner, scope=session.scope)
    if user_today.filter(status__in=(*ACTIVE, 'succeeded')).count() >= effective_limit(config):
        raise ServiceError(f'{SCOPE_NAMES[session.scope]}今日对话次数已用完，请明天再来。', 'LLM_DAILY_LIMIT', 429)
    if user_today.count() >= config.per_user_attempt_limit:
        raise ServiceError(f'{SCOPE_NAMES[session.scope]}今日提交次数已达到上限，请明天再试。', 'LLM_ATTEMPT_LIMIT', 429)
    if UsageLedger.objects.filter(status__in=ACTIVE).count() >= config.queue_limit:
        raise ServiceError('等待解读的请求较多，请稍后再试。', 'LLM_QUEUE_FULL', 429)
    if today.count() >= config.global_daily_attempt_limit:
        raise ServiceError('今日全站 AI 调用次数已达上限，请明天再试。', 'LLM_GLOBAL_LIMIT', 429)
    reservation = INPUT_TOKEN_RESERVATION + config.max_output_tokens
    settled = today.exclude(status__in=ACTIVE).aggregate(total=Sum('accounted_tokens'))['total'] or 0
    reserved = today.filter(status__in=ACTIVE).aggregate(total=Sum('reserved_tokens'))['total'] or 0
    if settled + reserved + reservation > config.global_daily_token_limit:
        raise ServiceError('今日全站 AI 用量预算已达上限，请明天再试。', 'LLM_BUDGET_LIMIT', 429)
    entry = UsageLedger.objects.create(owner=owner, session=session, scope=session.scope, request_id=data['request_id'], fingerprint=digest,
        day=day, reserved_tokens=reservation, max_output_tokens=config.max_output_tokens, timeout_seconds=config.timeout_seconds)
    turn = LLMTurn.objects.create(session=session, ledger=entry, question=data['question'])
    audit('llm.queued', owner, turn.pk)
    return turn, True


@transaction.atomic
def delete_session(owner, session_id):
    lock_owner(owner)
    get_config(locked=True)
    session = get_object_or_404(LLMSession, pk=session_id, owner=owner)
    session.delete()
    audit('llm.session_deleted', owner, session_id)


@transaction.atomic
def cleanup_expired(now=None, dry_run=False):
    now = now or timezone.now()
    if not dry_run:
        get_config(locked=True)
    sessions = LLMSession.objects.filter(Q(expires_at__lte=now) | Q(recognition_job__expires_at__lte=now) | Q(assessment_job__expires_at__lte=now) | ~visible_sources_filter())
    # Keep a minimum of thirty full calendar days, including today's accounting.
    cutoff = now.astimezone(SHANGHAI).date() - timedelta(days=max(30, getattr(settings, 'LLM_RETENTION_DAYS', 30)))
    entries = UsageLedger.objects.exclude(status__in=ACTIVE).filter(day__lt=cutoff, turn__isnull=True)
    counts = {'sessions': sessions.count(), 'ledger_rows': entries.count()}
    if not dry_run:
        recover_locked(now)
        sessions.delete()
        entries.delete()
    return counts
