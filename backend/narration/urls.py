from django.urls import path
from .views import NarrationAudio, PublicNarration

urlpatterns = [
    path('narrations/', PublicNarration.as_view(), name='narration-public'),
    path('narrations/<uuid:pk>/audio/', NarrationAudio.as_view(), name='narration-audio'),
]
