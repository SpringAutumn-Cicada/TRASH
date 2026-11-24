#!/usr/bin/env python3
"""Rename canonical paper notes to the shared filename scheme and update links."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
from typing import Iterable

from paper_note_naming import canonical_filename_from_text

TEXT_FILE_SUFFIXES = {".md", ".canvas"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rename paper notes to FirstAuthor-Year-ShortTitle and update project references."
    )
    parser.add_argument("--vault-root", required=True, help="Bound project root containing Sources/Papers/.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes. Default behavior is dry-run only.",
    )
    return parser.parse_args()


def build_mapping(papers_dir: Path) -> tuple[dict[str, str], list[str]]:
    mapping: dict[str, str] = {}
    issues: list[str] = []
    target_to_source: dict[str, str] = {}

    for path in sorted(papers_dir.glob("*.md")):
        expected_name = canonical_filename_from_text(path.read_text(encoding="utf-8"))
        if expected_name is None:
            issues.append(f"{path.name}: missing title/authors/year in frontmatter")
            continue
        if path.name == expected_name:
            continue
        if expected_name in target_to_source:
            issues.append(
                f"{path.name}: canonical target {expected_name} already claimed by {target_to_source[expected_name]}"
            )
            continue
        mapping[path.name] = expected_name
        target_to_source[expected_name] = path.name

    for source_name, target_name in mapping.items():
        target_path = papers_dir / target_name
        if target_path.exists() and target_name not in mapping:
            issues.append(f"{source_name}: target already exists on disk -> {target_name}")

    return mapping, issues


def iter_text_files(vault_root: Path) -> Iterable[Path]:
    for path in sorted(vault_root.rglob("*")):
        if path.is_file() and path.suffix in TEXT_FILE_SUFFIXES:
            yield path


def replace_explicit_targets(text: str, old_target: str, new_target: str) -> str:
    old_escaped = re.escape(old_target)

    wikilink = re.compile(rf"\[\[{old_escaped}(?P<suffix>(?:[#|][^\]]*)?)\]\]")
    text = wikilink.sub(lambda match: f"[[{new_target}{match.group('suffix')}]]", text)

    markdown_link = re.compile(rf"(?P<prefix>\]\(){old_escaped}(?P<suffix>(?:#[^)]+)?\))")
    text = markdown_link.sub(lambda match: f"{match.group('prefix')}{new_target}{match.group('suffix')}", text)

    json_path = re.compile(rf'(?P<prefix>"(?:file|path)":\s*"){old_escaped}(?P<suffix>")')
    text = json_path.sub(lambda match: f"{match.group('prefix')}{new_target}{match.group('suffix')}", text)
    return text


def replace_note_targets(text: str, mapping: dict[str, str]) -> tuple[str, list[str]]:
    warnings: list[str] = []
    for old_name, new_name in mapping.items():
        old_stem = old_name[:-3]
        new_stem = new_name[:-3]
        new_stem_rel = f"Sources/Papers/{new_stem}"
        new_file_rel = f"Sources/Papers/{new_name}"
        explicit_targets = (
            (f"Sources/Papers/{old_name}", new_file_rel),
            (f"Sources/Papers/{old_stem}", new_stem_rel),
            (f"Papers/{old_name}", new_file_rel),
            (f"Papers/{old_stem}", new_stem_rel),
        )

        for old_target, new_target in explicit_targets:
            text = replace_explicit_targets(text, old_target, new_target)

        bare_pattern = re.compile(
            rf"\[\[{re.escape(old_stem)}(?P<suffix>(?:[#|][^\]]*)?)\]\]"
        )
        if bare_pattern.search(text):
            warnings.append(
                f"ambiguous bare wikilink [[{old_stem}]] found; verify whether it should point to {new_stem_rel}"
            )
    return text, warnings


def write_updated_references(vault_root: Path, mapping: dict[str, str]) -> list[Path]:
    updated_files: list[Path] = []
    warning_messages: list[str] = []
    for path in iter_text_files(vault_root):
        original = path.read_text(encoding="utf-8")
        updated, warnings = replace_note_targets(original, mapping)
        warning_messages.extend(f"{path}: {warning}" for warning in warnings)
        if updated == original:
            continue
        path.write_text(updated, encoding="utf-8")
        updated_files.append(path)
    for warning in warning_messages:
        print(f"WARNING: {warning}")
    return updated_files


def rename_note_files(papers_dir: Path, mapping: dict[str, str]) -> None:
    staged_paths: dict[Path, Path] = {}

    for index, old_name in enumerate(sorted(mapping), start=1):
        source = papers_dir / old_name
        staged = papers_dir / f".rename-stage-{index:02d}-{old_name}"
        source.rename(staged)
        staged_paths[staged] = papers_dir / mapping[old_name]

    for staged, target in staged_paths.items():
        staged.rename(target)


def main() -> int:
    args = parse_args()
    vault_root = Path(args.vault_root).expanduser()
    papers_dir = vault_root / "Sources" / "Papers"

    if not papers_dir.exists():
        print(f"ERROR: papers dir not found: {papers_dir}")
        return 1

    mapping, issues = build_mapping(papers_dir)
    if issues:
        print("ERROR: canonicalization blocked by the following issues:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    if not mapping:
        print("No paper-note filename changes required.")
        return 0

    print("Planned paper-note renames:")
    for old_name, new_name in sorted(mapping.items()):
        print(f"- {old_name} -> {new_name}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write changes.")
        return 0

    updated_files = write_updated_references(vault_root, mapping)
    rename_note_files(papers_dir, mapping)

    print(f"\nUpdated references in {len(updated_files)} files.")
    print(f"Renamed {len(mapping)} paper notes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
