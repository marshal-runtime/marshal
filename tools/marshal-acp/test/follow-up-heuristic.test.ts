// Marshal-owned module.
import { describe, expect, it } from "vitest";

import { needsSynthesisFollowUp } from "../src/slot.ts";

describe("needsSynthesisFollowUp — fires (truncated reviews)", () => {
  it.each([
    [
      "narration ending at N of M complete",
      "Dispatching 14 sub-agents in parallel.Two agents back. Waiting on the rest.Three agents back. Continuing to wait.Fourteen agents back. Waiting on electron-architecture.",
    ],
    [
      "narration ending at outstanding",
      "I'll review the PR.Dispatching agents.14 of 14 complete (architecture-doc-sync still outstanding). Waiting for last one.",
    ],
    [
      "narration ending at continuing to wait",
      "Five agents back. Continuing to wait.Six agents back. Continuing to wait.",
    ],
    [
      "narration with N of M done (alternate phrasing)",
      "Reading the diff.Dispatching 10 sub-agents.5 of 10 done. Continuing to wait for the rest.",
    ],
    ["single agent remaining", "Dispatching 14 sub-agents.13 of 14 back. 1 agent remaining."],
    [
      "multiple agents remaining (plural)",
      "Dispatching 14 sub-agents.11 of 14 back. 3 sub-agents remaining.",
    ],
    ["N to go phrasing", "Dispatching agents.Most are back. 1 to go (tests-quality)."],
    ["N of M still running phrasing", "Dispatching 8 sub-agents.7 are back. 1 of 8 still running."],
  ])("fires for: %s", (_label, body) => {
    expect(needsSynthesisFollowUp(body)).toBe(true);
  });
});

describe("needsSynthesisFollowUp — does NOT fire (complete reviews)", () => {
  it.each([
    [
      "complete with ## Findings heading",
      "Dispatching agents.All 13 sub-agents complete.\n\n## Findings\n\n### 🟡 1. Some issue\n\nFix this.\n\n## What's good\n\n- Solid tests.",
    ],
    [
      "complete with ## What's good heading",
      "narration narration narration.\n\n## What's good\n\n- Clean implementation.",
    ],
    [
      "complete with ## Summary heading",
      "narration narration.\n\n## Summary\n\nThe PR does X correctly.",
    ],
    [
      "complete with ## Review: heading",
      "narration narration.\n\n## Review: Foo Bar Baz\n\nDetailed review here.",
    ],
    [
      "short non-skill response (XS PR, no sub-agents, no waiting markers)",
      "The change is correct. Nothing to flag.",
    ],
    [
      "early waiting mention but synthesis present (heading inside body)",
      "I started by waiting on the cache to populate. Done.\n\n## Findings\n\n### Important\n\n- Issue here",
    ],
  ])("does NOT fire for: %s", (_label, body) => {
    expect(needsSynthesisFollowUp(body)).toBe(false);
  });
});

describe("needsSynthesisFollowUp — trailing-window edge cases", () => {
  it("requires waiting marker in trailing 1500 chars, not in early text", () => {
    const earlyWaiting =
      "I was waiting on the cache. " + "lorem ipsum ".repeat(200) + "\n\n## Findings\n\nClean.";
    expect(needsSynthesisFollowUp(earlyWaiting)).toBe(false);
  });

  it("does fire if waiting marker is in trail AND no synthesis heading anywhere", () => {
    const trail = "lorem ipsum ".repeat(150) + "Twelve agents back. Continuing to wait.";
    expect(needsSynthesisFollowUp(trail)).toBe(true);
  });
});
