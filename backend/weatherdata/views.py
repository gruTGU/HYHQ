from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import WeatherLocation, WeatherReminder
from .provider import configured
from .services import get_component, location_data, summary
from .configuration import forecast_enabled, public_subscription_config
from .subscriptions import cancel_reminder, consent_reminder, prepare_reminder, public_reminder


class LocationList(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        if request.query_params:
            raise ValidationError('地点列表不接受额外参数。')
        return Response({'items': [location_data(item) for item in WeatherLocation.objects.filter(is_active=True)],
                         'enabled': configured(), 'forecast_enabled': forecast_enabled()})


class WeatherSummary(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        if set(request.query_params) != {'location'} or len(request.query_params.getlist('location')) != 1:
            raise ValidationError('仅允许提供一个管理员已配置的 location。')
        location = WeatherLocation.objects.filter(slug=request.query_params['location'], is_active=True).first()
        if location is None:
            raise NotFound('天气查询地点不存在。')
        return Response(summary(location))


class WeatherForecast(APIView):
    permission_classes = [AllowAny]

    def get(self, request, slug):
        if request.query_params:
            raise ValidationError('预报不接受额外参数。')
        location = WeatherLocation.objects.filter(slug=slug, is_active=True).first()
        if location is None:
            raise NotFound('天气查询地点不存在。')
        return Response({'location': location_data(location), 'enabled': forecast_enabled(),
                         'forecast': get_component(location, 'forecast')})


class ReminderStatus(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        if request.query_params:
            raise ValidationError('提醒状态不接受额外参数。')
        items = []
        if request.user.is_authenticated:
            items = [public_reminder(row) for row in WeatherReminder.objects.filter(user=request.user)
                     .select_related('location')[:20]]
        return Response({**public_subscription_config(), 'items': items,
                         'wechat_login': bool(request.user.is_authenticated and request.user.auth_kind == 'wechat')})


class ReminderIntent(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not isinstance(request.data, dict) or set(request.data) != {'location'} or not isinstance(request.data['location'], str):
            raise ValidationError('请选择一个已配置的天气地点。')
        return Response(public_reminder(prepare_reminder(request.user, request.data['location'])), status=201)


class ReminderConsent(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, reminder_id):
        if not isinstance(request.data, dict) or set(request.data) != {'template_id', 'acceptance'}:
            raise ValidationError('提醒授权参数不正确。')
        return Response(public_reminder(consent_reminder(request.user, reminder_id,
                        request.data['template_id'], request.data['acceptance'])))


class ReminderCancel(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, reminder_id):
        if request.data:
            raise ValidationError('取消提醒不接受额外参数。')
        return Response(public_reminder(cancel_reminder(request.user, reminder_id)))
