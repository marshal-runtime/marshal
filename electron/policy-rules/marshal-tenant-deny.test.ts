import { describe, expect, it } from "vitest";

import { TENANT_DENY_RULE } from "./marshal-tenant-deny";
import { makeCtx, makeRequest, testDouble, type TenantPolicyProvider } from "./test-helpers";

describe("TENANT_DENY_RULE", () => {
  it("returns null when no tenant policy is set", () => {
    const ctx = makeCtx({ tenantPolicy: undefined });
    const request = makeRequest({ kind: "shell" });
    expect(TENANT_DENY_RULE.apply(request, ctx)).toBeNull();
  });

  it("denies when kind is in disabledPermissionKinds", () => {
    const ctx = makeCtx({
      tenantPolicy: testDouble<TenantPolicyProvider>({
        get: () => ({ disabledPermissionKinds: ["shell"] }),
      }),
    });
    const request = makeRequest({ kind: "shell" });
    const result = TENANT_DENY_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
    expect(result?.auditOutcome).toBe("denied");
    expect(result?.sdkResult).toBe("denied-by-rules");
  });

  it("denies mcp when serverName is in disabledServers", () => {
    const ctx = makeCtx({
      tenantPolicy: testDouble<TenantPolicyProvider>({
        get: () => ({ disabledServers: ["playwright"] }),
      }),
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
    const result = TENANT_DENY_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
  });

  it("returns null for mcp when serverName is not in disabledServers", () => {
    const ctx = makeCtx({
      tenantPolicy: testDouble<TenantPolicyProvider>({
        get: () => ({ disabledServers: ["other-server"] }),
      }),
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
    expect(TENANT_DENY_RULE.apply(request, ctx)).toBeNull();
  });
});
