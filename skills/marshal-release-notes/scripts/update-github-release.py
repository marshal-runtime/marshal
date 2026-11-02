#!/usr/bin/env python3
"""
Update an existing GitHub release with new release notes.

Usage:
    python3 skills/marshal-release-notes/scripts/update-github-release.py <version-tag> <notes-file>

Example:
    python3 skills/marshal-release-notes/scripts/update-github-release.py v0.21.76 /tmp/release-notes.md

The release must already exist — this script will NOT create one.
Requires: gh CLI authenticated with access to OmerMachluf/marshal.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = "OmerMachluf/marshal"


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode != 0:
        print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
        print(result.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return result


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <version-tag> <notes-file>", file=sys.stderr)
        sys.exit(1)

    tag = sys.argv[1]
    notes_file = Path(sys.argv[2])

    # Normalize: ensure tag starts with 'v'
    if not tag.startswith("v"):
        tag = f"v{tag}"

    if not notes_file.is_file():
        print(f"Error: notes file not found: {notes_file}", file=sys.stderr)
        sys.exit(1)

    # Verify the release exists
    result = run(["gh", "release", "view", tag, "--repo", REPO], check=False)
    if result.returncode != 0:
        print(
            f"Error: release {tag} does not exist in {REPO}. This script only updates existing releases.",
            file=sys.stderr,
        )
        sys.exit(1)

    run(["gh", "release", "edit", tag, "--repo", REPO, "--notes-file", str(notes_file)])
    print(f"Updated release {tag} in {REPO}")


if __name__ == "__main__":
    main()
