#!/usr/bin/env python3
"""PR review dashboard for OmerMachluf/marshal.

Lists open PRs updated within the lookback window and groups them into:

    A. Needs review                   — not authored by me, I haven't touched it
    B. Stale review from me           — I commented, author pushed after my last comment
    C. My PRs with new feedback       — I'm the author, someone else commented after my last push

PRs are hidden from the dashboard by default when any of the four merge-blocking
checks (Chore, Unit Tests, E2E Tests, Lint & Format) is failing — there's no
point reviewing code the author already needs to touch again. Pass
`--include-failing` to surface them anyway. ("Chore" covers the "PR template"
workflow — i.e., the description doesn't match the template.)

For each surfaced PR, optionally prefetches the review cache and prints a ready-to-paste
Zellij launcher that opens Claude Code cwd'd to the repo with `/marshal-code-review <url>`.

Usage:
    python3 list-prs.py                              # last 7 days, own PRs hidden
    python3 list-prs.py --days 3
    python3 list-prs.py --include-mine               # show own PRs (default: hide)
    python3 list-prs.py --exclude-author bob         # also drop bob's PRs (repeatable)
    python3 list-prs.py --include-drafts
    python3 list-prs.py --include-failing            # don't hide PRs with failing CI
    python3 list-prs.py --json
    python3 list-prs.py --no-prefetch
"""

from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import subprocess
import sys

# Windows default console codecs often can't encode unicode bullets.
# Force UTF-8 so human-readable output renders cleanly everywhere.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, io.UnsupportedOperation):
        pass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

REPO = "OmerMachluf/marshal"
# Script lives at <repo>/skills/marshal-review-dashboard/scripts/list-prs.py.
REPO_ROOT = Path(__file__).resolve().parents[3]
# Emit a POSIX-form path so bash (including Git Bash on Windows) doesn't
# stumble over backslashes when the user pastes the launch command.
REPO_CWD = REPO_ROOT.as_posix()
CACHE_SCRIPT = REPO_ROOT / "skills" / "marshal-code-review" / "scripts" / "fetch-pr-cache.py"
# Per-reviewer "trusted contributor" list. Gitignored — each reviewer keeps
# their own. Authors listed here are surfaced ahead of `other` PRs in the
# Needs review section, just below maintainer-labelled ones. See
# `load_trusted_contributors` for the file format.
TRUSTED_CONTRIBUTORS_FILE = Path(__file__).resolve().parent.parent / ".trusted-contributors"

# Author-trust tiers used to sort the Needs review bucket. Lower index
# in TIER_ORDER = surfaces earlier.
TIER_MAINTAINER = "maintainer"
TIER_TRUSTED = "trusted"
TIER_OTHER = "other"
TIER_ORDER = (TIER_MAINTAINER, TIER_TRUSTED, TIER_OTHER)
MAINTAINER_LABEL = "maintainer"

BOT_LOGIN_SUFFIX = "[bot]"
BOT_LOGINS = {
    "github-actions[bot]",
    "dependabot[bot]",
    "copilot-pull-request-reviewer[bot]",
    "copilot-pull-request-reviewer",
    "copilot",
}

# Size buckets keyed on additions+deletions. Upper bound exclusive.
# Tuned against a typical week of OmerMachluf/marshal PRs so XS covers single-file
# trivia, S fits a 10-min review, M a focused session, L an hour+, XL warns
# the reviewer to carve out dedicated time.
SIZE_BUCKETS = (
    ("XS", 100),
    ("S", 500),
    ("M", 1500),
    ("L", 3500),
)


def classify_size(additions: int | None, deletions: int | None) -> str:
    total = (additions or 0) + (deletions or 0)
    for label, upper in SIZE_BUCKETS:
        if total < upper:
            return label
    return "XL"


def load_trusted_contributors(path: Path = TRUSTED_CONTRIBUTORS_FILE) -> set[str]:
    """Load the local per-reviewer trusted-contributor list, if present.

    Format: one GitHub login per line, with or without a leading `@`. Blank
    lines and lines starting with `#` are ignored, as are trailing inline
    comments after a `#`. The file is intentionally gitignored — each
    reviewer maintains their own list. Returns lowercase logins.
    """
    if not path.is_file():
        return set()
    out: set[str] = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        no_comment = raw_line.split("#", 1)[0].strip()
        if not no_comment:
            continue
        # Tolerate "  @login   extra-junk" — first whitespace-separated token wins.
        token = no_comment.split()[0]
        if token.startswith("@"):
            token = token[1:]
        if token:
            out.add(token.lower())
    return out


def pr_tier(pr: dict[str, Any], trusted: set[str]) -> str:
    """Classify a PR by author trust tier.

    `maintainer` — PR carries the `maintainer` label, applied by the labeller
                   (`.github/scripts/marshal-pr-labeler.cjs`) when the author is in the
                   global `*` rule of `docs/CODEOWNERS`.
    `trusted`    — PR author is in the local trusted-contributor set.
    `other`      — neither.
    """
    label_names = {
        (label.get("name") or "").lower() for label in (pr.get("labels") or [])
    }
    if MAINTAINER_LABEL in label_names:
        return TIER_MAINTAINER
    author = ((pr.get("author") or {}).get("login") or "").lower()
    if author and author in trusted:
        return TIER_TRUSTED
    return TIER_OTHER


def tier_priority(tier: str) -> int:
    """Sort key for tier — lower index sorts earlier. Unknown tiers sink."""
    try:
        return TIER_ORDER.index(tier)
    except ValueError:
        return len(TIER_ORDER)


# Merge-blocking check categories. A PR is hidden from the dashboard when any
# of these is in the "fail" bucket (gh's coarse grouping — already covers
# FAILURE / CANCELLED / TIMED_OUT / ACTION_REQUIRED). Predicates run on the
# raw `gh pr checks --json` row; match against `name` (the job/check name) or
# `workflow` (the parent workflow file). Names observed on OmerMachluf/marshal as of
# 2026-05: e.g. "Marshal Buddy (Unit Tests UnitTests)", "(E2E Tests E2E)",
# "(Lint & Format LintAndFormat)", and the "PR template" workflow with
# name "check".
BLOCKING_CHECK_LABELS: tuple[tuple[str, Callable[[dict[str, Any]], bool]], ...] = (
    # "Chore" covers the GitHub workflow named "PR template" — a failure here
    # just means the description doesn't match the template (chore-level fix
    # for the author, not a code issue), so the friendlier label conveys why
    # the PR is hidden better than the workflow's literal name.
    ("Chore", lambda c: (c.get("workflow") or "").strip().lower() == "pr template"),
    ("Unit Tests", lambda c: "unit tests" in (c.get("name") or "").lower()),
    ("E2E Tests", lambda c: "e2e" in (c.get("name") or "").lower()),
    # Match the literal "lint & format" substring rather than `"lint" in name
    # AND "format" in name`, which would also catch a hypothetical
    # "Format Linting" or "Pretty-Print Linter Format Test" check.
    ("Lint & Format", lambda c: "lint & format" in (c.get("name") or "").lower()),
)


def blocking_check_failures(checks: list[dict[str, Any]] | None) -> list[str]:
    """Return labels of merge-blocking categories that are currently failing.

    Order is stable (matches `BLOCKING_CHECK_LABELS` declaration order) so that
    rendered output is deterministic across runs. Pending / in-progress checks
    are intentionally ignored — only `bucket == "fail"` counts.
    """
    if not checks:
        return []
    seen: set[str] = set()
    for check in checks:
        if (check.get("bucket") or "").lower() != "fail":
            continue
        for label, predicate in BLOCKING_CHECK_LABELS:
            if label in seen:
                continue
            if predicate(check):
                seen.add(label)
    return [label for label, _ in BLOCKING_CHECK_LABELS if label in seen]


def fetch_checks(pr_number: int) -> list[dict[str, Any]]:
    """Fetch `gh pr checks` JSON, tolerating non-zero exit on failing checks.

    `gh pr checks` exits 1 whenever any check is failing — the JSON is still
    valid on stdout. `run_json` would raise on non-zero, so we shell out
    directly here. Empty stdout means a real fetch failure (auth, network,
    PR not found) — return [] so the caller treats the PR as having no
    blocking failures rather than crashing the whole dashboard run.
    """
    result = subprocess.run(
        [
            "gh", "pr", "checks", str(pr_number), "--repo", REPO,
            "--json", "name,state,bucket,workflow",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stdout = result.stdout.strip()
    if not stdout:
        return []
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return []


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


def detect_me() -> str:
    """Return the authenticated GitHub login.

    Uses `gh api user --jq .login` — the API response is a stable contract,
    whereas `gh auth status` text formatting has changed across gh versions.
    """
    try:
        return run(["gh", "api", "user", "--jq", ".login"]).strip()
    except RuntimeError as exc:
        raise RuntimeError(
            f"could not determine GitHub login via `gh api user`: {exc}"
        ) from exc


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.rstrip("Z")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_bot(login: str | None) -> bool:
    if not login:
        return True
    lowered = login.lower()
    if lowered in BOT_LOGINS:
        return True
    if lowered.endswith(BOT_LOGIN_SUFFIX):
        return True
    return False


def truncate(text: str, width: int) -> str:
    if len(text) <= width:
        return text
    if width <= 3:
        return text[:width]
    return text[: width - 3] + "..."


def humanize_delta(then: datetime | None, now: datetime) -> str:
    if then is None:
        return "?"
    seconds = max(0, int((now - then).total_seconds()))
    if seconds < 60:
        return f"{seconds}s ago"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 48:
        return f"{hours}h ago"
    days = hours // 24
    return f"{days}d ago"


PR_LIST_LIMIT = 100


def filter_excluded_authors(
    prs: list[dict[str, Any]],
    excluded: set[str],
) -> list[dict[str, Any]]:
    """Drop PRs whose author login (lowercased) is in `excluded`.

    Run before `fetch_pr_details` so excluded PRs don't burn gh API calls.
    Authors with missing logins are kept — defensive, the upstream gh response
    always has one but a malformed row shouldn't silently disappear.
    """
    if not excluded:
        return prs
    out: list[dict[str, Any]] = []
    for pr in prs:
        author = ((pr.get("author") or {}).get("login") or "").lower()
        if author and author in excluded:
            continue
        out.append(pr)
    return out


def list_candidates(include_drafts: bool, since: datetime) -> list[dict[str, Any]]:
    fields = "number,title,author,updatedAt,headRefOid,isDraft,url,additions,deletions,changedFiles,labels"
    raw = run_json([
        "gh", "pr", "list", "--repo", REPO,
        "--state", "open", "--limit", str(PR_LIST_LIMIT),
        "--json", fields,
    ])
    if len(raw) == PR_LIST_LIMIT:
        # Hitting the cap means we may have silently truncated older PRs
        # that still fall within `since`. Warn rather than double the limit
        # unconditionally — repo size and window width are the real variables.
        print(
            f"warn: `gh pr list` returned exactly {PR_LIST_LIMIT} open PRs — the cap may "
            f"be hiding PRs that still match the lookback window.",
            file=sys.stderr,
        )
    out: list[dict[str, Any]] = []
    for pr in raw:
        updated = parse_iso(pr.get("updatedAt"))
        if updated is None or updated < since:
            continue
        if pr.get("isDraft") and not include_drafts:
            continue
        out.append(pr)
    return out


def fetch_pr_details(pr: dict[str, Any]) -> dict[str, Any]:
    """Fetch the per-PR payloads in parallel.

    Concurrency is handled inside this function so the outer pool only needs one
    worker per PR. Total concurrency = outer_workers * len(fetchers).
    """
    n = pr["number"]
    head = pr.get("headRefOid") or ""

    # Each fetcher is a zero-arg callable so checks (which can't use run_json
    # because gh exits non-zero on failing checks) plugs in alongside the gh-api
    # calls without a special case in the loop below.
    fetchers: dict[str, Any] = {}
    if head:
        fetchers["commit"] = lambda: run_json(["gh", "api", f"repos/{REPO}/commits/{head}"])
    fetchers["reviews"] = lambda: run_json(["gh", "api", f"repos/{REPO}/pulls/{n}/reviews"])
    fetchers["pulls_comments"] = lambda: run_json(["gh", "api", f"repos/{REPO}/pulls/{n}/comments"])
    fetchers["issues_comments"] = lambda: run_json(["gh", "api", f"repos/{REPO}/issues/{n}/comments"])
    fetchers["checks"] = lambda: fetch_checks(n)

    # Per-task empty fallbacks: commit → dict, the rest → list. Shape-matches
    # what the code below expects so a single failed fetch doesn't blow up the
    # entire dashboard run (rate limits + network blips hit these endpoints).
    fallbacks: dict[str, Any] = {"commit": {}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(fetchers)) as pool:
        futures = {pool.submit(fn): key for key, fn in fetchers.items()}
        results: dict[str, Any] = {}
        for future in concurrent.futures.as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
            except Exception as exc:
                print(f"warn: PR #{n} {key} fetch failed: {exc}", file=sys.stderr)
                results[key] = fallbacks.get(key, [])

    commit = results.get("commit") or {}
    # Committer timestamp is the cheapest "last activity" signal — REST's
    # /repos/.../commits/<sha> already returns it. For most PRs it matches
    # the actual push. Edge case: a `git push --force` that restores an
    # older commit will back-date this value (the push happened now, but the
    # commit was authored days ago). Fixing that precisely requires GraphQL
    # `PullRequest.commits.nodes.commit.pushedDate`; deferred because the
    # failure mode (missing a brand-new push of an old commit) is rare and
    # the author usually notices via CI.
    commit_date = parse_iso(((commit.get("commit") or {}).get("committer") or {}).get("date"))

    activity: list[tuple[str, datetime]] = []
    for r in results.get("reviews", []):
        login = (r.get("user") or {}).get("login")
        ts = parse_iso(r.get("submitted_at") or r.get("created_at"))
        if login and ts:
            activity.append((login, ts))
    for c in results.get("pulls_comments", []):
        login = (c.get("user") or {}).get("login")
        ts = parse_iso(c.get("created_at"))
        if login and ts:
            activity.append((login, ts))
    for c in results.get("issues_comments", []):
        login = (c.get("user") or {}).get("login")
        ts = parse_iso(c.get("created_at"))
        if login and ts:
            activity.append((login, ts))

    return {
        **pr,
        "last_push_at": commit_date,
        "activity": activity,
        "blocking_failures": blocking_check_failures(results.get("checks")),
    }


def attach_commit_counts(prs: list[dict[str, Any]]) -> None:
    """For each PR, fetch the commits list once and stash it on the record.

    Runs in parallel so bucket() can compute commits-since timestamps without
    a sequential tail.
    """
    def fetch_commits(pr: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            payload = run_json([
                "gh", "pr", "view", str(pr["number"]), "--repo", REPO, "--json", "commits",
            ])
        except RuntimeError:
            return []
        return payload.get("commits") or []

    if not prs:
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(prs))) as pool:
        futures = {pool.submit(fetch_commits, pr): pr for pr in prs}
        for future in concurrent.futures.as_completed(futures):
            pr = futures[future]
            pr["_commits"] = future.result()


def bucket(
    prs: list[dict[str, Any]],
    me: str,
    trusted: frozenset[str] | set[str] = frozenset(),
) -> dict[str, list[dict[str, Any]]]:
    needs = []
    stale_candidates = []
    mine_with_feedback = []

    for pr in prs:
        author = (pr.get("author") or {}).get("login") or ""
        activity = pr["activity"]
        last_push = pr["last_push_at"]

        my_activity = [t for (a, t) in activity if a == me]
        other_activity = [(a, t) for (a, t) in activity if a != me and a != author and not is_bot(a)]

        author_is_me = author == me

        if not author_is_me and not my_activity:
            needs.append({
                **pr,
                "other_commenters": collapse_commenters(other_activity),
                "tier": pr_tier(pr, trusted),
            })
            continue

        if not author_is_me and my_activity and last_push and max(my_activity) < last_push:
            stale_candidates.append({
                **pr,
                "my_last_at": max(my_activity),
            })
            continue

        if author_is_me and other_activity and last_push and max(t for _, t in other_activity) > last_push:
            mine_with_feedback.append({
                **pr,
                "other_commenters": collapse_commenters(other_activity),
            })
            continue

        # Fall-through: none of the three buckets matched. Usually this is a
        # PR I've already reviewed and the author hasn't pushed since, or my
        # own PR with no new feedback — both benign. But it also catches the
        # degenerate case where `last_push` is None (head-commit fetch failed)
        # and we silently drop the PR. Warn so that failure is visible.
        if last_push is None and not author_is_me and my_activity:
            print(
                f"warn: PR #{pr.get('number')} skipped — could not determine last push date "
                "(commits fetch failed or head SHA returned no committer date)",
                file=sys.stderr,
            )

    # Parallel enrich: commits-pushed-since needs one additional gh call per stale PR.
    attach_commit_counts(stale_candidates)
    for pr in stale_candidates:
        commits = pr.pop("_commits", [])
        since = pr["my_last_at"]
        pr["commits_pushed_since"] = sum(
            1 for c in commits
            if (ts := parse_iso(c.get("committedDate"))) and ts > since
        )

    # Primary sort: tier (maintainer → trusted → other). Secondary: last_push_at
    # descending so within-tier the freshest activity surfaces first. We sort
    # explicitly on last_push_at rather than relying on gh's updatedAt-desc input
    # order because `updatedAt` reflects any activity (label edits, label-only
    # comments) — `last_push_at` is the signal a reviewer actually cares about.
    # `datetime.min` (made UTC-aware to match parsed values) is used for PRs
    # where the commit fetch failed; they sink to the bottom of their tier.
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    needs.sort(
        key=lambda p: (
            tier_priority(p.get("tier") or TIER_OTHER),
            -(p.get("last_push_at") or epoch).timestamp(),
        )
    )

    return {
        "needs_review": needs,
        "stale_my_review": stale_candidates,
        "my_prs_with_feedback": mine_with_feedback,
    }


def partition_failing(
    buckets: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """Split each bucket into (kept, hidden) based on `blocking_failures`.

    Each hidden PR is tagged with `_source_bucket` so downstream renderers
    can attribute it back to where it came from. The kept dict preserves
    the original bucket order.
    """
    kept: dict[str, list[dict[str, Any]]] = {name: [] for name in buckets}
    hidden: list[dict[str, Any]] = []
    for name, rows in buckets.items():
        for pr in rows:
            if pr.get("blocking_failures"):
                hidden.append({**pr, "_source_bucket": name})
            else:
                kept[name].append(pr)
    return kept, hidden


def collapse_commenters(entries: list[tuple[str, datetime]]) -> list[dict[str, Any]]:
    latest: dict[str, datetime] = {}
    for login, ts in entries:
        if login not in latest or ts > latest[login]:
            latest[login] = ts
    return [
        {"login": login, "at": ts.isoformat()}
        for login, ts in sorted(latest.items(), key=lambda kv: kv[1], reverse=True)
    ]


LAUNCH_SCRIPT = Path(__file__).resolve().parent / "launch-review.sh"


def zellij_command(pr_number: int, url: str) -> str:
    # url is accepted for API symmetry; launch-review.sh rebuilds the URL from the PR number.
    del url
    return f'bash "{LAUNCH_SCRIPT.as_posix()}" {pr_number}'


def prefetch(pr_numbers: list[int]) -> None:
    if not CACHE_SCRIPT.is_file():
        print(f"warn: cache script missing at {CACHE_SCRIPT}; skipping prefetch", file=sys.stderr)
        return
    # Each fetch-pr-cache.py invocation internally parallelizes 6 gh calls, but
    # only on cache-miss paths. On the hot "everything cached" path it's a single
    # `gh pr view` call, so it's safe to keep the outer width reasonably wide.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = {
            pool.submit(
                subprocess.run,
                ["python3", str(CACHE_SCRIPT), str(n), "--json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            ): n
            for n in pr_numbers
        }
        for future in concurrent.futures.as_completed(futures):
            n = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                print(f"warn: prefetch pr-{n}: {exc}", file=sys.stderr)
                continue
            if result.returncode != 0:
                print(f"warn: prefetch pr-{n} failed: {result.stderr.strip()}", file=sys.stderr)


def render_human(
    buckets: dict[str, list[dict[str, Any]]],
    hidden: list[dict[str, Any]],
    me: str,
    window_days: int,
) -> str:
    now = datetime.now(timezone.utc)
    lines: list[str] = []

    def section(title: str, rows: list[dict[str, Any]], render_row) -> None:
        lines.append(f"=== {title} ({len(rows)}) ===")
        if not rows:
            lines.append("(none)")
            lines.append("")
            return
        for r in rows:
            lines.extend(render_row(r))
            lines.append("")

    def size_tag(pr: dict[str, Any]) -> str:
        bucket = classify_size(pr.get("additions"), pr.get("deletions"))
        return f"[{bucket:<2}]"

    def size_detail(pr: dict[str, Any]) -> str:
        a = pr.get("additions") or 0
        d = pr.get("deletions") or 0
        f = pr.get("changedFiles") or 0
        return f"+{a}/-{d} across {f} file{'s' if f != 1 else ''}"

    def needs_row(pr: dict[str, Any]) -> list[str]:
        n = pr["number"]
        author = (pr.get("author") or {}).get("login") or "?"
        title = pr.get("title") or ""
        pushed = humanize_delta(pr.get("last_push_at"), now)
        others = pr.get("other_commenters") or []
        tier = pr.get("tier") or TIER_OTHER
        # Tier marker sits next to the author so it's easy to scan vertically
        # alongside the (already padded) title column. `other` gets no marker
        # to keep the common case visually quiet.
        tier_suffix = ""
        if tier == TIER_MAINTAINER:
            tier_suffix = "  (maintainer)"
        elif tier == TIER_TRUSTED:
            tier_suffix = "  (trusted)"
        if others:
            other_str = ", ".join(
                f"{o['login']} ({humanize_delta(parse_iso(o['at']), now)})" for o in others[:3]
            )
            head_extra = f"pushed {pushed} · other commenters: {other_str}"
        else:
            head_extra = f"pushed {pushed} · no other reviewers yet"
        return [
            f"#{n}  {size_tag(pr)}  {truncate(title, 64):<64}  {author}{tier_suffix}",
            f"       {head_extra}",
            f"       size: {size_detail(pr)}",
            f"       {pr.get('url')}",
            f"       -> {zellij_command(n, pr.get('url') or '')}",
        ]

    def stale_row(pr: dict[str, Any]) -> list[str]:
        n = pr["number"]
        author = (pr.get("author") or {}).get("login") or "?"
        title = pr.get("title") or ""
        pushed_since = pr.get("commits_pushed_since", 0)
        my_last = humanize_delta(pr.get("my_last_at"), now)
        return [
            f"#{n}  {size_tag(pr)}  {truncate(title, 64):<64}  {author}",
            f"       my last comment {my_last} · {pushed_since} commits pushed since",
            f"       size: {size_detail(pr)}",
            f"       {pr.get('url')}",
            f"       -> {zellij_command(n, pr.get('url') or '')}",
        ]

    def mine_row(pr: dict[str, Any]) -> list[str]:
        n = pr["number"]
        title = pr.get("title") or ""
        others = pr.get("other_commenters") or []
        other_str = ", ".join(
            f"{o['login']} ({humanize_delta(parse_iso(o['at']), now)})" for o in others[:3]
        ) or "(none)"
        return [
            f"#{n}  {size_tag(pr)}  {truncate(title, 64):<64}  (me)",
            f"       new feedback: {other_str}",
            f"       size: {size_detail(pr)}",
            f"       {pr.get('url')}",
            f"       -> {zellij_command(n, pr.get('url') or '')}",
        ]

    lines.append(
        f"PR dashboard for {REPO} · me={me} · window={window_days}d · generated {now.isoformat(timespec='seconds')}"
    )
    lines.append("")
    # Stale comes first — author already addressed my earlier feedback, so
    # re-engaging there unblocks them. Within Needs review, maintainer-labelled
    # PRs are sorted to the top, then locally trusted contributors, then others.
    section("Stale — author pushed after my comment", buckets["stale_my_review"], stale_row)
    section("Needs review", buckets["needs_review"], needs_row)
    section("My PRs with new feedback", buckets["my_prs_with_feedback"], mine_row)

    if hidden:
        lines.append(f"=== Hidden — failing CI ({len(hidden)}) ===")
        lines.append(
            "(Chore / Unit Tests / E2E / Lint & Format failing. "
            "Re-run with --include-failing to show.)"
        )
        for pr in hidden:
            n = pr["number"]
            author = (pr.get("author") or {}).get("login") or "?"
            title = pr.get("title") or ""
            failures = ", ".join(pr.get("blocking_failures") or []) or "?"
            lines.append(
                f"#{n}  {size_tag(pr)}  {truncate(title, 64):<64}  {author}"
            )
            lines.append(f"       failing: {failures}")
            lines.append(f"       {pr.get('url')}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def to_json_serializable(
    buckets: dict[str, list[dict[str, Any]]],
    hidden: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    def convert(pr: dict[str, Any], source_bucket: str | None = None) -> dict[str, Any]:
        additions = pr.get("additions")
        deletions = pr.get("deletions")
        out: dict[str, Any] = {
            "number": pr["number"],
            "title": pr.get("title"),
            "author": (pr.get("author") or {}).get("login"),
            "url": pr.get("url"),
            "is_draft": bool(pr.get("isDraft")),
            "head_sha": pr.get("headRefOid"),
            "last_push_at": (pr["last_push_at"].isoformat() if pr.get("last_push_at") else None),
            "my_last_at": (pr["my_last_at"].isoformat() if pr.get("my_last_at") else None),
            "commits_pushed_since": pr.get("commits_pushed_since"),
            "other_commenters": pr.get("other_commenters"),
            "additions": additions,
            "deletions": deletions,
            "changed_files": pr.get("changedFiles"),
            "size_bucket": classify_size(additions, deletions),
            "blocking_failures": pr.get("blocking_failures") or [],
            "zellij_command": zellij_command(pr["number"], pr.get("url") or ""),
        }
        # Tier only applies to needs_review; emit only when actually classified
        # so stale_my_review / my_prs_with_feedback rows don't carry a misleading
        # `"tier": null` field.
        if pr.get("tier") is not None:
            out["tier"] = pr["tier"]
        if source_bucket is not None:
            out["source_bucket"] = source_bucket
        return out

    serialized = {name: [convert(pr) for pr in rows] for name, rows in buckets.items()}
    serialized["hidden_failing_ci"] = [convert(pr, pr.get("_source_bucket")) for pr in hidden]
    return serialized


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7)")
    parser.add_argument("--me", default=None, help="Override detected GitHub login")
    parser.add_argument("--include-drafts", action="store_true", help="Include draft PRs")
    parser.add_argument(
        "--include-mine",
        action="store_true",
        help=(
            "Include PRs authored by the detected user (`--me`). Default is to hide them "
            "— you already get GitHub notifications for your own PRs and the queue should "
            "not review them."
        ),
    )
    parser.add_argument(
        "--exclude-author",
        action="append",
        default=[],
        metavar="LOGIN",
        help=(
            "GitHub login to exclude from the dashboard. Repeatable. Case-insensitive. "
            "Useful when paired with the review queue to drop noisy bots or specific authors."
        ),
    )
    parser.add_argument(
        "--include-failing",
        action="store_true",
        help=(
            "Don't hide PRs where Chore / Unit Tests / E2E / Lint & Format is failing. "
            "By default the dashboard suppresses these — there's nothing to review until the "
            "author pushes a fix."
        ),
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable text")
    parser.add_argument("--no-prefetch", action="store_true", help="Skip invoking fetch-pr-cache.py")
    args = parser.parse_args()

    try:
        me = args.me or detect_me()
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)

    try:
        candidates = list_candidates(args.include_drafts, since)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    excluded_authors = {login.lower() for login in args.exclude_author if login}
    if not args.include_mine and me:
        excluded_authors.add(me.lower())
    candidates = filter_excluded_authors(candidates, excluded_authors)

    if not candidates:
        empty = {
            "needs_review": [],
            "stale_my_review": [],
            "my_prs_with_feedback": [],
            "hidden_failing_ci": [],
        }
        if args.json:
            print(json.dumps({
                "generated_at": now.isoformat(),
                "me": me,
                "window_days": args.days,
                "buckets": empty,
            }, indent=2))
        else:
            print(f"No open PRs updated in the last {args.days} days for {REPO}.")
        return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        detailed = list(pool.map(fetch_pr_details, candidates))

    trusted = load_trusted_contributors()
    buckets = bucket(detailed, me, trusted=trusted)

    if args.include_failing:
        visible_buckets = buckets
        hidden: list[dict[str, Any]] = []
    else:
        visible_buckets, hidden = partition_failing(buckets)

    # Skip prefetch for hidden PRs — the user opted not to see them, so warming
    # their cache would just be wasted gh calls. They re-fetch on demand if the
    # user later passes --include-failing or runs /marshal-code-review directly.
    surfaced = [pr["number"] for rows in visible_buckets.values() for pr in rows]
    if surfaced and not args.no_prefetch:
        prefetch(surfaced)

    if args.json:
        out = {
            "generated_at": now.isoformat(),
            "me": me,
            "window_days": args.days,
            "buckets": to_json_serializable(visible_buckets, hidden),
        }
        print(json.dumps(out, indent=2))
    else:
        print(render_human(visible_buckets, hidden, me, args.days))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        sys.exit(130)
