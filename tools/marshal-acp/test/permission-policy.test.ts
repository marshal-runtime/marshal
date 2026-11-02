import { describe, it, expect } from "vitest";

import { isToolUseAllowed } from "../src/permission-policy.ts";

const allowAll = { profile: "review" as const };

describe("permission-policy: deny PR writes", () => {
  it.each([
    "gh pr comment 1147 -b 'looks good'",
    "gh pr review 1147 --approve",
    "gh pr review 1147 --comment -b foo",
    "gh pr review 1147 --request-changes",
    "gh pr edit 1147",
    "gh pr merge 1147",
    "gh pr close 1147",
    "gh pr ready 1147",
    "  gh   pr   comment   1147   -b foo  ",
    "gh api --method POST repos/x/y/pulls/1147/comments -f body=foo",
    "gh api --method PATCH repos/x/y/pulls/1147/reviews/4 -f body=foo",
    'gh api repos/x/y/issues/1147/comments --method POST -f body="x"',
    "gh auth token",
    "gh   auth   token",
    'curl -X POST -H "Authorization: token foo" https://api.github.com/repos/x/y/pulls/1147/comments -d "{}"',
    "wget --post-data foo https://api.github.com/repos/x/y/issues/1147/comments",
    // Chained-command bypasses — previously slipped through the ^\s* anchor.
    "cd /tmp && gh pr comment 1 -b foo",
    "ls && gh pr review 1 --approve",
    "gh pr view 1 ; gh pr comment 1 -b foo",
    "cd /tmp && gh auth token",
    // `gh api` with implicit-POST shape (-f / -F / --field / --raw-field
    // without an explicit --method). gh applies POST by default when any
    // field is present.
    "gh api repos/x/y/issues/1147/comments -f body=foo",
    "gh api repos/x/y/issues/1147/comments -F body=foo",
    "gh api repos/x/y/issues/1147/comments --field body=foo",
    "gh api repos/x/y/issues/1147/comments --raw-field body=foo",
  ])("denies %s", (cmd) => {
    expect(isToolUseAllowed({ tool: "Bash", input: { command: cmd } }, allowAll)).toBe(false);
  });

  it.each([
    { tool: "mcp__github__create_pull_request_review", input: {} },
    { tool: "mcp__github__create_issue_comment", input: {} },
    { tool: "mcp__github__update_pull_request", input: {} },
    { tool: "mcp__github__merge_pull_request", input: {} },
  ])("denies MCP github write tool $tool", (req) => {
    expect(isToolUseAllowed(req, allowAll)).toBe(false);
  });
});

describe("permission-policy: allow read paths", () => {
  it.each([
    "gh pr view 1147",
    "gh pr diff 1147",
    "gh pr checks 1147",
    "gh pr list",
    "gh api repos/x/y/pulls/1147",
    "gh api repos/x/y/pulls/1147/comments",
    "git log --oneline -n 5",
    "rg foo src/",
    "python3 skills/marshal-code-review/scripts/fetch-pr-cache.py 1147 --json",
  ])("allows %s", (cmd) => {
    expect(isToolUseAllowed({ tool: "Bash", input: { command: cmd } }, allowAll)).toBe(true);
  });

  it.each([
    { tool: "Read", input: {} },
    { tool: "Grep", input: {} },
    { tool: "Glob", input: {} },
    { tool: "mcp__github__get_pull_request", input: {} },
    { tool: "mcp__github__list_pull_request_files", input: {} },
  ])("allows non-Bash read tool $tool", (req) => {
    expect(isToolUseAllowed(req, allowAll)).toBe(true);
  });
});

describe("permission-policy: default profile (no policy denies)", () => {
  const defaultProfile = { profile: "default" as const };

  it.each([
    // Every command the `review` profile denies is allowed under `default`.
    // The user is in the loop; the runtime's own permission prompts are the
    // only filter.
    "gh pr comment 1147 -b 'looks good'",
    "gh pr review 1147 --approve",
    "gh api repos/x/y/issues/1147/comments --method POST -f body=foo",
    "gh api repos/x/y/issues/1147/comments -f body=foo",
    "gh auth token",
    "cd /tmp && gh pr comment 1 -b foo",
  ])("allows %s under default profile", (cmd) => {
    expect(isToolUseAllowed({ tool: "Bash", input: { command: cmd } }, defaultProfile)).toBe(true);
  });

  it("allows MCP github write tools under default profile", () => {
    expect(
      isToolUseAllowed(
        { tool: "mcp__github__create_pull_request_review", input: {} },
        defaultProfile,
      ),
    ).toBe(true);
  });
});
