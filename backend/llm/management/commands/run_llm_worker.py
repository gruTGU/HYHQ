import time
from django.core.management.base import BaseCommand
from llm.worker import process_one


class Command(BaseCommand):
    help = '处理独立 AI 解读队列；不占用图像识别 CPU 锁，绝不自动重试上游。'

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
