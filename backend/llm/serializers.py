from rest_framework import serializers
from .models import LLMSession, LLMTurn
from .services import image_available
from .sources import ALLOWED_SOURCES, SCOPE_NAMES, public_source, reference


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if isinstance(data, dict):
            unknown = set(data) - set(self.fields)
            if unknown:
                raise serializers.ValidationError({'non_field_errors': ['不接受客户端提供的额外上下文、提示词或身份字段。']})
        return super().to_internal_value(data)


class ScopeInput(serializers.Serializer):
    scope = serializers.ChoiceField(choices=list(SCOPE_NAMES), default='recognition')


class SessionInput(StrictInput):
    scope = serializers.ChoiceField(choices=list(SCOPE_NAMES), default='recognition')
    recognition_job_id = serializers.UUIDField(required=False)
    assessment_job_id = serializers.UUIDField(required=False)
    source_type = serializers.ChoiceField(choices=['region', 'place', 'water', 'content', 'route'], required=False)
    source_id = serializers.UUIDField(required=False)
    # Kept only for older clients. Registration now explains the external service.
    consent_version = serializers.CharField(max_length=32, allow_blank=True, required=False)
    include_image = serializers.BooleanField(default=False)
    weather_location = serializers.SlugField(max_length=50, allow_blank=True, required=False, default='')

    def validate(self, attrs):
        if attrs['scope'] == 'recognition':
            if attrs['weather_location']:
                raise serializers.ValidationError('识别解读不附加天气；请从生态导览或科普智游选择天气地点。')
            if ('recognition_job_id' in attrs) == ('assessment_job_id' in attrs):
                raise serializers.ValidationError('请选择且仅选择一条本人的花卉识别或河道观察记录。')
            if 'source_type' in attrs or 'source_id' in attrs:
                raise serializers.ValidationError('AI 识别会话只能关联本人的识别记录。')
        else:
            if 'recognition_job_id' in attrs or 'assessment_job_id' in attrs:
                raise serializers.ValidationError('导览与科普会话不能绑定私人识别记录。')
            if attrs.get('source_type') not in ALLOWED_SOURCES[attrs['scope']] or 'source_id' not in attrs:
                raise serializers.ValidationError('请提供此板块支持的公开资料类型与 ID。')
            if attrs['include_image']:
                raise serializers.ValidationError('此板块仅解读公开页面资料，请从 AI 识别页面选择附图。')
        return attrs


class SessionSerializer(serializers.ModelSerializer):
    image_available = serializers.SerializerMethodField()
    recognition_job_id = serializers.UUIDField(read_only=True, allow_null=True)
    assessment_job_id = serializers.UUIDField(read_only=True, allow_null=True)
    source_type = serializers.SerializerMethodField()
    source_id = serializers.SerializerMethodField()
    source_region_id = serializers.SerializerMethodField()
    weather_context = serializers.SerializerMethodField()

    def get_weather_context(self, obj):
        if obj.scope == 'recognition':
            return None
        from .public_context import bounded_weather_context
        if not hasattr(self, '_weather_summaries'):
            self._weather_summaries = {}
        if obj.weather_location not in self._weather_summaries:
            weather = bounded_weather_context(obj.weather_location)
            self._weather_summaries[obj.weather_location] = {
                'status': weather['status'], 'location': weather.get('location'), 'reason': weather.get('reason', ''),
                'cache_only': True, 'components': {
                    kind: {key: value.get(key) for key in ('status', 'reason', 'observed_at', 'fetched_at', 'expires_at')}
                    for kind, value in weather.get('components', {}).items()
                },
            }
        return self._weather_summaries[obj.weather_location]

    def get_image_available(self, obj):
        return image_available(obj)

    def get_source_type(self, obj):
        return reference(obj)[0]

    def get_source_id(self, obj):
        source_id = reference(obj)[1]
        return str(source_id) if source_id else None

    def get_source_region_id(self, obj):
        if obj.scope == 'recognition':
            return None
        source = public_source(obj)
        if source is None:
            return None
        source_type = reference(obj)[0]
        if source_type == 'region':
            return str(source.pk)
        if source_type in {'place', 'route'}:
            return str(source.region_id)
        if source_type == 'water':
            return str(source.place.region_id)
        if source_type == 'content' and source.place_id and source.place.is_published:
            return str(source.place.region_id)
        return None

    class Meta:
        model = LLMSession
        fields = ('id', 'kind', 'scope', 'title', 'context_summary', 'include_image', 'image_available',
                  'recognition_job_id', 'assessment_job_id', 'source_type', 'source_id', 'source_region_id',
                  'created_at', 'expires_at', 'weather_location', 'weather_context')


class TurnInput(StrictInput):
    request_id = serializers.UUIDField()
    question = serializers.CharField(max_length=500, allow_blank=False, trim_whitespace=True)


class TurnSerializer(serializers.ModelSerializer):
    session_id = serializers.UUIDField(read_only=True)
    citations = serializers.SerializerMethodField()

    def get_citations(self, obj):
        from .citations import visible_citations
        return visible_citations(obj.citations) if obj.status == 'succeeded' else []

    class Meta:
        model = LLMTurn
        fields = ('id', 'session_id', 'question', 'answer', 'status', 'error_code', 'message', 'created_at',
                  'finished_at', 'used_image', 'model', 'usage', 'citations')
