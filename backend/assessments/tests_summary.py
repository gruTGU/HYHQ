from types import SimpleNamespace

from django.test import SimpleTestCase

from .summary import observation_summary


def candidate(box, confidence=.9, **extra):
    return dict({'class_id': 9, 'eval_category': 'floating_debris', 'confidence': confidence, 'bbox': box}, **extra)


def result(detections=None, **extra):
    return SimpleNamespace(**dict({'status': 'succeeded', 'reason': '', 'image_width': 300,
                                  'image_height': 300, 'detections': detections or []}, **extra))


class ObservationSummaryTests(SimpleTestCase):
    def test_overlap_is_counted_once_in_area_but_each_candidate_has_one_cell(self):
        data = observation_summary(result([candidate([0, 0, 100, 100], .4), candidate([50, 0, 150, 100], .8)]))
        self.assertEqual(data['status'], 'ready')
        self.assertEqual(data['candidate_count'], 2)
        self.assertAlmostEqual(data['box_area_ratio'], 15000 / 90000)
        self.assertEqual(data['confidence'], {'min': .4, 'max': .8, 'mean': .6})
        self.assertEqual([cell['count'] for cell in data['grid']], [1, 1, 0, 0, 0, 0, 0, 0, 0])
        self.assertIn('不是水面覆盖率', data['area_note'])
        self.assertIn('不是地图方位', data['spatial_note'])

    def test_all_nine_cells_and_boundary_convention_are_deterministic(self):
        boxes = [candidate([x, y, x + 100, y + 100]) for y in (0, 100, 200) for x in (0, 100, 200)]
        data = observation_summary(result(boxes))
        self.assertEqual([cell['count'] for cell in data['grid']], [1] * 9)
        self.assertEqual(data['box_area_ratio'], 1)
        # A spanning box's centre falls exactly on the first vertical/horizontal third.
        spanning = observation_summary(result([candidate([0, 0, 200, 200])]))
        self.assertEqual(spanning['grid'][4]['count'], 1)
        self.assertEqual(sum(cell['count'] for cell in spanning['grid']), 1)

    def test_unsupported_classes_and_malformed_candidates_are_excluded_not_repaired(self):
        good = candidate([200, 200, 300, 300])
        invalid = [None, [], dict(good, class_id=0), dict(good, class_id='9'),
                   dict(good, eval_category='outfall_discharge'), dict(good, confidence=float('nan')),
                   dict(good, confidence=True), dict(good, confidence=1.01),
                   dict(good, bbox=[-1, 0, 20, 20]), dict(good, bbox=[0, 0, 301, 20]),
                   dict(good, bbox=[0, 0, float('inf'), 20]), dict(good, bbox=[0, 0, 0, 20]),
                   dict(good, bbox=[False, 0, 20, 20])]
        data = observation_summary(result([good] + invalid))
        self.assertEqual(data['candidate_count'], 1)
        self.assertEqual(data['excluded_count'], len(invalid))
        self.assertEqual(data['grid'][8]['count'], 1)
        self.assertAlmostEqual(data['box_area_ratio'], 1 / 9)

    def test_uncertain_and_incomplete_results_never_become_zero_clean_water(self):
        for job in [result(), result([candidate([0, 0, 1, 1], class_id=0)]),
                    result([candidate([0, 0, 1, 1])], image_width=None),
                    result([candidate([0, 0, 1, 1])], image_height=True),
                    result([candidate([0, 0, 1, 1])], reason='LOW_IMAGE_QUALITY'),
                    result(detections={'bad': 'container'}),
                    result([candidate([0, 0, 1, 1])] * 301)]:
            with self.subTest(job=job):
                data = observation_summary(job)
                self.assertEqual(data['status'], 'unavailable')
                self.assertIsNone(data['candidate_count'])
                self.assertIsNone(data['box_area_ratio'])
                self.assertIsNone(data['confidence'])
                self.assertEqual(data['grid'], [])
        for status in ('queued', 'running', 'failed'):
            self.assertIsNone(observation_summary(result(status=status)))

    def test_summary_has_no_private_image_location_or_inferred_environmental_fields(self):
        data = observation_summary(result([candidate([0, 0, 1, 1])], image_width=10000, image_height=10000,
                                          latitude=30.1, longitude=120.1, original='/private/river.jpg'))
        self.assertGreater(data['box_area_ratio'], 0)
        self.assertEqual(set(data), {'schema_version', 'status', 'reason', 'candidate_count', 'excluded_count',
                                     'box_area_ratio', 'confidence', 'grid', 'area_note', 'spatial_note'})
