import type {
  AgentRuntimeBindings,
  CapabilityInvocationResult,
  InvocationContext,
  RuntimeCallContext,
  RuntimeHostProviderSource,
  RuntimeResourceToolDescriptor,
  RuntimeResourceToolResult,
  RuntimeSearchResponse,
} from "@marshal/runtime";
import type { RuntimeResourceContent } from "@marshal/runtime";
import type {
  PermissionApprovalDecision,
  PermissionCheck,
  PermissionDecision,
  RuntimeExecutionReceipt,
  RuntimeModuleSourceReference,
} from "@marshal/runtime/core";
import type {
  RuntimeExtensionContractRepairRequest,
  RuntimeExtensionContractRepairResult,
  RuntimeExtensionInstallRequest,
  RuntimeExtensionIntegrity,
  RuntimeExtensionRecord,
} from "@marshal/runtime/extensions";

import type { RuntimeTool } from "../backend/runtime-contract";
import type { Skill } from "../skills";

export { MARSHAL_RUNTIME_DEFAULT_WORKSPACE } from "../../common/runtime-ui";

export const MARSHAL_RUNTIME_PERMISSION = Object.freeze({
  sessionRead: "marshal.session.read",
  workspaceRead: "marshal.workspace.read",
  skillRead: "marshal.skill.read",
  typescriptExecute: "runtime.inline_module.execute",
  moduleExecute: "runtime.module.execute",
  extensionList: "marshal.extension.list",
  extensionInstall: "marshal.extension.install",
  extensionUpdate: "marshal.extension.update",
  extensionEnable: "marshal.extension.enable",
  extensionDisable: "marshal.extension.disable",
  extensionRemove: "marshal.extension.remove",
  extensionConfigure: "marshal.extension.configure",
  extensionProvider: "marshal.extension.provider",
  extensionContractRepair: "marshal.extension.contract-repair",
  uiNotificationShow: "marshal.ui.notification.show",
  uiChatMessagePost: "marshal.ui.chat.message.post",
  uiChatCardShow: "marshal.ui.chat.card.show",
  uiApplicationOpen: "marshal.ui.application.open",
  uiApplicationUpdate: "marshal.ui.application.update",
  uiApplicationFocus: "marshal.ui.application.focus",
  uiApplicationClose: "marshal.ui.application.close",
  uiApplicationList: "marshal.ui.application.list",
  agentLaunch: "marshal.agent.launch",
  agentRead: "marshal.agent.read",
  agentMessage: "marshal.agent.message",
  agentCancel: "marshal.agent.cancel",
  brainLaunch: "marshal.brain.launch",
  brainRead: "marshal.brain.read",
  brainMessage: "marshal.brain.message",
  brainCancel: "marshal.brain.cancel",
  memoryStore: "marshal.memory.store",
  memoryRecall: "marshal.memory.recall",
  appRestart: "marshal.app.restart",
} as const);

export const MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX = "marshal.tool.invoke:";
export const MARSHAL_RUNTIME_BROWSER_PERMISSION_PREFIX = "marshal.browser.invoke:";

export interface MarshalRuntimeScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export interface ResolvedMarshalRuntimeScope extends MarshalRuntimeScope {
  readonly workspacePath: string;
}

export interface MarshalRuntimeAuthorityRequest {
  readonly scope: MarshalRuntimeScope;
  readonly capability: string;
  readonly permissions: readonly string[];
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeAuthorityPort {
  resolveScope(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<ResolvedMarshalRuntimeScope | null>;
  authorize(request: MarshalRuntimeAuthorityRequest): Promise<PermissionDecision>;
}

export interface MarshalRuntimeAuthorityDecisionEvent {
  readonly scope: MarshalRuntimeScope;
  readonly capability: string;
  readonly permissions: readonly string[];
  readonly decision: PermissionDecision;
}

export interface MarshalRuntimeDiagnosticEvent {
  readonly type: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MarshalRuntimeDiagnostics {
  onEvent(event: MarshalRuntimeDiagnosticEvent): void;
  onRuntimeObject?(kind: "kernel" | "extension-manager", instance: object): void;
}

export interface MarshalRuntimeSessionContext {
  readonly id: string;
  readonly name: string;
  readonly workspaceName?: string;
  readonly repoPath?: string;
  readonly source?: string;
}

export interface MarshalRuntimeWorkspaceContext {
  readonly name: string;
  readonly path: string;
}

export interface MarshalRuntimeCatalogPort {
  listTools(sessionId: string): readonly RuntimeTool[];
  onToolsListed?(tools: readonly RuntimeTool[]): void;
  onToolInvoked?(tool: RuntimeTool): void;
  listSkills(
    sessionId: string,
    context?: InvocationContext,
  ): readonly Skill[] | Promise<readonly Skill[]>;
  getSkill(
    sessionId: string,
    name: string,
    context?: InvocationContext,
  ):
    | { readonly instructions: string; readonly resourceDir: string | null }
    | null
    | Promise<{ readonly instructions: string; readonly resourceDir: string | null } | null>;
  listWorkspaces(
    context?: InvocationContext,
  ): readonly MarshalRuntimeWorkspaceContext[] | Promise<readonly MarshalRuntimeWorkspaceContext[]>;
  getSessionContext(
    sessionId: string,
    signal?: AbortSignal,
    context?: InvocationContext,
  ): Promise<MarshalRuntimeSessionContext | null>;
}

export type MarshalRuntimeLifecycleState =
  | "stopped"
  | "starting"
  | "running"
  | "disposing"
  | "disposed"
  | "failed";

export interface MarshalRuntimePackageMetadata {
  readonly name: "@marshal/runtime";
  readonly version: string;
  readonly entrypoint: string;
  readonly entrySha256: string;
}

export type MarshalRuntimeFactory = (
  options: Parameters<typeof import("@marshal/runtime").createAgentRuntime>[0] & {
    readonly resolveWorkspace?: (
      context: Readonly<RuntimeCallContext>,
    ) => MarshalRuntimeHostWorkspaceScope | Promise<MarshalRuntimeHostWorkspaceScope>;
  },
) => Promise<AgentRuntimeBindings>;

export interface MarshalRuntimeExtensionDiscoveryDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface MarshalRuntimeExtensionDiscoveryCandidate {
  readonly packageRoot: string;
  readonly status: "installable" | "invalid" | "unbuilt" | "unreadable";
  readonly identity?: string;
  readonly version?: string;
  readonly installation?: {
    readonly script: string;
    readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  };
  readonly catalogEntry?: { readonly id: string };
  readonly diagnostics: readonly MarshalRuntimeExtensionDiscoveryDiagnostic[];
}

export interface MarshalRuntimeExtensionDiscoverySnapshot {
  readonly revision: number;
  readonly status: "ready" | "error";
  readonly scannedAt: string;
  readonly candidates: readonly MarshalRuntimeExtensionDiscoveryCandidate[];
  readonly diagnostics: readonly MarshalRuntimeExtensionDiscoveryDiagnostic[];
}

export interface MarshalRuntimeExtensionDiscovery {
  snapshot(): MarshalRuntimeExtensionDiscoverySnapshot;
  subscribe(listener: (snapshot: MarshalRuntimeExtensionDiscoverySnapshot) => void): {
    dispose(): void;
  };
  refresh(): Promise<MarshalRuntimeExtensionDiscoverySnapshot>;
  dispose(): Promise<void>;
}

export interface MarshalRuntimeHostWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface MarshalRuntimePermissionApproval {
  requestApproval(
    check: PermissionCheck,
    missingPermissions: readonly string[],
    presentation?: {
      readonly reason: string;
      readonly prompt?: string;
    },
  ):
    | Omit<PermissionApprovalDecision, "decision">
    | Promise<Omit<PermissionApprovalDecision, "decision">>;
  verifyApproval(
    approval: Readonly<Record<string, unknown>>,
    check: PermissionCheck,
  ):
    | {
        readonly approved: boolean;
        readonly permissions?: readonly string[];
        readonly reason?: string;
      }
    | Promise<{
        readonly approved: boolean;
        readonly permissions?: readonly string[];
        readonly reason?: string;
      }>;
}

export type MarshalRuntimeApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "missing";

export interface MarshalRuntimeApprovalPort {
  readonly permissionApproval: MarshalRuntimePermissionApproval;
  status(approvalId: string): MarshalRuntimeApprovalStatus;
  cancel(approvalId: string): void;
  cancelRequest(sessionId: string, requestId: string): void;
  dispose(): void;
}

export interface MarshalRuntimeModule {
  readonly createAgentRuntime: MarshalRuntimeFactory;
  readonly createRuntimeBuiltinsSource: (
    options: Parameters<typeof import("@marshal/runtime").createRuntimeBuiltinsSource>[0],
  ) => RuntimeHostProviderSource;
  readonly createRuntimeNativeExtensionDiscoveryService?: (options: {
    readonly roots: readonly string[];
    readonly watch?: boolean;
    readonly debounceMs?: number;
  }) => Promise<MarshalRuntimeExtensionDiscovery>;
}

export interface MarshalRuntimeStatus {
  readonly lifecycle: MarshalRuntimeLifecycleState;
  readonly runtimePackage: MarshalRuntimePackageMetadata;
}

export type MarshalRuntimeApiErrorCode =
  | "aborted"
  | "approval-required"
  | "idempotency-capacity"
  | "idempotency-conflict"
  | "invalid-request"
  | "not-found"
  | "permission-denied"
  | "runtime-unavailable"
  | "operation-failed";

export interface MarshalRuntimeApiError {
  readonly code: MarshalRuntimeApiErrorCode;
  readonly message: string;
  readonly approval?: PermissionApprovalDecision;
}

export type MarshalRuntimeApiResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly receipts: readonly RuntimeExecutionReceipt[];
    }
  | {
      readonly ok: false;
      readonly error: MarshalRuntimeApiError;
      readonly receipts: readonly RuntimeExecutionReceipt[];
    };

export interface MarshalRuntimeSearchRequest extends MarshalRuntimeScope {
  readonly query?: string;
  readonly name?: string;
  readonly detail?: "summary" | "full";
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly catalogId?: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeReadResourceRequest extends MarshalRuntimeScope {
  readonly uri: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeInvokeRequest extends MarshalRuntimeScope {
  readonly capability: string;
  readonly input?: unknown;
  readonly idempotencyKey: string;
  readonly approval?: Readonly<Record<string, unknown>>;
  readonly origin?: "runtime-ui";
  /**
   * "forbid": never open an interactive approval prompt for this invocation —
   * a capability that would prompt is denied fail-closed instead. For
   * automatic/background callers (UI polling); an explicit user action must
   * omit this so the normal approval flow applies.
   */
  readonly approvalPolicy?: "forbid";
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeTypeScriptRequest extends MarshalRuntimeScope {
  readonly source: string;
  readonly input?: unknown;
  readonly timeoutMs?: number;
  readonly idempotencyKey: string;
  /** Apply agent-authoring conveniences (body-only source, auto globals, workspace cwd). */
  readonly agentAuthoring?: boolean;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeModuleRequest extends MarshalRuntimeScope {
  readonly module: RuntimeModuleSourceReference;
  readonly input?: unknown;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeRenderToolListRequest extends MarshalRuntimeScope {
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeRenderToolInvokeRequest extends MarshalRuntimeScope {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionListRequest extends MarshalRuntimeScope {
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionInstallRequest
  extends MarshalRuntimeScope, RuntimeExtensionInstallRequest {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeLocalExtensionInstallRequest extends MarshalRuntimeScope {
  readonly packageRoot: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionUpdateRequest extends MarshalRuntimeScope {
  readonly identity: string;
  readonly packageRoot: string;
  readonly integrity?: RuntimeExtensionIntegrity;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionStateRequest extends MarshalRuntimeScope {
  readonly identity: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionConfigurationRequest extends MarshalRuntimeExtensionStateRequest {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface MarshalRuntimeExtensionProviderRequest extends MarshalRuntimeExtensionStateRequest {
  readonly serviceId: string;
  readonly providerId?: string;
}

export interface MarshalRuntimeExtensionContractRepairRequest extends MarshalRuntimeScope {
  readonly request: RuntimeExtensionContractRepairRequest;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeExtensionRemoval {
  readonly identity: string;
  readonly removed: true;
}

export interface MarshalRuntimeInvocationValue {
  readonly output: unknown;
  readonly result: CapabilityInvocationResult;
}

export interface MarshalRuntimeApi {
  search(
    request: MarshalRuntimeSearchRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeSearchResponse>>;
  invoke(
    request: MarshalRuntimeInvokeRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>>;
  executeTypeScript(
    request: MarshalRuntimeTypeScriptRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>>;
  executeModule(
    request: MarshalRuntimeModuleRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>>;
  listRenderTools(
    request: MarshalRuntimeRenderToolListRequest,
  ): Promise<MarshalRuntimeApiResult<readonly RuntimeResourceToolDescriptor[]>>;
  invokeRenderTool(
    request: MarshalRuntimeRenderToolInvokeRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeResourceToolResult | undefined>>;
  listExtensions(
    request: MarshalRuntimeExtensionListRequest,
  ): Promise<MarshalRuntimeApiResult<readonly RuntimeExtensionRecord[]>>;
  installExtension(
    request: MarshalRuntimeExtensionInstallRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  installLocalExtension(
    request: MarshalRuntimeLocalExtensionInstallRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  configureExtension(
    request: MarshalRuntimeExtensionConfigurationRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  setProvider(
    request: MarshalRuntimeExtensionProviderRequest & { readonly providerId: string },
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  clearProvider(
    request: MarshalRuntimeExtensionProviderRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  repairContractConflict(
    request: MarshalRuntimeExtensionContractRepairRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionContractRepairResult>>;
  readResource(
    request: MarshalRuntimeReadResourceRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeResourceContent>>;
  updateExtension(
    request: MarshalRuntimeExtensionUpdateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  enableExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  disableExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>>;
  removeExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeExtensionRemoval>>;
  getStatus(): MarshalRuntimeStatus;
}
