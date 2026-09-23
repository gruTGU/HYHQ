"""Repairs must preserve editorial work and never regenerate observation data."""
import io

from django.core.management import call_command
from django.test import TestCase

from ecology.management.commands.refresh_seed_copy import ARTICLE_REVISIONS, PLACE_ORIGINAL
from ecology.models import Observation, Place, Region, SimulationRun
from ecology.seed_copy import GINKGO_DESCRIPTION, GREEN_WALK_BODY, OBSERVE_PLANTS_BODY
from knowledge.models import Content


class SeedCopyRefreshTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_demo', no_observations=True, stdout=io.StringIO())

    def restore_original_copy(self):
        for article in ARTICLE_REVISIONS:
            Content.objects.filter(slug=article['slug']).update(body=article['body'])
        Place.objects.filter(slug='ginkgo-grove').update(description=PLACE_ORIGINAL['description'])

    def run_refresh(self, apply=False):
        output = io.StringIO()
        call_command('refresh_seed_copy', apply=apply, stdout=output)
        return output.getvalue()

    def test_new_seed_uses_current_bounded_capabilities(self):
        plant = Content.objects.get(slug='observe-campus-plants')
        walk = Content.objects.get(slug='green-campus-walk')
        ginkgo = Place.objects.get(slug='ginkgo-grove')
        self.assertEqual(plant.body, OBSERVE_PLANTS_BODY)
        self.assertIn('不覆盖银杏', plant.body)
        self.assertEqual(walk.body, GREEN_WALK_BODY)
        self.assertIn('上下文不包含实时天气或预警', walk.body)
        self.assertEqual(ginkgo.description, GINKGO_DESCRIPTION)
        self.assertIn('不支持银杏识别', ginkgo.description)
        self.assertIn('匹配 0 项，写入 0 项', self.run_refresh(apply=True))

    def test_preview_changes_nothing_and_apply_is_idempotent(self):
        self.restore_original_copy()
        before = list(Content.objects.order_by('slug').values())
        place_before = Place.objects.get(slug='ginkgo-grove').updated_at
        self.assertIn('匹配 3 项，写入 0 项', self.run_refresh())
        self.assertEqual(list(Content.objects.order_by('slug').values()), before)
        self.assertEqual(Place.objects.get(slug='ginkgo-grove').updated_at, place_before)
        self.assertIn('匹配 3 项，写入 3 项', self.run_refresh(apply=True))
        self.assertEqual(Content.objects.get(slug='observe-campus-plants').body, OBSERVE_PLANTS_BODY)
        self.assertEqual(Content.objects.get(slug='green-campus-walk').body, GREEN_WALK_BODY)
        self.assertEqual(Place.objects.get(slug='ginkgo-grove').description, GINKGO_DESCRIPTION)
        # Publication history and unrelated materials are not rewritten.
        after = {item['slug']: item for item in Content.objects.values()}
        for original in before:
            for field, value in original.items():
                if field not in {'body', 'updated_at'}:
                    self.assertEqual(after[original['slug']][field], value)
            if original['slug'] == 'read-water-indicators':
                self.assertEqual(after[original['slug']], original)
        self.assertIn('匹配 0 项，写入 0 项', self.run_refresh(apply=True))
        self.assertFalse(Observation.objects.exists())
        self.assertFalse(SimulationRun.objects.exists())

    def test_editorial_changes_to_body_metadata_and_publication_are_preserved(self):
        self.restore_original_copy()
        plant = Content.objects.get(slug='observe-campus-plants')
        original = {field: getattr(plant, field) for field in ['body', 'summary', 'title', 'source', 'status', 'is_demo', 'plant_label', 'place_id']}
        changes = [
            {'body': original['body'] + '\n管理员补充观察方法'},
            {'summary': '管理员改过摘要'}, {'title': '管理员重新命名'},
            {'source': '管理员核实的资料来源'}, {'status': 'draft'},
            {'is_demo': False}, {'plant_label': 'ginkgo'},
            {'place_id': Place.objects.get(slug='camphor-tree').pk},
        ]
        for change in changes:
            with self.subTest(change=change):
                Content.objects.filter(pk=plant.pk).update(**original)
                Content.objects.filter(pk=plant.pk).update(**change)
                self.run_refresh(apply=True)
                plant.refresh_from_db()
                self.assertEqual(plant.body, change.get('body', original['body']))
                for field, value in change.items():
                    self.assertEqual(getattr(plant, field), value)

    def test_edited_place_and_a_region_no_longer_marked_simulation_are_skipped(self):
        self.restore_original_copy()
        place = Place.objects.get(slug='ginkgo-grove')
        Place.objects.filter(pk=place.pk).update(name='管理员调整点位名称')
        self.run_refresh(apply=True)
        place.refresh_from_db()
        self.assertEqual(place.description, PLACE_ORIGINAL['description'])
        self.restore_original_copy()
        Place.objects.filter(pk=place.pk).update(name=PLACE_ORIGINAL['name'])
        Region.objects.filter(slug='demo-campus').update(is_demo=False)
        self.assertIn('匹配 0 项，写入 0 项', self.run_refresh(apply=True))
        self.assertEqual(Content.objects.get(slug='green-campus-walk').body, ARTICLE_REVISIONS[1]['body'])
