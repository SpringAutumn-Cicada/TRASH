#!/usr/bin/env python3
"""Check local Markdown links and the fixed Wiki navigation."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from common import cli_errors, NAVIGATION, pages, links, local_target


def check(root: Path) -> list[str]:
    errors = []
    all_pages = pages(root)
    graph = {}
    whoami = root / "whoami.md"
    if not whoami.is_file():
        return ["missing whoami.md"]
    navigation = links(whoami.read_text())
    positions = []
    for label, target in NAVIGATION:
        matches = [i for i, (name, raw) in enumerate(navigation) if name == label and raw.removeprefix("./") == target]
        if len(matches) != 1:
            errors.append(f"whoami.md: missing or duplicate navigation {label}")
        else:
            positions.append(matches[0])
        if not re.search(rf"\[{re.escape(label)}\].*?[：:]\s*\S", whoami.read_text()):
            errors.append(f"whoami.md: missing description for {label}")
    if positions != sorted(positions):
        errors.append("whoami.md: navigation out of order")
    for page in all_pages:
        graph[page.resolve()] = []
        for label, raw in links(page.read_text()):
            target = local_target(page, raw, root)
            if target is None:
                continue
            destination, fragment = target
            if not destination.is_file():
                errors.append(f"{page.relative_to(root)}: broken link {raw}")
                continue
            graph[page.resolve()].append(destination)
            if destination.parent.name == "evidence" and destination.stem.startswith("ev-") and label != destination.stem:
                errors.append(f"{page.relative_to(root)}: evidence label must be {destination.stem}")
            if fragment:
                body = destination.read_text()
                anchors = re.findall(r'(?:id|name)=["\']([^"\']+)', body)
                for heading in re.findall(r"^#+ (.+)$", body, re.M):
                    anchors.append(re.sub(r"[^\w\s-]", "", heading.lower()).replace(" ", "-"))
                if fragment not in anchors:
                    errors.append(f"{page.relative_to(root)}: missing anchor {raw}")
    reachable = {whoami.resolve()}
    pending = [whoami.resolve()]
    while pending:
        for target in graph.get(pending.pop(), []):
            if target not in reachable:
                reachable.add(target)
                pending.append(target)
    for page in all_pages:
        if page.resolve() not in reachable:
            errors.append(f"unreachable page: {page.relative_to(root)}")
    index = root / "evidence.md"
    indexed = {raw.removeprefix("./") for _, raw in links(index.read_text())} if index.is_file() else set()
    for page in (root / "evidence").glob("ev-*.md"):
        if f"evidence/{page.name}" not in indexed:
            errors.append(f"evidence.md: missing {page.name}")
        if not page.read_text().split("---", 2)[-1].strip().startswith("[依据总览](../evidence.md)"):
            errors.append(f"{page.name}: missing leading return link")
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
    print(f"OK: Wiki links are valid: {args.wiki}")
    return 0


if __name__ == "__main__":
    sys.exit(cli_errors(main))
