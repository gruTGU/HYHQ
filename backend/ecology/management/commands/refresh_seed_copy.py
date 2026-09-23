"""Explicit, narrowly matched repair for untouched early catalogue copy."""
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from ecology.models import Place
from ecology.seed_copy import GINKGO_DESCRIPTION, GREEN_WALK_BODY, OBSERVE_PLANTS_BODY
from knowledge.models import Content


# Match the original public fields and catalogue identity, not merely a slug or a
# substring. An edited title, summary, status, source or association is retained.
ARTICLE_REVISIONS = (
    {
        'slug': 'observe-campus-plants',
        'title': '从一片叶子开始观察校园植物',
        'category': 'plants', 'place__slug': 'ginkgo-grove',
        'summary': '先观察叶片轮廓、叶脉和排列，再记录生境。仅凭一张照片可能无法准确确定植物类别。',
        'body': '在示范植物点练习观察和记录。请勿采摘或食用未知植物。识别模型尚未接入，本篇内容为管理员示范稿。',
        'replacement': OBSERVE_PLANTS_BODY,
    },
    {
        'slug': 'green-campus-walk',
        'title': '一次校园绿色步行',
        'category': 'green', 'place__slug': 'green-trail',
        'summary': '携带水杯、沿步道行走、带走随身垃圾，记录一次低干扰的生态观察。',
        'body': '这是一份课程演示路线说明。实际出行请核实校园开放范围与天气；平台尚未接入真实气象预警。',
        'replacement': GREEN_WALK_BODY,
    },
)
ARTICLE_IDENTITY = {
    'status': 'published', 'source': 'HYHQ 项目编写的示范科普稿。',
    'is_demo': True, 'plant_label': '',
    'place__region__slug': 'demo-campus', 'place__region__is_demo': True,
    'place__is_published': True,
}
PLACE_ORIGINAL = {
    'slug': 'ginkgo-grove', 'name': '银杏学习点', 'kind': 'plant',
    'description': '示范植物观察点；识别功能待后续真实模型接入。',
    'region__slug': 'demo-campus', 'region__is_demo': True,
    'map_layout__region__slug': 'demo-campus', 'map_layout__version': 1,
    'x_ratio': 0.35, 'y_ratio': 0.25,
    'latitude': None, 'longitude': None, 'coordinate_system': '',
    'source_note': '项目自建虚构示范资料。', 'is_published': True,
}


class Command(BaseCommand):
    help = '预览过期种子文案修订；仅 --apply 更新完全匹配原稿的两篇文章及银杏点位，保留管理员改稿。'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='实际写入；默认只预览，不生成观测、不调用外部服务。')

    def handle(self, *args, **options):
        revisions = []
        for article in ARTICLE_REVISIONS:
            filters = {**ARTICLE_IDENTITY, **article}
            replacement = filters.pop('replacement')
            revisions.append((Content, filters, 'body', replacement))
        revisions.append((Place, PLACE_ORIGINAL, 'description', GINKGO_DESCRIPTION))
        eligible = changed = 0
        with transaction.atomic():
            for model, filters, field, replacement in revisions:
                # PostgreSQL locks only the target row (Place.map_layout is
                # nullable); the repeated predicate guards against stale edits.
                item = model.objects.filter(**filters).select_for_update(of=('self',)).first()
                if not item:
                    self.stdout.write(f'跳过 {model.__name__}:{filters["slug"]}（原稿不匹配、已修订或不存在）')
                    continue
                eligible += 1
                if options['apply']:
                    count = model.objects.filter(pk=item.pk, updated_at=item.updated_at, **filters).update(
                        **{field: replacement, 'updated_at': timezone.now()})
                    changed += count
                    self.stdout.write(f'{"已更新" if count else "跳过并发变更"} {model.__name__}:{item.slug}')
                else:
                    self.stdout.write(f'待更新 {model.__name__}:{item.slug} · 字段 {field}')
        self.stdout.write(f'匹配 {eligible} 项，写入 {changed} 项。' + ('' if options['apply'] else '当前仅预览；使用 --apply 执行。'))
