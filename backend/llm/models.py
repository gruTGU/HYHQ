"""Private conversation data and a separate, content-free accounting ledger."""
import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


SCOPES = [('recognition', 'AI 识别'), ('explore', '生态导览'), ('learn', '科普智游')]
PUBLIC_SOURCE_FIELDS = ('region', 'place', 'water_body', 'content', 'route')
ALL_SOURCE_FIELDS = ('recognition_job', 'assessment_job', *PUBLIC_SOURCE_FIELDS)


def source_constraint():
    conditions = models.Q()
    for field in ALL_SOURCE_FIELDS:
        selected = {name + '__isnull': name != field for name in ALL_SOURCE_FIELDS}
        if field in {'recognition_job', 'assessment_job'}:
            conditions |= models.Q(**selected, scope='recognition', kind=field.removesuffix('_job'))
        else:
            scopes = ['explore', 'learn'] if field == 'region' else (['explore'] if field in {'place', 'water_body'} else ['learn'])
            for scope in scopes:
                conditions |= models.Q(**selected, scope=scope, kind=scope)
    return conditions


def bounded(default, low, high, **kwargs):
    return models.PositiveIntegerField(default=default, validators=[MinValueValidator(low), MaxValueValidator(high)], **kwargs)


class GatewayConfig(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    enabled = models.BooleanField(default=False, verbose_name='允许外部 AI 解读')
    daily_turn_limit = bounded(5, 1, 5, verbose_name='每用户每板块每日成功回合上限')
    per_user_attempt_limit = bounded(10, 1, 10, verbose_name='每用户每板块每日提交上限')
    global_daily_attempt_limit = bounded(200, 1, 10000, verbose_name='全站每日提交上限')
    global_daily_token_limit = bounded(1000000, 1024, 100000000, verbose_name='全站每日 token 预算')
    max_output_tokens = bounded(600, 64, 2048, verbose_name='单次最大输出 token')
    timeout_seconds = bounded(45, 5, 120, verbose_name='单次硬超时秒数')
    queue_limit = bounded(20, 1, 20, verbose_name='全站待处理任务上限')
    max_concurrency = bounded(2, 1, 2, verbose_name='全站并发上限')
    updated_at = models.DateTimeField(auto_now=True)

    def clean(self):
        if self.pk != 1:
            raise ValidationError('网关只能有一份配置。')

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return 'DeepSeek Flash 网关'

    class Meta:
        verbose_name = '网关配置'
        verbose_name_plural = verbose_name
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name='llm_single_config')]


class LLMSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='llm_sessions')
    recognition_job = models.ForeignKey('recognition.RecognitionJob', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    assessment_job = models.ForeignKey('assessments.AssessmentJob', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    scope = models.CharField(max_length=16, choices=SCOPES, default='recognition', db_index=True)
    region = models.ForeignKey('ecology.Region', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    place = models.ForeignKey('ecology.Place', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    water_body = models.ForeignKey('ecology.WaterBody', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    content = models.ForeignKey('knowledge.Content', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    route = models.ForeignKey('knowledge.Route', null=True, blank=True, on_delete=models.CASCADE, related_name='llm_sessions')
    kind = models.CharField(max_length=16, choices=[('recognition', '花卉解读'), ('assessment', '河道解读'), ('explore', '生态导览'), ('learn', '科普智游')])
    title = models.CharField(max_length=100)
    context_summary = models.TextField()
    consent_version = models.CharField(max_length=32, blank=True, default='')
    include_image = models.BooleanField(default=False)
    weather_location = models.SlugField(max_length=50, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ['-created_at', '-id']
        constraints = [models.CheckConstraint(condition=source_constraint(), name='llm_scoped_source')]
        verbose_name = '私人 AI 会话'
        verbose_name_plural = verbose_name


class UsageLedger(models.Model):
    """Never store prompts, responses, images, upstream identifiers or coordinates.

    SET_NULL preserves global accounting after account/source/session deletion. The
    original day is the admission day in Asia/Shanghai, even when work crosses 00:00.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='llm_usage')
    session = models.ForeignKey(LLMSession, null=True, blank=True, on_delete=models.SET_NULL, related_name='usage_entries')
    request_id = models.UUIDField()
    fingerprint = models.CharField(max_length=64)
    scope = models.CharField(max_length=16, choices=SCOPES, default='recognition', db_index=True)
    day = models.DateField(db_index=True)
    status = models.CharField(max_length=16, default='queued', db_index=True, choices=[(x, x) for x in ['queued', 'running', 'succeeded', 'failed']])
    reserved_tokens = models.PositiveIntegerField()
    accounted_tokens = models.PositiveIntegerField(default=0)
    usage = models.JSONField(default=dict, blank=True)
    usage_estimated = models.BooleanField(default=False)
    dispatched = models.BooleanField(default=False)
    error_code = models.CharField(max_length=80, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)
    used_image = models.BooleanField(default=False)
    max_output_tokens = models.PositiveIntegerField()
    timeout_seconds = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    lease_until = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at', '-id']
        constraints = [models.UniqueConstraint(fields=['owner', 'request_id'], name='llm_user_request_unique')]
        indexes = [models.Index(fields=['owner', 'scope', 'day', 'status'], name='llm_owner_scope_day_status')]
        verbose_name = 'AI 用量账目（不含对话内容）'
        verbose_name_plural = verbose_name


class LLMTurn(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(LLMSession, on_delete=models.CASCADE, related_name='turns')
    ledger = models.OneToOneField(UsageLedger, on_delete=models.PROTECT, related_name='turn')
    question = models.CharField(max_length=500)
    answer = models.TextField(blank=True)
    context_revision = models.CharField(max_length=64, blank=True, default='')
    citations = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=16, default='queued', choices=[(x, x) for x in ['queued', 'running', 'succeeded', 'failed']])
    error_code = models.CharField(max_length=80, blank=True)
    message = models.CharField(max_length=200, blank=True)
    used_image = models.BooleanField(default=False)
    model = models.CharField(max_length=32, default='deepseek-flash')
    usage = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at', '-id']
        verbose_name = '私人 AI 回合'
        verbose_name_plural = verbose_name
