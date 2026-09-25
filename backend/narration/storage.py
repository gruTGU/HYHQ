from pathlib import Path

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.files.storage import FileSystemStorage
from django.utils.deconstruct import deconstructible


@deconstructible
class PrivateNarrationStorage(FileSystemStorage):
    def __init__(self):
        super().__init__(file_permissions_mode=0o600, directory_permissions_mode=0o700)

    @property
    def base_location(self):
        return str(getattr(settings, 'NARRATION_STORAGE_ROOT', Path(settings.MEDIA_ROOT).parent / 'private-narration'))

    @property
    def location(self):
        root = Path(self.base_location).resolve()
        for value in (settings.MEDIA_ROOT, getattr(settings, 'STATIC_ROOT', None)):
            if value:
                public = Path(value).resolve()
                if root == public or public in root.parents:
                    raise ImproperlyConfigured('Narration storage must be outside media/static roots')
        return str(root)

    def url(self, name):
        raise ValueError('Narration files have no direct public storage URL')


private_storage = PrivateNarrationStorage()
