#!/usr/bin/env python3
"""
Detect hidden-experiment flags at a given Marshal version.

Reads `src/features/settings/SettingsPanel.tsx` at the supplied version tag
and extracts the flag names + labels living inside
`<Section title="Hidden Experiments">`. PRs whose primary effect is gated on
any of these flags should NOT be announced in release notes — they are
internal experimentation, not shipped functionality.

Usage:
    python3 scripts/detect-hidden-experiments.py <to-version>

Example:
    python3 skills/marshal-release-notes/scripts/detect-hidden-experiments.py 0.22.118

Output (JSON to stdout):
  {
    "version": "0.22.118",
    "tag": "v0.22.118",
    "settingsPath": "src/features/settings/SettingsPanel.tsx",
    "flags":       ["runtimeId", "uiExtensionsSystem", ...],
    "labels":      ["AI Runtime", "UI Plugins", ...],
    "descriptions": ["Connect to the Aether/Lobster gateway ...", ...],
    "aliases":     ["marshalruntime", "marshal runtime", "uiextensionssystem", ...]
  }

Requires: git CLI with the tag fetched, Python 3.10+.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys

# Force UTF-8 stdout on Windows (cp1252 can't handle unicode that may appear
# in TSX descriptions, e.g. en-dashes, curly quotes).
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

SETTINGS_PATH = "src/features/settings/SettingsPanel.tsx"
SECTION_TITLE = "Hidden Experiments"


def normalize_version(v: str) -> str:
    return v.lstrip("v")


def run(cmd: list[str], check: bool = True) -> tuple[int, str, str]:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode != 0:
        print(f"Error running: {' '.join(cmd)}", file=sys.stderr)
        print(result.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    return result.returncode, result.stdout, result.stderr


def resolve_ref(version: str) -> str:
    """Resolve a version string to a git ref.

    The release tag (e.g. `v0.22.118`) may not exist yet for freshly-bumped
    versions — the tag is only created when ADO publishes the release. Fall
    back to the `chore: bump to v<X>` commit SHA found in git log, mirroring
    fetch-prs.py's resolution strategy.
    """
    tag = f"v{version}"
    code, _, _ = run(["git", "rev-parse", "--verify", f"{tag}^{{commit}}"], check=False)
    if code == 0:
        return tag

    for ref in ["origin/main", "--all"]:
        _, sha, _ = run(
            ["git", "log", ref, "--format=%H", f"--grep=bump to v{version}"],
            check=False,
        )
        first = sha.splitlines()[0].strip() if sha else ""
        if first:
            return first

    print(f"Could not resolve a git ref for version {version}", file=sys.stderr)
    sys.exit(1)


def git_show(ref: str, path: str) -> str:
    code, out, err = run(["git", "show", f"{ref}:{path}"], check=False)
    if code != 0:
        print(f"Error: git show {ref}:{path} failed", file=sys.stderr)
        print(err.strip(), file=sys.stderr)
        sys.exit(1)
    return out


def extract_hidden_section(source: str) -> str:
    """Slice the JSX of `<Section title="Hidden Experiments">...</Section>`.

    Uses a simple forward search for the next `</Section>` after the title
    marker. Sufficient because SettingsPanel.tsx is a flat list of sibling
    `<Section>` blocks — none of them nest another `<Section>` inside.
    """
    marker = f'<Section title="{SECTION_TITLE}">'
    start = source.find(marker)
    if start < 0:
        return ""
    end_marker = "</Section>"
    end = source.find(end_marker, start)
    if end < 0:
        return source[start:]
    return source[start : end + len(end_marker)]


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <to-version>", file=sys.stderr)
        sys.exit(1)

    version = normalize_version(sys.argv[1])
    ref = resolve_ref(version)

    source = git_show(ref, SETTINGS_PATH)
    section = extract_hidden_section(source)

    if not section:
        print(
            f"Warning: no '<Section title=\"{SECTION_TITLE}\">' found at {ref}.\n"
            f"Either the section has been renamed or there are no hidden experiments at this version.",
            file=sys.stderr,
        )
        result: dict[str, object] = {
            "version": version,
            "ref": ref,
            "settingsPath": SETTINGS_PATH,
            "flags": [],
            "labels": [],
            "descriptions": [],
            "aliases": [],
        }
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return

    # Experiment flags and device-local runtime selection are the canonical
    # hidden gates. Extract every referenced key inside the section.
    flags = sorted(
        set(re.findall(r"experiments\?\.(\w+)", section))
        | set(re.findall(r"settings\.(runtimeId|cloudProviderId)", section))
    )

    # Toggle labels — what the user sees in the Settings UI. Useful for matching
    # against PR titles / bodies that reference the feature by its product name.
    labels = sorted(set(re.findall(r'label="([^"]+)"', section)))

    # Description prose often contains codenames (Aether, Lobster, Memora, etc.)
    # that PRs reference even when the flag name doesn't appear.
    descriptions = re.findall(r'description="([^"]+)"', section)

    # Aliases for case-insensitive substring matching against PR titles / bodies.
    # Includes lowercased labels (with and without spaces) and lowercased flag
    # names. Caller layers on its own codename heuristics for descriptions.
    aliases: set[str] = set()
    for label in labels:
        aliases.add(label.lower())
        aliases.add(label.replace(" ", "").lower())
    for flag in flags:
        aliases.add(flag.lower())

    result = {
        "version": version,
        "ref": ref,
        "settingsPath": SETTINGS_PATH,
        "flags": flags,
        "labels": labels,
        "descriptions": descriptions,
        "aliases": sorted(aliases),
    }
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
