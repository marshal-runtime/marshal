// Marshal-owned tooling test.
import { describe, it, expect } from "vitest";

import { renderInitial, appendIteration } from "../src/marshal-review-renderer.ts";
import type { Iteration } from "../src/marshal-review-types.ts";

const pr = {
  number: 1147,
  url: "https://github.com/OmerMachluf/marshal/pull/1147",
  title: "Add tunnel cache",
  author: "alice",
};

const iter1: Iteration = {
  sha: "a1b2c3d",
  sessionId: "cc-1",
  agentRuntime: "claude",
  startedAt: "2026-05-08T14:00:00Z",
  completedAt: "2026-05-08T14:08:00Z",
  status: "pending-confirmation",
};

const iter2: Iteration = {
  sha: "7f3a9c2",
  sessionId: "cc-2",
  agentRuntime: "claude",
  startedAt: "2026-05-09T11:30:00Z",
  completedAt: "2026-05-09T11:39:00Z",
  status: "pending-confirmation",
};

describe("renderInitial", () => {
  it("produces a frontmatter + heading + iteration block", () => {
    const md = renderInitial(pr, iter1, "## Findings\n\n- nothing major\n");
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("pr: 1147");
    expect(md).toContain(`url: ${pr.url}`);
    expect(md).toContain(`title: ${pr.title}`);
    expect(md).toContain(`status: pending-confirmation`);
    expect(md).toContain(`# PR #1147 — Add tunnel cache`);
    expect(md).toContain(`## Iteration 1 · \`a1b2c3d\``);
    expect(md).toContain("## Findings");
    expect(md).not.toContain("<details>");
  });
});

describe("appendIteration", () => {
  it("wraps prior iterations in <details> and prepends the new one", () => {
    const initial = renderInitial(pr, iter1, "## Findings\n\n- nothing major\n");
    const next = appendIteration(initial, iter2, "## Findings\n\n- watch out for X\n");

    expect(next).toContain(`## Iteration 2 · \`7f3a9c2\``);
    expect(next).toContain("watch out for X");
    expect(next).toContain("<details>");
    expect(next).toContain("Iteration 1 · <code>a1b2c3d</code>");
    expect(next).toContain("nothing major");

    // Frontmatter iterations[] should now have both, latest first
    const fm = next.match(/iterations:[\s\S]*?(?=\n---\n)/)?.[0] ?? "";
    expect(fm).toMatch(/sha: 7f3a9c2[\s\S]+sha: a1b2c3d/);
    // Top-level status mirrors latest iteration
    expect(next).toMatch(/^status: pending-confirmation/m);
  });

  it("appending to a markdown without prior <details> wraps just the previous iteration", () => {
    const initial = renderInitial(pr, iter1, "Body 1");
    const next = appendIteration(initial, iter2, "Body 2");
    expect((next.match(/<details>/g) ?? []).length).toBe(1);
  });
});
