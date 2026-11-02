// Marshal-owned test
// electron/permission-classifier.marshal.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { classifyShellCommand, type InferFn } from "./permission-classifier";

const fakeIsReadOnly = () => false;

describe("classifyShellCommand — fallback paths", () => {
  it("returns fallback when infer throws", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockRejectedValue(new Error("boom"));
    const out = await classifyShellCommand("ls", { infer, isReadOnlyCommand: fakeIsReadOnly });
    expect(out.source).toBe("fallback");
    expect(out.suggestedPattern).toBeNull();
  });

  it("returns fallback when LLM returns malformed JSON", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue("not-json-at-all");
    const out = await classifyShellCommand("ls", { infer, isReadOnlyCommand: fakeIsReadOnly });
    expect(out.source).toBe("fallback");
  });

  it("returns llm source when JSON parses", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue(
      JSON.stringify({
        explanation: "lists files",
        category: "readonly",
        suggestedPattern: "ls *",
        patternRationale: "ls is always read-only",
      }),
    );
    const out = await classifyShellCommand("ls -la", {
      infer,
      isReadOnlyCommand: fakeIsReadOnly,
    });
    expect(out.source).toBe("llm");
    // ls is not in structured-CLI allowlist; G_BARE_STAR nulls the pattern.
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
    expect(out.category).toBe("readonly");
    expect(out.explanation).toBe("lists files");
  });

  it("keeps pattern for valid structured-CLI suggestion", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue(
      JSON.stringify({
        explanation: "lists az repos",
        category: "readonly",
        suggestedPattern: "az repos list *",
        patternRationale: "read-only listing",
      }),
    );
    const out = await classifyShellCommand("az repos list --project foo", {
      infer,
      isReadOnlyCommand: fakeIsReadOnly,
    });
    expect(out.suggestedPattern).toBe("az repos list *");
    expect(out.category).toBe("readonly");
  });

  it("returns fallback when LLM returns valid JSON with invalid category", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue(
      JSON.stringify({
        explanation: "does something bad",
        category: "evil",
        suggestedPattern: "evil *",
        patternRationale: "trust me",
      }),
    );
    const out = await classifyShellCommand("evil cmd", {
      infer,
      isReadOnlyCommand: () => false,
    });
    expect(out.source).toBe("fallback");
    expect(out.category).toBe("unknown");
    expect(out.suggestedPattern).toBeNull();
  });
});

describe("classifyShellCommand — log redaction", () => {
  // The logger's default sink writes to console.log / console.warn, so spy
  // those to capture everything the classifier ever emits during a run.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function allLoggedText(): string {
    const collect = (spy: typeof logSpy): string[] =>
      spy.mock.calls.flat().map((arg: unknown) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return "";
        }
      });
    return [...collect(logSpy), ...collect(warnSpy)].join(" | ");
  }

  const sensitiveCommand = "rm -rf /home/alice/secrets/token.txt";

  it("does not log the command text on the success path", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue(
      JSON.stringify({
        explanation: "removes a file",
        category: "destructive",
        suggestedPattern: null,
        patternRationale: null,
      }),
    );
    await classifyShellCommand(sensitiveCommand, { infer, isReadOnlyCommand: fakeIsReadOnly });
    const text = allLoggedText();
    expect(text).not.toContain("/home/alice/secrets/token.txt");
    expect(text).not.toContain("rm -rf");
  });

  it("does not log the command text on the infer-throw fallback path", async () => {
    const infer: InferFn = vi.fn<InferFn>().mockRejectedValue(new Error("boom"));
    await classifyShellCommand(sensitiveCommand, { infer, isReadOnlyCommand: fakeIsReadOnly });
    const text = allLoggedText();
    expect(text).not.toContain("/home/alice/secrets/token.txt");
    expect(text).not.toContain("rm -rf");
  });

  it("does not log the raw LLM response on the parse-fail fallback path", async () => {
    const sensitiveRawResponse =
      "sorry, I cannot help with " + sensitiveCommand + " — here's junk instead";
    const infer: InferFn = vi.fn<InferFn>().mockResolvedValue(sensitiveRawResponse);
    await classifyShellCommand(sensitiveCommand, { infer, isReadOnlyCommand: fakeIsReadOnly });
    const text = allLoggedText();
    expect(text).not.toContain("/home/alice/secrets/token.txt");
    expect(text).not.toContain(sensitiveRawResponse);
  });
});
