#!/usr/bin/env python3
"""Validate a draft exchange file; export cloud JSONL or rehearse local SQLite."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from knowledge.draft_import import (ImportValidationError, canonical_json, export_jsonl,
                                    parse_source, sqlite_rollback, sqlite_stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path)
    parser.add_argument('--jsonl', type=Path, help='Write validated JSONL for the private content_drafts collection; never uploads.')
    parser.add_argument('--report', required=True, type=Path, help='JSON validation report and rollback receipt.')
    parser.add_argument('--sqlite', type=Path, help='Explicit isolated local rehearsal database.')
    parser.add_argument('--apply', action='store_true', help='Write the local SQLite database. Default only previews.')
    parser.add_argument('--rollback', type=Path, help='Undo rows created by this earlier report, checking exact document checksums.')
    args = parser.parse_args()
    if args.apply and not args.sqlite:
        parser.error('--apply requires --sqlite; this command cannot write a cloud database')
    if args.rollback and (not args.sqlite or args.source or args.jsonl):
        parser.error('--rollback requires --sqlite and cannot be combined with source or --jsonl')
    if not args.rollback and not args.source:
        parser.error('source is required unless --rollback is used')
    inputs = [path.resolve() for path in (args.source, args.sqlite, args.rollback) if path]
    outputs = [path.resolve() for path in (args.report, args.jsonl) if path]
    if len(set(outputs)) != len(outputs) or set(inputs) & set(outputs):
        parser.error('source, SQLite, receipt, JSONL and report paths must be distinct')
    if args.apply and args.report.exists():
        parser.error('write operations require a new report path, to preserve earlier rollback receipts')
    try:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        if args.rollback:
            receipt = json.loads(args.rollback.read_text(encoding='utf-8'))
            result = sqlite_rollback(args.sqlite, receipt, args.apply)
            report = {'dataset_id': receipt['dataset_id'], 'sqlite': result}
        else:
            documents, report = parse_source(args.source)
            if args.sqlite:
                report['sqlite'] = sqlite_stage(documents, args.sqlite, args.apply)
            if args.jsonl and not report.get('sqlite', {}).get('conflicts'):
                report.update(export_jsonl(documents, args.jsonl))
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        summary = {key: value for key, value in report.items() if key != 'sqlite'}
        if 'sqlite' in report:
            summary['sqlite'] = {key: value for key, value in report['sqlite'].items() if key != 'created_documents'}
        print(canonical_json(summary))
        return 2 if report.get('sqlite', {}).get('conflicts') else 0
    except (ImportValidationError, OSError, ValueError, sqlite3.Error) as exc:
        print(f'Import rejected: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
