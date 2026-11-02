"""Tests for the marshal-review-dashboard list-prs.py pure logic.

Run with:
    python3 -m unittest skills.marshal-review-dashboard.scripts.test_list_prs

or from the script dir:
    python3 -m unittest test_list_prs

The network-hitting code (list_candidates, fetch_pr_details, attach_commit_counts,
detect_me, prefetch) is deliberately not covered — it's a thin shell over `gh`.
We focus on the decision logic that's easy to get wrong: size classification,
bucket assignment, and bot filtering.
"""

from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path

# list-prs.py has a dash in its name so we can't import it normally.
SCRIPT_PATH = Path(__file__).resolve().parent / "list-prs.py"
spec = importlib.util.spec_from_file_location("list_prs", SCRIPT_PATH)
assert spec and spec.loader
list_prs = importlib.util.module_from_spec(spec)
sys.modules["list_prs"] = list_prs
spec.loader.exec_module(list_prs)

classify_size = list_prs.classify_size
bucket = list_prs.bucket
is_bot = list_prs.is_bot
truncate = list_prs.truncate
parse_iso = list_prs.parse_iso
blocking_check_failures = list_prs.blocking_check_failures
partition_failing = list_prs.partition_failing
load_trusted_contributors = list_prs.load_trusted_contributors
pr_tier = list_prs.pr_tier
tier_priority = list_prs.tier_priority
to_json_serializable = list_prs.to_json_serializable
filter_excluded_authors = list_prs.filter_excluded_authors
TIER_MAINTAINER = list_prs.TIER_MAINTAINER
TIER_TRUSTED = list_prs.TIER_TRUSTED
TIER_OTHER = list_prs.TIER_OTHER

ME = "reviewer_one"
UTC = timezone.utc


def t(hours_ago: float) -> datetime:
    return datetime.now(UTC) - timedelta(hours=hours_ago)


def make_pr(
    number: int,
    author: str,
    activity: list[tuple[str, datetime]],
    last_push_at: datetime | None,
    **extra,
) -> dict:
    return {
        "number": number,
        "title": f"Test PR #{number}",
        "author": {"login": author},
        "url": f"https://example/{number}",
        "headRefOid": "abc123",
        "additions": 50,
        "deletions": 20,
        "changedFiles": 3,
        "labels": [],
        "last_push_at": last_push_at,
        "activity": activity,
        **extra,
    }


class SizeClassification(unittest.TestCase):
    def test_xs_under_100(self):
        self.assertEqual(classify_size(50, 49), "XS")
        self.assertEqual(classify_size(0, 0), "XS")

    def test_s_under_500(self):
        # 100 is not XS (exclusive upper); it's S.
        self.assertEqual(classify_size(100, 0), "S")
        self.assertEqual(classify_size(250, 249), "S")

    def test_m_under_1500(self):
        self.assertEqual(classify_size(500, 0), "M")
        self.assertEqual(classify_size(750, 749), "M")

    def test_l_under_3500(self):
        self.assertEqual(classify_size(1500, 0), "L")
        self.assertEqual(classify_size(1750, 1749), "L")

    def test_xl_at_or_above_3500(self):
        self.assertEqual(classify_size(3500, 0), "XL")
        self.assertEqual(classify_size(10000, 5000), "XL")

    def test_none_counts_as_zero(self):
        self.assertEqual(classify_size(None, None), "XS")
        self.assertEqual(classify_size(50, None), "XS")


class BotFiltering(unittest.TestCase):
    def test_human_logins(self):
        self.assertFalse(is_bot("reviewer_one"))
        self.assertFalse(is_bot("reviewer_two"))

    def test_bot_suffix(self):
        self.assertTrue(is_bot("dependabot[bot]"))
        self.assertTrue(is_bot("custom[bot]"))

    def test_known_bot_logins(self):
        self.assertTrue(is_bot("github-actions[bot]"))
        self.assertTrue(is_bot("copilot-pull-request-reviewer"))
        self.assertTrue(is_bot("copilot"))

    def test_empty(self):
        self.assertTrue(is_bot(""))
        self.assertTrue(is_bot(None))


class BucketAssignment(unittest.TestCase):
    def test_needs_review_no_activity(self):
        pr = make_pr(1, "alice", activity=[], last_push_at=t(2))
        b = bucket([pr], ME)
        self.assertEqual([p["number"] for p in b["needs_review"]], [1])
        self.assertEqual(b["stale_my_review"], [])
        self.assertEqual(b["my_prs_with_feedback"], [])

    def test_needs_review_someone_else_commented(self):
        # Others commented but not me.
        pr = make_pr(
            2,
            "alice",
            activity=[("bob", t(5)), ("carol", t(3))],
            last_push_at=t(2),
        )
        b = bucket([pr], ME)
        self.assertEqual(len(b["needs_review"]), 1)
        commenters = {c["login"] for c in b["needs_review"][0]["other_commenters"]}
        self.assertEqual(commenters, {"bob", "carol"})

    def test_needs_review_filters_bots(self):
        pr = make_pr(
            3,
            "alice",
            activity=[("dependabot[bot]", t(1))],
            last_push_at=t(2),
        )
        b = bucket([pr], ME)
        self.assertEqual(len(b["needs_review"]), 1)
        self.assertEqual(b["needs_review"][0]["other_commenters"], [])

    def test_stale_my_review(self):
        # I commented 5h ago, author pushed 1h ago -> stale.
        pr = make_pr(
            4,
            "alice",
            activity=[(ME, t(5))],
            last_push_at=t(1),
        )
        b = bucket([pr], ME)
        self.assertEqual([p["number"] for p in b["stale_my_review"]], [4])
        self.assertEqual(b["needs_review"], [])

    def test_stale_not_stale_if_push_before_my_comment(self):
        # I commented 1h ago, last push 5h ago -> NOT stale.
        pr = make_pr(
            5,
            "alice",
            activity=[(ME, t(1))],
            last_push_at=t(5),
        )
        b = bucket([pr], ME)
        self.assertEqual(b["stale_my_review"], [])
        self.assertEqual(b["needs_review"], [])

    def test_my_pr_with_feedback(self):
        # I'm the author, someone else commented after I pushed.
        pr = make_pr(
            6,
            ME,
            activity=[("bob", t(1))],
            last_push_at=t(5),
        )
        b = bucket([pr], ME)
        self.assertEqual([p["number"] for p in b["my_prs_with_feedback"]], [6])

    def test_my_pr_no_feedback_after_push(self):
        # I'm the author, someone commented BEFORE my last push -> drop.
        pr = make_pr(
            7,
            ME,
            activity=[("bob", t(5))],
            last_push_at=t(1),
        )
        b = bucket([pr], ME)
        self.assertEqual(b["my_prs_with_feedback"], [])

    def test_fallthrough_warn_when_last_push_unknown(self):
        # My activity present but last_push is None (commit fetch failed).
        # Should be dropped and stderr-warn.
        pr = make_pr(
            8,
            "alice",
            activity=[(ME, t(5))],
            last_push_at=None,
        )
        err = io.StringIO()
        with redirect_stderr(err):
            b = bucket([pr], ME)
        self.assertEqual(b["needs_review"], [])
        self.assertEqual(b["stale_my_review"], [])
        self.assertIn("PR #8 skipped", err.getvalue())

    def test_no_spurious_warn_for_author_pr_with_no_feedback(self):
        # My own PR, no new activity — silently dropped, not worth warning.
        pr = make_pr(
            9,
            ME,
            activity=[],
            last_push_at=t(1),
        )
        err = io.StringIO()
        with redirect_stderr(err):
            bucket([pr], ME)
        self.assertEqual(err.getvalue(), "")


class Truncate(unittest.TestCase):
    def test_short_unchanged(self):
        self.assertEqual(truncate("hello", 10), "hello")

    def test_exact_width_unchanged(self):
        self.assertEqual(truncate("hello", 5), "hello")

    def test_ellipsis_applied(self):
        self.assertEqual(truncate("hello world", 8), "hello...")

    def test_tiny_width_no_ellipsis(self):
        self.assertEqual(truncate("hello world", 3), "hel")
        self.assertEqual(truncate("hello world", 2), "he")


class ParseIso(unittest.TestCase):
    def test_with_z(self):
        ts = parse_iso("2026-04-21T16:32:44Z")
        assert ts is not None
        self.assertEqual(ts.tzinfo, UTC)
        self.assertEqual(ts.year, 2026)
        self.assertEqual(ts.hour, 16)

    def test_naive_becomes_utc(self):
        ts = parse_iso("2026-04-21T16:32:44")
        assert ts is not None
        self.assertEqual(ts.tzinfo, UTC)

    def test_invalid_returns_none(self):
        self.assertIsNone(parse_iso("not a date"))
        self.assertIsNone(parse_iso(""))
        self.assertIsNone(parse_iso(None))


class BlockingCheckFailures(unittest.TestCase):
    """Match the real `gh pr checks --json name,state,bucket,workflow` shape.

    Verified against OmerMachluf/marshal on 2026-05-05. If the repo's check naming ever
    changes (e.g. job names get re-suffixed) these patterns will need updating.
    """

    def _check(self, *, name: str = "", workflow: str = "", bucket: str = "fail"):
        return {"name": name, "workflow": workflow, "bucket": bucket}

    def test_no_checks(self):
        self.assertEqual(blocking_check_failures([]), [])
        self.assertEqual(blocking_check_failures(None), [])

    def test_all_passing(self):
        checks = [
            self._check(name="Marshal Buddy (Unit Tests UnitTests)", bucket="pass"),
            self._check(name="check", workflow="PR template", bucket="pass"),
        ]
        self.assertEqual(blocking_check_failures(checks), [])

    def test_pending_does_not_count(self):
        checks = [
            self._check(name="Marshal Buddy (Unit Tests UnitTests)", bucket="pending"),
        ]
        self.assertEqual(blocking_check_failures(checks), [])

    def test_chore_failure(self):
        checks = [self._check(name="check", workflow="PR template", bucket="fail")]
        self.assertEqual(blocking_check_failures(checks), ["Chore"])

    def test_unit_tests_failure(self):
        checks = [self._check(name="Marshal Buddy (Unit Tests UnitTests)")]
        self.assertEqual(blocking_check_failures(checks), ["Unit Tests"])

    def test_unit_tests_macos_variant(self):
        checks = [self._check(name="Marshal Buddy (Unit Tests (macOS) UnitTestsMacOS)")]
        self.assertEqual(blocking_check_failures(checks), ["Unit Tests"])

    def test_e2e_failure(self):
        checks = [self._check(name="Marshal Buddy (E2E Tests E2E)")]
        self.assertEqual(blocking_check_failures(checks), ["E2E Tests"])

    def test_lint_format_failure(self):
        checks = [self._check(name="Marshal Buddy (Lint & Format LintAndFormat)")]
        self.assertEqual(blocking_check_failures(checks), ["Lint & Format"])

    def test_multiple_failures_stable_order(self):
        # Order in input is jumbled; output should match BLOCKING_CHECK_LABELS order.
        checks = [
            self._check(name="Marshal Buddy (E2E Tests E2E)"),
            self._check(name="Marshal Buddy (Lint & Format LintAndFormat)"),
            self._check(name="check", workflow="PR template"),
            self._check(name="Marshal Buddy (Unit Tests UnitTests)"),
        ]
        self.assertEqual(
            blocking_check_failures(checks),
            ["Chore", "Unit Tests", "E2E Tests", "Lint & Format"],
        )

    def test_dedupe_within_category(self):
        # Two unit-test variants both fail — collapse to a single label.
        checks = [
            self._check(name="Marshal Buddy (Unit Tests UnitTests)"),
            self._check(name="Marshal Buddy (Unit Tests (macOS) UnitTestsMacOS)"),
        ]
        self.assertEqual(blocking_check_failures(checks), ["Unit Tests"])

    def test_unrelated_failure_ignored(self):
        # An advanced-security or labeler failure isn't merge-blocking from our
        # perspective — must not appear in the output.
        checks = [
            self._check(name="GitOps/AdvancedSecurity"),
            self._check(name="Marshal Buddy"),  # aggregate parent — skip
        ]
        self.assertEqual(blocking_check_failures(checks), [])


class PartitionFailing(unittest.TestCase):
    def test_no_failures_keeps_everything(self):
        prs = [
            {"number": 1, "blocking_failures": []},
            {"number": 2, "blocking_failures": []},
        ]
        kept, hidden = partition_failing({"needs_review": prs, "stale_my_review": []})
        self.assertEqual([p["number"] for p in kept["needs_review"]], [1, 2])
        self.assertEqual(hidden, [])

    def test_failing_pr_moves_to_hidden(self):
        prs = [
            {"number": 1, "blocking_failures": []},
            {"number": 2, "blocking_failures": ["Lint & Format"]},
        ]
        kept, hidden = partition_failing({"needs_review": prs})
        self.assertEqual([p["number"] for p in kept["needs_review"]], [1])
        self.assertEqual([p["number"] for p in hidden], [2])
        self.assertEqual(hidden[0]["_source_bucket"], "needs_review")

    def test_partition_preserves_bucket_keys_when_empty(self):
        prs_failing = [{"number": 5, "blocking_failures": ["E2E Tests"]}]
        kept, hidden = partition_failing(
            {"needs_review": prs_failing, "stale_my_review": [], "my_prs_with_feedback": []}
        )
        # All three keys present in kept (even when their lists are empty)
        # so renderers don't have to guard against KeyError.
        self.assertEqual(set(kept.keys()), {"needs_review", "stale_my_review", "my_prs_with_feedback"})
        self.assertEqual(kept["needs_review"], [])
        self.assertEqual(len(hidden), 1)


class LoadTrustedContributors(unittest.TestCase):
    def _write(self, content: str) -> Path:
        tmp = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".trusted")
        tmp.write(content)
        tmp.close()
        path = Path(tmp.name)
        self.addCleanup(path.unlink)
        return path

    def test_missing_file_returns_empty(self):
        self.assertEqual(load_trusted_contributors(Path("/nope/does/not/exist")), set())

    def test_basic_logins(self):
        path = self._write("alice\nbob\n")
        self.assertEqual(load_trusted_contributors(path), {"alice", "bob"})

    def test_at_prefix_optional(self):
        path = self._write("@alice\nbob\n@carol\n")
        self.assertEqual(load_trusted_contributors(path), {"alice", "bob", "carol"})

    def test_blank_lines_and_comments_ignored(self):
        path = self._write(
            "# top-level note\n"
            "\n"
            "alice\n"
            "   \n"
            "# bob is on leave, not trusted right now\n"
            "carol\n"
        )
        self.assertEqual(load_trusted_contributors(path), {"alice", "carol"})

    def test_inline_comments_stripped(self):
        path = self._write("alice  # promoted from contributor 2026-01\nbob\n")
        self.assertEqual(load_trusted_contributors(path), {"alice", "bob"})

    def test_lowercased(self):
        # GitHub logins are case-insensitive; we normalize to lowercase so the
        # caller can compare without re-casing.
        path = self._write("Alice\nBOB\n")
        self.assertEqual(load_trusted_contributors(path), {"alice", "bob"})

    def test_extra_tokens_after_login_tolerated(self):
        # Defensive — first token wins, junk after is ignored.
        path = self._write("@alice junk_field\n")
        self.assertEqual(load_trusted_contributors(path), {"alice"})


class PRTier(unittest.TestCase):
    def test_maintainer_label_wins(self):
        # Author is in trusted set AND has maintainer label -> maintainer.
        pr = make_pr(1, "alice", activity=[], last_push_at=t(1),
                     labels=[{"name": "maintainer"}])
        self.assertEqual(pr_tier(pr, {"alice"}), TIER_MAINTAINER)

    def test_maintainer_label_case_insensitive(self):
        pr = make_pr(2, "alice", activity=[], last_push_at=t(1),
                     labels=[{"name": "Maintainer"}])
        self.assertEqual(pr_tier(pr, set()), TIER_MAINTAINER)

    def test_trusted_when_in_set(self):
        pr = make_pr(3, "bob", activity=[], last_push_at=t(1))
        self.assertEqual(pr_tier(pr, {"bob"}), TIER_TRUSTED)

    def test_trusted_lookup_is_case_insensitive(self):
        # Author case shouldn't matter — set is lowercased, author normalized.
        pr = make_pr(4, "Bob", activity=[], last_push_at=t(1))
        self.assertEqual(pr_tier(pr, {"bob"}), TIER_TRUSTED)

    def test_other_when_neither(self):
        pr = make_pr(5, "stranger", activity=[], last_push_at=t(1))
        self.assertEqual(pr_tier(pr, {"alice", "bob"}), TIER_OTHER)

    def test_no_labels_field(self):
        # Defensive: if `labels` is missing entirely, treat as no label.
        pr = make_pr(6, "alice", activity=[], last_push_at=t(1))
        del pr["labels"]
        self.assertEqual(pr_tier(pr, set()), TIER_OTHER)

    def test_unrelated_labels_dont_match(self):
        pr = make_pr(7, "alice", activity=[], last_push_at=t(1),
                     labels=[{"name": "type: feat"}, {"name": "size/M"}])
        self.assertEqual(pr_tier(pr, set()), TIER_OTHER)


class TierPriority(unittest.TestCase):
    def test_ordering(self):
        self.assertLess(tier_priority(TIER_MAINTAINER), tier_priority(TIER_TRUSTED))
        self.assertLess(tier_priority(TIER_TRUSTED), tier_priority(TIER_OTHER))

    def test_unknown_sinks(self):
        self.assertGreater(tier_priority("nonsense"), tier_priority(TIER_OTHER))


class NeedsReviewSortByTier(unittest.TestCase):
    def test_maintainers_first_then_trusted_then_other(self):
        # Cross-tier order: maintainer → trusted → other. Within tier, freshest
        # last_push_at wins (t(1) = 1h ago is fresher than t(2) = 2h ago).
        prs = [
            make_pr(1, "stranger_a", activity=[], last_push_at=t(1)),  # other,    1h ago
            make_pr(2, "trusted_a",  activity=[], last_push_at=t(2)),  # trusted,  2h ago
            make_pr(3, "anyone",     activity=[], last_push_at=t(3),
                    labels=[{"name": "maintainer"}]),                    # maintainer, 3h ago
            make_pr(4, "stranger_b", activity=[], last_push_at=t(4)),  # other,    4h ago
            make_pr(5, "trusted_b",  activity=[], last_push_at=t(5)),  # trusted,  5h ago
            make_pr(6, "anyone2",    activity=[], last_push_at=t(6),
                    labels=[{"name": "maintainer"}]),                    # maintainer, 6h ago
        ]
        b = bucket(prs, ME, trusted={"trusted_a", "trusted_b"})
        ordered = [(p["number"], p["tier"]) for p in b["needs_review"]]
        self.assertEqual(
            ordered,
            [
                (3, TIER_MAINTAINER),  # 3h ago, freshest maintainer
                (6, TIER_MAINTAINER),  # 6h ago
                (2, TIER_TRUSTED),     # 2h ago, freshest trusted
                (5, TIER_TRUSTED),     # 5h ago
                (1, TIER_OTHER),       # 1h ago, freshest other
                (4, TIER_OTHER),       # 4h ago
            ],
        )

    def test_default_trusted_set_is_empty(self):
        # Calling bucket() without a trusted= kwarg still works (no trust tier
        # promotion, but maintainer-labelled PRs still surface first).
        prs = [
            make_pr(1, "stranger", activity=[], last_push_at=t(1)),
            make_pr(2, "anyone",   activity=[], last_push_at=t(2),
                    labels=[{"name": "maintainer"}]),
        ]
        b = bucket(prs, ME)
        self.assertEqual([p["number"] for p in b["needs_review"]], [2, 1])
        self.assertEqual(b["needs_review"][0]["tier"], TIER_MAINTAINER)
        self.assertEqual(b["needs_review"][1]["tier"], TIER_OTHER)

    def test_other_tier_sorted_by_last_push_desc(self):
        # All `other` tier — freshest push surfaces first regardless of input order.
        prs = [
            make_pr(1, "stranger_a", activity=[], last_push_at=t(10)),  # 10h ago
            make_pr(2, "stranger_b", activity=[], last_push_at=t(1)),   # 1h ago  (freshest)
            make_pr(3, "stranger_c", activity=[], last_push_at=t(5)),   # 5h ago
        ]
        b = bucket(prs, ME)
        self.assertEqual([p["number"] for p in b["needs_review"]], [2, 3, 1])

    def test_missing_last_push_sinks_to_bottom_of_tier(self):
        # PRs whose commit fetch failed (last_push_at=None) should not crash
        # the sort and should land at the bottom of their tier.
        prs = [
            make_pr(1, "stranger_a", activity=[], last_push_at=None),
            make_pr(2, "stranger_b", activity=[], last_push_at=t(5)),
            make_pr(3, "stranger_c", activity=[], last_push_at=t(1)),
        ]
        b = bucket(prs, ME)
        self.assertEqual([p["number"] for p in b["needs_review"]], [3, 2, 1])


class FilterExcludedAuthors(unittest.TestCase):
    def test_no_exclusions_passes_through(self):
        prs = [make_pr(1, "alice", activity=[], last_push_at=t(1))]
        self.assertEqual(filter_excluded_authors(prs, set()), prs)

    def test_excludes_listed_author(self):
        prs = [
            make_pr(1, "alice", activity=[], last_push_at=t(1)),
            make_pr(2, "bob",   activity=[], last_push_at=t(1)),
        ]
        out = filter_excluded_authors(prs, {"alice"})
        self.assertEqual([p["number"] for p in out], [2])

    def test_case_insensitive(self):
        prs = [make_pr(1, "Alice", activity=[], last_push_at=t(1))]
        out = filter_excluded_authors(prs, {"alice"})
        self.assertEqual(out, [])

    def test_missing_author_login_is_kept(self):
        # Defensive: a malformed gh row with no login shouldn't be silently dropped.
        prs = [{"number": 1, "author": None, "title": "t"}]
        out = filter_excluded_authors(prs, {"alice"})
        self.assertEqual(len(out), 1)


class JsonShape(unittest.TestCase):
    """Tier should appear only on needs_review entries — stale and mine-with-feedback
    rows have no tier concept, so a `tier: null` field there is misleading.
    """

    def test_tier_omitted_for_stale_entries(self):
        stale_pr = make_pr(1, "alice", activity=[(ME, t(5))], last_push_at=t(1))
        b = bucket([stale_pr], ME)
        # Round-trip to JSON-shape; tier should not appear on stale rows.
        # `to_json_serializable` expects a `commits_pushed_since` field on stale
        # entries — bucket() already added it. Hidden list is empty for this case.
        serialized = to_json_serializable(b, hidden=[])
        self.assertEqual(len(serialized["stale_my_review"]), 1)
        self.assertNotIn("tier", serialized["stale_my_review"][0])

    def test_tier_present_for_needs_review_entries(self):
        pr = make_pr(2, "alice", activity=[], last_push_at=t(1))
        b = bucket([pr], ME)
        serialized = to_json_serializable(b, hidden=[])
        self.assertEqual(serialized["needs_review"][0]["tier"], TIER_OTHER)

    def test_tier_omitted_for_my_prs_with_feedback(self):
        my_pr = make_pr(3, ME, activity=[("bob", t(1))], last_push_at=t(5))
        b = bucket([my_pr], ME)
        serialized = to_json_serializable(b, hidden=[])
        self.assertEqual(len(serialized["my_prs_with_feedback"]), 1)
        self.assertNotIn("tier", serialized["my_prs_with_feedback"][0])


if __name__ == "__main__":
    unittest.main()
