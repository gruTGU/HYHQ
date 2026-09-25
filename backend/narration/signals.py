from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import Narration


@receiver(post_delete, sender=Narration)
def remove_audio_after_commit(sender, instance, **kwargs):
    name, storage = instance.audio.name, instance.audio.storage
    if name:
        transaction.on_commit(lambda: storage.delete(name))
