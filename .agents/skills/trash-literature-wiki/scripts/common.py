"""Shared helpers for deterministic single-paper Wiki checks."""

from __future__ import annotations

import re
from pathlib import Path


REQUIRED_PAGES = (
    "whoami.md",
    "idcard.md",
    "background.md",
    "research_problem.md",
    "contributions.md",
    "method/method.md",
    "results/results.md",
    "limitations.md",
    "insights.md",
    "evidence.md",
)

NAVIGATION = (
    ("题录", "idcard.md"),
    ("背景", "background.md"),
    ("研究问题", "research_problem.md"),
    ("贡献", "contributions.md"),
    ("方法", "method/method.md"),
    ("实验与结果", "results/results.md"),
    ("局限", "limitations.md"),
    ("可复用认识", "insights.md"),
    ("依据总览", "evidence.md"),
)


def frontmatter(text: str) -> dict[str, str]:
    """Parse the simple scalar YAML used by Wiki frontmatter."""
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    result: dict[str, str] = {}
    for line in parts[1].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        result[key.strip()] = value.strip().strip("'\"")
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
