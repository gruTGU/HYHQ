from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from accounts.models import User
from common.audit import audit
from common.exceptions import ServiceError
from community.models import Configuration
from community.safety import check_text, credential_digest
from community.services import reserve_safety_call


class Command(BaseCommand):
    help = '显式调用一次微信文本检测，记录运行凭据；不会自动开放评论。'
    def add_arguments(self, parser):
        parser.add_argument('--user-id', required=True, help='近两小时已访问小程序的微信用户 UUID（不能传 OpenID/密钥）')
    def handle(self, *args, **options):
        try:
            user = User.objects.get(pk=options['user_id'], is_active=True, auth_kind='wechat')
        except (User.DoesNotExist, ValueError, ValidationError):
            raise CommandError('请提供有效微信用户 UUID。') from None
        digest = credential_digest()
        try:
            with transaction.atomic():
                Configuration.objects.select_for_update().get_or_create(pk=1)
                reserve_safety_call()
            result = check_text(user, '爱护环境，文明游览。')
        except ServiceError:
            raise CommandError('微信文本安全核验失败；未开启评论，也未记录可用状态。') from None
        if result['suggest'] != 'pass' or not digest or digest != credential_digest():
            raise CommandError('微信检测未通过或配置已变化；未记录可用状态。')
        with transaction.atomic():
            config, _ = Configuration.objects.select_for_update().get_or_create(pk=1)
            config.safety_verified_at, config.safety_credential_digest = timezone.now(), digest
            config.save(update_fields=['safety_verified_at', 'safety_credential_digest', 'updated_at'])
            audit('community.safety_verified', target_id=config.pk, source='wechat', status='pass')
        self.stdout.write(self.style.SUCCESS('微信文本安全核验通过，有效期七天。评论仍需完成其余独立开放条件。'))
