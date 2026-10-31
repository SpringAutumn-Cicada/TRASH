"""Collect bounded analysis text from a platform-generated ZIP; never extract or execute it."""
import hashlib
import json
import pathlib
import re
import sys
import zipfile

archive, output = sys.argv[1:3]
MAX_FILE = 256 * 1024
MAX_TOTAL = 4 * 1024 * 1024
MAX_FILES = 100
skip_dirs = {'.git', '.agents', '.codex', '.claude', 'node_modules', '__pycache__', '.venv', 'venv', 'data', 'datasets', 'weights', 'checkpoints', 'vendor'}
env_names = {'environment.yml', 'environment.yaml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'pipfile.lock', 'poetry.lock', 'uv.lock', 'dockerfile', 'makefile', 'package.json', 'package-lock.json', 'pnpm-lock.yaml'}
def priority(path):
    name = path.name.lower()
    if name.startswith('readme') or name in env_names or name.startswith('requirements') or name.startswith('dockerfile'):
        return 0
    if path.suffix.lower() in {'.sh', '.bat', '.ps1'} or re.search(r'(install|setup|train|eval|main|run|infer)', name):
        return 1
    return 2

files, skipped = [], []
total = 0
with zipfile.ZipFile(archive) as source:
    entries = sorted((i for i in source.infolist() if not i.is_dir()), key=lambda i: (priority(pathlib.PurePosixPath(i.filename)), i.filename))
    for item in entries:
        path = pathlib.PurePosixPath(item.filename)
        reason = None
        name = path.name.lower()
        if path.is_absolute() or '..' in path.parts or '\\' in item.filename:
            raise ValueError('UNSAFE_INPUT_PATH')
        if any(part.lower() in skip_dirs for part in path.parts) or name in {'agents.md', 'skill.md', 'auth.json', 'credentials', 'id_rsa', 'id_ed25519'} or (name.startswith('.env') and name != '.env.example') or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'}:
            reason = 'excluded_sensitive_or_non_source'
        elif not (priority(path) < 2 or path.suffix.lower() in {'.py', '.md', '.rst', '.txt', '.toml', '.yaml', '.yml', '.json', '.cfg', '.ini', '.c', '.cpp', '.h', '.cu', '.js', '.ts', '.r'}):
            reason = 'not_analysis_text'
        elif item.file_size > MAX_FILE:
            reason = 'file_limit'
        elif len(files) >= MAX_FILES or total + item.file_size > MAX_TOTAL:
            reason = 'collection_limit'
        if reason:
            skipped.append({'path': item.filename, 'reason': reason})
            continue
        data = source.read(item)
        try:
            if b'\x00' in data:
                raise ValueError('binary')
            text = data.decode('utf-8')
        except (UnicodeDecodeError, ValueError):
            skipped.append({'path': item.filename, 'reason': 'binary_or_non_utf8'})
            continue
        text = re.sub(r'(?i)((?:password|passwd|api[_-]?key|secret|token)\s*[=:]\s*)[^\n,;]+', r'\1[REDACTED]', text)
        text = re.sub(r'\bsk-[A-Za-z0-9_-]+', '[REDACTED]', text)
        text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----', '[REDACTED PRIVATE KEY]', text)
        files.append({'path': item.filename, 'text': text, 'line_count': len(text.split('\n')), 'sha256': hashlib.sha256(data).hexdigest()})
        total += len(data)
json.dump({'files': files, 'coverage': {'selected_files': len(files), 'selected_bytes': total, 'skipped': skipped, 'limits': {'files': MAX_FILES, 'file_bytes': MAX_FILE, 'total_bytes': MAX_TOTAL}}}, open(output, 'w', encoding='utf8'), ensure_ascii=False)
