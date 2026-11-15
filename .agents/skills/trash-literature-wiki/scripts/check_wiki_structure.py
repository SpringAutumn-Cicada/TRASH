#!/usr/bin/env python3
"""Check the deterministic structure and metadata of one paper Wiki."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import REQUIRED_PAGES, frontmatter, first_heading, source_id


def check(root: Path) -> list[str]:
    errors: list[str] = []
    if not root.is_dir():
        return [f"Wiki directory does not exist: {root}"]
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
    args = parser.parse_args()
    errors = check(args.wiki)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"OK: Wiki structure is valid: {args.wiki}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
