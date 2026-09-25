import uuid
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


def one_target(fields):
    result = Q(pk__isnull=True)
    for field in fields:
        branch = Q(**{field + '__isnull': False})
        for other in fields:
            if other != field:
                branch &= Q(**{other + '__isnull': True})
        result |= branch
    return result


class Configuration(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    enabled = models.BooleanField('管理员启用', default=False)
    personal_eligibility_confirmed = models.BooleanField('已核实个人主体当前业务范围支持公开评论', default=False)
    eligibility_evidence = models.CharField('平台核实记录或工单依据（不填密钥）', max_length=300, blank=True)
    eligibility_confirmed_on = models.DateField('资格核实日期', null=True, blank=True)
    moderation_ready = models.BooleanField('人工审核流程及值守已就绪', default=False)
    moderator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+', verbose_name='负责审核的管理员')
    safety_verified_at = models.DateTimeField('微信文本安全接口最近成功核验', null=True, blank=True, editable=False)
    safety_credential_digest = models.CharField(max_length=64, blank=True, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    def clean(self):
        if self.id != 1:
            raise ValidationError('评论服务仅允许一份配置。')
        if self.personal_eligibility_confirmed and (not self.eligibility_evidence.strip() or not self.eligibility_confirmed_on):
            raise ValidationError('确认资格必须记录平台核实依据和日期；不能仅凭接口可调用作确认。')
        if self.moderation_ready and not self.moderator_id:
            raise ValidationError('请指定负责审核的管理员。')

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return '公开评论开放条件（默认关闭）'

    class Meta:
        verbose_name = '评论开放条件'
        verbose_name_plural = verbose_name
        constraints = [models.CheckConstraint(condition=Q(id=1), name='community_single_configuration')]


class Comment(models.Model):
    STATUS = [('pending', '待审核'), ('approved', '已通过'), ('rejected', '未通过')]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='community_comments')
    content = models.ForeignKey('knowledge.Content', null=True, blank=True, on_delete=models.CASCADE)
    route = models.ForeignKey('knowledge.Route', null=True, blank=True, on_delete=models.CASCADE)
    place = models.ForeignKey('ecology.Place', null=True, blank=True, on_delete=models.CASCADE)
    body = models.CharField(max_length=500)
    status = models.CharField(max_length=12, choices=STATUS, default='pending', db_index=True)
    safety_status = models.CharField(max_length=12, choices=[('pass', '微信检测通过'), ('review', '微信建议复审'), ('risky', '微信检测未通过')], default='review')
    safety_trace_id = models.CharField(max_length=128, blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    reviewed_at = models.DateTimeField(null=True, blank=True)
    moderation_note = models.CharField('内部审核备注', max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    def __str__(self):
        return f'评论 {self.id}'

    def clean(self):
        if sum(bool(getattr(self, key + '_id')) for key in ('content', 'route', 'place')) != 1:
            raise ValidationError('评论必须对应一个文章、路线或地点。')
        if self.status == 'approved' and self.safety_status != 'pass':
            raise ValidationError('仅微信检测通过的评论可以人工审核通过。')

    class Meta:
        ordering = ['-created_at', '-id']
        verbose_name = '用户评论'
        verbose_name_plural = verbose_name
        constraints = [models.CheckConstraint(condition=one_target(('content', 'route', 'place')), name='community_comment_one_target'),
                       models.CheckConstraint(condition=~Q(status='approved') | Q(safety_status='pass'), name='community_approved_safety_pass')]


class Report(models.Model):
    REASONS = [('spam', '广告或无关信息'), ('abuse', '辱骂或不当内容'), ('privacy', '泄露隐私'), ('inaccurate', '内容存在错误'), ('other', '其他问题')]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='community_reports')
    content = models.ForeignKey('knowledge.Content', null=True, blank=True, on_delete=models.CASCADE)
    route = models.ForeignKey('knowledge.Route', null=True, blank=True, on_delete=models.CASCADE)
    place = models.ForeignKey('ecology.Place', null=True, blank=True, on_delete=models.CASCADE)
    comment = models.ForeignKey(Comment, null=True, blank=True, on_delete=models.CASCADE)
    reason = models.CharField(max_length=16, choices=REASONS)
    detail = models.CharField(max_length=300, blank=True)
    status = models.CharField(max_length=12, choices=[('pending', '待处理'), ('resolved', '已处理'), ('dismissed', '不予受理')], default='pending', db_index=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    reviewed_at = models.DateTimeField(null=True, blank=True)
    moderation_note = models.CharField('内部处理备注', max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'举报 {self.id}'

    class Meta:
        ordering = ['-created_at', '-id']
        verbose_name = '用户举报'
        verbose_name_plural = verbose_name
        constraints = [models.CheckConstraint(condition=one_target(('content', 'route', 'place', 'comment')), name='community_report_one_target')] + [
            models.UniqueConstraint(fields=['owner', field], condition=Q(**{field + '__isnull': False}), name='community_report_unique_' + field)
            for field in ('content', 'route', 'place', 'comment')]


class SubmissionAttempt(models.Model):
    """Contains no text. Retains quota when a comment/report is deleted."""
    id = models.BigAutoField(primary_key=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    kind = models.CharField(max_length=10, choices=[('comment', '评论'), ('report', '举报')])
    request_id = models.UUIDField()
    state = models.CharField(max_length=12, default='processing')
    result_id = models.UUIDField(null=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner', 'kind', 'request_id'], name='community_idempotent_attempt')]


class SafetyDay(models.Model):
    """Anonymous aggregate survives account/record deletion; contains no user IDs."""
    day = models.DateField(primary_key=True)
    calls = models.PositiveIntegerField(default=0)
