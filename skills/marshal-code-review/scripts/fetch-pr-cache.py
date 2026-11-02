#!/usr/bin/env python3
"""Pre-fetch PR artifacts for marshal-code-review into a local cache.

Idempotent: compares the PR's current head SHA to the stored one and skips the
fetch when they match (unless --force). Writes atomically so a partial run
can't leave corrupt artifacts behind.

Cache layout (per PR), under the platform's temp dir (`tempfile.gettempdir()`):

    <tempdir>/marshal-code-review/pr-<n>/
        head-sha             SHA whose artifacts are cached
        metadata.json        gh pr view --json ...
        diff.patch           gh pr diff
        reviews.json         gh api repos/OmerMachluf/marshal/pulls/<n>/reviews
        pulls-comments.json  gh api repos/OmerMachluf/marshal/pulls/<n>/comments
        issues-comments.json gh api repos/OmerMachluf/marshal/issues/<n>/comments
        checks.json          gh pr checks --json (best-effort)

Usage:
    python3 fetch-pr-cache.py 1147
    python3 fetch-pr-cache.py 1147 --force
    python3 fetch-pr-cache.py 1147 --json --agent-instructions
    python3 fetch-pr-cache.py 1147 --cache-root /tmp/custom    # override (testing only)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO = "OmerMachluf/marshal"
# Path("/tmp/marshal-code-review") is drive-relative on Windows (resolves to whatever
# drive cwd is on, and `str()` reports it without a drive letter). Use the
# system temp dir so the path is always fully absolute when serialized to JSON.
DEFAULT_CACHE_ROOT = Path(tempfile.gettempdir()) / "marshal-code-review"
DEFAULT_MAX_AGE_DAYS = 7
PR_DIR_PATTERN = re.compile(r"^pr-(\d+)$")

METADATA_FIELDS = (
    "number,title,author,body,state,isDraft,url,createdAt,updatedAt,"
    "headRefOid,headRefName,baseRefName,additions,deletions,changedFiles,"
    "labels,files,mergeable,reviewDecision,commits"
)

# Files the cache must contain before we trust a cache-hit.
CACHE_FILES = (
    "metadata.json",
    "diff.patch",
    "reviews.json",
    "pulls-comments.json",
    "issues-comments.json",
    "checks.json",
)


def run(cmd: list[str]) -> str:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr.strip()}"
        )
    return result.stdout


def run_json(cmd: list[str]) -> Any:
    return json.loads(run(cmd))


def atomic_write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "wb" if isinstance(content, bytes) else "w"
    encoding = None if isinstance(content, bytes) else "utf-8"
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        with tmp.open(mode, encoding=encoding) as handle:
            handle.write(content)
        tmp.replace(path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def current_head_sha(pr: int) -> str:
    meta = run_json(
        ["gh", "pr", "view", str(pr), "--repo", REPO, "--json", "headRefOid"]
    )
    sha = meta.get("headRefOid")
    if not isinstance(sha, str) or not sha:
        raise RuntimeError(f"could not resolve head SHA for PR #{pr}")
    return sha


def stored_head_sha(pr_dir: Path) -> str | None:
    path = pr_dir / "head-sha"
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def cache_is_fresh(pr_dir: Path, head: str) -> bool:
    if stored_head_sha(pr_dir) != head:
        return False
    return all((pr_dir / name).exists() for name in CACHE_FILES)


def fetch_artifacts(pr: int) -> dict[str, str]:
    """Fetch all six artifacts in parallel. Raises on any non-optional failure."""

    def fetch_checks() -> str:
        try:
            return run([
                "gh", "pr", "checks", str(pr), "--repo", REPO, "--json",
                "name,state,bucket,workflow,link,completedAt,startedAt",
            ])
        except RuntimeError:
            return "[]"

    # Each task is a zero-arg callable so the executor signature stays uniform.
    tasks: dict[str, Any] = {
        "metadata.json": lambda: run([
            "gh", "pr", "view", str(pr), "--repo", REPO, "--json", METADATA_FIELDS,
        ]),
        "diff.patch": lambda: run(["gh", "pr", "diff", str(pr), "--repo", REPO]),
        "reviews.json": lambda: run(["gh", "api", f"repos/{REPO}/pulls/{pr}/reviews"]),
        "pulls-comments.json": lambda: run(["gh", "api", f"repos/{REPO}/pulls/{pr}/comments"]),
        "issues-comments.json": lambda: run(["gh", "api", f"repos/{REPO}/issues/{pr}/comments"]),
        "checks.json": fetch_checks,
    }

    # Fail-fast is intentional here (unlike list-prs.py, which substitutes
    # empty fallbacks). A partial cache — e.g. missing diff.patch — would
    # silently mislead downstream review agents. Letting exceptions propagate
    # means head-sha is never written on partial failure, so cache_is_fresh()
    # will return False and the next run retries cleanly.
    results: dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        futures = {pool.submit(fn): name for name, fn in tasks.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            results[name] = future.result()
    return results


def sweep_stale(cache_root: Path, max_age_days: int, keep: set[int] | None = None) -> list[int]:
    """Remove PR cache directories not touched within max_age_days.

    Uses the head-sha file's mtime as the "last successful fetch" timestamp —
    it's rewritten on every refetch, so a stale dir has a stale head-sha mtime.
    Falls back to the directory mtime if head-sha is missing.

    `keep` is a set of PR numbers to never sweep (e.g. the PRs we're about to
    refresh in the same invocation).
    """
    if max_age_days <= 0 or not cache_root.is_dir():
        return []

    keep = keep or set()
    cutoff = time.time() - max_age_days * 86400
    removed: list[int] = []
    for entry in cache_root.iterdir():
        if not entry.is_dir():
            continue
        match = PR_DIR_PATTERN.match(entry.name)
        if not match:
            continue
        pr_number = int(match.group(1))
        if pr_number in keep:
            continue
        anchor = entry / "head-sha"
        try:
            mtime = anchor.stat().st_mtime if anchor.is_file() else entry.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff:
            try:
                shutil.rmtree(entry)
                removed.append(pr_number)
            except OSError as exc:
                print(f"warn: could not remove {entry}: {exc}", file=sys.stderr)
    return removed


def head_sha_mtime(pr_dir: Path) -> float | None:
    """Return the head-sha file's mtime, or None if the sentinel is missing."""
    try:
        return (pr_dir / "head-sha").stat().st_mtime
    except OSError:
        return None


def fetch(pr: int, cache_root: Path, force: bool, max_cache_age: int = 0) -> dict[str, Any]:
    # .resolve() makes the path absolute and platform-correct so the JSON `dir`
    # field is directly usable by sub-agents on any drive / cwd.
    pr_dir = (cache_root / f"pr-{pr}").resolve()

    # TTL short-circuit: if the cache was written within max_cache_age seconds
    # AND every expected artifact is present, skip the `gh pr view` for the
    # head SHA entirely. The dashboard typically prefetched seconds ago, and
    # each `gh` call is another permission-prompt opportunity in auto mode.
    if not force and max_cache_age > 0:
        mtime = head_sha_mtime(pr_dir)
        if (
            mtime is not None
            and time.time() - mtime < max_cache_age
            and all((pr_dir / name).exists() for name in CACHE_FILES)
        ):
            stored = stored_head_sha(pr_dir) or "?"
            # Touch so LRU sweeps count this read as recent activity
            # (sweep_stale uses head-sha mtime; cache hits wouldn't otherwise
            # reset it and a daily-used PR could still be swept after 7 days).
            try:
                (pr_dir / "head-sha").touch()
            except OSError:
                pass
            return {"pr": pr, "status": "cached", "head": stored, "dir": str(pr_dir)}

    head = current_head_sha(pr)

    if not force and cache_is_fresh(pr_dir, head):
        # Touch so LRU sweeps count this cache hit as recent activity even
        # though we didn't rewrite the sentinel.
        try:
            (pr_dir / "head-sha").touch()
        except OSError:
            pass
        return {"pr": pr, "status": "cached", "head": head, "dir": str(pr_dir)}

    pr_dir.mkdir(parents=True, exist_ok=True)
    artifacts = fetch_artifacts(pr)

    # All fetches succeeded. Write artifacts first, then the head-sha sentinel —
    # if we die mid-write, the sentinel stays stale and the next run refetches.
    for name, content in artifacts.items():
        atomic_write(pr_dir / name, content)
    atomic_write(pr_dir / "head-sha", head + "\n")

    return {"pr": pr, "status": "fetched", "head": head, "dir": str(pr_dir)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pr", type=int, help="PR number")
    parser.add_argument("--force", action="store_true", help="Refetch even if head SHA matches")
    parser.add_argument("--cache-root", default=str(DEFAULT_CACHE_ROOT),
                        help=f"Cache root (default: {DEFAULT_CACHE_ROOT}). Intended for testing; "
                             "downstream callers (marshal-code-review sub-agents, the dashboard's "
                             "prefetch) assume the default — override at your own risk.")
    parser.add_argument("--max-cache-age", type=int, default=0,
                        help="If the cache is fresher than this many seconds, skip the `gh pr view` "
                             "head-SHA check entirely (default: 0 = always check). "
                             "Callers that just prefetched (e.g. marshal-review-dashboard) can pass 300.")
    parser.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                        help=f"Sweep cache dirs older than this many days (default: {DEFAULT_MAX_AGE_DAYS}; 0 disables)")
    parser.add_argument("--no-sweep", action="store_true", help="Skip the stale-cache sweep for this run")
    parser.add_argument("--json", action="store_true", help="Emit JSON status to stdout")
    parser.add_argument("--agent-instructions", action="store_true",
                        help="After fetching, print a ready-to-paste markdown block telling a "
                             "sub-agent how to read the cache. The orchestrator pastes this block "
                             "verbatim into every Agent dispatch - same path, same wording, no "
                             "per-agent customization, no chance of forgetting.")
    args = parser.parse_args()

    cache_root = Path(args.cache_root)
    swept: list[int] = []
    if not args.no_sweep:
        swept = sweep_stale(cache_root, args.max_age_days, keep={args.pr})

    try:
        result = fetch(args.pr, cache_root, force=args.force, max_cache_age=args.max_cache_age)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    result["swept"] = swept

    if args.json:
        print(json.dumps(result))
    else:
        status = result["status"]
        head_short = result["head"][:10]
        print(f"PR #{result['pr']} {status} @ {head_short} -> {result['dir']}")
        if swept:
            print(f"  swept stale: {', '.join(f'pr-{n}' for n in swept)}")

    if args.agent_instructions:
        print(agent_instructions_block(result["pr"], result["dir"]))
    return 0


def agent_instructions_block(pr: int, cache_dir: str) -> str:
    """Markdown block the orchestrator pastes into every sub-agent dispatch.

    Centralized here so all 16 review sub-agents see the same wording, the
    same absolute path, and the same fail-loudly verification step. If the
    orchestrator forgets to include this block in a dispatch, the agent will
    fall back to calling `gh` (which the agent prompts forbid) or hallucinate
    a path — both worse than a clean "cache not accessible" error.
    """
    return f"""
**PR cache directory** (read these files with the Read tool - DO NOT call `gh`):
`{cache_dir}`

Read `diff.patch`, `metadata.json`, `pulls-comments.json`, `issues-comments.json`, and `reviews.json` from there.

**Sanity check:** your first action MUST be to `Read {cache_dir}/diff.patch` (or `metadata.json`). If the Read fails, stop immediately and report `cache directory not accessible at {cache_dir}` as your only finding - do NOT call `gh` as a fallback, and do NOT proceed with the review on whatever stale state you can find."""


if __name__ == "__main__":
    sys.exit(main())
