import hashlib
import uuid

from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from common.audit import audit_admin
from .formats import validate_audio
from .models import Narration
from .revision import source_is_public, source_revision
from .storage import private_storage


def import_narration(*, source, filename, data, reviewer, rights_note, reviewed=False, copyright_confirmed=False, publish=False):
    if not (reviewer.is_active and reviewer.is_staff and reviewer.has_perm('narration.add_narration')
            and reviewer.has_perm('narration.publish_narration')):
        raise PermissionDenied('审核人须为有语音新增和审核发布权限的在职管理员。')
    if not reviewed or not copyright_confirmed or not rights_note.strip():
        raise ValidationError('必须明确确认内容审核、版权授权，并填写授权说明。')
    extension, mime = validate_audio(data, filename)
    stored_name = ''
    try:
        with transaction.atomic():
            source = type(source).objects.select_for_update().get(pk=source.pk)
            if not source_is_public(source):
                raise ValidationError('只可为已公开且关联地点仍公开的文章或路线导入语音。')
            field = 'content' if source._meta.model_name == 'content' else 'route'
            if publish:
                for old in Narration.objects.select_for_update().filter(**{field: source}, status='published'):
                    old.status = 'withdrawn'
                    old.save(update_fields=['status', 'updated_at'])
                    audit_admin('narration.withdrawn', reviewer, old, action='withdraw', changed_fields=['status'])
            stored_name = private_storage.save(f'audio/{uuid.uuid4().hex}.{extension}', ContentFile(data))
            item = Narration.objects.create(**{field: source}, title=source.title, audio=stored_name,
                mime_type=mime, byte_size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                source_revision=source_revision(source), rights_note=rights_note.strip(), copyright_confirmed=True,
                reviewed_by=reviewer, reviewed_at=timezone.now(), status='published' if publish else 'draft')
            audit_admin('narration.imported', reviewer, item, action='import', changed_fields=['audio', 'status', 'source_revision', 'copyright_confirmed'])
        return item
    except Exception:
        if stored_name:
            private_storage.delete(stored_name)
        raise


def is_available(item):
    if not (item.status == 'published' and item.copyright_confirmed and item.rights_note.strip()
            and item.reviewed_by_id and item.reviewed_at):
        return False
    source = item.content if item.content_id else item.route
    return source_is_public(source) and source_revision(source) == item.source_revision
