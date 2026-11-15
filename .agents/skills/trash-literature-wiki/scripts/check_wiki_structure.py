#!/usr/bin/env python3
"""Check the deterministic structure and metadata of one paper Wiki."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import cli_errors, REQUIRED_PAGES, frontmatter, first_heading, source_id, pages


def check(root: Path) -> list[str]:
    errors: list[str] = []
    if not root.is_dir():
        return [f"Wiki directory does not exist: {root}"]
    all_pages = pages(root)
    sid = source_id(root)
    if not sid:
        errors.append("missing source_id in whoami.md or idcard.md")
    for relative in REQUIRED_PAGES:
        path = root / relative
        if not path.is_file():
            errors.append(f"missing required page: {relative}")
            continue
        meta = frontmatter(path.read_text(encoding="utf-8"))
        for key in ("knowledge_version", "kind", "source_id", "level", "id"):
            if key not in meta:
                errors.append(f"{relative}: missing frontmatter field {key}")
        if meta.get("kind") != "wiki-page":
            errors.append(f"{relative}: kind must be wiki-page")
        if meta.get("level") != "single":
            errors.append(f"{relative}: level must be single")
        if sid and meta.get("source_id") not in (None, sid):
            errors.append(f"{relative}: source_id differs from {sid}")
        if not first_heading(path.read_text(encoding="utf-8")):
            errors.append(f"{relative}: missing一级标题")

    ids = set()
    for path in all_pages:
        relative = path.relative_to(root).as_posix()
        if relative not in REQUIRED_PAGES and not re.fullmatch(r"(?:method|results)/[a-z][a-z0-9_-]*\.md|evidence/ev-[a-z0-9][a-z0-9_-]*\.md", relative):
            errors.append(f"unexpected page: {relative}")
        meta = frontmatter(path.read_text(encoding="utf-8"))
        expected = f"wiki-{sid}--{relative[:-3].replace('/', '--')}"
        if meta.get("id") != expected or meta.get("id") in ids:
            errors.append(f"{relative}: invalid or duplicate stable id")
        ids.add(meta.get("id"))
        for key, value in {"knowledge_version":"2", "source_id":sid, "kind":"wiki-page", "level":"single"}.items():
            if meta.get(key) != value:
                errors.append(f"{relative}: invalid {key}")
        if relative == "evidence.md" and meta.get("page_role") != "evidence-index":
            errors.append("evidence.md: missing evidence-index role")
        if relative.startswith("evidence/"):
            if not re.fullmatch(r"[a-f0-9]{64}|unknown", meta.get("pdf_hash", "")):
                errors.append(f"{relative}: invalid pdf_hash")
            if meta.get("verification") not in ("unknown", "not-reverified", "verified"):
                errors.append(f"{relative}: missing or invalid verification")
            if path.stem != "ev-reading-scope" and meta.get("scope_ref") != "ev-reading-scope":
                errors.append(f"{relative}: missing scope_ref")
            if first_heading(path.read_text()) != path.stem:
                errors.append(f"{relative}: heading differs from filename")
    if not (root / "evidence/ev-reading-scope.md").is_file():
        errors.append("missing ev-reading-scope")
    evidence = root / "evidence"
    if evidence.is_dir():
        for path in sorted(evidence.glob("ev-*.md")):
            meta = frontmatter(path.read_text(encoding="utf-8"))
            if meta.get("page_role") != "evidence":
                errors.append(f"{path.relative_to(root)}: page_role must be evidence")
            if "pdf_hash" not in meta:
                errors.append(f"{path.relative_to(root)}: missing pdf_hash")
            if not re.search(r"(?m)^\[依据总览\]\(\.\./evidence\.md\)\s*$", path.read_text(encoding="utf-8")):
                errors.append(f"{path.relative_to(root)}: missing 依据总览 link")
            for field in ("定位", "事实", "边界"):
                if not re.search(rf"(?m)^\*\*{field}：\*\*\s*\S+", path.read_text(encoding="utf-8")):
                    errors.append(f"{path.relative_to(root)}: missing non-empty {field} field")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wiki", type=Path)
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable report")
    args = parser.parse_args()
    errors = check(args.wiki)
    if args.json:
        import json
        print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False))
        return 1 if errors else 0
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"OK: Wiki structure is valid: {args.wiki}")
    return 0


if __name__ == "__main__":
    sys.exit(cli_errors(main))
