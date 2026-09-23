from datetime import timedelta

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from ecology.models import MapLayout, Place, Region, Station, WaterBody
from ecology.simulation import ensure_simulation_catalogue
from ecology.seed_copy import GINKGO_DESCRIPTION, GREEN_WALK_BODY, OBSERVE_PLANTS_BODY
from knowledge.models import Content, Route, RouteStop


PLACES = [
    ("campus-gate", "示范校园入口", "campus", 0.12, 0.83, "虚构示范校园入口，作为生态游览的集合点。"),
    ("clear-river", "清溪示范河", "river", 0.26, 0.48, "用于展示水环境指标的虚构河流，不对应真实监测点。"),
    ("mirror-lake", "镜湖示范点", "lake", 0.64, 0.36, "虚构湖泊，展示水温、pH、浊度及溶解氧。"),
    ("wetland-garden", "湿地科普园", "park", 0.79, 0.22, "示范湿地学习点，请沿步道观察、避免干扰生境。"),
    ("ginkgo-grove", "银杏学习点", "plant", 0.35, 0.25, GINKGO_DESCRIPTION),
    ("camphor-tree", "香樟学习点", "plant", 0.19, 0.28, "记录植物叶片、树皮与生境特征的示范学习点。"),
    ("bamboo-garden", "竹园学习点", "plant", 0.8, 0.58, "示范生态科普点，所有地点关系均为课程设计。"),
    ("waste-east", "东区分类投放点", "waste", 0.86, 0.77, "示范投放点，具体垃圾分类以实际地区规定为准。"),
    ("waste-west", "西区分类投放点", "waste", 0.18, 0.65, "示范投放点，支持后期关联当地分类规则。"),
    ("green-trail", "环湖绿色步道", "trail", 0.57, 0.57, "示范步行游览路线，不提供导航与到访验证。"),
    ("library", "生态阅读空间", "campus", 0.45, 0.78, "用于关联管理员发布的生态科普内容。"),
    ("weather-garden", "环境展示园", "park", 0.58, 0.16, "关联模拟气象与空气指标；不代表官方气象站。"),
]


class Command(BaseCommand):
    help = "幂等创建虚构示范校园、12 地点、4 监测站、科普和路线；默认生成最近 48 小时模拟值。"

    def add_arguments(self, parser):
        parser.add_argument("--no-observations", action="store_true")
        parser.add_argument("--start", help="可复现的生成开始时间；默认当前整点之前 47 小时")
        parser.add_argument("--hours", type=int, default=48)

    def handle(self, *args, **options):
        if not 1 <= options["hours"] <= 744:
            raise CommandError("--hours 必须为 1 至 744。")
        with transaction.atomic():
            region, _ = Region.objects.get_or_create(slug="demo-campus", defaults={"name": "海晏河清示范校园", "description": "课程/毕设虚构示范区域，地点和环境数据均非真实实测。", "is_demo": True})
            if not region.is_demo:
                raise CommandError("demo-campus 已被设为真实区域，停止写入模拟资料。")
            layout, created = MapLayout.objects.get_or_create(region=region, version=1, defaults={"name": "示范校园导览布局", "image_url": "/assets/maps/demo-campus-v1.png", "attribution": "HYHQ 原创示意布局，非实际地理地图。"})
            # Upgrade only the untouched M1 placeholder; keep administrator artwork and dimensions.
            if not created and not layout.image_url and (layout.image_width, layout.image_height) == (1000, 700) and layout.name == "示范校园导览布局" and layout.attribution == "HYHQ 原创示意布局，非实际地理地图。":
                layout.image_url = "/assets/maps/demo-campus-v1.png"
                layout.save(update_fields=["image_url", "updated_at"])
            places = {}
            for slug, name, kind, x_ratio, y_ratio, description in PLACES:
                places[slug], _ = Place.objects.get_or_create(slug=slug, defaults={"region": region, "name": name, "kind": kind, "description": description, "map_layout": layout, "x_ratio": x_ratio, "y_ratio": y_ratio, "source_note": "项目自建虚构示范资料。"})
            river, _ = WaterBody.objects.get_or_create(place=places["clear-river"])
            lake, _ = WaterBody.objects.get_or_create(place=places["mirror-lake"])
            for code, name, kind, place, water in [
                ("demo-water-01", "清溪模拟水站", "water", places["clear-river"], river),
                ("demo-water-02", "镜湖模拟水站", "water", places["mirror-lake"], lake),
                ("demo-weather-01", "校园模拟气象站", "weather", places["weather-garden"], None),
                ("demo-air-01", "校园模拟空气站", "air", places["weather-garden"], None),
            ]:
                Station.objects.get_or_create(code=code, defaults={"name": name, "kind": kind, "region": region, "place": place, "water_body": water})
            ensure_simulation_catalogue()
            articles = [
                ("observe-campus-plants", "从一片叶子开始观察校园植物", "plants", "ginkgo-grove", "先观察叶片轮廓、叶脉和排列，再记录生境。仅凭一张照片可能无法准确确定植物类别。", OBSERVE_PLANTS_BODY),
                ("read-water-indicators", "如何阅读河湖的四项展示指标", "water", "clear-river", "水温、pH、浊度与溶解氧展示水环境的不同侧面，不能单独替代完整水质评价。", "页面中的数值由模拟生成器产生。趋势图用于学习连续数据与缺失值的表达，不用于评判真实水质或饮用安全。"),
                ("green-campus-walk", "一次校园绿色步行", "green", "green-trail", "携带水杯、沿步道行走、带走随身垃圾，记录一次低干扰的生态观察。", GREEN_WALK_BODY),
            ]
            for slug, title, category, place_slug, summary, body in articles:
                Content.objects.get_or_create(slug=slug, defaults={"title": title, "category": category, "place": places[place_slug], "summary": summary, "body": body, "status": "published", "source": "HYHQ 项目编写的示范科普稿。", "is_demo": True, "published_at": timezone.now()})
            route, _ = Route.objects.get_or_create(slug="campus-eco-walk", defaults={"region": region, "title": "校园生态观察线", "description": "虚构示范路线：从校园入口到水环境与植物学习点，最后进入阅读空间。无导航或真实到访核验。", "published": True, "source": "项目自建示范路线。", "is_demo": True})
            for order, slug in enumerate(["campus-gate", "clear-river", "ginkgo-grove", "mirror-lake", "green-trail", "library"], 1):
                RouteStop.objects.get_or_create(route=route, order=order, defaults={"place": places[slug], "note": "示范游览节点"})
        self.stdout.write(self.style.SUCCESS("示范资料已就绪；重复执行保留已有管理员修改。"))
        if not options["no_observations"]:
            start = options["start"] or (timezone.now().replace(minute=0, second=0, microsecond=0) - timedelta(hours=options["hours"] - 1)).isoformat()
            call_command("generate_simulation", scenario="normal", start=start, hours=options["hours"], stdout=self.stdout)
