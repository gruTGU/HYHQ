from datetime import timedelta
import unicodedata
from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError
from accounts.models import User
from common.audit import audit, audit_admin
from common.exceptions import ServiceError
from ecology.models import Place
from knowledge.models import Content, Route
from . import safety
from .models import Comment, Configuration, Report, SubmissionAttempt, SafetyDay

TARGETS = {'content': (Content, {'status': 'published'}), 'route': (Route, {'published': True}), 'place': (Place, {'is_published': True})}


def gate(config=None):
    config = config or Configuration.objects.select_related('moderator').filter(pk=1).first()
    if not getattr(settings, 'COMMUNITY_ENABLED', False) or not config or not config.enabled:
        return False
    if not (config.personal_eligibility_confirmed and config.eligibility_evidence.strip() and config.eligibility_confirmed_on and config.eligibility_confirmed_on <= timezone.localdate()):
        return False
    moderator = config.moderator
    if not config.moderation_ready or not moderator or not moderator.is_active or not moderator.is_staff or not moderator.has_perms(['community.change_comment', 'community.change_report']):
        return False
    digest = safety.credential_digest()
    return bool(digest and config.safety_credential_digest == digest and config.safety_verified_at and timezone.now() - timedelta(days=7) <= config.safety_verified_at <= timezone.now())


def require_enabled(config=None):
    if not gate(config):
        raise ServiceError('评论与举报暂未开放。', 'COMMUNITY_DISABLED', 403)


def clean_text(text, maximum=500, required=True):
    if not isinstance(text, str):
        raise ValidationError('请填写文本内容。')
    text = unicodedata.normalize('NFC', text).strip()
    if (required and not text) or len(text) > maximum:
        raise ValidationError(f'请填写{1 if required else 0}至{maximum}字。')
    if any(unicodedata.category(char) in ('Cc', 'Cf', 'Cs') and char not in '\n\t' for char in text) or '<' in text or '>' in text:
        raise ValidationError('请使用普通文字，不包含标签或不可见控制字符。')
    return text


def visible_comments():
    return Comment.objects.filter(Q(content__status='published') | Q(route__published=True) | Q(place__is_published=True))


def target(kind, target_id, lock=False):
    if kind == 'comment':
        query = visible_comments().filter(status='approved')
    elif kind in TARGETS:
        model, conditions = TARGETS[kind]
        query = model.objects.filter(**conditions)
    else:
        raise ValidationError('请选择有效的内容类型。')
    if lock:
        query = query.select_for_update(of=('self',))
    result = query.filter(pk=target_id).first()
    if result is None:
        raise NotFound('内容不存在或已下架。')
    return result


def owner_locked(user):
    row = User.objects.select_for_update().filter(pk=user.pk, is_active=True).first()
    if row is None:
        raise ServiceError('登录已过期，请重新登录。', 'AUTH_REQUIRED', 401)
    return row


def _configuration_locked():
    return Configuration.objects.select_for_update().filter(pk=1).first()


def _reserve(user, kind, request_id):
    old = SubmissionAttempt.objects.filter(owner=user, kind=kind, request_id=request_id).first()
    if old:
        model = Comment if kind == 'comment' else Report
        row = model.objects.filter(pk=old.result_id, owner=user).first() if old.state == 'completed' else None
        if row:
            return None, row
        if old.state == 'failed':
            raise ServiceError('上次提交未完成，请重新提交。', 'SUBMISSION_FAILED', 409)
        raise ServiceError('该次提交已处理或仍在处理，请刷新记录核对。修改内容后可重新提交。', 'SUBMISSION_ALREADY_RECEIVED', 409)
    today = timezone.localdate()
    attempts = SubmissionAttempt.objects.filter(owner=user, kind=kind)
    if attempts.filter(created_at__date=today).count() >= (10 if kind == 'comment' else 20) or attempts.filter(created_at__gte=timezone.now() - timedelta(seconds=60)).exists():
        raise ServiceError('操作较频繁，请稍后再试。', 'COMMUNITY_RATE_LIMITED', 429)
    # Reserve before the external request, including failed requests. A small
    # pre-release ceiling also protects WeChat's 100/day unpublished-app quota.
    if kind == 'comment':
        reserve_safety_call()
    return SubmissionAttempt.objects.create(owner=user, kind=kind, request_id=request_id), None


def reserve_safety_call():
    # Caller owns the Configuration row lock and transaction. This anonymous
    # counter cannot be reset by deleting a comment or unregistering an account.
    day, _ = SafetyDay.objects.select_for_update().get_or_create(day=timezone.localdate())
    if day.calls >= 80:
        raise ServiceError('今日评论服务繁忙，请明天再试。', 'COMMUNITY_DAILY_LIMIT', 429)
    day.calls += 1
    day.save(update_fields=['calls'])


def create_comment(user, kind, target_id, body, request_id):
    body = clean_text(body)
    with transaction.atomic():
        config = _configuration_locked()
        require_enabled(config)
        owner = owner_locked(user)
        if owner.auth_kind != 'wechat' or not owner.wechat_openid:
            raise ServiceError('请使用微信账号登录后发表评论。', 'WECHAT_REQUIRED', 403)
        target(kind, target_id)
        attempt, existing = _reserve(owner, 'comment', request_id)
        if existing:
            if getattr(existing, kind + '_id') != target_id or existing.body != body:
                raise ServiceError('提交标识已使用，请刷新后重试。', 'IDEMPOTENCY_CONFLICT', 409)
            return existing, False
    try:
        checked = safety.check_text(owner, body)
        with transaction.atomic():
            config = _configuration_locked()
            require_enabled(config)
            owner = owner_locked(user)
            target(kind, target_id, lock=True)
            row = Comment.objects.create(owner=owner, **{kind + '_id': target_id}, body=body,
                safety_status=checked['suggest'], safety_trace_id=checked['trace_id'], status='pending' if checked['suggest'] == 'pass' else 'rejected')
            SubmissionAttempt.objects.filter(pk=attempt.pk, owner=owner).update(state='completed', result_id=row.pk)
            audit('community.comment_submitted', owner, row.pk, status=row.status, source='wechat')
            return row, True
    except Exception:
        SubmissionAttempt.objects.filter(pk=attempt.pk).update(state='failed')
        raise


@transaction.atomic
def create_report(user, kind, target_id, reason, detail, request_id):
    config = _configuration_locked()
    require_enabled(config)
    owner = owner_locked(user)
    target(kind, target_id, lock=True)
    existing = Report.objects.filter(owner=owner, **{kind + '_id': target_id}).first()
    if existing:
        return existing, False
    attempt, existing = _reserve(owner, 'report', request_id)
    if existing:
        if getattr(existing, kind + '_id') != target_id:
            raise ServiceError('提交标识已使用，请刷新后重试。', 'IDEMPOTENCY_CONFLICT', 409)
        return existing, False
    row = Report.objects.create(owner=owner, **{kind + '_id': target_id}, reason=reason, detail=clean_text(detail, 300, required=False))
    attempt.state, attempt.result_id = 'completed', row.pk
    attempt.save(update_fields=['state', 'result_id'])
    audit('community.report_submitted', owner, row.pk, status='pending')
    return row, True


@transaction.atomic
def moderate(actor, model, record_id, status, note=''):
    # This service is also the only admin write path for submitted text.
    actor = User.objects.select_for_update().filter(pk=actor.pk, is_active=True, is_staff=True).first()
    if actor is None or not actor.has_perm('community.change_' + model._meta.model_name):
        raise PermissionDenied('没有审核权限。')
    row = model.objects.select_for_update().get(pk=record_id)
    allowed = dict(model._meta.get_field('status').choices)
    if status not in allowed:
        raise ValidationError('无效的审核状态。')
    if model == Comment and status == 'approved':
        require_enabled()
        kind = next(key for key in TARGETS if getattr(row, key + '_id'))
        target(kind, getattr(row, kind + '_id'), lock=True)
        if row.safety_status != 'pass':
            raise ValidationError('微信检测未通过，不能公开此评论。')
    row.status = status
    row.moderation_note = clean_text(note, 300, required=False)
    row.reviewed_by = actor if status != 'pending' else None
    row.reviewed_at = timezone.now() if status != 'pending' else None
    row.save(update_fields=['status', 'moderation_note', 'reviewed_by', 'reviewed_at'])
    audit_admin('community.' + model._meta.model_name + '_moderated', actor, row, action='moderate', changed_fields=['status', 'moderation_note', 'reviewed_by', 'reviewed_at'], status=status)
    return row
