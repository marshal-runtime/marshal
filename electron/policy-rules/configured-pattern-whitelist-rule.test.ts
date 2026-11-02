import { describe, expect, it } from "vitest";

import { PATTERN_WHITELIST_RULE } from "./configured-pattern-whitelist-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("PATTERN_WHITELIST_RULE", () => {
  it("returns null when allow list is empty", () => {
    const ctx = makeCtx({
      permissions: { allow: [] },
    });
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    expect(PATTERN_WHITELIST_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves shell command matching an allow pattern", () => {
    const ctx = makeCtx({
      permissions: { allow: ["ls *"] },
    });
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    const result = PATTERN_WHITELIST_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("returns null for shell command not matching allow pattern", () => {
    const ctx = makeCtx({
      permissions: { allow: ["cat *"] },
    });
    const request = makeRequest({ kind: "shell", command: "rm -rf /tmp" });
    expect(PATTERN_WHITELIST_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves mcp request matching allow pattern", () => {
    const ctx = makeCtx({
      permissions: { allow: ["mcp:playwright:browser_navigate"] },
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
    const result = PATTERN_WHITELIST_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
  });
});
