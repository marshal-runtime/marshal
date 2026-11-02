import type { PermissionCheck } from "@marshal/runtime/core";
import { describe, expect, it, vi } from "vitest";

import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness/test-double";
import { __hostTesting, publicAuthority } from "./host";
import {
  createProductionMarshalRuntimePorts,
  EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX,
} from "./production-adapter";
import { RUNTIME_SELF_TOOL_NAMES } from "./runtime-self-tools";

const { decidePermission } = __hostTesting;

/**
 * Bounded native-host permission chain test for extension-declared pairs,
 * using the REAL production path an installed Acme capability takes:
 * host.ts decidePermission → MarshalAuthorityService.authorize
 * (production-adapter) → PermissionPolicy. Capability/permission pairs are
 * Acme's actual shape (`marshal.tool.invoke:acme_…` declared per descriptor,
 * v0.2.1). No network, no Google, no live profiles — the policy and session
 * manager are doubles; everything between them is production code.
 */

const ACME_CAPABILITY = "acme_google_drive_download_file";
const ACME_PERMISSION = `marshal.tool.invoke:${ACME_CAPABILITY}`;
const ACME_INPUT = { fileId: "f-1", destinationPath: "/Users/omer/Downloads/report.pdf" };

function sessionManagerDouble(): SessionManager {
  return testDouble<SessionManager>({
    getSessionScopeAsync: vi.fn<SessionManager["getSessionScopeAsync"]>().mockResolvedValue(
      testDouble({
        id: "session-1",
        name: "Acme routing test",
        workspaceName: "Engineering",
        source: "user",
        messages: [],
      }),
    ),
    listWorkspacesForSelfTools: vi
      .fn<SessionManager["listWorkspacesForSelfTools"]>()
      .mockReturnValue([{ name: "Engineering", path: "/tmp/native-permission-rig" }]),
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

function authority(policy: PermissionPolicy) {
  // The COMPLETE production chain: publicAuthority (context→scope adapter,
  // registered as MarshalServiceSymbols.authority) over the production ports.
  return publicAuthority(
    createProductionMarshalRuntimePorts({
      sessionManager: sessionManagerDouble(),
      permissionPolicy: policy,
      workspaceDir: "/tmp/native-permission-rig",
    }).authority,
  );
}

function check(overrides: { permission?: string; context?: unknown } = {}): PermissionCheck {
  return testDouble<PermissionCheck>({
    capability: testDouble({ name: ACME_CAPABILITY }),
    request: testDouble({ input: ACME_INPUT }),
    requirements: [
      testDouble({ permission: overrides.permission ?? ACME_PERMISSION, risk: "medium" as const }),
    ],
    context: testDouble(
      overrides.context ?? {
        scope: { sessionId: "session-1" },
        metadata: { marshalWorkspaceName: "Engineering" },
      },
    ),
  });
}

describe("native host permission chain (decidePermission → authority → policy)", () => {
  it("routes a Acme-declared tool.invoke pair to the policy and allows on approve", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(authority(policy), undefined, check());
    expect(decision.decision).toBe("allow");
    // The policy saw the BARE tool name and the real capability input.
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: ACME_CAPABILITY, toolArgs: ACME_INPUT }),
    );
  });

  it("propagates a policy deny unchanged", async () => {
    const { policy } = policyDouble("deny", "blocked by session policy");
    const decision = await decidePermission(authority(policy), undefined, check());
    expect(decision).toMatchObject({
      decision: "deny",
      reason: "blocked by session policy",
      code: "permission_denied",
    });
  });

  it("surfaces a policy prompt as an approval decision when no approval port exists", async () => {
    const { policy } = policyDouble("prompt");
    const decision = await decidePermission(authority(policy), undefined, check());
    expect(decision.decision).toBe("approval");
    expect(decision).toMatchObject({ prompt: expect.stringContaining(ACME_CAPABILITY) });
  });

  it("requests interactive approval through the approval port and returns its payload", async () => {
    const { policy } = policyDouble("prompt");
    const requestApproval = vi
      .fn<() => Promise<{ approvalId: string; prompt: string }>>()
      .mockResolvedValue({ approvalId: "approval-1", prompt: "Approve?" });
    const approval = testDouble<Parameters<typeof decidePermission>[1] & object>({
      permissionApproval: testDouble({
        requestApproval,
        verifyApproval: vi.fn<() => Promise<never>>(),
      }),
    });
    const decision = await decidePermission(authority(policy), approval, check());
    expect(decision).toMatchObject({ decision: "approval", approvalId: "approval-1" });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.anything(),
      [ACME_PERMISSION],
      expect.anything(),
    );
  });

  it("consumes a verified approval proof into an allow", async () => {
    const { policy } = policyDouble("prompt");
    const verifyApproval = vi
      .fn<() => Promise<{ approved: boolean; reason: string; permissions: string[] }>>()
      .mockResolvedValue({ approved: true, reason: "granted", permissions: [ACME_PERMISSION] });
    const approval = testDouble<Parameters<typeof decidePermission>[1] & object>({
      permissionApproval: testDouble({
        verifyApproval,
        requestApproval: vi.fn<() => Promise<never>>(),
      }),
    });
    const proofCheck = testDouble<PermissionCheck>({
      ...check(),
      context: testDouble({
        scope: { sessionId: "session-1" },
        metadata: { marshalWorkspaceName: "Engineering" },
        approval: { approvalId: "approval-1" },
      }),
    });
    const decision = await decidePermission(authority(policy), approval, proofCheck);
    expect(decision).toMatchObject({ decision: "allow", grants: [ACME_PERMISSION] });
  });

  it("fails closed on a smuggled identity-qualified bucket string", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const smuggled = `marshal.tool.invoke:${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}@acme/marshal-runtime-extension:x`;
    const decision = await decidePermission(
      authority(policy),
      undefined,
      check({ permission: smuggled }),
    );
    expect(decision).toMatchObject({ decision: "deny", code: "permission_denied" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when an extension declares a self-tool name through tool.invoke", async () => {
    const selfTool = RUNTIME_SELF_TOOL_NAMES[0];
    const { policy, evaluate } = policyDouble("approve");
    const chained = publicAuthority(
      createProductionMarshalRuntimePorts({
        sessionManager: sessionManagerDouble(),
        permissionPolicy: policy,
        workspaceDir: "/tmp/native-permission-rig",
        resolveExtensionDeclaredPermission: () => ({
          declared: true,
          extensionId: "@acme/marshal-runtime-extension",
        }),
      }).authority,
    );
    const decision = await decidePermission(
      chained,
      undefined,
      check({ permission: `marshal.tool.invoke:${selfTool}` }),
    );
    expect(decision).toMatchObject({ decision: "deny", code: "permission_denied" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("denies with invalid_scope before touching the authority when context has no scope", async () => {
    const { policy, evaluate } = policyDouble("approve");
    const decision = await decidePermission(
      authority(policy),
      undefined,
      check({ context: { scope: {}, metadata: {} } }),
    );
    expect(decision).toMatchObject({ decision: "deny", code: "invalid_scope" });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
