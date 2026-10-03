#!/bin/sh
set -eu
umask 077
export DJANGO_SETTINGS_MODULE=config.cloud
# No implicit migrate/seed, external calls or automatic registry activation.
case "${1:-serve}" in
  serve) exec python -m cloudruntime.supervisor ;;
  check) exec python manage.py check_cloud_runtime ;;
  manage) shift; exec python manage.py "$@" ;;
  *) printf '%s\n' 'Use serve, check, or manage <explicit management command>.' >&2; exit 2 ;;
esac
