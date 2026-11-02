"""Tests for the marshal-code-review fetch-pr-cache.py pure logic.

Run with:
    python3 -m unittest skills.marshal-code-review.scripts.test_fetch_pr_cache

or from the script dir:
    python3 -m unittest test_fetch_pr_cache

The network-hitting code (current_head_sha, fetch_artifacts) is deliberately
not covered. We focus on the cache-freshness / sweep / atomic-write logic
that's testable with a tmp dir alone.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parent / "fetch-pr-cache.py"
spec = importlib.util.spec_from_file_location("fetch_pr_cache", SCRIPT_PATH)
assert spec and spec.loader
fpc = importlib.util.module_from_spec(spec)
sys.modules["fetch_pr_cache"] = fpc
spec.loader.exec_module(fpc)

CACHE_FILES = fpc.CACHE_FILES


def write_complete_cache(pr_dir: Path, head: str, mtime: float | None = None) -> None:
    """Populate pr_dir with a realistic-looking complete cache."""
    pr_dir.mkdir(parents=True, exist_ok=True)
    for name in CACHE_FILES:
        (pr_dir / name).write_text("[]", encoding="utf-8")
    (pr_dir / "head-sha").write_text(head + "\n", encoding="utf-8")
    if mtime is not None:
        os.utime(pr_dir / "head-sha", (mtime, mtime))
        # Also adjust dir mtime so sweep_stale sees the same timestamp whether
        # it falls back to the dir or reads head-sha.
        os.utime(pr_dir, (mtime, mtime))


class StoredHeadSha(unittest.TestCase):
    def test_reads_stored_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            pr_dir.mkdir()
            (pr_dir / "head-sha").write_text("abc123\n")
            self.assertEqual(fpc.stored_head_sha(pr_dir), "abc123")

    def test_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(fpc.stored_head_sha(Path(tmp) / "pr-1"))

    def test_empty_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            pr_dir.mkdir()
            (pr_dir / "head-sha").write_text("")
            self.assertIsNone(fpc.stored_head_sha(pr_dir))


class CacheIsFresh(unittest.TestCase):
    def test_fresh_when_sha_matches_and_all_files_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            write_complete_cache(pr_dir, "abc123")
            self.assertTrue(fpc.cache_is_fresh(pr_dir, "abc123"))

    def test_stale_when_sha_mismatches(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            write_complete_cache(pr_dir, "abc123")
            self.assertFalse(fpc.cache_is_fresh(pr_dir, "different"))

    def test_stale_when_any_file_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            write_complete_cache(pr_dir, "abc123")
            (pr_dir / "diff.patch").unlink()
            self.assertFalse(fpc.cache_is_fresh(pr_dir, "abc123"))

    def test_stale_when_missing_head_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            pr_dir.mkdir()
            for name in CACHE_FILES:
                (pr_dir / name).write_text("[]")
            self.assertFalse(fpc.cache_is_fresh(pr_dir, "abc123"))


class HeadShaMtime(unittest.TestCase):
    def test_returns_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            pr_dir = Path(tmp) / "pr-1"
            pr_dir.mkdir()
            (pr_dir / "head-sha").write_text("abc")
            mtime = fpc.head_sha_mtime(pr_dir)
            self.assertIsNotNone(mtime)
            self.assertAlmostEqual(mtime, time.time(), delta=5)

    def test_none_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(fpc.head_sha_mtime(Path(tmp) / "pr-1"))


class SweepStale(unittest.TestCase):
    def test_removes_old_pr_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = time.time() - 10 * 86400
            fresh = time.time() - 1 * 86400
            write_complete_cache(root / "pr-1", "old", mtime=old)
            write_complete_cache(root / "pr-2", "fresh", mtime=fresh)

            removed = fpc.sweep_stale(root, max_age_days=7)
            self.assertEqual(removed, [1])
            self.assertFalse((root / "pr-1").exists())
            self.assertTrue((root / "pr-2").exists())

    def test_keep_set_protects_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = time.time() - 10 * 86400
            write_complete_cache(root / "pr-1", "x", mtime=old)
            write_complete_cache(root / "pr-2", "y", mtime=old)

            removed = fpc.sweep_stale(root, max_age_days=7, keep={1})
            self.assertEqual(removed, [2])
            self.assertTrue((root / "pr-1").exists())

    def test_max_age_zero_disables(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_complete_cache(root / "pr-1", "x", mtime=time.time() - 100 * 86400)

            self.assertEqual(fpc.sweep_stale(root, max_age_days=0), [])
            self.assertTrue((root / "pr-1").exists())

    def test_ignores_non_pr_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = time.time() - 10 * 86400
            write_complete_cache(root / "pr-1", "x", mtime=old)
            (root / "not-a-pr").mkdir()
            os.utime(root / "not-a-pr", (old, old))
            (root / "README.txt").write_text("ignore me")
            os.utime(root / "README.txt", (old, old))

            removed = fpc.sweep_stale(root, max_age_days=7)
            self.assertEqual(removed, [1])
            self.assertTrue((root / "not-a-pr").exists())
            self.assertTrue((root / "README.txt").exists())

    def test_missing_cache_root_is_noop(self):
        self.assertEqual(fpc.sweep_stale(Path("/nonexistent/xyz"), 7), [])


class AtomicWrite(unittest.TestCase):
    def test_creates_parent_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "subdir" / "out.txt"
            fpc.atomic_write(target, "hello")
            self.assertEqual(target.read_text(), "hello")

    def test_overwrites_existing(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "out.txt"
            target.write_text("old")
            fpc.atomic_write(target, "new")
            self.assertEqual(target.read_text(), "new")


if __name__ == "__main__":
    unittest.main()
