from django.utils import timezone
from django.db import transaction
from django.db.models import Q
from rest_framework import serializers
from common.exceptions import ServiceError
from common.urls import api_uri
from .models import User


class UserSerializer(serializers.ModelSerializer):
    avatar_url = serializers.SerializerMethodField()
    avatar_asset_id = serializers.UUIDField(write_only=True, required=False, allow_null=True)

    class Meta:
        model = User
        fields = ('id', 'nickname', 'avatar_url', 'avatar_asset_id', 'record_history', 'auth_kind')
        read_only_fields = ('id', 'auth_kind')

    def get_avatar_url(self, obj):
        if obj.avatar_id and (obj.avatar.expires_at is None or obj.avatar.expires_at > timezone.now()):
            return api_uri(self.context['request'], f'/api/v1/uploads/{obj.avatar_id}/content/?variant=thumbnail')
        return None

    def validate_avatar_asset_id(self, value):
        if value is None:
            return value
        from assets.models import Asset
        asset = Asset.objects.filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()), pk=value, owner=self.instance, purpose='avatar').first()
        if not asset:
            raise serializers.ValidationError('头像文件不存在或已过期')
        return asset

    def update(self, instance, validated_data):
        with transaction.atomic():
            # Authentication may have loaded an older snapshot before another PATCH.
            # Lock and refresh before changing privacy/profile/avatar fields.
            try:
                instance = User.objects.select_for_update().get(pk=instance.pk, is_active=True)
            except User.DoesNotExist:
                raise ServiceError('登录已过期，请重新登录', 'AUTH_REQUIRED', 401) from None
            old_avatar = instance.avatar
            changing_avatar = 'avatar_asset_id' in validated_data
            if changing_avatar:
                validated_data['avatar'] = validated_data.pop('avatar_asset_id')
                if validated_data['avatar']:
                    validated_data['avatar'].expires_at = None
                    validated_data['avatar'].save(update_fields=['expires_at'])
            result = super().update(instance, validated_data)
            if changing_avatar and old_avatar and old_avatar.pk != instance.avatar_id:
                old_avatar.delete()
            return result
