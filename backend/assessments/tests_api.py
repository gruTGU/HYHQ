import copy
import io
import tempfile
from datetime import timedelta

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from accounts.models import User
from accounts.services import issue_session
from assets.models import Asset
from assets.services import create_asset
from ecology.models import Place, Region, Station, WaterBody
from recognition.models import RecognitionJob
from .models import AssessmentJob, RuleSet
from .rules import RULE_V1, activate_rules


class AssessmentFixture:
    def setUp(self):
        super().setUp()
        cache.clear()
        self.temp = tempfile.TemporaryDirectory(prefix='hyhq-assessment-')
        self.addCleanup(self.temp.cleanup)
        settings = override_settings(MEDIA_ROOT=self.temp.name, RECOGNITION_LOCK_PATH=self.temp.name + '/cpu.lock')
        settings.enable()
        self.addCleanup(settings.disable)
        self.user = User.objects.create_user(username='river-owner')
        self.other = User.objects.create_user(username='river-other')
        self.api = APIClient()
        token, _ = issue_session(self.user)
        self.api.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.rule = RuleSet.objects.create(version='test-v1', definition=copy.deepcopy(RULE_V1), is_active=True)

    def asset(self, owner=None, purpose='recognition'):
        image = io.BytesIO()
        Image.new('RGB', (100, 80), 'blue').save(image, 'PNG')
        return create_asset(owner or self.user, SimpleUploadedFile('river.png', image.getvalue(), content_type='image/png'), purpose)

    def post(self, asset=None, **extra):
        asset = asset or self.asset()
        return self.api.post('/api/v1/assessment-jobs/', dict(asset_id=str(asset.pk), **extra))

    def water(self, slug='river', system='GCJ02', published=True, kind='river', active=True):
        region, _ = Region.objects.get_or_create(slug='river-region', defaults={'name': '河道测试区域'})
        place = Place.objects.create(region=region, slug=slug, name=slug, kind=kind, is_published=published,
                                     latitude=30.2, longitude=120.2, coordinate_system=system)
        water = WaterBody.objects.create(place=place)
        station = Station.objects.create(region=region, place=place, water_body=water, name=slug, code=slug,
                                         kind='water', is_active=active)
        return water, station


class AssessmentApiTests(AssessmentFixture, TestCase):
    def test_auth_owner_filter_and_foreign_asset(self):
        self.assertEqual(APIClient().get('/api/v1/assessment-jobs/').status_code, 401)
        self.assertEqual(self.post(asset=self.asset(owner=self.other)).status_code, 404)
        foreign = AssessmentJob.objects.create(owner=self.other, asset=self.asset(owner=self.other), expires_at=timezone.now() + timedelta(days=1))
        for method in [self.api.get, self.api.delete]:
            self.assertEqual(method(f'/api/v1/assessment-jobs/{foreign.pk}/').status_code, 404)
        self.assertEqual(self.api.get('/api/v1/assessment-jobs/').json()['data'], [])

    def test_post_is_idempotent_and_location_remains_optional(self):
        asset = self.asset()
        created = self.post(asset=asset)
        self.assertEqual(created.status_code, 201, created.content)
        duplicate = self.post(asset=asset, latitude=30, longitude=120, coordinate_system='GCJ02')
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(created.json()['data']['id'], duplicate.json()['data']['id'])
        job = AssessmentJob.objects.get()
        self.assertIsNone(job.latitude)
        self.assertIsNone(job.longitude)
        self.assertIsNone(job.water_body_id)
        self.assertIsNone(job.station_id)
        self.assertEqual(job.rule_snapshot, RULE_V1)
        self.assertEqual(job.rule_version, 'test-v1')

    def test_coordinates_require_pair_system_and_finite_values(self):
        asset = self.asset()
        cases = [{'latitude': 1}, {'longitude': 1}, {'latitude': 1, 'longitude': 1},
                 {'latitude': 1, 'longitude': 1, 'coordinate_system': 'BD09'},
                 {'latitude': 'NaN', 'longitude': 1, 'coordinate_system': 'GCJ02'},
                 {'latitude': 1, 'longitude': 'Infinity', 'coordinate_system': 'GCJ02'},
                 {'latitude': 91, 'longitude': 1, 'coordinate_system': 'GCJ02'},
                 {'latitude': 1, 'longitude': 181, 'coordinate_system': 'GCJ02'},
                 {'coordinate_system': 'GCJ02'}]
        for data in cases:
            with self.subTest(data=data):
                self.assertEqual(self.post(asset=asset, **data).status_code, 400)
        self.assertEqual(self.post(asset=asset, latitude=0, longitude=0, coordinate_system='WGS84').status_code, 201)

    def test_avatar_and_expired_original_are_rejected(self):
        self.assertEqual(self.post(asset=self.asset(purpose='avatar')).status_code, 404)
        expired = self.asset()
        Asset.objects.filter(pk=expired.pk).update(original_expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.post(asset=expired).status_code, 404)

    def test_rule_snapshot_is_pinned_at_admission(self):
        response = self.post()
        job = AssessmentJob.objects.get(pk=response.json()['data']['id'])
        changed = copy.deepcopy(RULE_V1)
        changed['floating_debris']['count_steps'][1][1] = 6
        v2 = RuleSet.objects.create(version='test-v2', definition=changed)
        activate_rules(v2.pk)
        job.refresh_from_db()
        self.assertEqual(job.rule_snapshot, RULE_V1)
        self.assertEqual(job.rule_version, 'test-v1')

    def test_no_active_rule_is_actionable_error(self):
        activate_rules(None)
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['error']['code'], 'RULE_NOT_CONFIGURED')

    @override_settings(RECOGNITION_QUEUE_LIMIT=1)
    def test_queue_capacity_and_idempotent_retry(self):
        asset = self.asset()
        self.assertEqual(self.post(asset=asset).status_code, 201)
        self.assertEqual(self.post(asset=asset).status_code, 200)
        self.assertEqual(self.post().status_code, 429)

    def test_deleting_job_removes_private_files_and_does_not_resurrect(self):
        asset = self.asset()
        job_id = self.post(asset=asset).json()['data']['id']
        original, thumb = asset.original.path, asset.thumbnail.path
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.api.delete(f'/api/v1/assessment-jobs/{job_id}/').status_code, 204)
        from pathlib import Path
        self.assertFalse(AssessmentJob.objects.filter(pk=job_id).exists())
        self.assertFalse(Asset.objects.filter(pk=asset.pk).exists())
        self.assertFalse(Path(original).exists())
        self.assertFalse(Path(thumb).exists())

    def test_published_water_list_and_manual_selection(self):
        water, _ = self.water()
        hidden, _ = self.water('hidden', published=False)
        response = APIClient().get('/api/v1/water-bodies/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item['id'] for item in response.json()['data']], [str(water.pk)])
        self.assertNotIn('latitude', response.json()['data'][0])
        self.assertEqual(self.post(water_body_id=str(hidden.pk)).status_code, 404)
        response = self.post(water_body_id=str(water.pk))
        self.assertEqual(response.json()['data']['water_body']['id'], str(water.pk))
        self.assertIsNone(response.json()['data']['latitude'])

    def test_nearby_requires_matching_system_published_places_and_active_station(self):
        water, station = self.water()
        query = {'latitude': 30.2, 'longitude': 120.2, 'coordinate_system': 'GCJ02'}
        client = APIClient()
        def nearby(**overrides):
            return client.get('/api/v1/nearby-water-bodies/', dict(query, **overrides)).json()['data']['match']
        match = nearby()
        self.assertEqual(match['water_body_id'], str(water.pk))
        self.assertTrue(match['suggestion_only'])
        self.assertIsNone(nearby(coordinate_system='WGS84'))
        self.assertIsNone(nearby(latitude=31.2))
        station.is_active = False
        station.save()
        self.assertIsNone(nearby())
        station.is_active = True
        station.save()
        Place.objects.filter(pk=water.place_id).update(is_published=False)
        self.assertIsNone(nearby())
        self.assertEqual(client.get('/api/v1/nearby-water-bodies/', {'lat': 30, 'lng': 120}).status_code, 400)

    def test_precise_location_is_private_and_hidden_links_redacted(self):
        water, station = self.water()
        response = self.post(water_body_id=str(water.pk), latitude=30.2, longitude=120.2, coordinate_system='GCJ02')
        job = AssessmentJob.objects.get(pk=response.json()['data']['id'])
        job.station = station
        job.save()
        Place.objects.filter(pk=water.place_id).update(is_published=False)
        data = self.api.get(f'/api/v1/assessment-jobs/{job.pk}/').json()['data']
        self.assertIsNone(data['water_body'])
        self.assertIsNone(data['station'])
        self.assertEqual(data['latitude'], 30.2)
        self.assertNotIn('model_snapshot', data)
        self.assertEqual(APIClient().get(f'/api/v1/assessment-jobs/{job.pk}/').status_code, 401)

    def test_location_does_not_automatically_assign_nearby_water_body(self):
        self.water()
        result = self.post(latitude=30.2, longitude=120.2, coordinate_system='GCJ02').json()['data']
        self.assertIsNone(result['water_body'])
        self.assertIsNone(result['station'])

    def test_historical_public_model_metadata_comes_from_snapshot(self):
        job = AssessmentJob.objects.create(owner=self.user, asset=self.asset(),
            model_snapshot={'name': 'historical-detector', 'version': 'v0', 'scope': '漂浮物', 'threshold': .4,
                            'artifact': '/private/do-not-publish.onnx'},
            image_width=100, image_height=80, expires_at=timezone.now() + timedelta(days=1))
        data = self.api.get(f'/api/v1/assessment-jobs/{job.pk}/').json()['data']
        self.assertEqual(data['model']['version'], 'v0')
        self.assertEqual(data['model_name'], 'historical-detector')
        self.assertEqual(data['image_width'], 100)
        self.assertNotIn('artifact', data['model'])
        self.assertNotIn('model_snapshot', data)

    def test_observation_summary_is_private_expiring_and_does_not_rewrite_history(self):
        detections = [{'class_id': 9, 'eval_category': 'floating_debris', 'confidence': .8, 'bbox': [0, 0, 50, 40]}]
        job = AssessmentJob.objects.create(owner=self.user, asset=self.asset(), status='succeeded',
            detections=detections, image_width=100, image_height=80, score=85, rule_version='historical-v1',
            expires_at=timezone.now() + timedelta(days=1))
        detail = f'/api/v1/assessment-jobs/{job.pk}/'
        self.assertEqual(APIClient().get(detail).status_code, 401)
        other = APIClient()
        token, _ = issue_session(self.other)
        other.credentials(HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(other.get(detail).status_code, 404)
        data = self.api.get(detail).json()['data']
        self.assertEqual(data['observation_summary']['candidate_count'], 1)
        self.assertEqual(data['observation_summary']['box_area_ratio'], .25)
        self.assertEqual(self.api.get('/api/v1/assessment-jobs/').json()['data'][0]['observation_summary'], data['observation_summary'])
        job.refresh_from_db()
        self.assertEqual(job.detections, detections)
        self.assertEqual(job.rule_version, 'historical-v1')
        self.assertEqual(job.score, 85)
        AssessmentJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.api.get(detail).status_code, 404)
        self.assertEqual(self.api.get('/api/v1/assessment-jobs/').json()['data'], [])
