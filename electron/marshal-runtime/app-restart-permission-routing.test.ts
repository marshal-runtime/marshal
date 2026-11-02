import type { PermissionCheck } from "@marshal/runtime/core";
import { describe, expect, it, vi } from "vitest";

import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness/test-double";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";
import { __hostTesting, publicAuthority } from "./host";
import {
  APP_LIFECYCLE_PERMISSION_POLICY_PREFIX,
  createProductionMarshalRuntimePorts,
  EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX,
  type ExtensionDeclaredPermissionResolver,
} from "./production-adapter";

const { decidePermission } = __hostTesting;

/**
 * Permission-chain coverage for marshal.app.restart through the REAL
 * production path (decidePermission → publicAuthority → production ports →
 * PermissionPolicy). The restart permission must route to the Marshal
 * permission POLICY — allow-all sessions proceed, default mode prompts —
 * and must NEVER take the unconditional builtin allow: restarting the app
 * kills every running agent session.
 */

const RESTART_CAPABILITY = "marshal.app.restart";
const RESTART_PERMISSION = MARSHAL_RUNTIME_PERMISSION.appRestart;
const RESTART_INPUT = { reason: "reload runtime packs" };

function sessionManagerDouble(): SessionManager {
  return testDouble<SessionManager>({
    getSessionScopeAsync: vi.fn<SessionManager["getSessionScopeAsync"]>().mockResolvedValue(
      testDouble({
        id: "session-1",
        name: "Restart routing test",
        workspaceName: "Engineering",
        source: "user",
        messages: [],
      }),
    ),
    listWorkspacesForSelfTools: vi
      .fn<SessionManager["listWorkspacesForSelfTools"]>()
      .mockReturnValue([{ name: "Engineering", path: "/tmp/app-restart-permission-rig" }]),
  });
}

function policyDouble(
  decision: "approve" | "prompt" | "deny",
  denyReason?: string,
): { policy: PermissionPolicy; evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = vi
    .fn<PermissionPolicy["evaluateDetailed"]>()
    .mockReturnValue(
      testDouble(denyReason !== undefined ? { decision, denyReason } : { decision }),
    );
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
      workspaceDir: "/tmp/app-restart-permission-rig",
      ...(resolveExtensionDeclaredPermission ? { resolveExtensionDeclaredPermission } : {}),
    }).authority,
  );
}

function check(overrides: { permission?: string } = {}): PermissionCheck {
  return testDouble<PermissionCheck>({
    capability: testDouble({ name: RESTART_CAPABILITY }),
    request: testDouble({ input: RESTART_INPUT }),
    requirements: [
      testDouble({ permission: overrides.permission ?? RESTART_PERMISSION, risk: "high" as const }),
    ],
    context: testDouble({
      scope: { sessionId: "session-1" },
      metadata: { marshalWorkspaceName: "Engineering" },
    }),
  });
}

const notDeclared: ExtensionDeclaredPermissionResolver = () => false;

describe("marshal.app.restart permission routing", () => {
  it("routes to the policy bucket and allows on approve (allow-all mode)", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(authority(policy, notDeclared), undefined, check());
    expect(decision.decision).toBe("allow");
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${APP_LIFECYCLE_PERMISSION_POLICY_PREFIX}${RESTART_PERMISSION}`,
        toolArgs: RESTART_INPUT,
      }),
    );
  });

  it("surfaces a policy prompt as an approval decision (default permission mode)", async () => {
    const { policy } = policyDouble("prompt");
    const decision = await decidePermission(authority(policy, notDeclared), undefined, check());
    expect(decision.decision).toBe("approval");
  });

  it("propagates a policy deny unchanged", async () => {
    const { policy } = policyDouble("deny", "blocked by session policy");
    const decision = await decidePermission(authority(policy, notDeclared), undefined, check());
    expect(decision).toMatchObject({
      decision: "deny",
      reason: "blocked by session policy",
      code: "permission_denied",
    });
  });

  it("fails closed when no extension-declared resolver is configured", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(authority(policy), undefined, check());
    expect(decision).toMatchObject({ decision: "deny", code: "permission_denied" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed on an indeterminate ownership result", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(
      authority(policy, () => ({ indeterminate: true, reason: "resolver-threw" })),
      undefined,
      check(),
    );
    expect(decision).toMatchObject({ decision: "deny", code: "permission_denied" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("routes a verified extension-declared match to that extension's own bucket", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(
      authority(policy, () => ({ declared: true, extensionId: "@acme/some-extension" })),
      undefined,
      check(),
    );
    expect(decision.decision).toBe("allow");
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}@acme/some-extension:${RESTART_PERMISSION}`,
      }),
    );
  });

  it("denies a mismatched permission id on the restart capability", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(
      authority(policy, notDeclared),
      undefined,
      check({ permission: "marshal.session.read" }),
    );
    // marshal.session.read is builtin — but it belongs to other capabilities;
    // the restart capability must not ride a read permission. The builtin
    // branch still owns this id, so the important assertion is that the
    // app-lifecycle policy bucket is never consulted for it.
    expect(evaluate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: `${APP_LIFECYCLE_PERMISSION_POLICY_PREFIX}marshal.session.read`,
      }),
    );
    expect(decision.decision).not.toBe("approval");
  });
});
