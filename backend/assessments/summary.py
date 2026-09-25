"""Versioned image-space observations; no metric scale or ecological inference."""
import math

from .rules import AREA_NOTE, union_area

GRID_LABELS = ('左上', '上中', '右上', '左中', '中央', '右中', '左下', '下中', '右下')
SPATIAL_NOTE = '按检测框中心在原图中的位置计数；不是地图方位、污染分布或实际密度。'


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def observation_summary(job):
    """Derive only from an owner's stored result, without reopening the private image.

    Old records can lack dimensions; malformed/unsupported candidates are excluded,
    never clipped into apparently valid evidence. The 300-candidate bound matches
    the detector/rules contract and also bounds the union-area sweep.
    """
    if job.status != 'succeeded':
        return None
    unavailable = {'schema_version': 1, 'status': 'unavailable', 'candidate_count': None,
                   'excluded_count': 0, 'box_area_ratio': None, 'confidence': None, 'grid': [],
                   'area_note': AREA_NOTE, 'spatial_note': SPATIAL_NOTE}
    if job.reason == 'LOW_IMAGE_QUALITY':
        return dict(unavailable, reason='LOW_IMAGE_QUALITY')
    width, height = job.image_width, job.image_height
    if (type(width) is not int or type(height) is not int or width <= 0 or height <= 0):
        return dict(unavailable, reason='INVALID_IMAGE_DIMENSIONS')
    detections = job.detections
    if not isinstance(detections, list) or len(detections) > 300:
        return dict(unavailable, reason='INVALID_DETECTIONS')
    boxes, confidences, excluded = [], [], 0
    grid = [{'key': str(index), 'label': label, 'count': 0} for index, label in enumerate(GRID_LABELS)]
    for item in detections:
        if not isinstance(item, dict):
            excluded += 1
            continue
        box, confidence = item.get('bbox'), item.get('confidence')
        if (type(item.get('class_id')) is not int or item['class_id'] != 9
                or item.get('eval_category') != 'floating_debris'
                or not _number(confidence) or not 0 <= confidence <= 1
                or not isinstance(box, list) or len(box) != 4
                or not all(_number(value) for value in box)
                or not 0 <= box[0] < box[2] <= width
                or not 0 <= box[1] < box[3] <= height):
            excluded += 1
            continue
        boxes.append(box)
        confidences.append(confidence)
        # A centre on a third boundary belongs to the cell to its right/below.
        column = min(2, int((box[0] + box[2]) / 2 / width * 3))
        row = min(2, int((box[1] + box[3]) / 2 / height * 3))
        grid[row * 3 + column]['count'] += 1
    if not boxes:
        return dict(unavailable, reason='NO_SUPPORTED_DETECTIONS', excluded_count=excluded)
    return {'schema_version': 1, 'status': 'ready', 'reason': '', 'candidate_count': len(boxes),
            'excluded_count': excluded,
            'box_area_ratio': min(1, max(0, union_area(boxes) / (width * height))),
            'confidence': {'min': round(min(confidences), 6), 'max': round(max(confidences), 6),
                           'mean': round(sum(confidences) / len(confidences), 6)},
            'grid': grid, 'area_note': AREA_NOTE, 'spatial_note': SPATIAL_NOTE}
