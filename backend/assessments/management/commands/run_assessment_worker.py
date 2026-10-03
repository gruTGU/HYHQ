import time

from django.core.management.base import BaseCommand
from assessments.worker import process_one


class Command(BaseCommand):
    help = '逐个处理河道图像评估：独立 CPU 子进程、与花卉识别共享执行锁与硬超时。'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')

    def handle(self, *args, **options):
        from cloudruntime.guards import require_supervised_worker
        require_supervised_worker()
        try:
            while True:
                processed = process_one()
                if options['once']:
                    self.stdout.write('processed' if processed else 'no queued jobs')
                    return
                if not processed:
                    time.sleep(1)
        except KeyboardInterrupt:
            self.stdout.write('worker stopped')
