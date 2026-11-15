#!/usr/bin/env python3
"""Build the lightweight evidence.md index from evidence/ev-*.md files."""

from __future__ import annotations

import argparse
from pathlib import Path

from common import frontmatter, first_heading, source_id


def build(root: Path) -> Path:
    evidence_dir = root / "evidence"
    entries = sorted(evidence_dir.glob("ev-*.md"))
    title = first_heading((root / "whoami.md").read_text(encoding="utf-8")) if (root / "whoami.md").exists() else root.name
    sid = source_id(root) or root.name
    lines = [
        "---",
        "knowledge_version: 2",
        "kind: wiki-page",
        f"source_id: {sid}",
        "level: single",
        f"id: wiki-{sid}--evidence",
        "page_role: evidence-index",
        "---",
        "",
        title or root.name,
        "",
        "[论文总览](./whoami.md)",
        "",
        "# 依据总览",
        "",
    ]
    lines.extend(f"- [{path.stem}](./evidence/{path.name})" for path in entries)
    (root / "evidence.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return root / "evidence.md"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wiki", type=Path)
    args = parser.parse_args()
    path = build(args.wiki)
    print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    main()
