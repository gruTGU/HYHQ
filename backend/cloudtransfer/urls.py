from django.urls import path, re_path
from .views import Download, UploadCancel, UploadChunk, UploadComplete, UploadStart

urlpatterns = [
    path('cloud-files/uploads/', UploadStart.as_view()),
    path('cloud-files/uploads/<uuid:pk>/', UploadCancel.as_view()),
    re_path(r'^cloud-files/uploads/(?P<pk>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/chunks/(?P<index>0|[1-9][0-9]{0,2})/$', UploadChunk.as_view()),
    path('cloud-files/uploads/<uuid:pk>/complete/', UploadComplete.as_view()),
    path('cloud-files/download/', Download.as_view()),
]
