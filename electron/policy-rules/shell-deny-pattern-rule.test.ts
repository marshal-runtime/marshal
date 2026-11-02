import { describe, expect, it } from "vitest";

import { SHELL_DENY_PATTERN_RULE } from "./shell-deny-pattern-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("SHELL_DENY_PATTERN_RULE", () => {
  it("returns null for non-shell requests", () => {
    const ctx = makeCtx({
      permissions: { denyPatterns: ["rm *"] },
    });
    const request = makeRequest({
      kind: "mcp",
      toolName: "playwright-browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    expect(SHELL_DENY_PATTERN_RULE.apply(request, ctx)).toBeNull();
  });

  it("returns null when there are no deny patterns", () => {
    const ctx = makeCtx({
      permissions: { denyPatterns: [] },
    });
    const request = makeRequest({ kind: "shell", command: "rm -rf /" });
    expect(SHELL_DENY_PATTERN_RULE.apply(request, ctx)).toBeNull();
  });

  it("denies shell command matching a deny pattern", () => {
    const ctx = makeCtx({
      permissions: { denyPatterns: ["rm *"] },
    });
    const request = makeRequest({ kind: "shell", command: "rm -rf /tmp" });
    const result = SHELL_DENY_PATTERN_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
    expect(result?.auditOutcome).toBe("denied");
  });

  it("denies unsafe shell syntax (subshell injection) even without matching pattern", () => {
    const ctx = makeCtx({
      permissions: { denyPatterns: ["safe-cmd"] },
    });
    // $() subshell expansion is unsafe shell syntax
    const request = makeRequest({ kind: "shell", command: "echo $(cat /etc/passwd)" });
    const result = SHELL_DENY_PATTERN_RULE.apply(request, ctx);
    // Subshell syntax triggers the unsafe gate
    expect(result?.decision).toBe("deny");
  });
});
