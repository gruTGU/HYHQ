import base64
import re
from urllib.parse import parse_qsl, urlsplit

from django.conf import settings
from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import NotAuthenticated
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from assets.serializers import AssetSerializer
from assets.views import AssetContent
from common.exceptions import ServiceError
from narration.views import NarrationAudio
from . import services

UUID_PATTERN = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
ASSET_PATH = re.compile(r'/api/v1/uploads/(' + UUID_PATTERN + r')/content/')
AUDIO_PATH = re.compile(r'/api/v1/narrations/(' + UUID_PATTERN + r')/audio/')


class CloudView(APIView):
    parser_classes = [JSONParser]

    def initial(self, request, *args, **kwargs):
        if not getattr(settings, 'CLOUD_TRANSFER_ENABLED', False):
            raise ServiceError('云文件通道未启用', 'CLOUD_TRANSFER_DISABLED', 404)
        return super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class BeginInput(serializers.Serializer):
    purpose = serializers.ChoiceField(choices=['avatar', 'recognition'])
    size = serializers.IntegerField(min_value=1, max_value=services.MAX_BYTES)
    request_id = serializers.UUIDField()


class UploadStart(CloudView):
    def post(self, request):
        serializer = BeginInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        item, created = services.begin(request.user, **serializer.validated_data)
        return Response(services.description(item), status=201 if created else 200)


class UploadChunk(CloudView):
    def put(self, request, pk, index):
        if not isinstance(request.data, dict) or set(request.data) != {'data_base64'}:
            raise ServiceError('须提供一个图片分块', 'INVALID_CHUNK', 400)
        item = services.put_chunk(request.user, pk, int(index), request.data['data_base64'])
        return Response(services.description(item))


class UploadComplete(CloudView):
    def post(self, request, pk):
        asset, created = services.finish(request.user, pk)
        return Response(AssetSerializer(asset, context={'request': request}).data, status=201 if created else 200)


class UploadCancel(CloudView):
    def delete(self, request, pk):
        services.cancel(request.user, pk)
        return Response(status=204)


def parse_download(params):
    if set(params) - {'path', 'offset'} or any(len(params.getlist(key)) != 1 for key in params):
        raise ServiceError('下载参数无效', 'INVALID_DOWNLOAD_PATH', 400)
    path, offset = params.get('path', ''), params.get('offset', '0')
    if len(path) > 240 or re.search(r'[\x00-\x20\\]', path) or not re.fullmatch(r'(0|[1-9][0-9]{0,8})', offset):
        raise ServiceError('下载参数无效', 'INVALID_DOWNLOAD_PATH', 400)
    try:
        parsed = urlsplit(path)
    except ValueError:
        raise ServiceError('下载路径无效', 'INVALID_DOWNLOAD_PATH', 400) from None
    if parsed.scheme or parsed.netloc or parsed.fragment or not path.startswith('/api/v1/'):
        raise ServiceError('仅支持受控文件下载', 'INVALID_DOWNLOAD_PATH', 400)
    match = ASSET_PATH.fullmatch(parsed.path)
    if match:
        pairs = parse_qsl(parsed.query, keep_blank_values=True)
        if pairs not in ([], [('variant', 'thumbnail')], [('variant', 'original')]):
            raise ServiceError('图片版本无效', 'INVALID_DOWNLOAD_PATH', 400)
        return 'asset', match[1], pairs[0][1] if pairs else 'thumbnail', int(offset)
    match = AUDIO_PATH.fullmatch(parsed.path)
    if match and not parsed.query:
        return 'audio', match[1], None, int(offset)
    raise ServiceError('仅支持受控文件下载', 'INVALID_DOWNLOAD_PATH', 400)


class Download(CloudView):
    # Public narration remains public; private images perform mandatory auth
    # and fresh owner locking below. No client-supplied cloud identity is trusted.
    permission_classes = [AllowAny]

    def perform_authentication(self, request):
        if parse_download(request.query_params)[0] == 'audio':
            # Existing public narration intentionally ignores stale credentials.
            request.authenticators = []
        return super().perform_authentication(request)

    def get(self, request):
        kind, pk, variant, offset = parse_download(request.query_params)
        with transaction.atomic():
            if kind == 'asset':
                if not request.user.is_authenticated:
                    raise NotAuthenticated()
                services.owner_lock(request.user)
                # Reuse the original ownership, retention and missing-file checks.
                # Only the allowlisted variant is handed to the existing view.
                original_query = request._request.GET
                request._request.GET = original_query.copy()
                request._request.GET['variant'] = variant
                try:
                    response = AssetContent().get(request, pk)
                finally:
                    request._request.GET = original_query
                try:
                    stream = response.file_to_stream
                    stream.seek(0, 2)
                    total = stream.tell()
                    self.validate_offset(offset, total)
                    stream.seek(offset)
                    data = stream.read(services.CHUNK_SIZE)
                finally:
                    # This is an internal FileResponse, not the request's final
                    # response. Its close() sends request_finished and may close
                    # PostgreSQL while our owner transaction is still active.
                    response.file_to_stream.close()
                content_type, extension = 'image/jpeg', 'jpg'
            else:
                # NarrationAudio verifies publication, source revision, rights,
                # exact byte count and SHA-256 on every chunk request.
                # Do not let a caller's Range header change that full-file check.
                range_header = request.META.pop('HTTP_RANGE', None)
                cached_headers = request._request.__dict__.pop('headers', None)
                try:
                    response = NarrationAudio().get(request, pk)
                finally:
                    if range_header is not None:
                        request.META['HTTP_RANGE'] = range_header
                    request._request.__dict__.pop('headers', None)
                    if cached_headers is not None:
                        request._request.__dict__['headers'] = cached_headers
                total = len(response.content)
                self.validate_offset(offset, total)
                data = response.content[offset:offset + services.CHUNK_SIZE]
                content_type = response['Content-Type']
                extension = {'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav'}[content_type]
        next_offset = offset + len(data)
        return Response({'data_base64': base64.b64encode(data).decode('ascii'), 'offset': offset,
                         'next_offset': next_offset, 'total_size': total, 'complete': next_offset == total,
                         'content_type': content_type, 'extension': extension})

    @staticmethod
    def validate_offset(offset, total):
        if offset > total or (offset != total and offset % services.CHUNK_SIZE):
            raise ServiceError('下载分块位置无效', 'INVALID_OFFSET', 416)
