"""Bounded, short-lived upload staging; never exposes filesystem paths."""
import uuid

from django.conf import settings
from django.db import models


class StagingState(models.Model):
    # A stable admission lock is independent of day rollover.
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)


class Upload(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    request_id = models.UUIDField()
    purpose = models.CharField(max_length=20)
    total_size = models.PositiveIntegerField()
    offset = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=12, default='open')
    asset = models.ForeignKey('assets.Asset', null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner', 'request_id'], name='cloud_upload_owner_request')]


class Chunk(models.Model):
    upload = models.ForeignKey(Upload, on_delete=models.CASCADE, related_name='chunks')
    index = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    data = models.BinaryField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['upload', 'index'], name='cloud_upload_chunk_index')]


class DailyBudget(models.Model):
    """Anonymous global reservation ledger: deletion/cancellation never refunds it."""
    day = models.DateField(primary_key=True)
    reserved_bytes = models.PositiveBigIntegerField(default=0)
    requests = models.PositiveIntegerField(default=0)


class OwnerBudget(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    day = models.DateField()
    reserved_bytes = models.PositiveBigIntegerField(default=0)
    requests = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner', 'day'], name='cloud_budget_owner_day')]
