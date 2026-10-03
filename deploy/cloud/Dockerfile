# Build from repository root. Never copy credentials, database, media or weights.
FROM python:3.12-slim-bookworm
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
WORKDIR /app
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /tmp/requirements.txt \
    && groupadd --gid 10001 hyhq && useradd --uid 10001 --gid 10001 --home-dir /app hyhq
COPY --chown=10001:10001 backend /app
COPY --chown=10001:10001 deploy/cloud/entrypoint.sh /app/cloud-entrypoint.sh
RUN mkdir -p /app/var /app/staticfiles /tmp/hyhq-runtime \
    && chown -R 10001:10001 /app/var /app/staticfiles /tmp/hyhq-runtime \
    && chmod 755 /app/cloud-entrypoint.sh \
    && ENV=test HYHQ_USE_SQLITE=1 DJANGO_SETTINGS_MODULE=config.settings python manage.py collectstatic --noinput
USER 10001:10001
ENV DJANGO_SETTINGS_MODULE=config.cloud
EXPOSE 8000
ENTRYPOINT ["/app/cloud-entrypoint.sh"]
CMD ["serve"]
