#!/usr/bin/env python3
"""Create a compact JSON manifest for staged Agent Wiki retrieval."""

from __future__ import annotations

import argparse
import json
import hashlib
from pathlib import Path

from common import cli_errors, REQUIRED_PAGES, frontmatter, first_heading, source_id, pages, links, atomic_write


def build(root: Path) -> dict:
    pages = {}
    for path in pages(root):
        relative = path.relative_to(root).as_posix()
        if path.exists():
            pages[relative.removesuffix(".md").replace("/", ".")] = {
                "path": relative,
                "hash": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
                "references": [{"label": label, "target": target} for label, target in links(path.read_text())],
                "title": first_heading(path.read_text(encoding="utf-8")),
            }
    evidence = []
    for path in sorted((root / "evidence").glob("ev-*.md")) if (root / "evidence").is_dir() else []:
        meta = frontmatter(path.read_text(encoding="utf-8"))
        evidence.append({
            "slug": path.stem,
            "path": str(path.relative_to(root)),
            "verification": meta.get("verification", "unknown"),
            "scope_ref": meta.get("scope_ref"),
            "title": first_heading(path.read_text(encoding="utf-8")),
        })
    return {
        "source_id": source_id(root) or root.name,
        "pages": pages,
        "evidence": evidence,
        "retrieval_order": ["whoami", "research_problem", "method.method", "results.results", "insights"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wiki", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output or args.wiki / "wiki-context-manifest.json"
    atomic_write(output, json.dumps(build(args.wiki), ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_errors(main))
