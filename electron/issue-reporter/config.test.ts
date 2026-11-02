import { describe, expect, it } from "vitest";

import { ISSUE_REPORTER_TARGET_ENV, resolveIssueReporterTarget } from "./config";

describe("resolveIssueReporterTarget", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveIssueReporterTarget(undefined)).toBeNull();
    expect(resolveIssueReporterTarget({})).toBeNull();
  });

  it("accepts a well-formed owner/name target from settings", () => {
    expect(resolveIssueReporterTarget({ target: "acme-org/widget" })).toBe("acme-org/widget");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveIssueReporterTarget({ target: "  acme/widget  " })).toBe("acme/widget");
  });

  it.each([
    "../traversal/attempt",
    "owner",
    "owner/repo/extra",
    "owner/re po",
    "owner/repo?x=1",
    "owner/repo#frag",
    "https://evil.example.com/owner/repo",
  ])("rejects malformed target %s", (target) => {
    expect(resolveIssueReporterTarget({ target })).toBeNull();
  });

  it("lets the env override win over settings", () => {
    const previous = process.env[ISSUE_REPORTER_TARGET_ENV];
    process.env[ISSUE_REPORTER_TARGET_ENV] = "env-owner/env-repo";
    try {
      expect(resolveIssueReporterTarget({ target: "settings-owner/settings-repo" })).toBe(
        "env-owner/env-repo",
      );
    } finally {
      if (previous === undefined) delete process.env[ISSUE_REPORTER_TARGET_ENV];
      else process.env[ISSUE_REPORTER_TARGET_ENV] = previous;
    }
  });

  it("falls through to settings when the env override is malformed", () => {
    const previous = process.env[ISSUE_REPORTER_TARGET_ENV];
    process.env[ISSUE_REPORTER_TARGET_ENV] = "not-a-target";
    try {
      expect(resolveIssueReporterTarget({ target: "acme/widget" })).toBe("acme/widget");
    } finally {
      if (previous === undefined) delete process.env[ISSUE_REPORTER_TARGET_ENV];
      else process.env[ISSUE_REPORTER_TARGET_ENV] = previous;
    }
  });
});
