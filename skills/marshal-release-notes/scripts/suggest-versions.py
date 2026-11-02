#!/usr/bin/env python3
"""
Suggest from/to versions for a Marshal release-notes announcement.

The announcement convention is **stable-to-stable**: each release-notes post
covers the diff between the previous stable release and the newly-promoted
"Latest" stable on GitHub. Beta cuts (Pre-release) are not announced
individually.

Algorithm:
- `gh api repos/OmerMachluf/marshal/releases/latest` → current Latest (to-version)
- `gh release list --exclude-pre-releases` → previous stable (from-version)
- `git log --grep="bump to v"` → HEAD-bumped version (informational; for the
  case where the user is preparing notes before the next promote lands on
  GitHub)
- `gh release list` → beta tags newer than current Latest (informational)

Usage:
    python3 scripts/suggest-versions.py

Outputs JSON to stdout. Caller (the skill) presents the suggestion to the user
for confirmation before running fetch-prs.py.

Requires: gh CLI authenticated with access to OmerMachluf/marshal, git, Python 3.10+.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO = "OmerMachluf/marshal"


def run(cmd: list[str], check: bool = True) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode != 0:
        print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
        print(result.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return result.stdout


def strip_v(tag: str) -> str:
    return tag.lstrip("v")


def get_current_latest() -> str | None:
    """Return the tag flagged 'Latest' on GitHub, or None if no release exists."""
    out = run(
        ["gh", "api", f"repos/{REPO}/releases/latest", "--jq", ".tag_name"],
        check=False,
    ).strip()
    return out or None


def get_stable_releases(limit: int = 10) -> list[dict]:
    """Return non-prerelease releases, newest first."""
    out = run([
        "gh", "release", "list",
        "--repo", REPO,
        "--exclude-pre-releases",
        "--limit", str(limit),
        "--json", "tagName,publishedAt,isLatest",
    ])
    return json.loads(out) if out.strip() else []


def get_recent_releases(limit: int = 30) -> list[dict]:
    """Return all releases (including prereleases), newest first."""
    out = run([
        "gh", "release", "list",
        "--repo", REPO,
        "--limit", str(limit),
        "--json", "tagName,publishedAt,isLatest,isPrerelease",
    ])
    return json.loads(out) if out.strip() else []


def get_head_version() -> str | None:
    """Most recent `chore: bump to v<X>` commit on origin/main.

    The HEAD-bumped version may be ahead of the latest published tag (a bump
    landed but ADO hasn't published the release yet).
    """
    for ref in ["origin/main", "HEAD"]:
        out = run(
            ["git", "log", ref, "--format=%s", "--grep=bump to v", "-n", "1"],
            check=False,
        ).strip()
        if out:
            match = re.search(r"bump to v(\S+)", out)
            if match:
                return match.group(1)
    return None


def main() -> None:
    current_latest_tag = get_current_latest()
    stable = get_stable_releases()

    current_latest = strip_v(current_latest_tag) if current_latest_tag else None

    previous_stable: str | None = None
    if current_latest_tag:
        # Skip the entry matching current Latest; pick the next non-prerelease.
        for entry in stable:
            if entry["tagName"] == current_latest_tag:
                continue
            previous_stable = strip_v(entry["tagName"])
            break

    head_version = get_head_version()

    # Beta tags newer than current Latest: candidates for "next promote".
    betas_since_latest: list[str] = []
    if current_latest_tag:
        current_latest_published = next(
            (e["publishedAt"] for e in stable if e["tagName"] == current_latest_tag),
            None,
        )
        if current_latest_published:
            for r in get_recent_releases():
                if r.get("isPrerelease") and r["publishedAt"] > current_latest_published:
                    betas_since_latest.append(strip_v(r["tagName"]))

    suggested: dict[str, str] | None = None
    if current_latest and previous_stable:
        suggested = {"from": previous_stable, "to": current_latest}

    output = {
        "currentLatest": current_latest,
        "previousStable": previous_stable,
        "headVersion": head_version,
        "betasSinceLatest": betas_since_latest,
        "suggested": suggested,
    }
    json.dump(output, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
