from django.contrib import admin
from django import forms
from django.core.exceptions import PermissionDenied, ValidationError as DjangoValidationError
from rest_framework.exceptions import APIException
from django.db import transaction
from common.admin_audit import AuditAdminMixin
from .models import Comment, Configuration, Report
from .services import moderate, gate, target


@admin.register(Configuration)
class ConfigurationAdmin(AuditAdminMixin, admin.ModelAdmin):
    readonly_fields = ['safety_verified_at', 'updated_at']
    exclude = ['safety_credential_digest']
    def has_add_permission(self, request):
        return super().has_add_permission(request) and not Configuration.objects.exists()
    def has_delete_permission(self, request, obj=None):
        return False


class ModerationForm(forms.ModelForm):
    def clean(self):
        values = super().clean()
        if isinstance(self.instance, Comment) and values.get('status') == 'approved':
            if not gate():
                raise forms.ValidationError('公开评论的开放条件未满足，不能审核通过。')
            if self.instance.safety_status != 'pass':
                raise forms.ValidationError('微信检测未通过，不能审核通过。')
            kind = next((key for key in ('content', 'route', 'place') if getattr(self.instance, key + '_id')), None)
            try:
                if kind:
                    target(kind, getattr(self.instance, kind + '_id'))
            except APIException:
                raise forms.ValidationError('关联内容已下架，不能公开评论。') from None
        return values


class ModerationAdmin(AuditAdminMixin, admin.ModelAdmin):
    form = ModerationForm
    list_display = ['id', 'status', 'created_at', 'reviewed_at', 'reviewed_by']
    list_filter = ['status']
    readonly_fields = ['id', 'owner', 'content', 'route', 'place', 'created_at', 'reviewed_at', 'reviewed_by']
    actions = None
    def has_add_permission(self, request):
        return False
    @transaction.atomic
    def save_model(self, request, obj, form, change):
        if not change or not self.has_change_permission(request, obj):
            raise PermissionDenied('没有审核权限。')
        try:
            result = moderate(request.user, self.model, obj.pk, obj.status, obj.moderation_note)
        except (APIException, self.model.DoesNotExist):
            raise PermissionDenied('记录或开放条件已变化，请刷新审核页面后再试。') from None
        obj.reviewed_at, obj.reviewed_by = result.reviewed_at, result.reviewed_by
        # Service emits its transactional audit. Avoid re-saving user-controlled
        # readonly fields, including a stale approval from a second browser tab.


@admin.register(Comment)
class CommentAdmin(ModerationAdmin):
    readonly_fields = ModerationAdmin.readonly_fields + ['body', 'safety_status', 'safety_trace_id']
    list_filter = ['status', 'safety_status']


@admin.register(Report)
class ReportAdmin(ModerationAdmin):
    readonly_fields = ModerationAdmin.readonly_fields + ['comment', 'reason', 'detail']
