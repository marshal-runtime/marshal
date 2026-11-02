import { createHash, randomUUID } from "node:crypto";

import { RUNTIME_PROTOCOL_VERSION } from "@marshal/runtime";
import type { PermissionCheck, PermissionDecision } from "@marshal/runtime/core";

import { createLogger } from "../../common/marshal-logger";
import { workspaceInstanceIdentitiesEqual } from "../../common/workspace-role-identity";
import { ApprovalBroker, type TransientApprovalBinding } from "../approval-broker";
import type { RuntimeTool } from "../backend/runtime-contract";
import type { ApprovalDecision, ApprovalRequest } from "../backend/types";
import type { PermissionPolicy } from "../permission-policy";
import type { SessionManager } from "../sessions";
import { captureWorkspaceBinding } from "../workspace-role-identity";
import {
  adaptMarshalBrowserCommand,
  isMarshalBrowserCommandName,
} from "./browser-command-adapters";
import {
  MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX,
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  MARSHAL_RUNTIME_PERMISSION,
  MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX,
  type MarshalRuntimeAuthorityPort,
  type MarshalRuntimeAuthorityDecisionEvent,
  type MarshalRuntimeApprovalPort,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeScope,
  type ResolvedMarshalRuntimeScope,
} from "./contracts";
import type { MarshalRuntimeHost } from "./host";
import { WORKSPACE_METADATA_KEY } from "./host";
import { RUNTIME_SELF_TOOL_NAMES } from "./runtime-self-tools";
import { TRUSTED_TYPESCRIPT_PERMISSIONS } from "./trusted-typescript";

const log = createLogger("MarshalRuntimeExtensionPermissionResolver");

/**
 * Declared permissions of the PORTABLE runtime builtin providers (the
 * react-ui provider `portable.react-ui` today) that route to the Marshal
 * permission POLICY rather than the unconditional builtin allow. These are
 * host-registered builtins (F-DEPLOY-5c provenance), but unlike the
 * BUILTIN_PERMISSIONS below their operations compile and render
 * agent-authored code, so the decision belongs to the user's policy
 * (allow-all mode, per-tool grants, or an interactive approval) — never to a
 * silent allow and never to the unsupported-permission deny that previously
 * made the whole authored-UI surface unreachable in production.
 */
const PORTABLE_UI_POLICY_ROUTES = new Map<string, string>([
  // capability -> the ONE permission its shipped descriptor declares. Pinned
  // pairwise so only the portable provider's own operations route here:
  // kernel capability names are globally unique (registration throws on
  // collision), so these capabilities cannot belong to an extension.
  ["ui.compile", "trusted_ui"],
  ["ui.registered.compile", "ui.registered_component.use"],
  ["ui.registered.list", "ui.registered.list"],
  ["ui.components.get", "ui.components.get"],
  ["ui.components.list", "ui.components.list"],
  ["ui.render", "ui.render"],
  ["ui.renders.get", "ui.renders.get"],
  ["ui.renders.list", "ui.renders.list"],
  ["ui.applications.list", "ui.applications.list"],
  ["ui.authoring.profiles.list", "ui.authoring.profiles.read"],
  ["ui.authoring.profiles.select", "ui.authoring.profiles.read"],
  // portable.react-ui-authored-state provider (marshal-host-10 pack): read
  // operations declare ui.authored.read (risk low), mutating operations
  // declare ui.authored.write (risk high) — mirrored exactly from the shipped
  // descriptors; the policy decision (prompt for high risk) still applies.
  ["ui.authored.read", "ui.authored.read"],
  ["ui.authored.list", "ui.authored.read"],
  ["ui.authored.readSnapshot", "ui.authored.read"],
  ["ui.authored.create", "ui.authored.write"],
  ["ui.authored.update", "ui.authored.write"],
  ["ui.authored.changeState", "ui.authored.write"],
  ["ui.authored.remove", "ui.authored.write"],
  ["ui.authored.migrate", "ui.authored.write"],
]);
/** Policy bucket prefix for portable-ui permissions (namespaced like
 *  EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX so these can never collide
 *  with self-tool/memory/code-intel policy names). */
const PORTABLE_UI_PERMISSION_POLICY_PREFIX = "runtime-portable-ui:";

/**
 * Host app-lifecycle capabilities that route to the Marshal permission POLICY
 * rather than the unconditional builtin allow, for the same reason as
 * PORTABLE_UI_POLICY_ROUTES above: restarting the app kills every running
 * agent session, so the decision belongs to the user's policy (allow-all
 * mode proceeds, default mode prompts) — never to a silent allow. Pinned
 * capability → permission pairwise like the portable map; kernel capability
 * names are globally unique, so these cannot belong to an extension.
 */
const APP_LIFECYCLE_POLICY_ROUTES = new Map<string, string>([
  ["marshal.app.restart", MARSHAL_RUNTIME_PERMISSION.appRestart],
]);
export const APP_LIFECYCLE_PERMISSION_POLICY_PREFIX = "runtime-app-lifecycle:";

/**
 * Host UI-observability capabilities (electron/ui-observe.ts), routed to the
 * Marshal permission policy for the same reason as the maps above: observing
 * renders extension UI in a hidden window and hands out screenshots / CDP
 * targets, so the decision belongs to the user's policy — never a silent
 * allow, never the unsupported-permission deny. Pinned capability →
 * permission pairwise; kernel capability names are globally unique.
 */
const UI_OBSERVE_POLICY_ROUTES = new Map<string, string>([
  ["ui.observe.open", "ui.observe.open"],
  ["ui.observe.capture", "ui.observe.capture"],
  ["ui.observe.close", "ui.observe.close"],
]);
export const UI_OBSERVE_PERMISSION_POLICY_PREFIX = "runtime-ui-observe:";

const BUILTIN_PERMISSIONS = new Set<string>([
  MARSHAL_RUNTIME_PERMISSION.sessionRead,
  MARSHAL_RUNTIME_PERMISSION.workspaceRead,
  MARSHAL_RUNTIME_PERMISSION.skillRead,
  MARSHAL_RUNTIME_PERMISSION.typescriptExecute,
  MARSHAL_RUNTIME_PERMISSION.moduleExecute,
  MARSHAL_RUNTIME_PERMISSION.extensionList,
  MARSHAL_RUNTIME_PERMISSION.extensionInstall,
  MARSHAL_RUNTIME_PERMISSION.extensionUpdate,
  MARSHAL_RUNTIME_PERMISSION.extensionEnable,
  MARSHAL_RUNTIME_PERMISSION.extensionDisable,
  MARSHAL_RUNTIME_PERMISSION.extensionRemove,
  MARSHAL_RUNTIME_PERMISSION.extensionConfigure,
  MARSHAL_RUNTIME_PERMISSION.extensionProvider,
  MARSHAL_RUNTIME_PERMISSION.uiNotificationShow,
  MARSHAL_RUNTIME_PERMISSION.uiChatMessagePost,
  MARSHAL_RUNTIME_PERMISSION.uiChatCardShow,
  MARSHAL_RUNTIME_PERMISSION.uiApplicationOpen,
  MARSHAL_RUNTIME_PERMISSION.uiApplicationUpdate,
  MARSHAL_RUNTIME_PERMISSION.uiApplicationFocus,
  MARSHAL_RUNTIME_PERMISSION.uiApplicationClose,
  MARSHAL_RUNTIME_PERMISSION.uiApplicationList,
  MARSHAL_RUNTIME_PERMISSION.agentLaunch,
  MARSHAL_RUNTIME_PERMISSION.agentRead,
  MARSHAL_RUNTIME_PERMISSION.agentMessage,
  MARSHAL_RUNTIME_PERMISSION.agentCancel,
  MARSHAL_RUNTIME_PERMISSION.brainLaunch,
  MARSHAL_RUNTIME_PERMISSION.brainRead,
  MARSHAL_RUNTIME_PERMISSION.brainMessage,
  MARSHAL_RUNTIME_PERMISSION.brainCancel,
  MARSHAL_RUNTIME_PERMISSION.memoryStore,
  MARSHAL_RUNTIME_PERMISSION.memoryRecall,
  "runtime.delegation.spawn",
  "runtime.delegation.wait",
  "runtime.delegation.pause",
  "runtime.delegation.cancel",
  "runtime.delegation.continue",
  "runtime.delegation.complete",
  "swarm.read",
  "swarm.execute",
]);
const RUNTIME_SELF_TOOL_NAME_SET = new Set<string>(RUNTIME_SELF_TOOL_NAMES);
const CODE_INTELLIGENCE_READ_CAPABILITIES = new Set([
  "code.query",
  "code.context",
  "code.status",
  "code.index.status",
  "knowledge.workspace.status",
  "knowledge.workspace.ensure",
]);
const KNOWLEDGE_INTELLIGENCE_READ_CAPABILITIES = new Set([
  "knowledge.search",
  "knowledge.context",
  "knowledge.status",
]);
const CODE_INTELLIGENCE_EXACT_PERMISSIONS = new Set([
  "code.impact",
  "code.detect_changes",
  "code.index.initialize",
  "code.index.refresh",
  "code.index.repair",
  "code.index.rebuild",
  "code.index.remove",
]);
// The agent-facing workspace index tools wrap these code.index operations and
// declare their permission, so they share its policy bucket.
const WORKSPACE_INDEX_ALIASES: ReadonlyMap<string, string> = new Map([
  ["knowledge.workspace.refresh", "code.index.refresh"],
  ["knowledge.workspace.remove", "code.index.remove"],
]);
const RUNTIME_APPROVAL_TTL_MS = 10 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function runtimeApprovalWorkspace(value: unknown): {
  readonly workspacePath: string;
  readonly workspaceIdentity: TransientApprovalBinding["workspaceIdentity"];
} {
  if (typeof value !== "string") {
    throw Object.assign(new Error("Runtime approval requires an absolute workspace path."), {
      code: "permission_denied",
    });
  }
  try {
    const captured = captureWorkspaceBinding("Runtime approval", value);
    return {
      workspacePath:
        process.platform === "win32"
          ? captured.canonicalPath.toLocaleLowerCase()
          : captured.canonicalPath,
      workspaceIdentity: captured.binding.identity,
    };
  } catch {
    throw Object.assign(new Error("Runtime approval workspace is unavailable."), {
      code: "permission_denied",
    });
  }
}

function approvalPermissions(check: PermissionCheck): readonly string[] {
  return [...new Set(check.requirements.map((requirement) => requirement.permission))].sort();
}

function transientApprovalBinding(
  check: PermissionCheck,
  permissions: readonly string[],
): TransientApprovalBinding {
  const sessionId = check.context.scope?.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw Object.assign(new Error("Runtime approval requires a session scope."), {
      code: "permission_denied",
    });
  }
  const workspace = runtimeApprovalWorkspace(check.context.scope?.workspacePath);
  return {
    sessionId,
    ...workspace,
    capability: check.capability.name,
    permissions: [...new Set(permissions)].sort(),
    requestDigest: createHash("sha256")
      .update(stableJson({ target: check.request.target, input: check.request.input }))
      .digest("hex"),
  };
}

function transientWorkspaceIdentityMatches(binding: TransientApprovalBinding): boolean {
  try {
    const current = runtimeApprovalWorkspace(binding.workspacePath);
    return (
      current.workspacePath === binding.workspacePath &&
      workspaceInstanceIdentitiesEqual(current.workspaceIdentity, binding.workspaceIdentity)
    );
  } catch {
    return false;
  }
}

const REQUIREMENT_RISK_LABELS: Readonly<Record<string, string>> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};
const REQUIREMENT_WARNING_SEPARATOR = " ";

function requirementsWarning(check: PermissionCheck): string | undefined {
  const lines = check.requirements.flatMap((requirement) => {
    const reason = requirement.reason?.trim();
    if (!reason) return [];
    const risk = requirement.risk ? REQUIREMENT_RISK_LABELS[requirement.risk] : undefined;
    return [risk ? `${risk}: ${reason}` : reason];
  });
  return lines.length > 0 ? lines.join(REQUIREMENT_WARNING_SEPARATOR) : undefined;
}

function runtimeApprovalRequest(
  check: PermissionCheck,
  requestId: string,
  binding: TransientApprovalBinding,
): ApprovalRequest {
  return {
    id: requestId,
    sessionId: binding.sessionId,
    toolCallId: undefined,
    kind: "custom-tool",
    toolName: check.capability.name,
    toolDescription: check.capability.description,
    toolArgs: {
      workspacePath: binding.workspacePath,
      permissions: [...binding.permissions],
    },
    intention: undefined,
    warning: requirementsWarning(check),
    commandIdentifiers: [],
  };
}

function isApprovalAction(action: string): boolean {
  return (
    action === "allow" ||
    action === "allow-type" ||
    action === "allow-all" ||
    action === "allow-session" ||
    action === "always-allow"
  );
}

function permissionDenied(message: string): never {
  throw Object.assign(new Error(message), { code: "permission_denied" });
}

function createRuntimeApprovalPort(
  broker: ApprovalBroker,
  policy: PermissionPolicy,
): MarshalRuntimeApprovalPort {
  const approvalIds = new Set<string>();
  const approvalIdsByRequest = new Map<string, Set<string>>();
  const requestKey = (sessionId: string, requestId: string): string => `${sessionId}\0${requestId}`;
  const untrack = (approvalId: string): void => {
    approvalIds.delete(approvalId);
    for (const [key, ids] of approvalIdsByRequest) {
      ids.delete(approvalId);
      if (ids.size === 0) approvalIdsByRequest.delete(key);
    }
  };
  const cancel = (approvalId: string): void => {
    if (!approvalIds.has(approvalId)) return;
    untrack(approvalId);
    broker.cancelTransientApproval(approvalId);
  };
  const hasRequestOwner = (approvalId: string): boolean => {
    for (const ids of approvalIdsByRequest.values()) {
      if (ids.has(approvalId)) return true;
    }
    return false;
  };
  return {
    permissionApproval: {
      requestApproval(
        check: PermissionCheck,
        missingPermissions: readonly string[],
        presentation?: {
          readonly reason: string;
          readonly prompt?: string;
        },
      ) {
        if (check.context.signal?.aborted) {
          permissionDenied("Marshal Runtime operation was aborted.");
        }
        // Background invocations (UI polling) must never mint approval cards:
        // a capability that would prompt is denied fail-closed here, before any
        // transient approval opens. Explicit user actions omit the flag and
        // keep the normal approval flow.
        if (check.context.metadata?.marshalApprovalPolicy === "forbid") {
          permissionDenied(
            "Marshal Runtime approval prompts are disabled for background invocations; invoke this capability explicitly to approve it.",
          );
        }
        const binding = transientApprovalBinding(check, missingPermissions);
        const requestId = `runtime-perm-${Date.now()}-${randomUUID()}`;
        const permissionRequest = runtimeApprovalRequest(check, requestId, binding);
        const evaluation = policy.evaluateHardDenial(permissionRequest);
        if (evaluation.decision === "deny") {
          permissionDenied(
            evaluation.denyReason ?? "Marshal policy denied local repository intelligence.",
          );
        }
        const expiresAtMs = Date.now() + RUNTIME_APPROVAL_TTL_MS;
        const opened = broker.requestTransientPrompt(
          { permissionRequest, requestId, sessionId: binding.sessionId },
          {
            binding,
            expiresAt: expiresAtMs,
            onResolution(action) {
              const approved = isApprovalAction(action);
              const decision: ApprovalDecision = approved
                ? "approved"
                : "denied-interactively-by-user";
              if (approved) {
                const currentEvaluation = policy.evaluateHardDenial(permissionRequest);
                if (
                  currentEvaluation.decision === "deny" ||
                  !transientWorkspaceIdentityMatches(binding)
                ) {
                  untrack(requestId);
                  return false;
                }
              }
              const accepted = policy.recordInteractiveOutcome(
                permissionRequest,
                approved ? "allow" : "deny",
                decision,
              );
              if (!approved || !accepted) untrack(requestId);
              return approved && accepted;
            },
            onTimeout: () => {
              untrack(requestId);
              policy.logInfraFailure(permissionRequest, "timeout");
            },
            onCancel: () => untrack(requestId),
          },
        );
        approvalIds.add(opened.requestId);
        const executionId = check.context.executionId?.trim();
        if (executionId) {
          const key = requestKey(binding.sessionId, executionId);
          const ids = approvalIdsByRequest.get(key) ?? new Set<string>();
          ids.add(opened.requestId);
          approvalIdsByRequest.set(key, ids);
        }
        return {
          reason:
            presentation?.reason ??
            "Local repository intelligence requires explicit user approval.",
          approvalId: opened.requestId,
          prompt:
            presentation?.prompt ??
            `Create a local intelligence index for ${binding.workspacePath}?`,
          expiresAt: new Date(opened.expiresAt).toISOString(),
        };
      },
      verifyApproval(approval: Readonly<Record<string, unknown>>, check: PermissionCheck) {
        const approvalId =
          typeof approval.approvalId === "string" ? approval.approvalId.trim() : "";
        if (!approvalId) permissionDenied("Runtime approval proof is missing its approval ID.");
        const binding = transientApprovalBinding(check, approvalPermissions(check));
        const consumed = broker.consumeTransientApproval(approvalId, binding);
        untrack(approvalId);
        if (consumed.status !== "approved") {
          permissionDenied(
            consumed.status === "pending"
              ? "Runtime approval is still pending."
              : `Runtime approval was rejected (${consumed.status}).`,
          );
        }
        return {
          approved: true,
          permissions: consumed.permissions,
          reason: "Approved by the existing Marshal permission card.",
        };
      },
    },
    status(approvalId) {
      const status = broker.transientApprovalStatus(approvalId);
      if (status === "denied" || status === "expired" || status === "missing") {
        untrack(approvalId);
      }
      return status;
    },
    cancel,
    cancelRequest(sessionId, requestId) {
      const key = requestKey(sessionId, requestId);
      const ids = approvalIdsByRequest.get(key);
      if (!ids) return;
      approvalIdsByRequest.delete(key);
      for (const approvalId of ids) {
        if (!hasRequestOwner(approvalId)) cancel(approvalId);
      }
    },
    dispose() {
      for (const approvalId of [...approvalIds]) cancel(approvalId);
    },
  };
}

function policyDecision(
  policy: PermissionPolicy,
  sessionId: string,
  toolName: string,
  input: unknown,
): PermissionDecision {
  const request: ApprovalRequest = {
    id: randomUUID(),
    sessionId,
    toolCallId: undefined,
    kind: "custom-tool",
    toolName,
    toolDescription: undefined,
    toolArgs: isRecord(input) ? input : {},
    intention: undefined,
    warning: undefined,
    commandIdentifiers: [],
  };
  const evaluation = policy.evaluateDetailed(request);
  if (evaluation.decision === "approve") {
    return { decision: "allow", reason: "Allowed by the Marshal permission policy." };
  }

  if (evaluation.decision === "prompt") {
    return {
      decision: "approval",
      reason: "Marshal requires interactive approval for this host tool.",
      prompt: `Approve Marshal Runtime tool "${toolName}".`,
    };
  }

  return {
    decision: "deny",
    reason: evaluation.denyReason ?? `Marshal policy denied host tool "${toolName}".`,
    code: "permission_denied",
  };
}

function browserPolicyDecision(
  policy: PermissionPolicy,
  sessionId: string,
  capability: string,
  input: unknown,
): PermissionDecision {
  if (!isMarshalBrowserCommandName(capability) || !isRecord(input)) {
    return {
      decision: "deny",
      reason: `Marshal does not support browser capability "${capability}".`,
      code: "permission_denied",
    };
  }
  let adapted: ReturnType<typeof adaptMarshalBrowserCommand>;
  try {
    adapted = adaptMarshalBrowserCommand(capability, input);
  } catch (error) {
    return {
      decision: "deny",
      reason: error instanceof Error ? error.message : "The browser command input is invalid.",
      code: "permission_denied",
    };
  }
  const request: ApprovalRequest = {
    id: randomUUID(),
    sessionId,
    toolCallId: undefined,
    kind: "mcp",
    serverName: "playwright",
    toolName: adapted.toolName,
    toolTitle: undefined,
    toolDescription: undefined,
    toolArgs: { ...adapted.input },
    readOnly:
      capability === "browser_accessibility_tree" ||
      capability === "browser_console" ||
      capability === "browser_list_tabs" ||
      capability === "browser_screenshot",
  };
  const evaluation = policy.evaluateDetailed(request);
  if (evaluation.decision === "approve") {
    return { decision: "allow", reason: "Allowed by the Marshal browser permission policy." };
  }
  if (evaluation.decision === "prompt") {
    return {
      decision: "approval",
      reason: "Marshal requires interactive approval for this browser command.",
      prompt: `Approve browser command "${capability}".`,
    };
  }
  return {
    decision: "deny",
    reason: evaluation.denyReason ?? `Marshal policy denied browser command "${capability}".`,
    code: "permission_denied",
  };
}

function codeIntelligencePolicyToolName(permission: string, capability: string): string | null {
  if (permission === "code.read") {
    return CODE_INTELLIGENCE_READ_CAPABILITIES.has(capability) ? capability : null;
  }
  if (permission === "knowledge.read") {
    return KNOWLEDGE_INTELLIGENCE_READ_CAPABILITIES.has(capability) ? capability : null;
  }
  if (!CODE_INTELLIGENCE_EXACT_PERMISSIONS.has(permission)) return null;
  return permission === capability || WORKSPACE_INDEX_ALIASES.get(capability) === permission
    ? capability
    : null;
}

function memoryPolicyToolName(permission: string, capability: string): string | null {
  if (permission !== "memory.read" && permission !== "memory.write") return null;
  return capability.startsWith("memory.") ? capability : null;
}

/**
 * A declared match names the installed+enabled extension whose capability
 * descriptor declared the permission (SF2-2), so the policy bucket can be
 * qualified by extension identity, not just by permission id.
 *
 * F-DEPLOY-5b (Codex adjudication): `false` means ONLY "the lookup succeeded
 * and no installed+enabled extension declares this permission" — verified
 * evidence of not-declared. Any outcome where that question could NOT be
 * answered (kernel search failed, the owner or host-provenance lookup threw,
 * a declaring descriptor's owner resolved to null WITHOUT affirmative host
 * provenance, or the capability was missing at authorize time) is
 * `indeterminate`, never `false`: collapsing those into `false` made the
 * builtin branch's unconditional allow reachable on a resolver-infrastructure
 * failure — fail-open on exactly the paths the F-R2 guard exists to close.
 *
 * F-DEPLOY-5c: a declaring descriptor whose owner lookup returns null AND
 * whose provider id carries affirmative host provenance
 * (MarshalRuntimeHost.isHostRegisteredCapabilityProvider — the
 * bindings.providers bootstrap registry) IS verified not-extension-declared
 * (`false`): builtin trust legitimately belongs to host-registered providers
 * (marshal.delegation declares runtime.delegation.*, marshal.runtime-ui
 * declares marshal.ui.application.* verbatim). Null ALONE is not enough: in
 * the extension enable/update/disable windows a provider is kernel-visible
 * while its lifecycle projection (status="enabled" + capabilityProviderIds)
 * is not yet — or no longer — populated, so a bare null can also mean "an
 * extension provider mid-lifecycle-transition", which must stay fail-closed.
 */
export type ExtensionDeclaredPermissionIndeterminate = {
  readonly indeterminate: true;
  readonly reason:
    | "capability-missing-at-authorize"
    | "resolver-search-threw"
    | "owner-unresolved"
    | "resolver-threw";
};

export type ExtensionDeclaredPermissionResult =
  | false
  | { readonly declared: true; readonly extensionId: string }
  | ExtensionDeclaredPermissionIndeterminate;

function isDeclaredPermissionMatch(
  result: ExtensionDeclaredPermissionResult,
): result is { readonly declared: true; readonly extensionId: string } {
  return result !== false && "declared" in result;
}

function isIndeterminatePermissionResult(
  result: ExtensionDeclaredPermissionResult,
): result is ExtensionDeclaredPermissionIndeterminate {
  return result !== false && "indeterminate" in result;
}

/**
 * Narrow, read-only lookup answering "does an installed and enabled extension's
 * capability descriptor declare this permission for this capability, and if so
 * which extension?" Backed in production by a live query against the runtime
 * capability catalog (see electron/main.ts wiring), so a disabled/uninstalled
 * extension's permissions disappear automatically once its capability
 * providers are deregistered.
 */
export type ExtensionDeclaredPermissionResolver = (
  permission: string,
  capability: string,
  scope: ResolvedMarshalRuntimeScope,
) => ExtensionDeclaredPermissionResult | Promise<ExtensionDeclaredPermissionResult>;

/**
 * Policy tool name prefix for extension-declared permissions (F-R2). Combined
 * with the declaring extension's identity (SF2-2) so a declared permission id
 * (e.g. "codereview.read") can never collide with a real self-tool/memory/
 * code-intel policy tool name, AND two different extensions declaring the
 * same permission id get separate policy buckets — neither can silently
 * inherit the other's session always-allow grant.
 */
export const EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX = "runtime-extension:";

/**
 * Codex 22:48(ii): before an extension-declared permission ever reaches the
 * resolver or policyDecision() — namespaced or not — refuse anything whose id
 * collides with a name an earlier branch already owns: a real self-tool name,
 * a builtin permission, a marshal.tool.invoke: / marshal.browser.invoke:
 * prefix wrapper, or a memory/code-intelligence id. A descriptor-controlled id like
 * "runtimeInvoke" or "memory.recall" must fall straight through to the
 * existing "not supported" deny below, never to the resolver.
 *
 * A BUILTIN_PERMISSIONS collision is additionally handled at the builtin
 * branch itself (below): a verified descriptor-declared builtin id routes to
 * the declaring extension's identity-qualified policy bucket (F-DEPLOY-5)
 * instead of the unconditional builtin allow, so it never reaches this guard
 * via the loop's earlier `continue`; the id is still listed here so the
 * predicate answers the same question at every call site.
 */
export function isReservedRuntimePermissionId(permission: string): boolean {
  return (
    RUNTIME_SELF_TOOL_NAME_SET.has(permission) ||
    BUILTIN_PERMISSIONS.has(permission) ||
    TRUSTED_TYPESCRIPT_PERMISSIONS.has(permission) ||
    permission.startsWith(MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX) ||
    permission.startsWith(MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX) ||
    permission === "memory.read" ||
    permission === "memory.write" ||
    permission === "code.read" ||
    permission === "knowledge.read" ||
    CODE_INTELLIGENCE_EXACT_PERMISSIONS.has(permission)
  );
}

/**
 * Fail-closed wrapper around the resolver: a throwing or rejecting resolver
 * is `indeterminate` (F-DEPLOY-5b), never "not extension-declared" — the
 * caller cannot know whether a descriptor declares the permission, so no
 * call site may treat the failure as evidence of not-declared. Every call
 * site below handles indeterminate as blocking: the builtin branch denies
 * (ownership-unverified), the self-tool smuggle guard denies, and the
 * dedicated extension-declared branch falls through to the
 * unsupported-permission deny. No resolver configured stays `false`: the
 * extension-declared-permission feature is not wired at all (no extensions
 * can be declaring anything), which is a static deployment shape, not an
 * infrastructure failure.
 */
async function isExtensionDeclaredPermissionForCapability(
  resolver: ExtensionDeclaredPermissionResolver | undefined,
  permission: string,
  capability: string,
  scope: ResolvedMarshalRuntimeScope,
): Promise<ExtensionDeclaredPermissionResult> {
  if (!resolver) return false;
  try {
    return await resolver(permission, capability, scope);
  } catch {
    return { indeterminate: true, reason: "resolver-threw" };
  }
}

/**
 * Live-catalog-backed {@link ExtensionDeclaredPermissionResolver} (R5 / D2):
 * searches the kernel, scoped to the caller's session/workspace, for a
 * capability descriptor that declares `permission`, then resolves which
 * enabled extension owns it.
 *
 * F-DEPLOY-4: the search context MUST carry `metadata[WORKSPACE_METADATA_KEY]`
 * — MarshalRuntimeHost's `resolveWorkspace` callback (host.ts's
 * `resolveRuntimeWorkspace`) reads the workspace name from there, not from a
 * top-level `workspacePath` field, and throws `invalid_scope` without it. That
 * throw was previously swallowed by this function's own fail-closed catch,
 * making every extension-declared permission check silently deny — the
 * declaring extension's own `runtimeSearch` (routed through
 * `ProductionMarshalRuntimeApi.search()`, which does set this metadata key)
 * kept working, which is what made the deny look like an unrelated policy gap
 * instead of a broken resolver.
 *
 * Fail-closed on any resolver-chain failure (F-R4). Each failure path logs a
 * reason category — never permission input values or customer content, per
 * CLAUDE.md — so a silent fail-closed deny is distinguishable from a genuine
 * "extension does not declare this permission" deny.
 *
 * F-DEPLOY-5b (Codex adjudication): failure paths return `indeterminate`, not
 * `false`. TRADE-OFF, by design: a kernel-search infrastructure failure now
 * DENIES builtin-permission invokes for the affected capability instead of
 * silently allowing them — loud fail-closed; the breadcrumbs above identify
 * which failure path fired. Do not "soften" this back to `false`: that is
 * exactly the collapse that kept the F-R2 builtin guard silently disarmed
 * under F-DEPLOY-4.
 *
 * F-DEPLOY-5c: owner-null with AFFIRMATIVE host provenance
 * (isHostRegisteredCapabilityProvider) is `false` — verified host-registered,
 * builtin authority applies. Owner-null without provenance, and a throwing
 * owner/provenance lookup, stay indeterminate ("owner-unresolved" — the
 * reason id is kept for the throw paths rather than introducing a separate
 * "owner-lookup-threw" so existing breadcrumb consumers stay stable; the
 * warn line text distinguishes the sub-paths).
 */
export function createExtensionDeclaredPermissionResolver(
  host: Pick<
    MarshalRuntimeHost,
    "search" | "resolveExtensionOwningProvider" | "isHostRegisteredCapabilityProvider"
  >,
): ExtensionDeclaredPermissionResolver {
  return async (permission, capability, scope) => {
    if (!capability.trim()) {
      log.warn("Extension-declared permission resolver denied: capability missing at authorize.", {
        reason: "capability-missing-at-authorize",
        permission,
      });
      // A missing capability is not evidence of not-declared — the search
      // never ran (F-DEPLOY-5b).
      return { indeterminate: true, reason: "capability-missing-at-authorize" };
    }
    let response: Awaited<ReturnType<typeof host.search>>;
    try {
      response = await host.search(
        { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: capability },
        {
          sessionId: scope.sessionId,
          workspacePath: scope.workspacePath,
          metadata: { [WORKSPACE_METADATA_KEY]: scope.workspaceName },
        },
      );
    } catch {
      log.warn("Extension-declared permission resolver denied: catalog search threw.", {
        reason: "resolver-search-threw",
        permission,
        capability,
      });
      return { indeterminate: true, reason: "resolver-search-threw" };
    }
    const match = response.matches.find(
      (candidate) =>
        candidate.capability.name === capability &&
        candidate.capability.permissions?.some(
          (requirement) => requirement.permission === permission,
        ),
    );
    if (!match) return false;
    // SF2-2: qualify the policy bucket by the declaring extension's identity,
    // resolved from the same scoped match above (see
    // MarshalRuntimeHost.resolveExtensionOwningProvider doc for why this
    // doesn't re-run search() with a different scope).
    let extensionId: string | null;
    try {
      extensionId = await host.resolveExtensionOwningProvider(match.capability.provider.id);
    } catch {
      log.warn("Extension-declared permission resolver denied: owner lookup threw.", {
        reason: "owner-unresolved",
        permission,
        capability,
      });
      return { indeterminate: true, reason: "owner-unresolved" };
    }
    if (!extensionId) {
      // F-DEPLOY-5c: owner-null is only a verified negative when the provider
      // carries AFFIRMATIVE host provenance — it was registered by the host at
      // kernel bootstrap (bindings.providers), so builtin trust legitimately
      // applies. A bare null without provenance stays indeterminate: in the
      // extension enable/update/disable windows a provider is kernel-visible
      // while the lifecycle projection resolveExtensionOwningProvider reads is
      // not yet (or no longer) populated, and misreporting that as
      // not-declared would hand an extension the unconditional builtin allow
      // (F-DEPLOY-5b / F-R2).
      let hostOwned: boolean;
      try {
        hostOwned = await host.isHostRegisteredCapabilityProvider(match.capability.provider.id);
      } catch {
        log.warn("Extension-declared permission resolver denied: host provenance lookup threw.", {
          reason: "owner-unresolved",
          permission,
          capability,
        });
        return { indeterminate: true, reason: "owner-unresolved" };
      }
      // No log on the host-owned path: it fires on every builtin invoke of a
      // host capability (steady state — e.g. every ui.application.list call),
      // and the allow itself is observable via the authority-decision event.
      if (hostOwned) return false;
      // A descriptor DECLARING the id was found but its owner is unknown and
      // it is NOT a host bootstrap provider — the most dangerous shape to
      // misreport as not-declared (F-DEPLOY-5b).
      log.warn("Extension-declared permission resolver denied: owning extension unresolved.", {
        reason: "owner-unresolved",
        permission,
        capability,
      });
      return { indeterminate: true, reason: "owner-unresolved" };
    }
    return { declared: true as const, extensionId };
  };
}

export function createProductionMarshalRuntimePorts(options: {
  readonly sessionManager: SessionManager;
  readonly permissionPolicy: PermissionPolicy;
  readonly approvalBroker?: ApprovalBroker;
  readonly workspaceDir: string;
  readonly onAuthorityDecision?: (event: MarshalRuntimeAuthorityDecisionEvent) => void;
  readonly onToolsListed?: (tools: readonly RuntimeTool[]) => void;
  readonly onToolInvoked?: (tool: RuntimeTool) => void;
  readonly resolveExtensionDeclaredPermission?: ExtensionDeclaredPermissionResolver;
  /** Allows full-Node TypeScript execution without a policy prompt. See trusted-typescript.ts. */
  readonly trustedTypeScript?: boolean;
}): {
  readonly authority: MarshalRuntimeAuthorityPort;
  readonly approval?: MarshalRuntimeApprovalPort;
  readonly catalog: MarshalRuntimeCatalogPort;
  readonly resolveScope: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
} {
  const resolveSessionScope = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly scope: MarshalRuntimeScope; readonly workspaceBound: boolean } | null> => {
    if (signal?.aborted) return null;
    const session = await options.sessionManager.getSessionScopeAsync(sessionId);
    if (signal?.aborted || !session) return null;
    const boundWorkspaceName = session.workspaceName?.trim();
    return {
      scope: {
        sessionId,
        workspaceName: boundWorkspaceName || MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      },
      workspaceBound: Boolean(boundWorkspaceName),
    };
  };

  const resolveScope = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeScope | null> =>
    (await resolveSessionScope(sessionId, signal))?.scope ?? null;

  const authority: MarshalRuntimeAuthorityPort = {
    async resolveScope(scope, signal) {
      const resolved = await resolveSessionScope(scope.sessionId, signal);
      const current = resolved?.scope;
      if (
        !resolved ||
        !current ||
        current.workspaceName.toLowerCase() !== scope.workspaceName.trim().toLowerCase()
      ) {
        return null;
      }
      // A registered workspace may legitimately be named the same as the default
      // sentinel ("marshal"); only sessions with no bound workspace use workspaceDir.
      // Repo-scoped sessions without a registered workspace (subagents and swarm
      // workers in worktrees) keep their verified repoPath so code intelligence and
      // memory resolve to that repository instead of the shared default directory.
      if (!resolved.workspaceBound) {
        return {
          ...current,
          workspacePath:
            options.sessionManager.getWorkspaceRootForSession(scope.sessionId) ??
            options.workspaceDir,
        };
      }
      const workspace = options.sessionManager
        .listWorkspacesForSelfTools()
        .find((candidate) => candidate.name.toLowerCase() === current.workspaceName.toLowerCase());
      return workspace
        ? { ...current, workspaceName: workspace.name, workspacePath: workspace.path }
        : null;
    },
    async authorize(request) {
      const finish = (decision: PermissionDecision): PermissionDecision => {
        options.onAuthorityDecision?.({
          scope: request.scope,
          capability: request.capability,
          permissions: [...request.permissions],
          decision,
        });
        return decision;
      };
      if (request.signal?.aborted) {
        return finish({
          decision: "deny",
          reason: "Marshal Runtime operation was aborted.",
          code: "aborted",
        });
      }
      const resolved = await authority.resolveScope(request.scope, request.signal);
      if (request.signal?.aborted) {
        return finish({
          decision: "deny",
          reason: "Marshal Runtime operation was aborted.",
          code: "aborted",
        });
      }
      if (!resolved) {
        return finish({
          decision: "deny",
          reason: "Marshal Runtime session or workspace authority is unavailable.",
          code: "permission_denied",
        });
      }
      for (const permission of request.permissions) {
        if (
          BUILTIN_PERMISSIONS.has(permission) ||
          (options.trustedTypeScript === true && TRUSTED_TYPESCRIPT_PERMISSIONS.has(permission))
        ) {
          // F-R2 defense in depth: an extension's own capability descriptor
          // must never be able to reuse a builtin trusted permission id to
          // get an unconditional allow with zero policy check. F-DEPLOY-5:
          // extensions DO legitimately declare builtin ids (@marshal/swarm
          // declares swarm.execute/swarm.read verbatim), so a verified
          // declared match is not denied — it routes to the SAME
          // identity-qualified policy bucket the declared-permission branch
          // below uses, so the decision is the policy's and no extension can
          // inherit another extension's or a self-tool's grants. Only a
          // VERIFIED not-declared (`false`) keeps the plain builtin allow via
          // `continue`. F-DEPLOY-5b (Codex adjudication): an indeterminate
          // result — search threw, owner unresolved, capability missing —
          // DENIES. TRADE-OFF, by design: a kernel-search infrastructure
          // failure now denies builtin-permission invokes for the affected
          // capability instead of silently allowing them (the exact fail-open
          // that kept this guard dead under F-DEPLOY-4); the resolver's
          // breadcrumbs name the failure path, so the deny is loud, not
          // silent.
          // eslint-disable-next-line no-await-in-loop -- must short-circuit in permission order, like the sibling branches below
          const declared = await isExtensionDeclaredPermissionForCapability(
            options.resolveExtensionDeclaredPermission,
            permission,
            request.capability,
            resolved,
          );
          if (isIndeterminatePermissionResult(declared)) {
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission ownership could not be verified: ${permission}.`,
              code: "permission_denied",
            });
          }
          if (isDeclaredPermissionMatch(declared)) {
            const extensionPolicyToolName = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}${declared.extensionId}:${permission}`;
            const decision = policyDecision(
              options.permissionPolicy,
              request.scope.sessionId,
              extensionPolicyToolName,
              request.input,
            );
            if (decision.decision !== "allow") return finish(decision);
          }
          continue;
        }
        const policyToolName =
          codeIntelligencePolicyToolName(permission, request.capability) ??
          memoryPolicyToolName(permission, request.capability);
        if (policyToolName) {
          const decision = policyDecision(
            options.permissionPolicy,
            request.scope.sessionId,
            policyToolName,
            request.input,
          );
          if (decision.decision !== "allow") return finish(decision);
          continue;
        }
        if (permission.startsWith(MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX)) {
          const toolName = permission.slice(MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX.length);
          if (toolName.startsWith(EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX)) {
            // SF2-3 defense in depth: a descriptor-declared permission id must
            // never smuggle into another extension's identity-qualified
            // policy bucket through this channel — deny before
            // policyDecision() is ever reached, mirroring the self-tool guard
            // immediately below.
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission is not supported: ${permission}.`,
              code: "permission_denied",
            });
          }
          if (
            RUNTIME_SELF_TOOL_NAME_SET.has(toolName) &&
            // F-R2 defense in depth: an extension can't smuggle its own
            // capability through the "marshal.tool.invoke:<selfTool>" channel
            // to inherit that self-tool's session always-allow grant. The
            // truthy check is deliberate (F-DEPLOY-5b): both a verified
            // declared match AND an indeterminate result block here — an
            // unverifiable declaration must never be treated as safe.
            // eslint-disable-next-line no-await-in-loop -- must short-circuit in permission order, like the sibling branches below
            (await isExtensionDeclaredPermissionForCapability(
              options.resolveExtensionDeclaredPermission,
              permission,
              request.capability,
              resolved,
            ))
          ) {
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission is not supported: ${permission}.`,
              code: "permission_denied",
            });
          }
          const decision = policyDecision(
            options.permissionPolicy,
            request.scope.sessionId,
            toolName,
            request.input,
          );
          if (decision.decision !== "allow") return finish(decision);
          continue;
        }
        if (permission.startsWith(MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX)) {
          const toolName = permission.slice(MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX.length);
          if (toolName.startsWith(EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX)) {
            // SF2-3 defense in depth: mirror the tool.invoke guard above —
            // never let the browser-invoke channel reach
            // browserPolicyDecision() with a smuggled extension-identity-
            // qualified bucket string either.
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission is not supported: ${permission}.`,
              code: "permission_denied",
            });
          }
          if (toolName !== request.capability) {
            return finish({
              decision: "deny",
              reason: "Marshal browser capability and permission identity do not match.",
              code: "permission_denied",
            });
          }
          const decision = browserPolicyDecision(
            options.permissionPolicy,
            request.scope.sessionId,
            toolName,
            request.input,
          );
          if (decision.decision !== "allow") return finish(decision);
          continue;
        }
        const routedPolicyPrefix =
          PORTABLE_UI_POLICY_ROUTES.get(request.capability) === permission
            ? PORTABLE_UI_PERMISSION_POLICY_PREFIX
            : APP_LIFECYCLE_POLICY_ROUTES.get(request.capability) === permission
              ? APP_LIFECYCLE_PERMISSION_POLICY_PREFIX
              : UI_OBSERVE_POLICY_ROUTES.get(request.capability) === permission
                ? UI_OBSERVE_PERMISSION_POLICY_PREFIX
                : undefined;
        if (routedPolicyPrefix) {
          if (!options.resolveExtensionDeclaredPermission) {
            // Fail closed: without the resolver we cannot verify that no
            // enabled extension declares this id, so the routed policy path
            // stays unreachable rather than trusting the pair alone.
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission ownership could not be verified: ${permission}.`,
              code: "permission_denied",
            });
          }
          // Mirror of the BUILTIN_PERMISSIONS branch (F-DEPLOY-5/5b/5c): a
          // VERIFIED extension-declared match routes to that extension's own
          // identity-qualified policy bucket; an indeterminate result denies
          // fail-closed; only a verified not-extension-declared (`false` —
          // which for these ids means the host-registered builtin owns the
          // capability) reaches the route's own policy bucket. The
          // decision is then the Marshal permission policy's: allow-all
          // sessions and explicit grants allow, everything else prompts.
          // eslint-disable-next-line no-await-in-loop -- must short-circuit in permission order, like the sibling branches above
          const declared = await isExtensionDeclaredPermissionForCapability(
            options.resolveExtensionDeclaredPermission,
            permission,
            request.capability,
            resolved,
          );
          if (isIndeterminatePermissionResult(declared)) {
            return finish({
              decision: "deny",
              reason: `Marshal Runtime permission ownership could not be verified: ${permission}.`,
              code: "permission_denied",
            });
          }
          const policyToolNameForPermission = isDeclaredPermissionMatch(declared)
            ? `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}${declared.extensionId}:${permission}`
            : `${routedPolicyPrefix}${permission}`;
          const decision = policyDecision(
            options.permissionPolicy,
            request.scope.sessionId,
            policyToolNameForPermission,
            request.input,
          );
          if (decision.decision !== "allow") return finish(decision);
          continue;
        }
        if (
          options.resolveExtensionDeclaredPermission &&
          !isReservedRuntimePermissionId(permission)
        ) {
          // eslint-disable-next-line no-await-in-loop -- must short-circuit in permission order, like the sibling branches above
          const declared = await isExtensionDeclaredPermissionForCapability(
            options.resolveExtensionDeclaredPermission,
            permission,
            request.capability,
            resolved,
          );
          // F-DEPLOY-5b: indeterminate skips this branch and falls through to
          // the unsupported-permission deny below — the same outcome `false`
          // gets, so an unverifiable declaration never weakens anything here.
          if (isDeclaredPermissionMatch(declared)) {
            if (RUNTIME_SELF_TOOL_NAME_SET.has(permission)) {
              // F-R2 defense in depth: a bare declared permission id equal to
              // a self-tool name must never reach policy, namespaced or not.
              return finish({
                decision: "deny",
                reason: `Marshal Runtime permission is not supported: ${permission}.`,
                code: "permission_denied",
              });
            }
            // F-R2 + SF2-2: namespaced by prefix AND by the declaring
            // extension's identity (not the permission id verbatim) so a
            // declared permission id can never collide with — and silently
            // inherit session always-allow grants from — a real self-tool/
            // memory/code-intel policy tool name, NOR from a different
            // extension declaring the same permission id. Approval UX still
            // shows the permission id and the requesting extension in the name.
            const extensionPolicyToolName = `${EXTENSION_DECLARED_PERMISSION_POLICY_PREFIX}${declared.extensionId}:${permission}`;
            const decision = policyDecision(
              options.permissionPolicy,
              request.scope.sessionId,
              extensionPolicyToolName,
              request.input,
            );
            if (decision.decision !== "allow") return finish(decision);
            continue;
          }
        }
        return finish({
          decision: "deny",
          reason: `Marshal Runtime permission is not supported: ${permission}.`,
          code: "permission_denied",
        });
      }
      return finish({
        decision: "allow",
        reason: "Allowed by bounded Marshal Runtime authority.",
      });
    },
  };

  const catalog: MarshalRuntimeCatalogPort = {
    listTools: (sessionId) =>
      options.sessionManager
        .listSelfToolsForSession(sessionId)
        .filter((tool) => !RUNTIME_SELF_TOOL_NAME_SET.has(tool.name)),
    onToolsListed: options.onToolsListed,
    onToolInvoked: options.onToolInvoked,
    listSkills: (sessionId) =>
      options.sessionManager.listSkillsForSession(sessionId).filter((skill) => skill.enabled),
    getSkill: (sessionId, name) =>
      options.sessionManager.getSkillInstructionsForSession(name, sessionId),
    listWorkspaces: () => options.sessionManager.listWorkspacesForSelfTools(),
    async getSessionContext(sessionId, signal) {
      if (signal?.aborted) return null;
      const session = await options.sessionManager.getSessionScopeAsync(sessionId);
      if (signal?.aborted || !session) return null;
      return {
        id: session.id,
        name: session.name,
        ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}),
        ...(session.repoPath ? { repoPath: session.repoPath } : {}),
        ...(session.source ? { source: session.source } : {}),
      };
    },
  };

  return {
    authority,
    ...(options.approvalBroker
      ? { approval: createRuntimeApprovalPort(options.approvalBroker, options.permissionPolicy) }
      : {}),
    catalog,
    resolveScope,
  };
}
