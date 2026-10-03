import json
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from cloudruntime.health import mounted_storage_ready, database_ready, workers_ready


class Command(BaseCommand):
    help = '只读检查云运行声明、挂载、迁移与微信凭据存在状态；不展示任何凭据。'

    def add_arguments(self, parser):
        parser.add_argument('--include-workers', action='store_true')

    def handle(self, *args, **options):
        if not getattr(settings, 'CLOUD_RUNTIME_ENABLED', False):
            raise CommandError('Requires DJANGO_SETTINGS_MODULE=config.cloud')
        checks = {'storage': mounted_storage_ready(), 'database': database_ready(),
                  'wechat_credentials_present': bool(settings.WECHAT_APP_ID and settings.WECHAT_APP_SECRET)}
        if options['include_workers']:
            checks['workers'] = workers_ready()
        self.stdout.write(json.dumps(checks, sort_keys=True))
        if not all(checks.values()):
            raise CommandError('Cloud runtime preflight failed; see boolean checks.')
