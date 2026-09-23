"""Add reviewed public learning materials without overwriting administrator edits."""
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from ecology.models import Place, Region
from knowledge.catalogue import DATA_DIR, CatalogueError, load_catalogue, sources
from knowledge.models import Content, Route, RouteStop


ROUTE_BOUNDARY = '\n\n阅读提示：这是依据公开资料整理的漫步参考，不提供实时导航或到访核验。未核实连续步行距离、临时开放或无障碍条件；出发前请确认各管理方最新公告，按现场标识通行。'


def check_existing(catalogue):
    """A name collision must not attach a real route to an unrelated old place."""
    for key, row in catalogue['regions'].items():
        current = Region.objects.filter(slug=key).first()
        if current and (current.is_demo or current.name != row['name']):
            raise CommandError(f'区域冲突 {key}；不会覆盖或混用示范区域。')
    for key, row in catalogue['places'].items():
        current = Place.objects.select_related('region').filter(slug=key).first()
        if current and (current.region.slug != row['region'] or current.name != row['name'] or current.kind != row['kind'] or not current.is_published):
            raise CommandError(f'地点冲突 {key}；请先人工核对，不会覆盖旧资料。')
    for key, row in catalogue['routes'].items():
        current = Route.objects.select_related('region').filter(slug=key).first()
        if current and current.region.slug != row['region']:
            raise CommandError(f'路线区域冲突 {key}；未执行导入。')


class Command(BaseCommand):
    help = '预览30篇科普与30条漫步路线的增量导入；--apply入库，保留同slug已有文章/路线及管理员修改。'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='执行入库；缺省只预览，不写数据库。')
        parser.add_argument('--directory', default=str(DATA_DIR), help='经过人工审核的三个离线JSON数据包目录。')

    def handle(self, *args, **options):
        try:
            catalogue = load_catalogue(options['directory'])
        except (OSError, ValueError, TypeError, ValidationError) as exc:
            raise CommandError(f'采集包验证失败：{exc}') from exc
        check_existing(catalogue)
        for name, model in [('regions', Region), ('places', Place), ('articles', Content), ('routes', Route)]:
            existing = model.objects.filter(slug__in=catalogue[name]).count()
            self.stdout.write(f'{name}: 数据包 {len(catalogue[name])}，新增 {len(catalogue[name]) - existing}，保留已有 {existing}')
        if not options['apply']:
            self.stdout.write('仅预览；如需入库请使用 --apply。不会抓取外网、改写旧稿或创建模拟监测。')
            return
        try:
            with transaction.atomic():
                check_existing(catalogue)
                regions = {}
                for key, row in catalogue['regions'].items():
                    regions[key], _ = Region.objects.get_or_create(slug=key, defaults={'name': row['name'], 'description': row['description'], 'is_demo': False})
                places = {}
                for key, row in catalogue['places'].items():
                    places[key], _ = Place.objects.get_or_create(slug=key, defaults={'region': regions[row['region']], 'name': row['name'], 'kind': row['kind'], 'description': row['description'], 'source_note': sources(row), 'is_published': True})
                # Recheck after get_or_create, including a possible concurrent importer.
                check_existing(catalogue)
                article_created = route_created = stop_created = 0
                published_at = timezone.now()
                for key, row in catalogue['articles'].items():
                    _, created = Content.objects.get_or_create(slug=key, defaults={'title': row['title'], 'summary': row['summary'], 'body': row['body'], 'category': row['category'], 'plant_label': row.get('plant_label', ''), 'source': sources(row), 'status': 'published', 'is_demo': False, 'published_at': published_at})
                    article_created += created
                for key, row in catalogue['routes'].items():
                    route, created = Route.objects.get_or_create(slug=key, defaults={'region': regions[row['region']], 'title': row['title'], 'description': row['description'] + ROUTE_BOUNDARY, 'source': sources(row), 'published': True, 'is_demo': False})
                    if not created:
                        continue  # Existing stops and publication state belong to their administrator.
                    route_created += 1
                    for order, stop in enumerate(row['stops'], 1):
                        RouteStop.objects.create(route=route, place=places[stop['place']], order=order, note=stop['note'])
                        stop_created += 1
        except (ValidationError, CatalogueError) as exc:
            raise CommandError(f'导入未完成，整批已回滚：{exc}') from exc
        self.stdout.write(self.style.SUCCESS(f'已新增科普 {article_created} 篇、路线 {route_created} 条、路线节点 {stop_created} 个。已有内容、坐标和管理员修改均保留。'))
