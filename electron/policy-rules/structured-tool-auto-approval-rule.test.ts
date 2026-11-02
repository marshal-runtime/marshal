import { describe, expect, it } from "vitest";

import { STRUCTURED_TOOL_AUTO_APPROVE_RULE } from "./structured-tool-auto-approval-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("STRUCTURED_TOOL_AUTO_APPROVE_RULE", () => {
  it("returns null for shell requests", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell" });
    expect(STRUCTURED_TOOL_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves mcp tool when specific tool key is true in tools map", () => {
    const ctx = makeCtx({
      permissions: { tools: { "mcp:playwright:browser_navigate": true } },
    });
    const request = makeRequest({
      kind: "mcp",
      toolName: "browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    const result = STRUCTURED_TOOL_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("returns null when tool key is explicitly false", () => {
    const ctx = makeCtx({
      permissions: { tools: { "mcp:playwright:browser_navigate": false } },
    });
    const request = makeRequest({
      kind: "mcp",
      toolName: "browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    expect(STRUCTURED_TOOL_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves via group key when specific tool is absent", () => {
    const ctx = makeCtx({
      permissions: { tools: { "mcp:playwright": true } },
    });
    const request = makeRequest({
      kind: "mcp",
      toolName: "browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    const result = STRUCTURED_TOOL_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
  });
});
