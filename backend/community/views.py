from django.db import transaction
from django.db.models import Q
from rest_framework import generics
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from common.audit import audit
from .models import Comment, Report
from .serializers import CommentInput, CommentSerializer, ReportInput, ReportSerializer, TargetInput
from .services import create_comment, create_report, gate, owner_locked, require_enabled, target, visible_comments


class StatusView(APIView):
    permission_classes = [AllowAny]
    def get(self, request):
        enabled = gate()
        return Response({'enabled': enabled, 'reason': '' if enabled else '评论与举报暂未开放。', 'max_comment_length': 500})


class CommentsView(generics.ListCreateAPIView):
    serializer_class = CommentSerializer
    def get_permissions(self):
        return [AllowAny()] if self.request.method == 'GET' else super().get_permissions()

    def get_queryset(self):
        require_enabled()
        params = TargetInput(data=self.request.query_params)
        params.is_valid(raise_exception=True)
        kind, target_id = params.validated_data['kind'], params.validated_data['target_id']
        target(kind, target_id)
        query = visible_comments().filter(**{kind + '_id': target_id})
        visibility = Q(status='approved')
        if self.request.user.is_authenticated:
            visibility |= Q(owner=self.request.user)
        return query.filter(visibility)

    def create(self, request, *args, **kwargs):
        require_enabled()
        data = CommentInput(data=request.data)
        data.is_valid(raise_exception=True)
        row, created = create_comment(request.user, **data.validated_data)
        return Response(self.get_serializer(row).data, status=201 if created else 200)


class MyCommentsView(generics.ListAPIView):
    serializer_class = CommentSerializer
    def get_queryset(self):
        return visible_comments().filter(owner=self.request.user)


class CommentDetail(APIView):
    @transaction.atomic
    def delete(self, request, pk):
        owner = owner_locked(request.user)
        row = generics.get_object_or_404(Comment.objects.select_for_update(), pk=pk, owner=owner)
        audit('community.comment_deleted', owner, row.pk)
        row.delete()
        return Response(status=204)


class ReportsView(generics.ListCreateAPIView):
    serializer_class = ReportSerializer
    def get_queryset(self):
        return Report.objects.filter(owner=self.request.user)

    def create(self, request, *args, **kwargs):
        require_enabled()
        data = ReportInput(data=request.data)
        data.is_valid(raise_exception=True)
        row, created = create_report(request.user, **data.validated_data)
        return Response(self.get_serializer(row).data, status=201 if created else 200)
