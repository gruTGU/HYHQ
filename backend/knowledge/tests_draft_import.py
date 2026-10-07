"""Offline parser / isolated SQL tests: python3 -m unittest knowledge.tests_draft_import."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from knowledge.draft_import import (
    DATASET_ID, PREFIXES, ImportValidationError, canonical_json, checksum,
    export_jsonl, parse_source, sqlite_rollback, sqlite_stage,
)


def exchange():
    blocks = ['# Source data, not executable code\n```python\nraise RuntimeError("never execute")\n```\n']
    for category, prefix in PREFIXES.items():
        row = {
            'id': prefix + '-001', 'category': category, 'title': '观察记录',
            'city': '北京', 'district': '', 'entity_name': '', 'parent_entity': '',
            'is_campus': False, 'institution': '', 'tags': ['观察'], 'summary': '原始概要',
            'observation_task': '非实测建议', 'access_note': '仅开放区域',
            'source_urls': ['https://example.org/source'], 'source_scope': '背景资料',
            'related_ids': ['RIV-001'] if category == 'routes' else [],
            'related_place_names': ['地点'] if category == 'routes' else [],
            'route_nodes': ['入口', '出口'] if category == 'routes' else [],
            'verification_date': '2026-10-07', 'editorial_status': 'draft_review_required',
            'related_plants': '', 'body_char_count': 6,
        }
        blocks.append('\n'.join([
            f'<!-- HYHQ_CATEGORY_BEGIN code="{category}" -->',
            f'<!-- HYHQ_RECORD_BEGIN id="{row["id"]}" -->',
            '### Title', '<!-- HYHQ_META_BEGIN -->', '```json',
            json.dumps(row, ensure_ascii=False, indent=2), '```', '<!-- HYHQ_META_END -->',
            '<!-- HYHQ_BODY_BEGIN -->', '正文原样\n\n保留。', '<!-- HYHQ_BODY_END -->',
            f'<!-- HYHQ_RECORD_END id="{row["id"]}" -->',
            f'<!-- HYHQ_CATEGORY_END code="{category}" -->',
        ]))
    return '\n'.join(blocks) + '\n'


class DraftImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source.md'
        self.original = exchange()
        self.source.write_text(self.original, encoding='utf-8')
        self.db = self.root / 'isolated.sqlite3'

    def parse(self, source=None):
        if source is not None:
            self.source.write_text(source, encoding='utf-8')
        return parse_source(self.source, expected_per_category=1)

    def test_full_fidelity_and_stable_ids(self):
        docs, report = self.parse()
        self.assertEqual(docs, self.parse()[0])
        self.assertEqual(report['records'], 12)
        self.assertEqual(report['body_char_count'], 72)
        self.assertEqual(docs[0]['_id'], 'hyhq-supplement-v1-riv-001')
        self.assertEqual(docs[0]['source_record']['body_md'], '正文原样\n\n保留。')
        self.assertTrue(all(doc['published'] is False for doc in docs))
        self.assertTrue(all(doc['editorial_status'] == 'draft_review_required' for doc in docs))
        self.assertEqual(docs[0]['provenance']['source_sha256'], checksum(self.source.read_bytes()))
        self.assertNotIn('latitude', canonical_json(docs))

    def test_export_is_byte_identical(self):
        docs, _ = self.parse()
        first = export_jsonl(docs, self.root / 'first.jsonl')
        second = export_jsonl(docs, self.root / 'second.jsonl')
        self.assertEqual(first['jsonl_sha256'], second['jsonl_sha256'])
        self.assertEqual(len((self.root / 'first.jsonl').read_text().splitlines()), 12)

    def test_rejects_structural_and_semantic_corruption(self):
        replacements = [
            ('HYHQ_RECORD_END id="RIV-001"', 'HYHQ_RECORD_END id="RIV-002"'),
            ('HYHQ_CATEGORY_END code="rivers"', 'HYHQ_CATEGORY_END code="parks"'),
            ('<!-- HYHQ_META_END -->', '<!-- HYHQ_META_MISSING -->'),
            ('<!-- HYHQ_BODY_END -->', ''),
            ('"category": "rivers"', '"category": "parks"'),
            ('"id": "RIV-001"', '"id": "RIV-001", "id": "RIV-002"'),
            ('"body_char_count": 6', '"body_char_count": 5'),
            ('"is_campus": false', '"is_campus": "false"'),
            ('"editorial_status": "draft_review_required"', '"editorial_status": "published"'),
            ('https://example.org/source', 'javascript:alert(1)'),
            ('https://example.org/source', 'https://user:password@example.org/source'),
            ('"verification_date": "2026-10-07"', '"verification_date": "2026-02-30"'),
            ('"related_ids": []', '"related_ids": ["MISSING-001"]'),
            ('"related_ids": []', '"related_ids": ["RIV-001"]'),
            ('"source_urls": [', '"unknown_urls": ['),
            ('"route_nodes": []', '"route_nodes": ["invented node"]'),
            ('<!-- HYHQ_CATEGORY_BEGIN code="rivers" -->', ' <!-- HYHQ_CATEGORY_BEGIN code="rivers" -->'),
        ]
        for before, after in replacements:
            with self.subTest(before=before):
                with self.assertRaises(ImportValidationError):
                    self.parse(self.original.replace(before, after, 1))

    def test_duplicate_and_missing_records_rejected(self):
        for source in [self.original + self.original, self.original[:self.original.index('<!-- HYHQ_CATEGORY_BEGIN code="tulip"')]]:
            with self.subTest(source_length=len(source)):
                with self.assertRaises(ImportValidationError):
                    self.parse(source)

    def test_preview_does_not_create_database(self):
        docs, _ = self.parse()
        result = sqlite_stage(docs, self.db)
        self.assertEqual(result['would_create'], 12)
        self.assertEqual(result['created'], 0)
        self.assertFalse(self.db.exists())

    def test_sqlite_repeat_preserves_every_row(self):
        docs, _ = self.parse()
        initial = sqlite_stage(docs, self.db, apply=True)
        repeat = sqlite_stage(docs, self.db, apply=True)
        self.assertEqual(initial['created'], 12)
        self.assertEqual(repeat['created'], 0)
        self.assertEqual(repeat['unchanged'], 12)
        self.assertEqual(repeat['created_documents'], {})

    def test_conflict_preflight_is_atomic(self):
        docs, _ = self.parse()
        sqlite_stage(docs[:1], self.db, apply=True)
        changed = copy.deepcopy(docs)
        changed[0]['source_record']['summary'] = 'later source revision'
        changed[0]['provenance']['record_sha256'] = checksum(changed[0]['source_record'])
        result = sqlite_stage(changed, self.db, apply=True)
        self.assertEqual(result['operation'], 'conflict_no_changes')
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM content_drafts').fetchone()[0], 1)

    def test_admin_edit_and_source_provenance_conflict(self):
        docs, _ = self.parse()
        sqlite_stage(docs, self.db, apply=True)
        for field, value in [('editorial_status', 'approved'), ('published', True)]:
            changed = copy.deepcopy(docs)
            changed[0][field] = value
            self.assertEqual(sqlite_stage(changed, self.db, apply=True)['conflicts'], [docs[0]['_id']])
        changed = copy.deepcopy(docs)
        changed[0]['provenance']['source_sha256'] = '0' * 64
        self.assertEqual(sqlite_stage(changed, self.db, apply=True)['conflicts'], [docs[0]['_id']])

    def test_rollback_exact_receipt_leaves_prior_rows(self):
        docs, report = self.parse()
        sqlite_stage(docs[:1], self.db, apply=True)
        report['sqlite'] = sqlite_stage(docs, self.db, apply=True)
        self.assertEqual(sqlite_rollback(self.db, report)['would_remove'], 11)
        self.assertEqual(sqlite_rollback(self.db, report, apply=True)['removed'], 11)
        self.assertEqual(sqlite_rollback(self.db, report, apply=True)['removed'], 0)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute('SELECT document_id FROM content_drafts').fetchall(), [(docs[0]['_id'],)])

    def test_rollback_preserves_edits_and_aborts_whole_batch(self):
        docs, report = self.parse()
        report['sqlite'] = sqlite_stage(docs, self.db, apply=True)
        with sqlite3.connect(self.db) as connection:
            connection.execute('UPDATE content_drafts SET document_json=? WHERE document_id=?', ('{}', docs[0]['_id']))
        result = sqlite_rollback(self.db, report, apply=True)
        self.assertEqual(result['operation'], 'rollback_conflict_no_changes')
        self.assertEqual(result['removed'], 0)
        with sqlite3.connect(self.db) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM content_drafts').fetchone()[0], 12)

    def test_invalid_rollback_receipts_rejected_before_database_access(self):
        for receipt in ([], {}, {'dataset_id': DATASET_ID, 'sqlite': []},
                        {'dataset_id': DATASET_ID, 'sqlite': {'created_documents': {'hyhq-supplement-v1-riv-001': None}}}):
            with self.subTest(receipt=receipt):
                with self.assertRaises(ImportValidationError):
                    sqlite_rollback(self.db, receipt, apply=True)
        self.assertFalse(self.db.exists())


if __name__ == '__main__':
    unittest.main()
