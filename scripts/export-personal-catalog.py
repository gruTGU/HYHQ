#!/usr/bin/env python3
"""Export ONLY published catalogue and simulated observations from the isolated restore DB.

No users, sessions, credentials, private files, real provider caches or usage
ledgers are read. The fixed local database guard prevents accidental production use.
"""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', default='postgresql://hyhq_cloud_test@127.0.0.1:55438/hyhq_cloud_restore')
    parser.add_argument('--output', type=Path, default=ROOT / 'cloudfunctions/hyhqApi/data/catalog.json')
    args = parser.parse_args()
    database = urlparse(args.database_url)
    if (database.scheme != 'postgresql' or database.hostname not in {'127.0.0.1', 'localhost'}
            or database.port != 55438 or database.path != '/hyhq_cloud_restore'):
        raise SystemExit('Only the isolated local hyhq_cloud_restore database on port 55438 is allowed.')
    if (ROOT / 'backend/.env').exists():
        raise SystemExit('Run from the isolated worktree without backend/.env.')
    os.environ.update(DJANGO_SETTINGS_MODULE='config.settings', ENV='test', HYHQ_USE_SQLITE='0',
                      DATABASE_URL=args.database_url, LLM_ENABLED='0', QWEATHER_ENABLED='0',
                      DEEPSEEK_API_KEY='', QWEATHER_API_KEY='', WECHAT_APP_SECRET='')
    sys.path.insert(0, str(ROOT / 'backend'))
    import django
    django.setup()
    from django.core.serializers.json import DjangoJSONEncoder
    from django.db.models import Q
    from django.utils import timezone
    from ecology.models import DataSource, MapLayout, Metric, Observation, Place, Region, SimulationRun, SimulationScenario
    from ecology.serializers import (DataSourceSerializer, MapSerializer, MetricSerializer, ObservationSerializer,
                                     PlaceSerializer, RegionSerializer, StationSerializer)
    from ecology.series import public_stations
    from knowledge.serializers import ContentSerializer, RouteSerializer
    from knowledge.views import public_contents, public_routes
    from assessments.geo import published_water_bodies
    from assessments.serializers import WaterBodySerializer

    def rows(queryset, serializer, extra=None):
        return [dict(serializer(item).data, **(extra(item) if extra else {})) for item in queryset]

    places = Place.objects.filter(is_published=True).select_related('region', 'water_body').order_by('name', 'id')
    stations = public_stations().select_related('region').order_by('code', 'id')
    sources = DataSource.objects.filter(is_active=True).order_by('code')
    observations = Observation.objects.filter(station__in=stations, source__kind='simulation', source__is_active=True,
                                              simulation_run__status='succeeded').select_related('station', 'metric', 'source').order_by('observed_at', 'id')
    runs = SimulationRun.objects.filter(id__in=observations.values('simulation_run_id')).select_related('source', 'scenario').order_by('-created_at', '-id')
    collections = {
        'regions': rows(Region.objects.order_by('name', 'id'), RegionSerializer),
        'places': rows(places, PlaceSerializer, lambda row: {'_updated_at': row.updated_at}),
        'maps': rows(MapLayout.objects.filter(is_active=True), MapSerializer),
        'stations': rows(stations, StationSerializer),
        'metrics': rows(Metric.objects.order_by('code'), MetricSerializer),
        'data_sources': rows(sources, DataSourceSerializer),
        'observations': rows(observations, ObservationSerializer),
        'simulation_runs': [{
            'id': str(row.id), 'source': dict(DataSourceSerializer(row.source).data),
            'scenario': {'code': row.scenario.code, 'name': row.scenario.name},
            'start': row.start, 'end': row.end, 'created_at': row.created_at,
            'counts': observations.filter(simulation_run=row).count(), 'generator_version': row.generator_version,
        } for row in runs],
        'scenarios': list(SimulationScenario.objects.order_by('code').values('id', 'code', 'name')),
        'water_bodies': rows(published_water_bodies(), WaterBodySerializer, lambda row: {'_place_id': str(row.place_id)}),
        'contents': rows(public_contents().filter(Q(place__isnull=True) | Q(place__is_published=True)), ContentSerializer,
                         lambda row: {'_created_at': row.created_at.isoformat()}),
        'routes': rows(public_routes(), RouteSerializer, lambda row: {'_updated_at': row.updated_at}),
    }
    payload = {'schema_version': 1, 'exported_at': timezone.now().isoformat(),
               'provenance': 'Published administrator-reviewed catalogue and explicitly simulated observations; no personal data or live weather.',
               'collections': collections}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, cls=DjangoJSONEncoder, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'output': str(args.output), 'bytes': args.output.stat().st_size,
                      'counts': {name: len(items) for name, items in collections.items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
