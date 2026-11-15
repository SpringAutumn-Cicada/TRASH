#!/usr/bin/env python3
"""Check local Markdown links and the fixed Wiki navigation."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import NAVIGATION

LINK_RE = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")


def check(root: Path) -> list[str]:
    errors: list[str] = []
    whoami = root / "whoami.md"
    if not whoami.exists():
        return ["missing whoami.md"]
    text = whoami.read_text(encoding="utf-8")
    for label, target in NAVIGATION:
        if not re.search(rf"\[{re.escape(label)}\]\({re.escape('./' + target)}\)", text):
            errors.append(f"whoami.md: missing navigation link [{label}](./{target})")
    for page in sorted(root.rglob("*.md")):
        content = page.read_text(encoding="utf-8")
        for raw in LINK_RE.findall(content):
            target = raw.split("#", 1)[0].strip()
            if not target or "://" in target or target.startswith("/"):
                continue
            destination = (page.parent / target).resolve()
            if not destination.exists():
                errors.append(f"{page.relative_to(root)}: broken link {raw}")
    for page in sorted((root / "evidence").glob("ev-*.md")) if (root / "evidence").is_dir() else []:
        if not re.search(r"\[依据总览\]\(\.\./evidence\.md\)", page.read_text(encoding="utf-8")):
            errors.append(f"{page.relative_to(root)}: missing return link to evidence.md")
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
    print(f"OK: Wiki links are valid: {args.wiki}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
