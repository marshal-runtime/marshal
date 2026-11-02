import type { PermissionCheck } from "@marshal/runtime/core";
import { describe, expect, it, vi } from "vitest";

import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness/test-double";
import { __hostTesting, publicAuthority } from "./host";
import {
  createProductionMarshalRuntimePorts,
  UI_OBSERVE_PERMISSION_POLICY_PREFIX,
  type ExtensionDeclaredPermissionResolver,
} from "./production-adapter";

const { decidePermission } = __hostTesting;

/**
 * Permission-chain coverage for the ui.observe.* host capabilities through
 * the REAL production path. Without an explicit route these permissions fall
 * through to the unsupported-permission deny (exactly what the first live
 * demo hit); with the route they resolve through the Marshal permission
 * POLICY — allow-all sessions proceed, default mode prompts — never through
 * an unconditional builtin allow.
 */

function sessionManagerDouble(): SessionManager {
  return testDouble<SessionManager>({
    getSessionScopeAsync: vi.fn<SessionManager["getSessionScopeAsync"]>().mockResolvedValue(
      testDouble({
        id: "session-1",
        name: "Observe routing test",
        workspaceName: "Engineering",
        source: "user",
        messages: [],
      }),
    ),
    listWorkspacesForSelfTools: vi
      .fn<SessionManager["listWorkspacesForSelfTools"]>()
      .mockReturnValue([{ name: "Engineering", path: "/tmp/ui-observe-permission-rig" }]),
  });
}

function policyDouble(decision: "approve" | "prompt" | "deny"): {
  policy: PermissionPolicy;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi
    .fn<PermissionPolicy["evaluateDetailed"]>()
    .mockReturnValue(testDouble({ decision }));
  return { policy: testDouble<PermissionPolicy>({ evaluateDetailed: evaluate }), evaluate };
}

function authority(
  policy: PermissionPolicy,
  resolveExtensionDeclaredPermission?: ExtensionDeclaredPermissionResolver,
) {
  return publicAuthority(
    createProductionMarshalRuntimePorts({
      sessionManager: sessionManagerDouble(),
      permissionPolicy: policy,
      workspaceDir: "/tmp/ui-observe-permission-rig",
      ...(resolveExtensionDeclaredPermission ? { resolveExtensionDeclaredPermission } : {}),
    }).authority,
  );
}

function check(capability: string, permission: string): PermissionCheck {
  return testDouble<PermissionCheck>({
    capability: testDouble({ name: capability }),
    request: testDouble({ input: { viewport: "mobile" } }),
    requirements: [testDouble({ permission, risk: "low" as const })],
    context: testDouble({
      scope: { sessionId: "session-1" },
      metadata: { marshalWorkspaceName: "Engineering" },
    }),
  });
}

const notDeclared: ExtensionDeclaredPermissionResolver = () => false;

describe("ui.observe permission routing", () => {
  it.each([
    ["ui.observe.open", "ui.observe.open"],
    ["ui.observe.capture", "ui.observe.capture"],
    ["ui.observe.close", "ui.observe.close"],
  ])("routes %s to its policy bucket and allows on approve", async (capability, permission) => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(
      authority(policy, notDeclared),
      undefined,
      check(capability, permission),
    );
    expect(decision.decision).toBe("allow");
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${UI_OBSERVE_PERMISSION_POLICY_PREFIX}${permission}`,
      }),
    );
  });

  it("surfaces a policy prompt as an approval decision (default permission mode)", async () => {
    const { policy } = policyDouble("prompt");
    const decision = await decidePermission(
      authority(policy, notDeclared),
      undefined,
      check("ui.observe.open", "ui.observe.open"),
    );
    expect(decision.decision).toBe("approval");
  });

  it("never routes a mismatched capability/permission pair", async () => {
    const { policy, evaluate } = policyDouble("approve");
    // A foreign capability declaring the observe permission id must not reach
    // the observe policy bucket through this route.
    const decision = await decidePermission(
      authority(policy, notDeclared),
      undefined,
      check("codereview.pr.list", "ui.observe.open"),
    );
    expect(decision.decision).toBe("deny");
    expect(evaluate).not.toHaveBeenCalled();
  });
});
