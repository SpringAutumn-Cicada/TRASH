#!/usr/bin/env python3
"""Explicit local cleanup of obsolete cards/Wiki; never invoked on server startup."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--home', required=True)
parser.add_argument('--backup', required=True)
args = parser.parse_args()
home = Path(args.home).resolve()
backup = Path(args.backup).resolve()
backup.mkdir(parents=True, exist_ok=False, mode=0o700)
db = sqlite3.connect(home / 'workspace.sqlite')
if db.execute("select count(*) from knowledge_tasks where status in ('queued','running')").fetchone()[0]:
    raise RuntimeError('Active knowledge tasks; no deletion performed')
projects = [row[0] for row in db.execute('select project_id from projects')]
for project in projects:
    for file in (home / 'projects' / project / 'code-agent').glob('*.json'):
        task = json.loads(file.read_text())
        if task.get('status') in ('running', 'cancelling', 'interrupted'):
            raise RuntimeError('Active or uncertain agent task; no deletion performed')
with sqlite3.connect(backup / 'workspace.sqlite') as target:
    db.backup(target)
os.chmod(backup / 'workspace.sqlite', 0o600)
rows = db.execute("select object_id,project_id,kind from knowledge_versions where kind in ('literature-card','wiki-page')").fetchall()
ids = {row[0] for row in rows}
tasks = [(row[0], row[1]) for row in db.execute('select task_id,project_id,data from knowledge_tasks') if json.loads(row[2]).get('input', {}).get('kind') in ('literature-card', 'wiki-page')]
targets = set()
for project in projects:
    root = (home / 'projects' / project).resolve()
    for folder in ('literature/cards', 'wiki'):
        directory = root / folder
        if not directory.exists():
            continue
        if directory.is_symlink():
            raise RuntimeError('Unexpected directory symlink')
        for file in directory.glob('*.md'):
            if file.is_symlink():
                raise RuntimeError('Unexpected file symlink')
            text = file.read_text()
            if text.startswith('---\nmetadata: '):
                metadata = json.loads(text.splitlines()[1][len('metadata: '):])
                if metadata.get('project_id') == project and metadata.get('kind') in ('literature-card', 'wiki-page'):
                    if not re.fullmatch(r'knowledge_[A-Za-z0-9-]+', metadata.get('object_id', '')):
                        raise RuntimeError('Invalid legacy object ID')
                    ids.add(metadata['object_id'])
                    targets.add(file)
    for object_id in ids:
        for folder, suffix in (('knowledge-history',''), ('knowledge-state','.json'), ('knowledge-pending','.json')):
            path = root / '.trash' / folder / (object_id + suffix)
            if path.exists():
                targets.add(path)
    for task_id, task_project in tasks:
        if task_project == project and (root / 'tasks' / task_id).exists():
            targets.add(root / 'tasks' / task_id)
    for path in (root / 'literature-analysis', root / 'agent-workspace' / 'project_snapshot.json'):
        if path.exists():
            targets.add(path)
manifest = {'at': datetime.now(timezone.utc).isoformat(), 'home': str(home), 'objects': len(set(row[0] for row in rows)), 'versions': len(rows), 'tasks': len(tasks), 'targets': []}
for index, path in enumerate(sorted(targets)):
    if path.is_symlink():
        raise RuntimeError('Unexpected cleanup symlink')
    copy = backup / 'files' / str(index)
    copy.parent.mkdir(exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, copy, symlinks=True)
    else:
        shutil.copy2(path, copy)
        if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(copy.read_bytes()).digest():
            raise RuntimeError('Backup mismatch')
    manifest['targets'].append({'original': str(path), 'backup': str(copy)})
(backup / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
with db:
    db.execute('begin immediate')
    for task_id, _ in tasks:
        db.execute('delete from knowledge_task_events where task_id=?', (task_id,))
        db.execute('delete from knowledge_tasks where task_id=?', (task_id,))
    for object_id in ids:
        db.execute('delete from knowledge_reviews where object_id=?', (object_id,))
        db.execute('delete from knowledge_metrics where object_id=?', (object_id,))
    db.execute("delete from knowledge_keys where kind in ('literature-card','wiki-page')")
    db.execute("delete from knowledge_versions where kind in ('literature-card','wiki-page')")
for path in sorted(targets):
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()
remaining = db.execute("select count(*) from knowledge_versions where kind in ('literature-card','wiki-page')").fetchone()[0]
print(json.dumps({'backup': str(backup), 'objects_removed': manifest['objects'], 'versions_removed': manifest['versions'], 'tasks_removed': len(tasks), 'paths_removed': len(targets), 'remaining_legacy_versions': remaining}, ensure_ascii=False))
