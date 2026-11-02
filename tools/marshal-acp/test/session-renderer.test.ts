// Marshal-owned module.
import { describe, it, expect } from "vitest";

import { appendTurn, parseSession, renderSession } from "../src/session-renderer.ts";
import type { SessionRecord, Turn } from "../src/types.ts";

const baseRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  title: "summarize this PR",
  sessionId: "sess-abc-123",
  runtime: "claude",
  cwd: "/repo",
  permissionProfile: "default",
  startedAt: "2026-05-12T10:00:00Z",
  completedAt: "2026-05-12T10:01:00Z",
  turns: [
    {
      at: "2026-05-12T10:00:00Z",
      promptText: "summarize",
      responseText: "## Findings\n\n- it does X\n",
      stopReason: "end_turn",
      usageOutputTokens: 42,
    },
  ],
  ...overrides,
});

describe("renderSession / parseSession round-trip", () => {
  it("produces frontmatter + body and parses back to the same record (response text excluded)", () => {
    const rec = baseRecord();
    const md = renderSession(rec);
    expect(md).toContain("title: summarize this PR");
    expect(md).toContain("sessionId: sess-abc-123");
    expect(md).toContain("## Turn 1");
    expect(md).toContain("it does X");

    const parsed = parseSession(md);
    expect(parsed.title).toBe(rec.title);
    expect(parsed.sessionId).toBe(rec.sessionId);
    expect(parsed.runtime).toBe("claude");
    expect(parsed.cwd).toBe(rec.cwd);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.usageOutputTokens).toBe(42);
    expect(parsed.turns[0]?.stopReason).toBe("end_turn");
  });

  it('quotes title with special YAML chars (`:`, `#`, `"`)', () => {
    const rec = baseRecord({ title: 'fix: handle "edge case" #404' });
    const md = renderSession(rec);
    const parsed = parseSession(md);
    expect(parsed.title).toBe('fix: handle "edge case" #404');
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseSession("no frontmatter here")).toThrow(/missing frontmatter/);
  });
});

describe("parseSession body extraction", () => {
  it("recovers response text from the body so re-render is non-destructive", () => {
    // Round-trip: render → parse → re-render. Without body extraction the
    // re-render would lose the response text (frontmatter doesn't carry it).
    const rec = baseRecord();
    const first = renderSession(rec);
    const parsed = parseSession(first);
    expect(parsed.turns[0]?.responseText).toContain("it does X");
    expect(renderSession(parsed)).toContain("it does X");
  });

  it("treats a literal `_(empty)_` body as empty, not as content", () => {
    const rec = baseRecord({
      turns: [{ at: "2026-05-12T10:00:00Z", promptText: "x", responseText: "" }],
    });
    const md = renderSession(rec);
    expect(md).toContain("_(empty)_");
    const parsed = parseSession(md);
    expect(parsed.turns[0]?.responseText).toBe("");
  });

  it("round-trips a prompt that itself contains a triple-backtick code block", () => {
    // Regression: previously extractTurnBodies found the closing prompt fence
    // by counting raw ``` occurrences, so a prompt embedding a code block
    // (a common shape: "explain this code: ```ts ...```") would misidentify
    // the inner fence as the closer and capture half the prompt as the
    // response. Start-of-line anchoring on both fences fixes it.
    const rec = baseRecord({
      turns: [
        {
          at: "2026-05-12T10:00:00Z",
          promptText: "Read this snippet:\n```ts\nconst x = 1;\n```\nthen explain.",
          responseText: "It declares x as 1.",
        },
      ],
    });
    const md = renderSession(rec);
    const parsed = parseSession(md);
    expect(parsed.turns[0]?.responseText).toBe("It declares x as 1.");
    expect(parsed.turns[0]?.responseText).not.toContain("const x");
  });

  it("handles multi-turn body extraction (no cross-bleeding)", () => {
    const rec = baseRecord({
      turns: [
        { at: "t1", promptText: "p1", responseText: "response one" },
        { at: "t2", promptText: "p2", responseText: "response two" },
      ],
    });
    const md = renderSession(rec);
    const parsed = parseSession(md);
    expect(parsed.turns[0]?.responseText).toContain("response one");
    expect(parsed.turns[0]?.responseText).not.toContain("response two");
    expect(parsed.turns[1]?.responseText).toContain("response two");
  });
});

describe("appendTurn", () => {
  it("adds a Turn 2 section, refreshes completedAt, preserves Turn 1", () => {
    const initial = renderSession(baseRecord());
    const turn2: Turn = {
      at: "2026-05-12T10:05:00Z",
      promptText: "follow up — what about tests?",
      responseText: "tests look fine\n",
      stopReason: "end_turn",
    };
    const updated = appendTurn(initial, turn2);
    expect(updated).toContain("## Turn 1");
    expect(updated).toContain("## Turn 2");
    expect(updated).toContain("follow up — what about tests?");
    expect(updated).toContain("completedAt: 2026-05-12T10:05:00Z");

    const parsed = parseSession(updated);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1]?.promptText).toBe(turn2.promptText);
    expect(parsed.completedAt).toBe(turn2.at);
    // Regression: Turn 1's body must survive the re-render that
    // append goes through (was lost before body-extraction in parseSession).
    expect(parsed.turns[0]?.responseText).toContain("it does X");
    expect(updated).toContain("it does X");
  });
});
