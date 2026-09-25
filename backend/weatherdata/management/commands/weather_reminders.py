from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from weatherdata.configuration import subscription_config
from weatherdata.models import WeatherReminder
from weatherdata.subscriptions import dispatch_reminder


class Command(BaseCommand):
    help = '预览待发送的一次性天气提醒；仅 --send 且全部能力门禁开启时发送，绝不刷新天气上游。'

    def add_arguments(self, parser):
        parser.add_argument('--send', action='store_true')
        parser.add_argument('--limit', type=int, default=50)

    def handle(self, *args, **options):
        config = subscription_config()
        if not config['enabled']:
            self.stdout.write('提醒入口关闭：' + config['reason'])
            return
        limit = min(100, max(1, options['limit']))
        now = timezone.now()
        ids = list(WeatherReminder.objects.filter(state__in=['pending', 'retry', 'sending'],
            scheduled_for__lte=now).filter(Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now) | Q(state='sending'))
            .order_by('scheduled_for').values_list('pk', flat=True)[:limit])
        if not options['send']:
            self.stdout.write(f'预览：{len(ids)} 条候选提醒；未发送、未请求天气。')
            return
        outcomes = {}
        for reminder_id in ids:
            outcome = dispatch_reminder(reminder_id)
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
        self.stdout.write('处理结果：' + ', '.join(f'{key}={value}' for key, value in sorted(outcomes.items())))
