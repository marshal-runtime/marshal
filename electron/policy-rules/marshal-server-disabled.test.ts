import { describe, expect, it } from "vitest";

import { SERVER_DISABLED_RULE } from "./marshal-server-disabled";
import { makeCtx, makeRequest } from "./test-helpers";

describe("SERVER_DISABLED_RULE", () => {
  it("returns null when serverConfig is undefined", () => {
    const ctx = makeCtx({ serverConfig: undefined });
    const request = makeRequest({ kind: "shell" });
    expect(SERVER_DISABLED_RULE.apply(request, ctx)).toBeNull();
  });

  it("denies when serverConfig.enabled is false", () => {
    const ctx = makeCtx({ serverConfig: { enabled: false, autoApprove: false } });
    const request = makeRequest({ kind: "shell" });
    const result = SERVER_DISABLED_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
    expect(result?.auditOutcome).toBe("denied");
    expect(result?.sdkResult).toBe("denied-by-rules");
  });

  it("returns null when serverConfig.enabled is true", () => {
    const ctx = makeCtx({ serverConfig: { enabled: true, autoApprove: false } });
    const request = makeRequest({ kind: "shell" });
    expect(SERVER_DISABLED_RULE.apply(request, ctx)).toBeNull();
  });
});
