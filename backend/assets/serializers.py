from rest_framework import serializers
from common.urls import api_uri
from .models import Asset


class AssetSerializer(serializers.ModelSerializer):
    thumbnail_url = serializers.SerializerMethodField()

    class Meta:
        model = Asset
        fields = ('id', 'purpose', 'width', 'height', 'byte_size', 'thumbnail_url', 'created_at', 'original_expires_at', 'expires_at')

    def get_thumbnail_url(self, obj):
        return api_uri(self.context['request'], f'/api/v1/uploads/{obj.pk}/content/?variant=thumbnail')


class UploadInput(serializers.Serializer):
    file = serializers.FileField()
    purpose = serializers.ChoiceField(choices=['avatar', 'recognition'], default='recognition')
