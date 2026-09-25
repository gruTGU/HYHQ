import re

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from ecology.models import ValidatedModel
from .storage import private_storage

MAX_AUDIO_BYTES = 8 * 1024 * 1024


class Narration(ValidatedModel):
    content = models.ForeignKey('knowledge.Content', null=True, blank=True, on_delete=models.CASCADE, related_name='narrations')
    route = models.ForeignKey('knowledge.Route', null=True, blank=True, on_delete=models.CASCADE, related_name='narrations')
    title = models.CharField(max_length=180)
    audio = models.FileField(storage=private_storage, upload_to='audio/', max_length=100)
    mime_type = models.CharField(max_length=32)
    byte_size = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    source_revision = models.CharField(max_length=64)
    rights_note = models.CharField(max_length=500)
    copyright_confirmed = models.BooleanField(default=False)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='reviewed_narrations')
    reviewed_at = models.DateTimeField(null=True)
    status = models.CharField(max_length=16, choices=[('draft', '待发布'), ('published', '已发布'), ('withdrawn', '已撤下')], default='draft')

    class Meta:
        ordering = ['-created_at']
        verbose_name = '授权语音讲解'
        verbose_name_plural = verbose_name
        permissions = [('publish_narration', '可审核发布授权语音讲解')]
        constraints = [
            models.CheckConstraint(condition=(models.Q(content__isnull=False, route__isnull=True) | models.Q(content__isnull=True, route__isnull=False)), name='narration_exactly_one_source'),
            models.UniqueConstraint(fields=['content'], condition=models.Q(status='published'), name='narration_one_published_content'),
            models.UniqueConstraint(fields=['route'], condition=models.Q(status='published'), name='narration_one_published_route'),
        ]

    def __str__(self):
        return self.title

    def clean(self):
        if bool(self.content_id) == bool(self.route_id):
            raise ValidationError('语音须且只能关联一篇文章或一条路线。')
        if not self.audio.name or not re.fullmatch(r'audio/[0-9a-f]{32}\.(mp3|m4a|wav)', self.audio.name):
            raise ValidationError({'audio': '请通过受控导入命令提供音频，不接受自定义路径。'})
        if not 0 < self.byte_size <= MAX_AUDIO_BYTES or self.mime_type not in {'audio/mpeg', 'audio/mp4', 'audio/wav'}:
            raise ValidationError('音频格式或大小无效。')
        if any(not re.fullmatch('[0-9a-f]{64}', value or '') for value in [self.sha256, self.source_revision]):
            raise ValidationError('音频校验值或正文版本无效。')
        if self.status == 'published' and not (self.copyright_confirmed and self.rights_note.strip() and self.reviewed_by_id and self.reviewed_at):
            raise ValidationError('发布前须完成内容审核及版权授权确认。')
        old = type(self).objects.filter(pk=self.pk).first() if self.pk else None
        if old:
            immutable = ('content_id', 'route_id', 'audio', 'mime_type', 'byte_size', 'sha256', 'source_revision',
                         'rights_note', 'copyright_confirmed', 'reviewed_by_id', 'reviewed_at', 'title')
            if any(getattr(old, key) != getattr(self, key) for key in immutable):
                raise ValidationError('已导入语音的内容与审核记录不可覆盖，请导入新版本。')
