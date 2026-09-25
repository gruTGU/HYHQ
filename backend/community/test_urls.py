"""Isolated URL configuration for the module's HTTP tests."""
from django.contrib import admin
from django.urls import include, path
urlpatterns = [path('admin/', admin.site.urls), path('api/v1/', include('community.urls')), path('api/v1/', include('accounts.urls'))]
