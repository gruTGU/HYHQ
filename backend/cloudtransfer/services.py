import base64
import binascii
import hashlib
from datetime import timedelta

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import User
from assets.services import create_asset
from common.audit import audit
from common.exceptions import ServiceError
from .models import Chunk, DailyBudget, OwnerBudget, StagingState, Upload

CHUNK_SIZE = 196608
MAX_BYTES = 5 * 1024 * 1024


def owner_lock(owner):
    try:
        return User.objects.select_for_update().get(pk=owner.pk, is_active=True)
    except User.DoesNotExist:
        raise ServiceError('登录已过期，请重新登录', 'AUTH_REQUIRED', 401) from None


def upload_lock(owner, pk):
    item = get_object_or_404(Upload.objects.select_for_update(), pk=pk, owner=owner)
    if item.expires_at <= timezone.now():
        raise ServiceError('上传会话已过期，请重新选择图片', 'UPLOAD_EXPIRED', 410)
    return item


def description(item):
    return {'id': str(item.pk), 'chunk_size': CHUNK_SIZE, 'total_size': item.total_size,
            'offset': item.offset, 'status': item.status, 'expires_at': item.expires_at}


@transaction.atomic
def begin(owner, *, purpose, size, request_id):
    owner = owner_lock(owner)
    existing = Upload.objects.filter(owner=owner, request_id=request_id).first()
    if existing:
        if existing.purpose != purpose or existing.total_size != size:
            raise ServiceError('相同请求编号对应的文件信息不同', 'UPLOAD_CONFLICT', 409)
        return upload_lock(owner, existing.pk), False
    now, day = timezone.now(), timezone.localdate()
    # A stable lock also protects the staging cap across a midnight rollover.
    StagingState.objects.get_or_create(pk=1)
    StagingState.objects.select_for_update().get(pk=1)
    DailyBudget.objects.get_or_create(day=day)
    budget = DailyBudget.objects.select_for_update().get(day=day)
    personal, _ = OwnerBudget.objects.get_or_create(owner=owner, day=day)
    active = Upload.objects.filter(status='open')
    if active.filter(owner=owner).count() >= getattr(settings, 'CLOUD_UPLOAD_ACTIVE_PER_USER', 2):
        raise ServiceError('请先完成或取消已有图片上传', 'UPLOAD_ACTIVE_LIMIT', 429)
    reserved = active.aggregate(size=Sum('total_size'))['size'] or 0
    if reserved + size > getattr(settings, 'CLOUD_UPLOAD_STAGING_BYTES', 64 * 1024 * 1024):
        raise ServiceError('文件上传繁忙，请稍后再试', 'UPLOAD_STORAGE_LIMIT', 429)
    if (budget.reserved_bytes + size > getattr(settings, 'CLOUD_UPLOAD_DAILY_BYTES', 128 * 1024 * 1024)
            or budget.requests >= getattr(settings, 'CLOUD_UPLOAD_DAILY_REQUESTS', 1000)
            or personal.reserved_bytes + size > getattr(settings, 'CLOUD_UPLOAD_USER_DAILY_BYTES', 20 * 1024 * 1024)
            or personal.requests >= getattr(settings, 'CLOUD_UPLOAD_USER_DAILY_REQUESTS', 40)):
        raise ServiceError('今日图片上传次数或流量已达上限，请明日再试', 'UPLOAD_DAILY_LIMIT', 429)
    for row in (budget, personal):
        row.reserved_bytes += size
        row.requests += 1
        row.save(update_fields=['reserved_bytes', 'requests'])
    return Upload.objects.create(owner=owner, purpose=purpose, total_size=size, request_id=request_id,
                                 expires_at=now + timedelta(seconds=getattr(settings, 'CLOUD_UPLOAD_TTL_SECONDS', 3600))), True


def decode_chunk(value):
    if not isinstance(value, str) or not value or len(value) > ((CHUNK_SIZE + 2) // 3) * 4:
        raise ServiceError('图片分块大小无效', 'INVALID_CHUNK', 400)
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ServiceError('图片分块编码无效', 'INVALID_CHUNK', 400) from None
    if not data or len(data) > CHUNK_SIZE or base64.b64encode(data).decode('ascii') != value:
        raise ServiceError('图片分块编码无效', 'INVALID_CHUNK', 400)
    return data


@transaction.atomic
def put_chunk(owner, pk, index, encoded):
    data = decode_chunk(encoded)
    owner = owner_lock(owner)
    item = upload_lock(owner, pk)
    if item.status != 'open':
        raise ServiceError('上传已完成', 'UPLOAD_COMPLETE', 409)
    digest = hashlib.sha256(data).hexdigest()
    existing = Chunk.objects.filter(upload=item, index=index).first()
    if existing:
        if existing.sha256 != digest or bytes(existing.data) != data:
            raise ServiceError('重复分块内容不同，请重新上传', 'UPLOAD_CONFLICT', 409)
        return item
    if index * CHUNK_SIZE != item.offset:
        raise ServiceError('分块顺序不正确，请重新上传', 'CHUNK_ORDER', 409)
    expected = min(CHUNK_SIZE, item.total_size - item.offset)
    if len(data) != expected:
        raise ServiceError('分块长度与声明大小不符', 'INVALID_CHUNK', 400)
    Chunk.objects.create(upload=item, index=index, data=data, sha256=digest)
    item.offset += len(data)
    item.save(update_fields=['offset'])
    return item


def finish(owner, pk):
    asset = None
    try:
        with transaction.atomic():
            owner = owner_lock(owner)
            item = upload_lock(owner, pk)
            if item.status == 'complete':
                if not item.asset_id:
                    raise ServiceError('图片已删除，请重新选择图片', 'FILE_NOT_FOUND', 410)
                existing_asset = item.asset
                if existing_asset.expires_at is not None and existing_asset.expires_at <= timezone.now():
                    raise ServiceError('图片已过期', 'FILE_EXPIRED', 410)
                return existing_asset, False
            if item.offset != item.total_size:
                raise ServiceError('图片尚未上传完整', 'UPLOAD_INCOMPLETE', 409)
            chunks = list(item.chunks.order_by('index'))
            data = bytearray()
            for index, chunk in enumerate(chunks):
                part = bytes(chunk.data)
                if (chunk.index != index or hashlib.sha256(part).hexdigest() != chunk.sha256
                        or len(part) != min(CHUNK_SIZE, item.total_size - len(data))):
                    raise ServiceError('图片完整性校验未通过', 'UPLOAD_CORRUPTED', 409)
                data.extend(part)
            if len(data) != item.total_size:
                raise ServiceError('图片完整性校验未通过', 'UPLOAD_CORRUPTED', 409)
            asset = create_asset(owner, SimpleUploadedFile('cloud-upload', bytes(data)), item.purpose)
            item.asset = asset
            item.status = 'complete'
            item.expires_at = timezone.now() + timedelta(hours=24)
            item.save(update_fields=['asset', 'status', 'expires_at'])
            item.chunks.all().delete()
            audit('file.uploaded', owner, asset.pk, source='cloud-transfer')
            return asset, True
    except Exception:
        # File storage is not transactional. Remove newly created files if the
        # outer staging/audit transaction rolls back after create_asset succeeds.
        if asset is not None:
            for field in (asset.original, asset.thumbnail):
                if field.name:
                    field.storage.delete(field.name)
        raise


@transaction.atomic
def cancel(owner, pk):
    owner = owner_lock(owner)
    item = Upload.objects.select_for_update().filter(pk=pk, owner=owner).first()
    if item and item.status != 'complete':
        item.delete()
    # Idempotent deletion never deletes the completed business asset or refunds
    # admission budgets, even when its staging record has already expired.
