import { randomUUID } from "node:crypto";

import type { InvocationContext, RuntimeCallContext } from "@marshal/runtime";
import type { PermissionCheck, PermissionDecision } from "@marshal/runtime/core";

import type { RuntimeUiOwner } from "../../common/runtime-ui";
import type { MarshalRuntimeScope } from "./contracts";

const TOKEN = "marshalApplicationInvocation";
const HOST_PERMISSION = /^(marshal\.|runtime\.|swarm\.|ui\.)/;
const DELIVERY = /^marshal\.session\.delivery\.(send|read|cancel|stop)$/;
const APPLICATION_SESSION = /^marshal\.session\.(start|resume|reply)$/;
const OWN_APPLICATION_UI = /^ui\.application\.(open|update|focus|close|list)$/;

export interface ApplicationInvocationAuthority {
  readonly owner: RuntimeUiOwner;
  readonly capabilities: ReadonlySet<string>;
  readonly workspacePath: string;
  readonly executionScope?: MarshalRuntimeScope;
  readonly backgroundJobInvocationId?: string;
  /**
   * The resolved selected-session delivery grant backing this invocation
   * (SPEC.md v2.2 §7/§8): extensions gate session-delivery capabilities on
   * `context.metadata.grantId`, so the UI invoke path must convey the grant
   * id itself, not only the execution scope it resolved to.
   */
  readonly grantId?: string;
  readonly isActive: () => Promise<boolean>;
}

/** Invocation-scoped bearer IDs are minted only by the native app controller. */
export class RuntimeApplicationAuthority {
  private readonly invocations = new Map<string, ApplicationInvocationAuthority>();

  async run<T>(
    authority: ApplicationInvocationAuthority,
    invoke: (context: RuntimeCallContext) => Promise<T>,
  ): Promise<T> {
    if (!(await authority.isActive()))
      throw new Error("The extension application is no longer active.");
    const token = randomUUID();
    this.invocations.set(token, authority);
    try {
      return await invoke({
        agentId: `application:${authority.owner.extensionId}:${authority.owner.applicationId}`,
        ...(authority.executionScope ? { sessionId: authority.executionScope.sessionId } : {}),
        workspacePath: authority.workspacePath,
        metadata: {
          [TOKEN]: token,
          marshalRuntimeUi: true,
          marshalWorkspaceName:
            authority.executionScope?.workspaceName ?? authority.owner.workspaceName,
          runtimeExtensionIdentity: authority.owner.extensionId,
          runtimeApplicationId: authority.owner.applicationId,
          ...(authority.owner.applicationScope
            ? { runtimeApplicationScope: authority.owner.applicationScope }
            : {}),
          ...(authority.grantId ? { grantId: authority.grantId } : {}),
          // R1 (extension babysit contract): only live UI invocations are
          // foreground; background job invocations must never claim it.
          ...(authority.backgroundJobInvocationId ? {} : { foreground: true }),
        },
      });
    } finally {
      this.invocations.delete(token);
    }
  }

  resolve(
    context: Pick<InvocationContext, "metadata"> | RuntimeCallContext,
  ): ApplicationInvocationAuthority | undefined {
    const token = context.metadata?.[TOKEN];
    return typeof token === "string" ? this.invocations.get(token) : undefined;
  }

  async decide(check: PermissionCheck): Promise<PermissionDecision | undefined> {
    const application = this.resolve(check.context);
    if (!application) return undefined;
    if (!(await application.isActive())) {
      return {
        decision: "deny",
        code: "permission_denied",
        reason: "The current application publication does not authorize this capability.",
      };
    }
    // W3-F1: the application-owned HOST-operation classes (session delivery,
    // session start/resume, image import, job arm/status/disarm) are classified BEFORE the
    // publication-capability membership gate. An extension's own capability
    // (e.g. codereview.ai.ask → an internal marshal.session.delivery.send,
    // or codereview.babysit.arm → marshal.application.job.arm) reaches the
    // host by issuing these INTERNAL `marshal.*` checks, and a publication's
    // declared capability set contains only EXTENSION capability names — it
    // can never contain a host `marshal.*` name. Gating them on membership
    // left every one of these allow-branches unreachable from real UI/agent
    // paths (installed symptom: an ai.ask dispatch cleared the §7 grant gate
    // and then died on its own internal delivery send with the
    // publication-unauthorized deny; babysit arm broke identically). Each
    // branch keeps its exact owner/permission validation; only its position
    // moved. OWN_APPLICATION_UI (`ui.application.*` / `ui.notifications.*`)
    // stays membership-gated below — those ARE declared in real publications.
    if (
      DELIVERY.test(check.capability.name) ||
      APPLICATION_SESSION.test(check.capability.name) ||
      check.capability.name === "marshal.ui.image.import" ||
      /^marshal\.application\.job\.(arm|status|disarm)$/.test(check.capability.name)
    ) {
      return check.requirements.every(({ permission }) => permission === check.capability.name)
        ? {
            decision: "allow",
            reason: "Application-owned host operation validates its native owner and inputs.",
          }
        : {
            decision: "deny",
            code: "permission_denied",
            reason: "Unexpected application-owned host permission.",
          };
    }
    if (!application.capabilities.has(check.capability.name)) {
      return {
        decision: "deny",
        code: "permission_denied",
        reason: "The current application publication does not authorize this capability.",
      };
    }
    if (OWN_APPLICATION_UI.test(check.capability.name)) {
      return check.requirements.every(
        ({ permission }) => permission === `marshal.${check.capability.name}`,
      )
        ? {
            decision: "allow",
            reason: "Application UI operations are restricted to the authenticated owner.",
          }
        : {
            decision: "deny",
            code: "permission_denied",
            reason: "Unexpected application UI permission.",
          };
    }
    if (
      HOST_PERMISSION.test(check.capability.name) ||
      check.requirements.some(({ permission }) => HOST_PERMISSION.test(permission))
    ) {
      if (application.executionScope) return undefined; // Preserve normal host policy and approval.
      return {
        decision: "deny",
        code: "permission_denied",
        reason:
          "Select an execution session in the native application toolbar to use session-scoped host capabilities.",
      };
    }
    return {
      decision: "allow",
      reason: "Capability explicitly declared by the active extension application.",
    };
  }
}

export function stripApplicationAuthority(metadata: Record<string, unknown>): void {
  delete metadata[TOKEN];
  delete metadata.runtimeApplicationId;
  delete metadata.runtimeApplicationScope;
}
