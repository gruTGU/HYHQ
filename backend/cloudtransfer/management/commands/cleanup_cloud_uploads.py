from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from cloudtransfer.models import DailyBudget, OwnerBudget, Upload


class Command(BaseCommand):
    help = 'Delete expired cloud upload staging; keep anonymous daily reservations for 90 days.'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true')

    def handle(self, *args, **options):
        now = timezone.now()
        expired = Upload.objects.filter(expires_at__lte=now)
        count = expired.count()
        if options['dry_run']:
            self.stdout.write(f'Expired upload sessions: {count}; no changes made.')
            return
        removed = 0
        while True:
            with transaction.atomic():
                rows = list(expired.select_for_update().order_by('pk')[:100])
                if not rows:
                    break
                removed += len(rows)
                Upload.objects.filter(pk__in=[row.pk for row in rows]).delete()
        cutoff = timezone.localdate() - timedelta(days=90)
        OwnerBudget.objects.filter(day__lt=cutoff).delete()
        DailyBudget.objects.filter(day__lt=cutoff).delete()
        self.stdout.write(f'Deleted expired upload sessions: {removed}.')
