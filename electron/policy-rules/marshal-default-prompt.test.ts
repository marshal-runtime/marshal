import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPT_RULE } from "./marshal-default-prompt";
import { makeCtx, makeRequest } from "./test-helpers";

describe("DEFAULT_PROMPT_RULE", () => {
  it("always returns prompt decision", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell" });
    const result = DEFAULT_PROMPT_RULE.apply(request, ctx);
    // DEFAULT_PROMPT_RULE always returns a result (never null)
    expect(result?.decision).toBe("prompt");
  });

  it("always returns undefined auditOutcome (no audit from terminal rule)", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell" });
    const result = DEFAULT_PROMPT_RULE.apply(request, ctx);
    expect(result?.auditOutcome).toBeUndefined();
  });

  it("returns prompt for any request kind", () => {
    const ctx = makeCtx();
    const mcpRequest = makeRequest({
      kind: "mcp",
      toolName: "playwright-browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    const result = DEFAULT_PROMPT_RULE.apply(mcpRequest, ctx);
    expect(result?.decision).toBe("prompt");
  });
});
