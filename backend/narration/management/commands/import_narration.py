from pathlib import Path

from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management.base import BaseCommand, CommandError

from accounts.models import User
from knowledge.models import Content, Route
from narration.models import MAX_AUDIO_BYTES
from narration.services import import_narration


class Command(BaseCommand):
    help = '导入管理员有权使用且已审核的本地音频；不调用 TTS，不下载外部文件。'

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument('--content', help='文章 slug')
        group.add_argument('--route', help='路线 slug')
        parser.add_argument('--file', required=True)
        parser.add_argument('--reviewer', required=True, help='审核管理员用户名')
        parser.add_argument('--rights-note', required=True, help='录制者或授权依据的管理记录')
        parser.add_argument('--reviewed', action='store_true', help='确认已听审，内容与当前正文一致')
        parser.add_argument('--copyright-confirmed', action='store_true', help='确认已取得公开播放授权')
        parser.add_argument('--publish', action='store_true', help='导入并发布；默认保存为待发布记录')

    def handle(self, *args, **options):
        try:
            model, slug = (Content, options['content']) if options.get('content') else (Route, options['route'])
            source = model.objects.get(slug=slug)
            reviewer = User.objects.get(username=options['reviewer'])
            path = Path(options['file'])
            if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_AUDIO_BYTES:
                raise ValidationError('须提供不超过 8MB 的普通本地音频文件。')
            with path.open('rb') as stream:
                data = stream.read(MAX_AUDIO_BYTES + 1)
            item = import_narration(source=source, filename=path.name, data=data, reviewer=reviewer,
                rights_note=options['rights_note'], reviewed=options['reviewed'],
                copyright_confirmed=options['copyright_confirmed'], publish=options['publish'])
        except (Content.DoesNotExist, Route.DoesNotExist, User.DoesNotExist):
            raise CommandError('资料或审核管理员不存在。') from None
        except (OSError, ValidationError, PermissionDenied) as error:
            raise CommandError(str(error)) from None
        self.stdout.write(self.style.SUCCESS(f'语音 {item.pk} 已导入，状态：{item.get_status_display()}。'))
