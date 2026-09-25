from django.contrib import admin
from django.db import transaction

from common.admin_audit import AuditAdminMixin
from common.audit import audit_admin
from .models import Narration


@admin.register(Narration)
class NarrationAdmin(AuditAdminMixin, admin.ModelAdmin):
    list_display = ['title', 'status', 'mime_type', 'byte_size', 'reviewed_by', 'reviewed_at']
    list_filter = ['status', 'mime_type']
    search_fields = ['title']
    # Files can only enter through the validated command, never via a raw FileField URL.
    exclude = ['audio']
    readonly_fields = [field.name for field in Narration._meta.fields if field.name != 'audio']
    actions = ['withdraw_selected']

    def has_add_permission(self, request):
        return False

    @admin.action(description='撤下选中的语音讲解', permissions=['change'])
    @transaction.atomic
    def withdraw_selected(self, request, queryset):
        for item in queryset.select_for_update().filter(status='published'):
            item.status = 'withdrawn'
            item.save(update_fields=['status', 'updated_at'])
            audit_admin('narration.withdrawn', request.user, item, action='withdraw', changed_fields=['status'])
