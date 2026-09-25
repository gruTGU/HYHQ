"""Export an aggregate accounting aid, not a supplier invoice or price estimate."""
import json
from datetime import date

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from llm.models import UsageLedger


class Command(BaseCommand):
    help = '按上海提交日汇总 AI 用量；不输出用户、提示词、密钥或回答，不调用提供方。'

    def add_arguments(self, parser):
        parser.add_argument('--day', default=timezone.localdate().isoformat())

    def handle(self, *args, **options):
        try:
            day = date.fromisoformat(options['day'])
        except ValueError:
            raise CommandError('日期格式须为 YYYY-MM-DD。') from None
        report = {'day': day.isoformat(), 'day_basis': 'Asia/Shanghai admission day', 'model': 'deepseek-flash',
                  'requests': 0, 'dispatched': 0, 'successful': 0, 'failed': 0, 'pending': 0,
                  'receipt_requests': 0, 'estimated_requests': 0, 'estimated_reserved_tokens': 0,
                  'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0,
                  'cache_detail_requests': 0, 'prompt_cache_hit_tokens': 0, 'prompt_cache_miss_tokens': 0,
                  'cross_day_dispatches': 0, 'invoice_verified': False,
                  'notice': 'token 回执不是金额账单。估算是安全预留量，不能当作实际费用；缓存明细缺失时不猜命中比例。提交日与提供方计费日可能不同，跨日任务及其他应用用量须另行核对。'}
        for entry in UsageLedger.objects.filter(day=day).iterator(chunk_size=500):
            report['requests'] += 1
            report['dispatched'] += int(entry.dispatched)
            report['successful'] += int(entry.status == 'succeeded')
            report['failed'] += int(entry.status == 'failed')
            report['pending'] += int(entry.status in {'queued', 'running'})
            if entry.started_at and timezone.localtime(entry.started_at).date() != day and entry.dispatched:
                report['cross_day_dispatches'] += 1
            if entry.usage_estimated:
                report['estimated_requests'] += 1
                report['estimated_reserved_tokens'] += entry.accounted_tokens
            elif entry.usage:
                report['receipt_requests'] += 1
                for key in ['prompt_tokens', 'completion_tokens', 'total_tokens']:
                    report[key] += entry.usage.get(key, 0)
                if all(key in entry.usage for key in ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']):
                    report['cache_detail_requests'] += 1
                    report['prompt_cache_hit_tokens'] += entry.usage['prompt_cache_hit_tokens']
                    report['prompt_cache_miss_tokens'] += entry.usage['prompt_cache_miss_tokens']
        self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
