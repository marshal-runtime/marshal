#!/usr/bin/env python3
# marshal-owned
"""Enrich extracted GitHub review comments with PR file metadata.

Input:  JSON array produced by marshal-extract-human-comments.py
Output: Same JSON enriched with:
  - ChangeType           (edit, new_file, deleted_file, renamed_file, unknown)
  - PullRequestFileStatus (raw GitHub status)
  - DiffSource           (review_thread, pull_request_file, missing)

GitHub already stores the exact review diff hunk on each review comment, so enrichment
mostly normalizes file-change metadata and backfills missing diff context from the PR
file patch when needed.

Usage:
  python3 marshal-enrich-with-diff.py comments.json
  python3 marshal-enrich-with-diff.py comments.json --output enriched-comments.json
  python3 marshal-enrich-with-diff.py comments.json --repo OmerMachluf/marshal
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

FILE_PAGE_SIZE = 100
MAX_DIFF_SIZE = 50_000
DEFAULT_REPO = "OmerMachluf/marshal"


def run_json(command: list[str]) -> Any:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Command failed")
    return json.loads(result.stdout)


def resolve_repo(repo_arg: str | None) -> tuple[str, str]:
    repo_value = repo_arg or DEFAULT_REPO
    if "/" not in repo_value:
        raise ValueError("--repo must be in owner/name form")
    owner, name = repo_value.split("/", 1)
    return owner, name


def truncate(text: str) -> str:
    if len(text) <= MAX_DIFF_SIZE:
        return text
    return text[:MAX_DIFF_SIZE] + f"\n... [truncated at {MAX_DIFF_SIZE} chars]"


def normalize_change_type(status: str | None) -> str:
    mapping = {
        "modified": "edit",
        "changed": "edit",
        "copied": "edit",
        "added": "new_file",
        "removed": "deleted_file",
        "renamed": "renamed_file",
    }
    return mapping.get((status or "").lower(), "unknown")


def fetch_pull_files(owner: str, repo: str, pull_request_number: int) -> dict[str, dict[str, Any]]:
    page = 1
    files: list[dict[str, Any]] = []

    while True:
        endpoint = f"/repos/{owner}/{repo}/pulls/{pull_request_number}/files?per_page={FILE_PAGE_SIZE}&page={page}"
        batch = run_json(["gh", "api", endpoint])
        files.extend(batch)
        if len(batch) < FILE_PAGE_SIZE:
            break
        page += 1

    index: dict[str, dict[str, Any]] = {}
    for file_entry in files:
        normalized = {
            "status": file_entry.get("status"),
            "patch": file_entry.get("patch") or "",
            "filename": file_entry.get("filename"),
            "previous_filename": file_entry.get("previous_filename"),
        }
        filename = normalized["filename"]
        if filename:
            index[filename] = normalized
        previous = normalized["previous_filename"]
        if previous and previous not in index:
            index[previous] = normalized
    return index


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich extracted GitHub review comments with PR file metadata")
    parser.add_argument("input", help="Input JSON file produced by marshal-extract-human-comments.py")
    parser.add_argument("--output", "-o", default=None, help="Output file (default: enriched-{input_stem}.json)")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo in owner/name form (default: {DEFAULT_REPO})")
    args = parser.parse_args()

    owner, repo = resolve_repo(args.repo)
    input_path = Path(args.input)
    output_path = Path(args.output) if args.output else input_path.with_name(f"enriched-{input_path.stem}.json")

    with input_path.open(encoding="utf-8") as handle:
        records = json.load(handle)

    file_cache: dict[int, dict[str, dict[str, Any]]] = {}
    change_counts = Counter()
    diff_source_counts = Counter()

    for record in records:
        pull_request_number = int(record["PullRequestNumber"])
        if pull_request_number not in file_cache:
            print(f"Fetching PR file metadata for #{pull_request_number}...", file=sys.stderr)
            file_cache[pull_request_number] = fetch_pull_files(owner, repo, pull_request_number)

        file_info = file_cache[pull_request_number].get(record.get("filePath") or "")
        raw_status = file_info.get("status") if file_info else None
        fallback_patch = file_info.get("patch") if file_info else ""
        review_hunk = record.get("DiffHunk") or ""

        if review_hunk:
            diff_source = "review_thread"
            diff_hunk = review_hunk
        elif fallback_patch:
            diff_source = "pull_request_file"
            diff_hunk = fallback_patch
        else:
            diff_source = "missing"
            diff_hunk = ""

        record["PullRequestFileStatus"] = raw_status
        record["ChangeType"] = normalize_change_type(raw_status)
        record["DiffSource"] = diff_source
        record["DiffHunk"] = truncate(diff_hunk)

        change_counts[record["ChangeType"]] += 1
        diff_source_counts[diff_source] += 1

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(records, handle, indent=2, ensure_ascii=False)

    print()
    print("Results:")
    print(f"  Comments: {len(records)}")
    print("  Change types:")
    for change_type, count in change_counts.most_common():
        print(f"    {change_type}: {count}")
    print("  Diff sources:")
    for diff_source, count in diff_source_counts.most_common():
        print(f"    {diff_source}: {count}")
    print()
    print(f"Written to: {output_path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
