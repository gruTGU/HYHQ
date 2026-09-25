import hashlib
import re
import uuid

from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import MAX_AUDIO_BYTES, Narration
from .services import is_available


def queryset():
    return Narration.objects.select_related('content__place__region', 'route__region').filter(status='published')


class PublicNarration(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        params = request.query_params
        if set(params) not in ({'content'}, {'route'}):
            raise ValidationError('须提供且只提供一个文章或路线 ID。')
        kind = next(iter(params))
        try:
            if len(params.getlist(kind)) != 1:
                raise ValueError
            source_id = uuid.UUID(params[kind])
        except (ValueError, TypeError, AttributeError):
            raise ValidationError('资料 ID 无效。') from None
        item = queryset().filter(**{kind + '_id': source_id}).first()
        available = item is not None and is_available(item) and item.audio.storage.exists(item.audio.name)
        payload = {'id': str(item.pk), 'title': item.title, 'mime_type': item.mime_type,
                   'revision': item.source_revision, 'audio_path': f'/api/v1/narrations/{item.pk}/audio/'} if available else None
        response = Response(payload)
        response['Cache-Control'] = 'no-store'
        return response


class NarrationAudio(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, pk):
        item = get_object_or_404(queryset(), pk=pk)
        if not is_available(item) or not re.fullmatch(r'audio/[0-9a-f]{32}\.(mp3|m4a|wav)', item.audio.name):
            raise NotFound('语音已撤下或对应内容已更新。')
        try:
            with item.audio.open('rb') as stream:
                data = stream.read(MAX_AUDIO_BYTES + 1)
        except (OSError, ValueError):
            raise NotFound('语音暂不可用。') from None
        if len(data) != item.byte_size or len(data) > MAX_AUDIO_BYTES or hashlib.sha256(data).hexdigest() != item.sha256:
            raise NotFound('语音文件校验未通过。')
        start, end, status = 0, len(data) - 1, 200
        range_header = request.headers.get('Range')
        if range_header:
            match = re.fullmatch(r'bytes=([0-9]{0,20})-([0-9]{0,20})', range_header)
            valid = match and any(match.groups())
            if valid:
                first, last = match.groups()
                if first:
                    start, end = int(first), min(int(last), end) if last else end
                else:
                    start = max(0, len(data) - int(last))
                valid = 0 <= start <= end < len(data)
            if not valid:
                response = HttpResponse(status=416)
                response['Content-Range'] = f'bytes */{len(data)}'
                response['Cache-Control'] = 'no-store'
                return response
            status = 206
        response = HttpResponse(data[start:end + 1], status=status, content_type=item.mime_type)
        response['Content-Length'] = str(end - start + 1)
        response['Accept-Ranges'] = 'bytes'
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Content-Disposition'] = 'inline; filename="narration.' + item.audio.name.rsplit('.', 1)[-1] + '"'
        if status == 206:
            response['Content-Range'] = f'bytes {start}-{end}/{len(data)}'
        return response
