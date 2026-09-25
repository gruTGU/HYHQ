from django.contrib import admin, messages
from common.admin_audit import AuditAdminMixin
from common.audit import audit_admin

from .models import WeatherCache, WeatherLocation, WeatherMonth, WeatherRequest, WeatherReminder, WeatherReminderAttempt
from .services import get_component


class ImmutableAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(WeatherLocation)
class LocationAdmin(AuditAdminMixin, admin.ModelAdmin):
    list_display = ['name', 'slug', 'latitude', 'longitude', 'is_active']
    list_filter = ['is_active']
    search_fields = ['name', 'slug']
    actions = ['refresh_weather']

    @admin.action(description='按缓存策略更新选中地点（受月预算及冷却限制）', permissions=['change'])
    def refresh_weather(self, request, queryset):
        if queryset.count() > 5:
            self.message_user(request, '每次最多维护 5 个地点。', messages.ERROR)
            return
        outcomes = []
        for location in queryset.filter(is_active=True):
            for kind in ('weather', 'air', 'alerts'):
                result = get_component(location, kind)
                outcomes.append(result['status'])
        for location in queryset:
            self.log_change(request, location, '按缓存策略刷新天气；全部请求受持久预算限制。')
            audit_admin('weather.cache_checked', request.user, location, action='refresh', count=3)
        self.message_user(request, f'已检查 {len(outcomes)} 项缓存；不可用 {outcomes.count("unavailable")} 项。')


@admin.register(WeatherMonth)
class MonthAdmin(ImmutableAdmin):
    list_display = ['month', 'reserved', 'created_at']


@admin.register(WeatherRequest)
class RequestAdmin(ImmutableAdmin):
    list_display = ['reserved_at', 'location', 'kind', 'outcome', 'http_status', 'completed_at']
    list_filter = ['kind', 'outcome', 'month']
    search_fields = ['location__name', 'location__slug']
    date_hierarchy = 'reserved_at'


@admin.register(WeatherCache)
class CacheAdmin(ImmutableAdmin):
    list_display = ['location', 'kind', 'point', 'fetched_at', 'expires_at', 'last_reason']
    list_filter = ['kind', 'last_reason']


@admin.register(WeatherReminder)
class ReminderAdmin(ImmutableAdmin):
    list_display = ['id', 'location', 'target_date', 'scheduled_for', 'state', 'attempts', 'last_code']
    list_filter = ['state', 'location']
    exclude = ['template_id', 'config_fingerprint']


@admin.register(WeatherReminderAttempt)
class ReminderAttemptAdmin(ImmutableAdmin):
    list_display = ['reminder', 'number', 'started_at', 'completed_at', 'outcome']
    list_filter = ['outcome']
