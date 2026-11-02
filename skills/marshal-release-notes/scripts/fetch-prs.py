#!/usr/bin/env python3
"""
Fetch PRs merged to main between two Marshal versions.

Usage:
    python3 scripts/fetch-prs.py <from-version> <to-version>

Example:
    python3 skills/marshal-release-notes/scripts/fetch-prs.py 0.21.0 0.21.53

Outputs JSON to stdout with PR data, contributor counts, and truncated summaries.
Requires: gh CLI authenticated with access to OmerMachluf/marshal, Python 3.10+.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone

# Force UTF-8 stdout on Windows (cp1252 can't handle unicode in PR bodies)
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO = "OmerMachluf/marshal"
BUMP_PREFIX = "chore: bump to v"
SUMMARY_MAX_CHARS = 500


def parse_ts(s: str) -> datetime:
    """Parse ISO 8601 timestamp to timezone-aware datetime.

    Handles both UTC 'Z' suffix (GitHub API) and offset formats like
    '+02:00' (git log %aI), normalizing both to UTC for comparison.
    """
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def run(cmd: list[str], check: bool = True) -> str:
    """Run a command and return stdout as a string."""
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode != 0:
        print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
        print(result.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def normalize_version(v: str) -> str:
    """Strip leading 'v' if present."""
    return v.lstrip("v")


def find_version_timestamp(version: str) -> tuple[str, str]:
    """Find the exact commit timestamp for a version bump commit.

    Returns (iso_timestamp, date_only) — e.g. ("2026-04-07T16:14:24Z", "2026-04-07").
    Uses the merge commit timestamp on origin/main when available, since that's
    when the version actually landed. Falls back to --all if origin/main is stale.
    """
    normalized = normalize_version(version)
    # Search origin/main first, fall back to --all
    for ref in ["origin/main", "--all"]:
        # Use %aI for strict ISO 8601 timestamp
        log = run(
            ["git", "log", ref, "--format=%aI", f"--grep=bump to v{normalized}"],
            check=False,
        )
        for line in log.splitlines():
            ts = line.strip()
            if ts:
                date_only = ts[:10]
                return ts, date_only
    print(f"Could not find commit for version {version}", file=sys.stderr)
    sys.exit(1)


def extract_prefix(title: str) -> str:
    """Extract conventional commit prefix from PR title."""
    match = re.match(r"^(feat|fix|refactor|chore|ci|docs|test|perf)[\(:]", title, re.IGNORECASE)
    if match:
        return match.group(1).lower()
    # Check for uppercase variants like "Feat:" or "Fix:"
    match = re.match(r"^(Feat|Fix|Refactor|Chore|CI|Docs|Test|Perf)\b", title)
    if match:
        return match.group(1).lower()
    return "other"


def truncate_body(body: str | None) -> tuple[str, bool]:
    """Truncate PR body to SUMMARY_MAX_CHARS, return (text, was_truncated)."""
    if not body:
        return "", False
    # Strip HTML comments and excessive whitespace
    clean = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL).strip()
    if len(clean) <= SUMMARY_MAX_CHARS:
        return clean, False
    # Try to cut at a sentence or paragraph boundary
    cut = clean[:SUMMARY_MAX_CHARS]
    last_para = cut.rfind("\n\n")
    last_sentence = cut.rfind(". ")
    break_at = max(last_para, last_sentence)
    if break_at > SUMMARY_MAX_CHARS // 2:
        return clean[: break_at + 1].rstrip(), True
    return cut.rstrip() + "...", True


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <from-version> <to-version>", file=sys.stderr)
        sys.exit(1)

    from_version = normalize_version(sys.argv[1])
    to_version = normalize_version(sys.argv[2])

    # Resolve exact timestamps for version bump commits
    from_ts, from_date = find_version_timestamp(from_version)
    to_ts, to_date = find_version_timestamp(to_version)

    print(f"From: v{from_version} ({from_ts})", file=sys.stderr)
    print(f"To:   v{to_version} ({to_ts})", file=sys.stderr)

    # Fetch PRs merged to main from the start date onward.
    # GitHub search only supports day granularity, so we over-fetch with
    # merged:>= and then filter precisely by timestamp in Python.
    gh_output = run([
        "gh", "pr", "list",
        "--repo", REPO,
        "--state", "merged",
        "--limit", "500",
        "--json", "number,title,mergedAt,author,baseRefName,body",
        "--search", f"merged:>={from_date} base:main",
    ])

    prs_raw = json.loads(gh_output)

    if len(prs_raw) == 500:
        print("Warning: hit 500-PR limit — results may be incomplete", file=sys.stderr)

    # Filter precisely by parsed UTC timestamps — string comparison would fail
    # when git log uses local timezone offsets (e.g. +02:00) while GitHub API
    # always uses UTC with Z suffix.
    from_dt = parse_ts(from_ts)
    to_dt = parse_ts(to_ts)
    prs_filtered = [
        pr for pr in prs_raw
        if parse_ts(pr["mergedAt"]) > from_dt
        and parse_ts(pr["mergedAt"]) <= to_dt
        and not pr["title"].startswith(BUMP_PREFIX)
    ]

    # Sort by merge date
    prs_filtered.sort(key=lambda pr: pr["mergedAt"])

    # Build output
    prs_out = []
    author_counts: Counter[str] = Counter()
    author_names: dict[str, str] = {}

    for pr in prs_filtered:
        login = pr["author"]["login"]
        name = pr["author"].get("name") or login
        author_names[login] = name
        author_counts[login] += 1

        summary, truncated = truncate_body(pr.get("body"))

        prs_out.append({
            "number": pr["number"],
            "title": pr["title"],
            "date": pr["mergedAt"][:10],
            "author": name,
            "login": login,
            "prefix": extract_prefix(pr["title"]),
            "summary": summary,
            "truncated": truncated,
        })

    contributors = [
        {"name": author_names[login], "login": login, "count": count}
        for login, count in author_counts.most_common()
    ]

    output = {
        "fromVersion": from_version,
        "toVersion": to_version,
        "fromTimestamp": from_ts,
        "toTimestamp": to_ts,
        "totalPrs": len(prs_out),
        "prs": prs_out,
        "contributors": contributors,
    }

    json.dump(output, sys.stdout, indent=2, ensure_ascii=False)
    print()  # trailing newline


if __name__ == "__main__":
    main()
