import { describe, expect, it, vi } from "vitest";

import { BACKGROUND_DENY_RULE } from "./marshal-background-deny";
import { makeCtx, makeRequest } from "./test-helpers";

describe("BACKGROUND_DENY_RULE", () => {
  it("returns null when session is not in sessionDenyPrompt", () => {
    const ctx = makeCtx({ sessionDenyPrompt: new Set() });
    const request = makeRequest({ kind: "shell", sessionId: "s1" });
    expect(BACKGROUND_DENY_RULE.apply(request, ctx)).toBeNull();
  });

  it("denies and fires callback when session is in sessionDenyPrompt", () => {
    const callback = vi.fn<(sessionId: string, kind: string, detail: string) => void>();
    const ctx = makeCtx({
      sessionDenyPrompt: new Set(["s1"]),
      onDenyPromptCallback: callback,
    });
    const request = makeRequest({ kind: "shell", sessionId: "s1" });
    const result = BACKGROUND_DENY_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
    expect(result?.auditOutcome).toBe("denied");
    expect(result?.sdkResult).toBe("denied-by-rules");
    // detail = getCommandText(request) || getServerName(request) || request.kind
    // default makeRequest has command: "ls", so detail = "ls"
    expect(callback).toHaveBeenCalledWith("s1", "shell", "ls");
  });

  it("does not fire callback when onDenyPromptCallback is undefined", () => {
    const ctx = makeCtx({
      sessionDenyPrompt: new Set(["s1"]),
      onDenyPromptCallback: undefined,
    });
    const request = makeRequest({ kind: "shell", sessionId: "s1" });
    const result = BACKGROUND_DENY_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
  });
});
