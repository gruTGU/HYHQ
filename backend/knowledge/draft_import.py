"""Strict, offline exchange parser for the 2026-10-07 content supplement.

This module has no Django dependency. Markdown, JSON values and URLs are data:
the importer never executes examples, fetches URLs or creates public content.
"""
from collections import Counter
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit


DATASET_ID = 'hyhq-beijing-tianjin-20261007-v1'
COLLECTION = 'content_drafts'
PREFIXES = dict(zip(
    ('rivers', 'parks', 'walk_sites', 'scenic', 'wetlands', 'nature_notes',
     'routes', 'daisy', 'dandelion', 'rosa', 'sunflower', 'tulip'),
    ('RIV', 'PARK', 'WALK', 'SCEN', 'WET', 'NOTE', 'ROUTE', 'DAISY', 'DAND', 'ROSA', 'SUN', 'TULIP'),
))
TEXT_FIELDS = {
    'id', 'category', 'title', 'city', 'district', 'entity_name', 'parent_entity',
    'institution', 'summary', 'observation_task', 'access_note', 'source_scope',
    'verification_date', 'editorial_status', 'related_plants',
}
LIST_FIELDS = {'tags', 'source_urls', 'related_ids', 'related_place_names', 'route_nodes'}
FIELDS = TEXT_FIELDS | LIST_FIELDS | {'is_campus', 'body_char_count'}
CJK = re.compile(r'[\u4e00-\u9fff]')
MARKER = re.compile(r'<!-- HYHQ_(CATEGORY|RECORD)_(BEGIN|END) (code|id)="([A-Za-z0-9_-]+)" -->')


class ImportValidationError(ValueError):
    pass


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def checksum(value):
    if not isinstance(value, bytes):
        value = canonical_json(value).encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def _error(message, line=None):
    raise ImportValidationError(f'line {line}: {message}' if line else message)


def _unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _error(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def _section(lines, start, end, line_number):
    if lines.count(start) != 1 or lines.count(end) != 1:
        _error(f'exactly one {start} / {end} required', line_number)
    first, last = lines.index(start), lines.index(end)
    if last <= first:
        _error(f'inverted section {start}', line_number)
    return first, last, lines[first + 1:last]


def _record(lines, marker_id, category, start_line):
    m1, m2, meta = _section(lines, '<!-- HYHQ_META_BEGIN -->', '<!-- HYHQ_META_END -->', start_line)
    b1, b2, body = _section(lines, '<!-- HYHQ_BODY_BEGIN -->', '<!-- HYHQ_BODY_END -->', start_line)
    if not m1 < m2 < b1 < b2 or not meta or meta[0] != '```json' or meta[-1] != '```':
        _error('metadata must contain one JSON fence, followed by body', start_line)
    outside = lines[:m1] + lines[m2 + 1:b1] + lines[b2 + 1:]
    if any(line.strip() and not line.startswith('### ') for line in outside):
        _error('unexpected text outside metadata/body', start_line)
    if any('<!-- HYHQ_' in line for line in meta + body):
        _error('reserved marker inside metadata/body', start_line)
    try:
        row = json.loads('\n'.join(meta[1:-1]), object_pairs_hook=_unique_json,
                         parse_constant=lambda value: _error(f'invalid JSON constant: {value}'))
    except (ValueError, TypeError) as exc:
        _error(f'invalid metadata: {exc}', start_line)
    if not isinstance(row, dict) or set(row) != FIELDS:
        _error('metadata fields differ from fixed exchange schema', start_line)
    if any(not isinstance(row[key], str) for key in TEXT_FIELDS):
        _error('text field type mismatch', start_line)
    if any(not isinstance(row[key], list) or any(not isinstance(x, str) or not x.strip() for x in row[key]) for key in LIST_FIELDS):
        _error('list fields must contain nonempty strings', start_line)
    if type(row['is_campus']) is not bool or type(row['body_char_count']) is not int:
        _error('invalid boolean or body_char_count', start_line)
    if row['id'] != marker_id or row['category'] != category:
        _error('record ID/category does not match enclosing marker', start_line)
    if not re.fullmatch(PREFIXES[category] + r'-\d{3}', row['id']):
        _error('invalid ID prefix/format', start_line)
    if not all(row[key].strip() for key in ('title', 'summary', 'source_scope')):
        _error('missing title, summary or source scope', start_line)
    if category in {'rivers', 'parks', 'walk_sites', 'scenic', 'wetlands', 'routes'} and not row['access_note'].strip():
        _error('place/route requires an access boundary', start_line)
    if row['editorial_status'] != 'draft_review_required':
        _error('all imported records must remain draft_review_required', start_line)
    if row['city'] not in {'北京', '天津', '通用', '京津通用'}:
        _error('unsupported city scope', start_line)
    try:
        if date.fromisoformat(row['verification_date']).isoformat() != row['verification_date']:
            raise ValueError('date must use YYYY-MM-DD')
    except ValueError as exc:
        _error(f'invalid verification_date: {exc}', start_line)
    if not row['source_urls']:
        _error('source_urls cannot be empty', start_line)
    for url in row['source_urls']:
        parsed = urlsplit(url)
        if parsed.scheme not in {'https', 'http'} or not parsed.hostname or parsed.username or parsed.password or re.search(r'\s', url):
            _error(f'invalid source URL for {marker_id}', start_line)
    if (category == 'routes') != bool(row['route_nodes']):
        _error('route_nodes required only for routes', start_line)
    if len(row['related_ids']) != len(set(row['related_ids'])):
        _error('duplicate related_ids', start_line)
    row['body_md'] = '\n'.join(body)
    if not row['body_md'].strip() or len(CJK.findall(row['body_md'])) != row['body_char_count']:
        _error('body_char_count does not match preserved body', start_line)
    return row


def parse_source(source_path, expected_per_category=100):
    """Validate the entire file before exporting or writing any database row."""
    path = Path(source_path)
    raw = path.read_bytes()
    source_sha = checksum(raw)
    try:
        source = raw.decode('utf-8')
    except UnicodeDecodeError as exc:
        _error(f'source must be UTF-8: {exc}')
    category = record_id = None
    buffer, documents, seen_categories, seen_ids = [], [], set(), set()
    record_start = None
    for number, line in enumerate(source.splitlines(), 1):
        match = MARKER.fullmatch(line)
        if match:
            kind, boundary, attribute, value = match.groups()
            if attribute != ('code' if kind == 'CATEGORY' else 'id'):
                _error('marker attribute mismatch', number)
            if kind == 'CATEGORY':
                if record_id:
                    _error('category marker inside record', number)
                if boundary == 'BEGIN':
                    if category or value in seen_categories or value not in PREFIXES:
                        _error('nested, repeated or unknown category', number)
                    category = value
                    seen_categories.add(value)
                elif value != category:
                    _error('unmatched category end', number)
                else:
                    category = None
            elif boundary == 'BEGIN':
                if not category or record_id or value in seen_ids:
                    _error('record outside category, nested or duplicate ID', number)
                record_id, record_start, buffer = value, number, []
                seen_ids.add(value)
            else:
                if record_id != value:
                    _error('unmatched record end', number)
                row = _record(buffer, record_id, category, record_start)
                documents.append({
                    '_id': 'hyhq-supplement-v1-' + row['id'].lower(),
                    'schema_version': 1, 'dataset_id': DATASET_ID,
                    'source_id': row['id'], 'category': row['category'],
                    'title': row['title'], 'city': row['city'], 'summary': row['summary'],
                    'editorial_status': 'draft_review_required', 'published': False,
                    'source_record': row,
                    'provenance': {
                        'source_filename': path.name, 'source_sha256': source_sha,
                        'record_sha256': checksum(row),
                        'source_line_start': record_start, 'source_line_end': number,
                    },
                })
                record_id, buffer = None, []
        elif record_id:
            if line.lstrip().startswith('<!-- HYHQ_') and line not in {
                '<!-- HYHQ_META_BEGIN -->', '<!-- HYHQ_META_END -->',
                '<!-- HYHQ_BODY_BEGIN -->', '<!-- HYHQ_BODY_END -->',
            }:
                _error('malformed reserved marker', number)
            buffer.append(line)
        elif line.lstrip().startswith('<!-- HYHQ_'):
            _error('unexpected or malformed reserved marker', number)
    if category or record_id:
        _error('unclosed category or record')
    counts = Counter(doc['category'] for doc in documents)
    if counts != Counter({name: expected_per_category for name in PREFIXES}):
        _error(f'category counts differ from expected {expected_per_category}: {dict(counts)}')
    expected_ids = {f'{prefix}-{n:03d}' for prefix in PREFIXES.values() for n in range(1, expected_per_category + 1)}
    if seen_ids != expected_ids:
        _error('IDs must form the complete declared sequence in every category')
    for doc in documents:
        for related in doc['source_record']['related_ids']:
            if related not in seen_ids or related == doc['source_id']:
                _error(f'invalid related_id {related} in {doc["source_id"]}')
    report = {
        'dataset_id': DATASET_ID, 'collection': COLLECTION, 'source_filename': path.name,
        'source_sha256': source_sha, 'records': len(documents), 'category_counts': dict(counts),
        'body_char_count': sum(d['source_record']['body_char_count'] for d in documents),
        'source_url_count': sum(len(d['source_record']['source_urls']) for d in documents),
        'unique_source_urls': len({url for d in documents for url in d['source_record']['source_urls']}),
        'related_id_count': sum(len(d['source_record']['related_ids']) for d in documents),
        'route_node_count': sum(len(d['source_record']['route_nodes']) for d in documents),
        'city_counts': dict(Counter(d['city'] for d in documents)),
        'drafts': len(documents), 'published': 0, 'coordinates_added': 0,
        'source_urls_fetched': False, 'remote_writes': False,
    }
    return documents, report


def export_jsonl(documents, output_path):
    payload = ''.join(canonical_json(doc) + '\n' for doc in documents).encode('utf-8')
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    return {'jsonl_path': str(output.resolve()), 'jsonl_sha256': checksum(payload), 'jsonl_bytes': len(payload)}


def sqlite_stage(documents, database_path, apply=False):
    """Isolated rehearsal database, never application tables or a remote server.

    Exact documents are immutable under this importer. A changed source or any
    administrator modification is a conflict, even when the source ID matches.
    """
    path = Path(database_path)
    if not path.exists() and not apply:
        return {'operation': 'preview', 'created': 0, 'would_create': len(documents), 'unchanged': 0, 'conflicts': [], 'created_documents': {}}
    if apply:
        path.parent.mkdir(parents=True, exist_ok=True)
    uri = path.resolve().as_uri() + ('?mode=rwc' if apply else '?mode=ro')
    connection = sqlite3.connect(uri, uri=True)
    try:
        if apply:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('CREATE TABLE IF NOT EXISTS content_drafts (document_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, record_sha256 TEXT NOT NULL, document_json TEXT NOT NULL)')
        elif not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_drafts'").fetchone():
            return {'operation': 'preview', 'created': 0, 'would_create': len(documents), 'unchanged': 0, 'conflicts': [], 'created_documents': {}}
        pending, conflicts, unchanged = [], [], 0
        for doc in documents:
            serialized = canonical_json(doc)
            current = connection.execute('SELECT document_json FROM content_drafts WHERE document_id=?', (doc['_id'],)).fetchone()
            if current is None:
                pending.append((doc, serialized))
            elif current[0] == serialized:
                unchanged += 1
            else:
                conflicts.append(doc['_id'])
        result = {'operation': 'apply' if apply else 'preview', 'created': 0, 'would_create': len(pending), 'unchanged': unchanged, 'conflicts': conflicts, 'created_documents': {}}
        if conflicts:
            connection.rollback()
            result['operation'] = 'conflict_no_changes'
            return result
        if apply:
            connection.executemany('INSERT INTO content_drafts VALUES (?, ?, ?, ?)', [(doc['_id'], doc['dataset_id'], doc['provenance']['record_sha256'], serialized) for doc, serialized in pending])
            connection.commit()
            result['created'] = len(pending)
            result['created_documents'] = {doc['_id']: checksum(serialized.encode('utf-8')) for doc, serialized in pending}
        return result
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def sqlite_rollback(database_path, receipt, apply=False):
    """Delete only receipt-owned rows whose complete document is still unchanged."""
    if not isinstance(receipt, dict) or not isinstance(receipt.get('sqlite'), dict):
        _error('invalid rollback receipt')
    owned = receipt.get('sqlite', {}).get('created_documents', {})
    if receipt.get('dataset_id') != DATASET_ID or not isinstance(owned, dict):
        _error('invalid rollback receipt')
    if any(not isinstance(key, str) or not key.startswith('hyhq-supplement-v1-') or not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value) for key, value in owned.items()):
        _error('invalid rollback document identity/checksum')
    connection = sqlite3.connect(Path(database_path).resolve().as_uri() + '?mode=rw', uri=True)
    try:
        connection.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        removable, conflicts, missing = [], [], []
        for doc_id, expected_sha in owned.items():
            row = connection.execute('SELECT dataset_id, document_json FROM content_drafts WHERE document_id=?', (doc_id,)).fetchone()
            if not row:
                missing.append(doc_id)
            elif row[0] != DATASET_ID or checksum(row[1].encode('utf-8')) != expected_sha:
                conflicts.append(doc_id)
            else:
                removable.append(doc_id)
        result = {'operation': 'rollback_apply' if apply else 'rollback_preview', 'would_remove': len(removable), 'removed': 0, 'missing': missing, 'conflicts': conflicts}
        if conflicts:
            result['operation'] = 'rollback_conflict_no_changes'
            connection.rollback()
        elif apply:
            connection.executemany('DELETE FROM content_drafts WHERE document_id=?', [(key,) for key in removable])
            connection.commit()
            result['removed'] = len(removable)
        return result
    finally:
        connection.close()
