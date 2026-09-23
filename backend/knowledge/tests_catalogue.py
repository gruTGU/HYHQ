"""Import safety, provenance and real public browsing of the curated catalogue."""
from copy import deepcopy
from io import StringIO
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.core.management import call_command, CommandError
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIRequestFactory

from ecology.models import Place, Region, WaterBody
from knowledge.catalogue import CatalogueError, load_catalogue, validate_catalogue
from knowledge.models import Content, Route, RouteStop
from knowledge.views import ContentList, RouteList, RouteDetail


def sample():
    source = [{'title': '公开资料', 'url': 'https://www.beijing.gov.cn/', 'publisher': '政府网站', 'accessed_on': '2026-09-01'}]
    note = {'slug': 'test-fieldnote', 'title': '自然观察', 'summary': '观察前后保持相同条件并记录变化。', 'body': '## 观察\n' + '了解自然需要持续观察，同一位置也会随季节变化。' * 5 + '\n## 实践\n' + '在公共步道记录叶色，不折取植物。' * 5, 'category': 'plants', 'sources': source}
    regions = [{'slug': 'real-region', 'name': '真实区域', 'description': '公开资料区域'}]
    places = [{'slug': key, 'name': name, 'region': 'real-region', 'kind': 'park', 'description': '真实地点文字介绍。', 'sources': source} for key, name in [('real-start', '起点'), ('real-end', '终点')]]
    route = {'slug': 'test-walk', 'title': '自然漫步', 'region': 'real-region', 'description': '根据公开资料整理的参考线路。', 'sources': source, 'stops': [{'place': row['slug'], 'note': '沿公共步道观察。'} for row in places]}
    return [note], {'regions': regions, 'places': places, 'items': [route]}


class CatalogueValidationTests(SimpleTestCase):
    def test_bundled_catalogue_has_thirty_of_each_and_real_sources(self):
        data = load_catalogue()
        self.assertEqual(len(data['articles']), 30)
        self.assertEqual(len(data['routes']), 30)
        self.assertEqual(set(data['regions']), {'tianjin-nature', 'beijing-nature'})
        self.assertEqual({row['category'] for row in data['articles'].values()}, {'plants', 'water', 'green', 'travel'})

    def test_malformed_or_misleading_catalogues_are_rejected(self):
        mutations = [
            lambda n, r: n[0].update(sources=[]),
            lambda n, r: n[0]['sources'][0].update(url='http://example.com/'),
            lambda n, r: n[0]['sources'][0].update(accessed_on='2999-01-01'),
            lambda n, r: n[0].update(body='占位文字'),
            lambda n, r: n.append(deepcopy(n[0])),
            lambda n, r: r['places'][0].update(latitude=39),
            lambda n, r: r['places'][1].update(name=' 起 点 '),
            lambda n, r: r['items'][0]['stops'][0].update(place='nonexistent'),
            lambda n, r: r['items'][0]['stops'].append(deepcopy(r['items'][0]['stops'][0])),
            lambda n, r: r['items'].append(dict(r['items'][0], slug='reverse-walk', title='换序假新路线', stops=list(reversed(r['items'][0]['stops'])))),
            lambda n, r: r['regions'].append({'slug': 'other', 'name': '其他', 'description': '其他区域'}) or r['places'][0].update(region='other'),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                notes, routes = sample()
                mutate(notes, routes)
                with self.assertRaises(CatalogueError):
                    validate_catalogue(notes, routes, expected_count=None)


class CatalogueImportTests(TestCase):
    def setUp(self):
        notes, routes = sample()
        self.catalogue = validate_catalogue(notes, routes, expected_count=None)
        self.loader = patch('knowledge.management.commands.import_public_knowledge.load_catalogue', return_value=self.catalogue)
        self.loader.start()
        self.addCleanup(self.loader.stop)

    def run_import(self, apply=False):
        output = StringIO()
        call_command('import_public_knowledge', apply=apply, stdout=output)
        return output.getvalue()

    def test_preview_does_not_write_anything(self):
        self.assertIn('仅预览', self.run_import())
        for model in (Region, Place, Content, Route, RouteStop):
            self.assertFalse(model.objects.exists())

    def test_apply_publishes_traceable_content_without_fake_map_or_observations(self):
        self.run_import(True)
        self.assertEqual(Content.objects.count(), 1)
        self.assertEqual(RouteStop.objects.count(), 2)
        self.assertFalse(WaterBody.objects.exists())
        self.assertFalse(Region.objects.get().is_demo)
        article = Content.objects.get()
        self.assertEqual(article.status, 'published')
        self.assertFalse(article.is_demo)
        self.assertIsNone(article.place_id)
        self.assertIn('https://', article.source)
        self.assertIn('查阅 2026-09-01', article.source)
        for place in Place.objects.all():
            self.assertIsNone(place.latitude)
            self.assertIsNone(place.longitude)
            self.assertIsNone(place.map_layout_id)
        factory = APIRequestFactory()
        response = ContentList.as_view()(factory.get('/api/v1/contents/', {'region': 'real-region'}))
        self.assertEqual(response.data['meta']['count'], 1)
        listing = RouteList.as_view()(factory.get('/api/v1/routes/', {'region': 'real-region'}))
        self.assertEqual(listing.data['meta']['count'], 1)
        detail = RouteDetail.as_view()(factory.get('/api/v1/routes/'), pk=Route.objects.get().pk)
        self.assertEqual(detail.data['stop_count'], 2)
        self.assertFalse(detail.data['is_demo'])
        self.assertIn('不提供实时导航', detail.data['description'])

    def test_repeat_preserves_admin_edits_and_removed_stops(self):
        self.run_import(True)
        article = Content.objects.get()
        article.title, article.body, article.status = '管理员修订', '保留这个正文', 'draft'
        article.save()
        route = Route.objects.get()
        route.published, route.description = False, '管理员路线修订'
        route.save()
        route.stops.first().delete()
        place = Place.objects.first()
        place.description = '实地补充'
        place.save()
        self.assertIn('新增科普 0 篇、路线 0 条', self.run_import(True))
        article.refresh_from_db(); route.refresh_from_db(); place.refresh_from_db()
        self.assertEqual((article.title, article.body, article.status), ('管理员修订', '保留这个正文', 'draft'))
        self.assertEqual((route.description, route.published, route.stops.count()), ('管理员路线修订', False, 1))
        self.assertEqual(place.description, '实地补充')

    def test_demo_region_collision_aborts_without_content_writes(self):
        Region.objects.create(slug='real-region', name='真实区域', is_demo=True)
        with self.assertRaisesMessage(CommandError, '区域冲突'):
            self.run_import(True)
        self.assertFalse(Place.objects.exists())
        self.assertFalse(Content.objects.exists())

    def test_existing_place_collision_is_not_overwritten(self):
        region = Region.objects.create(slug='real-region', name='真实区域', is_demo=False)
        Place.objects.create(region=region, slug='real-start', name='另一处地点', kind='park')
        with self.assertRaisesMessage(CommandError, '地点冲突'):
            self.run_import(True)
        self.assertEqual(Place.objects.get().name, '另一处地点')
        self.assertFalse(Content.objects.exists())

    def test_failure_mid_import_rolls_back_all_records(self):
        with patch.object(RouteStop.objects, 'create', side_effect=ValidationError('节点写入失败')):
            with self.assertRaisesMessage(CommandError, '整批已回滚'):
                self.run_import(True)
        for model in (Region, Place, Content, Route, RouteStop):
            self.assertFalse(model.objects.exists())
