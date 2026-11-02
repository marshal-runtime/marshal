import { describe, expect, it } from "vitest";

import { TENANT_FORCE_PROMPT_RULE } from "./marshal-tenant-force-prompt";
import { makeCtx, makeRequest, testDouble, type TenantPolicyProvider } from "./test-helpers";

describe("TENANT_FORCE_PROMPT_RULE", () => {
  it("returns null when no tenant policy is set", () => {
    const ctx = makeCtx({ tenantPolicy: undefined });
    const request = makeRequest({ kind: "shell" });
    expect(TENANT_FORCE_PROMPT_RULE.apply(request, ctx)).toBeNull();
  });

  it("returns prompt with no audit when forcePrompt is true", () => {
    const ctx = makeCtx({
      tenantPolicy: testDouble<TenantPolicyProvider>({ get: () => ({ forcePrompt: true }) }),
    });
    const request = makeRequest({ kind: "shell" });
    const result = TENANT_FORCE_PROMPT_RULE.apply(request, ctx);
    expect(result?.decision).toBe("prompt");
    expect(result?.auditOutcome).toBeUndefined();
  });

  it("returns null when forcePrompt is false", () => {
    const ctx = makeCtx({
      tenantPolicy: testDouble<TenantPolicyProvider>({ get: () => ({ forcePrompt: false }) }),
    });
    const request = makeRequest({ kind: "shell" });
    expect(TENANT_FORCE_PROMPT_RULE.apply(request, ctx)).toBeNull();
  });
});
