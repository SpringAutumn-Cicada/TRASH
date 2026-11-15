#!/usr/bin/env python3
"""Build the lightweight evidence.md index from evidence/ev-*.md files."""

from __future__ import annotations

import argparse
from pathlib import Path

from common import cli_errors, frontmatter, first_heading, source_id, pages, atomic_write


def build(root: Path) -> Path:
    pages(root)
    evidence_dir = root / "evidence"
    entries = sorted(evidence_dir.glob("ev-*.md"))
    if not entries:
        raise ValueError("缺少独立依据文件：evidence/ev-*.md 未生成。目录脚本只能汇总已有条目，不能代写依据；请先补齐 ev-reading-scope.md 和正文引用的依据，再生成目录。")
    if not (root / "whoami.md").is_file() or not source_id(root):
        raise ValueError("missing Wiki identity")
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
    existing = root / "evidence.md"
    if existing.exists():
        text = existing.read_text(encoding="utf-8")
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            raise ValueError("existing index has invalid frontmatter")
        header, body = text[4:].split("\n---\n", 1)
        if frontmatter(text).get("id") != f"wiki-{sid}--evidence":
            raise ValueError("existing index stable id mismatch")
        after_heading = body.split("# ", 1)[-1].split("\n", 1)[-1]
        if any(line.strip() and not line.lstrip().startswith("- [") for line in after_heading.splitlines()):
            raise ValueError("index contains manual content; preserve and resolve explicitly")
        lines = ["---", header, "---", "", title, "", "[论文总览](./whoami.md)", "", "# 依据总览", ""]
    lines.extend(f"- [{path.stem}](./evidence/{path.name})" for path in entries)
    atomic_write(root / "evidence.md", "\n".join(lines) + "\n")
    return root / "evidence.md"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wiki", type=Path)
    args = parser.parse_args()
    path = build(args.wiki)
    print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_errors(main))
