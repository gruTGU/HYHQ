from django.urls import path
from .views import CommentDetail, CommentsView, MyCommentsView, ReportsView, StatusView

urlpatterns = [
    path('community/status/', StatusView.as_view()),
    path('community/comments/', CommentsView.as_view()),
    path('community/comments/mine/', MyCommentsView.as_view()),
    path('community/comments/<uuid:pk>/', CommentDetail.as_view()),
    path('community/reports/', ReportsView.as_view()),
]
