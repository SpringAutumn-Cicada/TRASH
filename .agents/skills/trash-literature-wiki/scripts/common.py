"""Shared helpers for deterministic single-paper Wiki checks."""

from __future__ import annotations

import re
from pathlib import Path


import json
import os
import tempfile
from urllib.parse import unquote, urlsplit

CONTRACT = json.loads((Path(__file__).resolve().parent.parent / "contract.json").read_text())
REQUIRED_PAGES = CONTRACT["required_pages"]
NAVIGATION = CONTRACT["navigation"]


def pages(root: Path) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Wiki root must be a real directory")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"symlink rejected: {path}")
    result = sorted(root.rglob("*.md"))
    for path in result:
        if path.stat().st_size > 1048576:
            raise ValueError(f"file too large: {path}")
    return result


def atomic_write(path: Path, text: str) -> None:
    if path.is_symlink():
        raise ValueError(f"symlink rejected: {path}")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = file.name
        file.write(text)
    os.replace(temporary, path)


def links(text: str) -> list[tuple[str, str]]:
    text = re.sub(r"```[\s\S]*?```|~~~[\s\S]*?~~~", "", text)
    definitions = {m[1].strip().casefold(): m[2] or m[3] for m in re.finditer(r'^ {0,3}\[([^]\n]+)\]:\s*(?:<([^>]+)>|(\S+))', text, re.M)}
    result = [(m[1], m[2] or m[3]) for m in re.finditer(r'(?<!!)\[([^]\n]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)', text)]
    for m in re.finditer(r'(?<!!)\[([^]\n]+)\]\[([^]\n]*)\]', text):
        key = (m[2] or m[1]).strip().casefold()
        if key not in definitions:
            raise ValueError(f"undefined reference: {key}")
        result.append((m[1], definitions[key]))
    return result


def local_target(page: Path, target: str, root: Path) -> tuple[Path, str] | None:
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or target.startswith("/"):
        return None
    destination = (page.parent / unquote(parsed.path)).resolve() if parsed.path else page.resolve()
    if not destination.is_relative_to(root.resolve()):
        raise ValueError(f"link escapes Wiki: {target}")
    return destination, unquote(parsed.fragment)


def frontmatter(text: str) -> dict[str, str]:
    """Parse the simple scalar YAML used by Wiki frontmatter."""
    match = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
    if not match:
        return {}
    result: dict[str, str] = {}
    for line in match[1].splitlines():
        field = re.fullmatch(r"([a-z_]+):\s*([A-Za-z0-9_-]+)\s*", line)
        if field:
            if field[1] in result:
                raise ValueError(f"duplicate metadata field: {field[1]}")
            result[field[1]] = field[2]
    return result


def first_heading(text: str) -> str | None:
    match = re.search(r"(?m)^# (.+?)\s*$", text)
    return match.group(1).strip() if match else None


def source_id(root: Path) -> str | None:
    for name in ("whoami.md", "idcard.md"):
        path = root / name
        if path.exists():
            value = frontmatter(path.read_text(encoding="utf-8")).get("source_id")
            if value:
                return value
    return None


def cli_errors(main):
    """Consistent nonzero status without leaking a Python traceback."""
    import sys
    try:
        return main() or 0
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
