from django.conf import settings
from django.db import connection
from django.http import JsonResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


@api_view(['GET'])
@permission_classes([AllowAny])
def health(request):
    with connection.cursor() as cursor:
        cursor.execute('SELECT 1')
    from recognition.registry import public_status
    from assessments.registry import public_status as assessment_status
    from llm.services import enabled as llm_enabled
    recognition = public_status()
    assessment = assessment_status()
    return Response({'status': 'ok', 'mode': settings.DATA_MODE, 'dev_auth_enabled': settings.ALLOW_DEV_AUTH,
                     'features': {'recognition': recognition['enabled'], 'assessment': assessment['enabled'], 'llm': llm_enabled()},
                     'recognition': recognition, 'assessment': assessment, 'version': 'm5'})


def not_found(request, exception=None):
    return JsonResponse({'error': {'code': 'NOT_FOUND', 'message': '接口不存在'}, 'request_id': getattr(request, 'request_id', None)}, status=404)


def server_error(request):
    return JsonResponse({'error': {'code': 'INTERNAL_ERROR', 'message': '服务暂不可用，请稍后重试'}, 'request_id': getattr(request, 'request_id', None)}, status=500)
