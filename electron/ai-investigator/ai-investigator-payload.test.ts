import { describe, expect, it } from "vitest";

import {
  appendDiagnosticsToIssueBody,
  buildAIInvestigatorPrompt,
  AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES,
  AI_INVESTIGATOR_PROMPT_MAX_BYTES,
  composeInvestigatorReport,
} from "./ai-investigator-payload";

const INSTRUCTIONS = "<<destination-supplied instructions>>";

describe("buildAIInvestigatorPrompt", () => {
  it("includes the user description verbatim", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "Crash on opening Heartbeat settings",
      diagnosticsTail: "",
      instructions: INSTRUCTIONS,
    });
    expect(out).toContain("Crash on opening Heartbeat settings");
  });

  it("falls back to placeholder when description is blank", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "  ",
      diagnosticsTail: "",
      instructions: INSTRUCTIONS,
    });
    expect(out).toContain("(no description provided)");
  });

  it("falls back to placeholder when diagnostics tail is empty", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "x",
      diagnosticsTail: "",
      instructions: INSTRUCTIONS,
    });
    expect(out).toContain("(no diagnostics available)");
  });

  it("includes diagnostics tail in a fenced block", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "x",
      diagnosticsTail: 'ERROR foo bar baz {"k":"v"}',
      instructions: INSTRUCTIONS,
    });
    expect(out).toMatch(/```[\s\S]*ERROR foo bar baz[\s\S]*```/);
  });

  it("splices in the destination-supplied instructions", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "x",
      diagnosticsTail: "",
      instructions: INSTRUCTIONS,
    });
    expect(out).toContain(INSTRUCTIONS);
    // The payload module must stay provider-neutral — no `gh`/GitHub prose
    // of its own.
    expect(out).not.toContain("gh search code");
  });

  it("embeds the structured-report contract", () => {
    // Smoke-check the headings the parser/composer keys on.
    const out = buildAIInvestigatorPrompt({
      userDescription: "x",
      diagnosticsTail: "",
      instructions: INSTRUCTIONS,
    });
    expect(out).toContain("## Output contract");
    expect(out).toMatch(/# <Concise issue title/);
    expect(out).toContain("## Summary");
    expect(out).toContain("## Suspected cause");
    expect(out).toContain("## Reproduction steps");
    expect(out).toContain("## Diagnostics excerpt");
  });

  it("does not include any chat-history section", () => {
    const out = buildAIInvestigatorPrompt({
      userDescription: "x",
      diagnosticsTail: "y",
      instructions: INSTRUCTIONS,
    });
    expect(out).not.toMatch(/chat/i);
  });

  it("caps the prompt at AI_INVESTIGATOR_PROMPT_MAX_BYTES", () => {
    const huge = "x".repeat(200_000);
    const out = buildAIInvestigatorPrompt({
      userDescription: huge,
      diagnosticsTail: huge,
      instructions: INSTRUCTIONS,
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(AI_INVESTIGATOR_PROMPT_MAX_BYTES);
  });
});

describe("appendDiagnosticsToIssueBody", () => {
  it("returns the body unchanged when the tail is empty", () => {
    expect(appendDiagnosticsToIssueBody("hello", "")).toBe("hello");
  });

  it("wraps the tail in a collapsed <details> block at the end", () => {
    const out = appendDiagnosticsToIssueBody("# report\n\nbody", "ERROR boom");
    expect(out).toMatch(/^# report\n\nbody/);
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Full diagnostics tail");
    expect(out).toContain("```\nERROR boom\n```");
    expect(out).toContain("</details>");
  });

  it("tail-truncates the diagnostics at AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES, keeping the most recent bytes", () => {
    const head = "OLD_LINE_DROP_ME";
    const tail = "RECENT_LINE_KEEP_ME";
    const filler = "x".repeat(AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES + 1024);
    const out = appendDiagnosticsToIssueBody("body", `${head}\n${filler}\n${tail}`);
    expect(out).toContain(tail);
    expect(out).not.toContain(head);
    expect(out).toContain("…[earlier truncated]…");
  });

  it("handles multi-byte (UTF-8) characters at the truncation boundary", () => {
    // A long string of 4-byte emoji to stress-test the byte-length walker.
    const big = "🐛".repeat(AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES);
    const out = appendDiagnosticsToIssueBody("body", big);
    // No mojibake: every emoji boundary is preserved (no lone surrogates).
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("composeInvestigatorReport", () => {
  it("extracts the first H1 as the title and the rest as the body", () => {
    const md = ["# A nice title", "", "## Summary", "Body content here"].join("\n");
    const out = composeInvestigatorReport(md, "user-typed description");
    expect(out.title).toBe("A nice title");
    expect(out.body).toContain("## Summary");
    expect(out.body).toContain("Body content here");
    expect(out.synthesized).toBe(false);
  });

  it("tolerates leading whitespace and noise before the H1", () => {
    const md = ["", "  ", "# Real title", "Body"].join("\n");
    const out = composeInvestigatorReport(md, "user-typed description");
    expect(out.title).toBe("Real title");
    expect(out.body).toBe("Body");
    expect(out.synthesized).toBe(false);
  });

  it("falls back to placeholder body when H1 has no content after it", () => {
    const out = composeInvestigatorReport("# Crash on startup", "user-typed description");
    expect(out.title).toBe("Crash on startup");
    expect(out.body).toBe("(no investigation report produced)");
    expect(out.synthesized).toBe(false);
  });

  it("falls back to placeholder body when H1 is followed only by blank lines", () => {
    const out = composeInvestigatorReport(
      "# Crash on startup\n\n   \n\n",
      "user-typed description",
    );
    expect(out.title).toBe("Crash on startup");
    expect(out.body).toBe("(no investigation report produced)");
    expect(out.synthesized).toBe(false);
  });

  it("normal H1 + body returns both without modification", () => {
    const md = "# Bug title\n\n## Summary\nSomething broke.";
    const out = composeInvestigatorReport(md, "user-typed description");
    expect(out.title).toBe("Bug title");
    expect(out.body).toContain("## Summary");
    expect(out.body).toContain("Something broke.");
    expect(out.synthesized).toBe(false);
  });

  it("synthesizes title from user description when no H1 (synthesized=true)", () => {
    const out = composeInvestigatorReport(
      "Just some prose with no heading at all, but still useful content.",
      "Heartbeat keeps crashing on save",
    );
    expect(out.title).toBe("AI investigation: Heartbeat keeps crashing on save");
    // Full model response is preserved as the body.
    expect(out.body).toContain("Just some prose with no heading at all");
    expect(out.synthesized).toBe(true);
  });

  it("truncates very long synthesized titles with an ellipsis (≤80 chars)", () => {
    const longDesc = "a".repeat(500);
    const out = composeInvestigatorReport("no heading here", longDesc);
    expect(out.title.length).toBeLessThanOrEqual(80);
    expect(out.title.startsWith("AI investigation: ")).toBe(true);
    expect(out.title.endsWith("…")).toBe(true);
  });

  it("truncates synthesized titles without splitting surrogate pairs", () => {
    const out = composeInvestigatorReport("no heading here", `${"a".repeat(60)}🔥bc`);
    expect(Array.from(out.title).length).toBeLessThanOrEqual(80);
    expect(out.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.title.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in synthesized titles", () => {
    const out = composeInvestigatorReport("no heading", "Crash\n\non\tsave   please");
    expect(out.title).toBe("AI investigation: Crash on save please");
  });

  it("falls back to a generic title when both response and description are empty-ish", () => {
    const out = composeInvestigatorReport("just text no heading", "   ");
    expect(out.title).toBe("AI investigation report");
    expect(out.body).toBe("just text no heading");
    expect(out.synthesized).toBe(true);
  });

  it("falls back to a placeholder body when model output is empty", () => {
    const out = composeInvestigatorReport("   ", "Bug X");
    expect(out.title).toBe("AI investigation: Bug X");
    expect(out.body).toBe("(no investigation report produced)");
    expect(out.synthesized).toBe(true);
  });

  it("never throws and never returns null for any input", () => {
    // Property-style smoke test for the always-permissive contract.
    for (const text of ["", "   ", "no heading", "# Title\n\nbody", "# ", "## Only h2"]) {
      for (const desc of ["", "x", "long ".repeat(200)]) {
        const r = composeInvestigatorReport(text, desc);
        expect(typeof r.title).toBe("string");
        expect(r.title.length).toBeGreaterThan(0);
        expect(typeof r.body).toBe("string");
        expect(r.body.length).toBeGreaterThan(0);
      }
    }
  });
});
