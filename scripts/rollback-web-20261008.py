#!/usr/bin/env python3
"""Code-only rollback on the Beijing host. Preserve private data and usage ledgers."""
from pathlib import Path
import json
import os
import subprocess
import time
import urllib.request

BASE = Path('/srv/hyhq-web')
TARGET = BASE / 'releases/20261008-1920'
CURRENT = BASE / 'current'

def activate(target):
    link = BASE / 'rollback.next'
    if link.is_symlink():
        link.unlink()
    link.symlink_to(target)
    os.replace(link, CURRENT)
    subprocess.run(['systemctl', 'restart', 'hyhq-web.service'], check=True)

def healthy():
    for _ in range(10):
        try:
            req = urllib.request.Request('http://127.0.0.1:18787/api/v1/health/', headers={'Host': 'greatdata.asia'})
            with urllib.request.urlopen(req, timeout=3) as response:
                result = json.load(response)
                if response.status == 200 and result.get('data'):
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False

if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the Beijing host.')
    if not CURRENT.is_symlink() or not (TARGET / 'backend/server.cjs').is_file():
        raise SystemExit('Expected current link or previous release is missing.')
    previous = CURRENT.resolve()
    if previous == TARGET:
        raise SystemExit('Already on the requested previous release; no changes.')
    try:
        activate(TARGET)
        if not healthy():
            raise RuntimeError('Previous release failed its health check')
    except Exception:
        activate(previous)
        raise
    print('Code rolled back. Shared data, secrets and usage ledgers were retained.')
