from rest_framework import serializers
from .models import Comment, Report
from .services import clean_text


class TargetInput(serializers.Serializer):
    kind = serializers.ChoiceField(choices=['content', 'route', 'place'])
    target_id = serializers.UUIDField()


class CommentInput(TargetInput):
    body = serializers.CharField(max_length=500, trim_whitespace=True)
    request_id = serializers.UUIDField()

    def validate_body(self, value):
        return clean_text(value)


class ReportInput(TargetInput):
    kind = serializers.ChoiceField(choices=['content', 'route', 'place', 'comment'])
    reason = serializers.ChoiceField(choices=Report.REASONS)
    detail = serializers.CharField(max_length=300, required=False, allow_blank=True, default='')
    request_id = serializers.UUIDField()

    def validate_detail(self, value):
        return clean_text(value, 300, required=False)


class CommentSerializer(serializers.ModelSerializer):
    is_owner = serializers.SerializerMethodField()
    author = serializers.SerializerMethodField()
    class Meta:
        model = Comment
        fields = ['id', 'body', 'status', 'created_at', 'is_owner', 'author']

    def get_is_owner(self, obj):
        return obj.owner_id == self.context['request'].user.pk

    def get_author(self, obj):
        # Nicknames and avatars are user supplied and not checked by this module.
        # Do not bypass the text/image moderation gate through profile fields.
        return '我' if self.get_is_owner(obj) else '生态同行者'


class ReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = Report
        fields = ['id', 'reason', 'detail', 'status', 'created_at']
