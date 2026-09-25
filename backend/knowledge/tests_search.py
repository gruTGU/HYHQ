from django.core.cache import cache
from unittest.mock import patch
from django.test import TestCase
from rest_framework.test import APIRequestFactory
from ecology.models import Place, Region
from .models import Content, Route, RouteStop
from .search import KnowledgeSearch


class KnowledgeSearchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.region = Region.objects.create(name='天津', slug='search-tianjin')
        cls.place = Place.objects.create(name='湿地公园', slug='search-park', kind='park', region=cls.region, description='芦苇和鸟类', source_note='官方公园资料')
        cls.hidden = Place.objects.create(name='隐藏湿地', slug='search-hidden', kind='park', region=cls.region, is_published=False)
        cls.content = Content.objects.create(slug='wetland-note', title='湿地与候鸟', body='只有正文中包含的词：生态恢复。芦苇为鸟类提供栖息空间。', status='published', category='plants', plant_label='reed', place=cls.place, source='湿地保护公开资料 https://example.org/notes')
        Content.objects.create(slug='wetland-draft', title='湿地草稿秘密', body='生态恢复', status='draft')
        Content.objects.create(slug='wetland-hidden', title='湿地关联隐藏地点', body='生态恢复', status='published', place=cls.hidden)
        cls.route = Route.objects.create(slug='wetland-walk', title='湿地漫步', description='沿步道了解芦苇和鸟类', region=cls.region, published=True, source='公园路线指南')
        RouteStop.objects.create(route=cls.route, place=cls.place, order=1)
        RouteStop.objects.create(route=cls.route, place=cls.hidden, order=2, note='秘密节点')
        Route.objects.create(slug='draft-walk', title='湿地路线草稿', region=cls.region)

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def query(self, **params):
        return KnowledgeSearch.as_view()(APIRequestFactory().get('/api/v1/knowledge-search/', params))

    def test_keywords_search_body_and_return_exact_source_without_upstream(self):
        with patch('llm.provider.generate') as llm, patch('weatherdata.provider.fetch') as weather:
            result = self.query(q='生态恢复')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data['count'], 1)
        row = result.data['results'][0]
        self.assertEqual(row['id'], str(self.content.pk))
        self.assertIn('生态恢复', row['excerpt'])
        self.assertEqual(row['source'], self.content.source)
        self.assertTrue(row['source_path'].endswith(f'{self.content.pk}/'))
        llm.assert_not_called(); weather.assert_not_called()

    def test_tags_and_place_filter_compose(self):
        result = self.query(category='plants', plant_label='reed', place=self.place.slug)
        self.assertEqual(result.data['count'], 1)
        self.assertEqual(result.data['results'][0]['kind'], 'content')
        self.assertEqual(self.query(plant_label='not-recorded').data['answer_kind'], 'no_evidence')

    def test_place_search_includes_routes_but_not_hidden_stops(self):
        data = self.query(place=str(self.place.pk)).data
        self.assertEqual({row['kind'] for row in data['results']}, {'content', 'route', 'place'})
        self.assertNotIn('秘密', str(data))
        self.assertEqual(self.query(place=str(self.hidden.pk)).status_code, 400)

    def test_multiple_keywords_are_and_not_or(self):
        data = self.query(q='芦苇 鸟类').data
        self.assertEqual(data['count'], 3)
        self.assertEqual(self.query(q='芦苇 海豚').data['count'], 0)

    def test_no_evidence_is_explicit_and_does_not_generate_realtime_claim(self):
        data = self.query(q='今天的水质一定安全').data
        self.assertEqual(data['answer_kind'], 'no_evidence')
        self.assertEqual(data['results'], [])
        self.assertIn('无法依据本站资料回答', data['answer'])

    def test_invalid_and_duplicate_inputs(self):
        for query in ({}, {'q': 'a' * 101}, {'q': 'a b c d e f'}, {'q': '湿地', 'page': 0}, {'q': '湿地', 'page_size': 21}, {'kind': 'route', 'plant_label': 'reed'}, {'q': '湿地', 'prompt': 'fake'}):
            self.assertEqual(self.query(**query).status_code, 400, query)
        req = APIRequestFactory().get('/api/v1/knowledge-search/?q=one&q=two')
        self.assertEqual(KnowledgeSearch.as_view()(req).status_code, 400)

    def test_pagination_deterministic_no_duplicates_or_leaks(self):
        first = self.query(q='湿地', page_size=1).data
        second = self.query(q='湿地', page_size=1, page=2).data
        self.assertEqual(first['count'], 3)
        self.assertTrue(first['has_more'])
        self.assertNotEqual(first['results'][0]['id'], second['results'][0]['id'])
        self.assertFalse(self.query(q='湿地', page=4, page_size=1).data['has_more'])
        self.assertNotIn('秘密', str(self.query(q='湿地').data))

    def test_unpublish_removes_evidence_on_next_request(self):
        self.content.status = 'draft'; self.content.save()
        self.assertEqual(self.query(q='生态恢复').data['answer_kind'], 'no_evidence')

    def test_mixed_kind_pagination_tie_order_matches_each_queryset_prefix(self):
        # Names deliberately conflict with UUID order. Database locale collation
        # must not affect the order used to merge different model querysets.
        import uuid
        for index, title in enumerate(['é湿地', 'Z湿地', '湿地A', 'a湿地']):
            Content.objects.create(id=uuid.UUID(int=100 + index), slug=f'collation-{index}', title=title, body='资料', status='published')
            Place.objects.create(id=uuid.UUID(int=200 + index), slug=f'collation-place-{index}', name=title, region=self.region, kind='park')
        all_rows = self.query(q='湿地', page_size=20).data['results']
        paged = []
        for page in range(1, len(all_rows) + 1):
            paged.extend(self.query(q='湿地', page_size=1, page=page).data['results'])
        self.assertEqual([(row['kind'], row['id']) for row in paged], [(row['kind'], row['id']) for row in all_rows])
        self.assertEqual(len({(row['kind'], row['id']) for row in paged}), len(all_rows))
