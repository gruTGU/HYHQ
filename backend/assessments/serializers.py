import math

from rest_framework import serializers

from ecology.models import WaterBody
from .geo import public_stations
from .models import AssessmentJob
from .rules import LIMITATION, SCORE_NAME
from .summary import observation_summary


class CoordinateInput(serializers.Serializer):
    latitude = serializers.FloatField(required=False, allow_null=True, min_value=-90, max_value=90)
    longitude = serializers.FloatField(required=False, allow_null=True, min_value=-180, max_value=180)
    coordinate_system = serializers.ChoiceField(choices=['GCJ02', 'WGS84'], required=False)

    def validate(self, attrs):
        latitude, longitude = attrs.get('latitude'), attrs.get('longitude')
        if (latitude is None) != (longitude is None):
            raise serializers.ValidationError('经纬度必须成对提供。')
        if latitude is not None and not attrs.get('coordinate_system'):
            raise serializers.ValidationError({'coordinate_system': '提供定位时必须注明 GCJ02 或 WGS84 坐标系。'})
        if latitude is None and attrs.get('coordinate_system'):
            raise serializers.ValidationError('坐标系必须与经纬度一起提供。')
        if any(value is not None and not math.isfinite(value) for value in (latitude, longitude)):
            raise serializers.ValidationError('经纬度必须是有限数字。')
        return attrs


class JobInput(CoordinateInput):
    asset_id = serializers.UUIDField()
    water_body_id = serializers.UUIDField(required=False, allow_null=True)


class NearbyInput(CoordinateInput):
    latitude = serializers.FloatField(min_value=-90, max_value=90)
    longitude = serializers.FloatField(min_value=-180, max_value=180)
    coordinate_system = serializers.ChoiceField(choices=['GCJ02', 'WGS84'])


class WaterBodySerializer(serializers.ModelSerializer):
    name = serializers.CharField(source='place.name')
    kind = serializers.CharField(source='place.kind')
    region = serializers.UUIDField(source='place.region_id')
    region_name = serializers.CharField(source='place.region.name')
    is_demo = serializers.BooleanField(source='place.region.is_demo')

    class Meta:
        model = WaterBody
        fields = ('id', 'name', 'kind', 'region', 'region_name', 'is_demo', 'description')


class JobSerializer(serializers.ModelSerializer):
    asset_id = serializers.UUIDField(read_only=True, allow_null=True)
    water_body = serializers.SerializerMethodField()
    station = serializers.SerializerMethodField()
    score_name = serializers.SerializerMethodField()
    limitation = serializers.SerializerMethodField()
    model_name = serializers.SerializerMethodField()
    model = serializers.SerializerMethodField()
    observation_summary = serializers.SerializerMethodField()

    def get_observation_summary(self, obj):
        return observation_summary(obj)

    def get_water_body(self, obj):
        if obj.water_body_id and obj.water_body.place.is_published and obj.water_body.place.kind in {'river', 'lake'}:
            return {'id': str(obj.water_body_id), 'name': obj.water_body.place.name, 'kind': obj.water_body.place.kind}
        return None

    def get_station(self, obj):
        if obj.station_id and public_stations().filter(pk=obj.station_id).exists():
            return {'id': str(obj.station_id), 'name': obj.station.name}
        return None

    def get_score_name(self, obj):
        return SCORE_NAME

    def get_limitation(self, obj):
        return LIMITATION

    def get_model_name(self, obj):
        return obj.model_snapshot.get('name') or None

    def get_model(self, obj):
        snapshot = obj.model_snapshot
        return {key: snapshot.get(key) for key in ('name', 'version', 'scope', 'threshold')} if snapshot and not snapshot.get('invalid') else None

    class Meta:
        model = AssessmentJob
        fields = ('id', 'asset_id', 'status', 'detections', 'image_width', 'image_height', 'score', 'score_name', 'grade', 'causes', 'issues',
                  'decision', 'reason', 'limitation', 'error_code', 'message', 'model_version', 'model_name', 'model', 'rule_version', 'observation_summary',
                  'water_body', 'station', 'latitude', 'longitude', 'coordinate_system',
                  'created_at', 'started_at', 'finished_at', 'duration_ms', 'expires_at')
