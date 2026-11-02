import { describe, expect, it } from "vitest";

import { KIND_SERVER_FALLBACK_RULE } from "./marshal-kind-server-fallback";
import { makeCtx, makeRequest } from "./test-helpers";

describe("KIND_SERVER_FALLBACK_RULE", () => {
  it("returns null for shell requests (no fallback mapping)", () => {
    const ctx = makeCtx({ effectiveServerName: "shell" });
    const request = makeRequest({ kind: "shell" });
    expect(KIND_SERVER_FALLBACK_RULE.apply(request, ctx)).toBeNull();
  });

  it("returns null when effectiveServerName does not match fallback", () => {
    const ctx = makeCtx({ effectiveServerName: "other" });
    const request = makeRequest({
      kind: "write",
      path: "/tmp/file.txt",
      diff: null,
      intention: undefined,
      origin: "sdk",
      browserToolName: undefined,
      toolCallId: undefined,
    });
    expect(KIND_SERVER_FALLBACK_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves write request when filesystem group tool is enabled", () => {
    const ctx = makeCtx({
      effectiveServerName: "filesystem",
      permissions: {
        tools: { "mcp:filesystem": true },
      },
    });
    const request = makeRequest({
      kind: "write",
      path: "/tmp/file.txt",
      diff: null,
      intention: undefined,
      origin: "sdk",
      browserToolName: undefined,
      toolCallId: undefined,
    });
    const result = KIND_SERVER_FALLBACK_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("approves url request when an individual mapped tool is enabled (KIND_TO_MCP_TOOLS)", () => {
    const ctx = makeCtx({
      effectiveServerName: "playwright",
      permissions: {
        tools: { "mcp:playwright:browser_navigate": true },
      },
    });
    const request = makeRequest({ kind: "url", url: "https://example.com" });
    const result = KIND_SERVER_FALLBACK_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
  });
});
