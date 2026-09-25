from django.contrib import admin
from django.urls import include, path
from common.views import health

admin.site.site_header = 'HYHQ 海晏河清管理平台'
admin.site.site_title = 'HYHQ 管理端'
admin.site.index_title = '内容、数据与运行管理'
urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v1/health/', health),
    path('api/v1/', include('accounts.urls')),
    path('api/v1/', include('ecology.urls')),
    path('api/v1/', include('knowledge.urls')),
    path('api/v1/', include('assets.urls')),
    path('api/v1/', include('recognition.urls')),
    path('api/v1/', include('activity.urls')),
    path('api/v1/', include('assessments.urls')),
    path('api/v1/', include('llm.urls')),
    path('api/v1/', include('community.urls')),
    path('api/v1/', include('narration.urls')),
    path('api/v1/weather-data/', include('weatherdata.urls')),
]
handler404 = 'common.views.not_found'
handler500 = 'common.views.server_error'
