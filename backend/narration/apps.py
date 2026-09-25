from django.apps import AppConfig


class NarrationConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'narration'
    verbose_name = '授权语音讲解'

    def ready(self):
        from . import signals  # noqa: F401
