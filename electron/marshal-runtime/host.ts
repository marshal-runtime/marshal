import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  createNodeBuiltinModuleMap,
  createRuntimeHostMaterializer,
  createRuntimeNativeExtensionCatalogSource,
  createRuntimeExtensionCatalogProvider,
  createRuntimeExtensionResourcePort,
  projectRuntimeExtensionCatalogEntry,
  RuntimeCompositionRegistry,
  type RuntimeCompositionServiceDescriptor,
  type RuntimeHostMaterializer,
} from "@marshal/runtime";
import type {
  AgentRuntimeBindings,
  InvocationContext,
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeServiceBindingHandle,
  RuntimeServiceContainer,
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeResourceToolDescriptor,
  RuntimeResourceToolResult,
  RuntimeSearchRequest,
  RuntimeHostProviderSource,
} from "@marshal/runtime";
import type { PermissionCheck, PermissionDecision } from "@marshal/runtime/core";
import {
  JsonFileRuntimeExtensionStateStore,
  LocalRuntimeExtensionPackageLoader,
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_CATALOG_SOURCE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  RuntimeExtensionCatalog,
  RuntimeExtensionManager,
  RuntimeExtensionUiPublicationRegistry,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionContractRepairRequest,
  type RuntimeExtensionContractRepairResult,
  RuntimeExtensionInstallRequest,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionRecord,
  type RuntimeExtensionStateStore,
  type RuntimeExtensionStoredRecord,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";

import {
  RUNTIME_UI_EXTENSION_HOST_PLACEMENTS,
  type RuntimeUiAuthorityRequest,
  type RuntimeUiPermission,
  type RuntimeUiScope,
  type RuntimeUiOwnerIdentity,
} from "../../common/runtime-ui";
import type { MemoryProviderRegistrationService } from "../active-memory-store";
import type { OverlayReviewPackageHost } from "../overlay-review";
import { captureWorkspaceBinding } from "../workspace-role-identity";
import type { MarshalRuntimeAgentPort } from "./agent-orchestration";
import {
  AGENTIC_BROWSER_EXTENSION_IDENTITY,
  createMarshalAgenticBrowserRuntimeHostModule,
} from "./agentic-browser-runtime-host";
import { BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY } from "./agentic-debugger-extension";
import {
  AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE,
  isAgenticDebuggerNativeProviderId,
  unavailableDebuggerHostAdapter,
} from "./agentic-debugger-runtime-host";
import { RuntimeApplicationAuthority, stripApplicationAuthority } from "./application-authority";
import type { MarshalRuntimeBrainPort } from "./brain-provider";
import type { MarshalRuntimeBrowserCommandExecutorPort } from "./browser-command-executor";
import {
  MARSHAL_RUNTIME_PERMISSION,
  type MarshalRuntimeAuthorityPort,
  type MarshalRuntimeAuthorityRequest,
  type MarshalRuntimeApprovalPort,
  type MarshalRuntimeApprovalStatus,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeDiagnostics,
  type MarshalRuntimeExtensionDiscovery,
  type MarshalRuntimeHostWorkspaceScope,
  type MarshalRuntimeLifecycleState,
  type MarshalRuntimeScope,
  type MarshalRuntimeStatus,
  type ResolvedMarshalRuntimeScope,
} from "./contracts";
import type { RuntimeExtensionSecrets } from "./extension-secrets";
import {
  createFirstPartyExtensionPackageLoader,
  type ResolvedFirstPartyExtension,
} from "./first-party-extension-catalog";
import { LIFECYCLE_PIN_METADATA_KEY, LifecycleWorkspacePins } from "./lifecycle-workspace-pins";
import { resolveRuntimeExtensionDiscoveryRoots } from "./local-source";
import {
  createMarshalHostProviderSource,
  createRuntimeAgentService,
  createRuntimeBrainService,
  createRuntimeCatalogService,
  createRuntimeMemoryService,
} from "./providers";
import type { MarshalRuntimeMemoryPort } from "./runtime-memory";
import {
  type MarshalRuntimePackageLoader,
  PinnedMarshalRuntimePackageLoader,
  type RuntimePackageLocation,
} from "./runtime-package-loader";
import { resolveRuntimeWorkspaceIds } from "./runtime-workspace-identity";
import { MarshalRuntimeCompositionServices, MarshalServiceSymbols } from "./service-symbols";
import type {
  MarshalAuthorityService,
  MarshalBrowserExecutionService,
  MarshalUiDeliveryService,
  MarshalUiReviewService,
} from "./service-symbols";
import { TRUSTED_TYPESCRIPT_IMPORT_POLICY } from "./trusted-typescript";
import {
  MarshalRuntimeUiController,
  type RuntimeUiAuthority,
  type RuntimeUiClock,
  type RuntimeUiControllerLimits,
  type RuntimeUiDocumentAccessIssuer,
  type RuntimeUiChatCardDelivery,
  type RuntimeUiChatMessageDelivery,
  type RuntimeUiDeliveryPorts,
  type RuntimeUiNotificationDelivery,
} from "./ui-controller";

// F-DEPLOY-4: exported so production-adapter.ts's extension-declared-permission
// resolver can scope MarshalRuntimeHost.search() by workspace the same way
// ProductionMarshalRuntimeApi.search() does (see api.ts's context() helper) —
// resolveRuntimeWorkspace() below throws without this metadata key present.
export const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";
const MARSHAL_HOST_PROVIDER_PREFIX = "marshal.host.";

async function ensureBundledExtension(
  lifecycle: RuntimeExtensionLifecycleService,
  extension: {
    readonly identity: string;
    readonly version: string;
    readonly request: RuntimeExtensionInstallRequest;
    readonly configuration?: RuntimeExtensionConfiguration;
  },
): Promise<RuntimeExtensionRecord> {
  const installed = lifecycle.get(extension.identity);
  const needsRefresh =
    installed !== undefined &&
    (installed.version !== extension.version ||
      installed.request.packageRoot !== extension.request.packageRoot ||
      installed.integrity.value !== extension.request.integrity.value ||
      installed.integrity.domain !== extension.request.integrity.domain);
  const installOptions = extension.configuration ? { configuration: extension.configuration } : {};

  if (installed === undefined) {
    await lifecycle.install(extension.request, installOptions);
  } else if (needsRefresh) {
    await lifecycle.update(extension.identity, extension.request, installOptions);
  }

  const current = lifecycle.get(extension.identity);
  if (!current) {
    throw new Error(`Bundled runtime extension ${extension.identity} was not installed.`);
  }
  return current;
}

async function ensureRequiredBundledExtension(
  lifecycle: RuntimeExtensionLifecycleService,
  extension: {
    readonly identity: string;
    readonly version: string;
    readonly request: RuntimeExtensionInstallRequest;
    readonly configuration?: RuntimeExtensionConfiguration;
  },
  diagnosticName: string,
  emitDiagnostic: (type: string, details?: Readonly<Record<string, unknown>>) => void,
): Promise<void> {
  emitDiagnostic(`${diagnosticName}.install.started`, {
    identity: extension.identity,
    version: extension.version,
  });
  try {
    await ensureBundledExtension(lifecycle, extension);
  } catch (error) {
    emitDiagnostic(`${diagnosticName}.install.failed`, {
      identity: extension.identity,
      version: extension.version,
      ...diagnosticError(error),
    });
    throw error;
  }
  emitDiagnostic(`${diagnosticName}.install.completed`, {
    identity: extension.identity,
    version: extension.version,
  });
}

async function reconcileBundledExtensionState(
  stateStore: RuntimeExtensionStateStore,
  extension: {
    readonly identity: string;
    readonly version: string;
    readonly request: RuntimeExtensionInstallRequest;
  },
): Promise<void> {
  const records = await stateStore.load();
  const installed = records.find(({ identity }) => identity === extension.identity);
  if (!installed) return;
  if (
    installed.version === extension.version &&
    installed.request.packageRoot === extension.request.packageRoot &&
    installed.request.integrity.algorithm === extension.request.integrity.algorithm &&
    installed.request.integrity.domain === extension.request.integrity.domain &&
    installed.request.integrity.value === extension.request.integrity.value
  ) {
    return;
  }
  await stateStore.save(
    records.map(
      (record): RuntimeExtensionStoredRecord =>
        record.identity === extension.identity
          ? {
              ...record,
              identity: extension.identity,
              version: extension.version,
              request: extension.request,
            }
          : record,
    ),
  );
}

function registerHostService<T>(
  registry: RuntimeCompositionRegistry,
  service: RuntimeCompositionServiceDescriptor<T>,
  serviceName: string,
  value: T,
): Promise<RuntimeServiceBindingHandle> {
  return registry.registerProvider({
    provider: {
      id: `${MARSHAL_HOST_PROVIDER_PREFIX}${serviceName}`,
      service,
      contract: service.contract,
    },
    binding: { useValue: value },
  });
}

function contextScope(context: InvocationContext | undefined): MarshalRuntimeScope | null {
  const sessionId = context?.scope?.sessionId?.trim();
  const workspaceName = context?.metadata?.[WORKSPACE_METADATA_KEY];
  return sessionId && typeof workspaceName === "string" && workspaceName.trim()
    ? { sessionId, workspaceName: workspaceName.trim() }
    : null;
}

function abortSignal(context: InvocationContext | undefined): AbortSignal | undefined {
  const signal = context?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function invalidRuntimeWorkspace(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_scope" });
}

async function resolveRuntimeWorkspace(
  services: RuntimeServiceContainer,
  context: Readonly<RuntimeCallContext>,
): Promise<MarshalRuntimeHostWorkspaceScope> {
  const sessionId = context.sessionId?.trim();
  const workspaceName = context.metadata?.[WORKSPACE_METADATA_KEY];
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw invalidRuntimeWorkspace(
      "Marshal Runtime workspace resolution requires a session and registered workspace.",
    );
  }
  throwIfAborted(context.signal);
  const requested = { sessionId, workspaceName: workspaceName.trim() };
  const resolved = await services
    .get(MarshalServiceSymbols.authority)
    .resolveScope({}, runtimeServiceContext(requested, context.signal));
  throwIfAborted(context.signal);
  if (
    !resolved ||
    resolved.sessionId !== requested.sessionId ||
    resolved.workspaceName.toLowerCase() !== requested.workspaceName.toLowerCase() ||
    !path.isAbsolute(resolved.workspacePath)
  ) {
    throw invalidRuntimeWorkspace(
      "Marshal Runtime session workspace is unavailable or no longer registered.",
    );
  }
  let workspace: ReturnType<typeof captureWorkspaceBinding>;
  try {
    workspace = captureWorkspaceBinding(requested.workspaceName, resolved.workspacePath);
  } catch {
    throw invalidRuntimeWorkspace(
      "Marshal Runtime session workspace is unavailable or no longer registered.",
    );
  }
  throwIfAborted(context.signal);
  const ids = await resolveRuntimeWorkspaceIds(workspace.canonicalPath, workspace.binding.identity);
  throwIfAborted(context.signal);
  return {
    workspacePath: workspace.canonicalPath,
    ...ids,
  };
}

export function publicAuthority(port: MarshalRuntimeAuthorityPort): MarshalAuthorityService {
  return {
    resolveScope: (_input, context) => {
      const scope = contextScope(context);
      return scope ? port.resolveScope(scope, abortSignal(context)) : Promise.resolve(null);
    },
    authorize: (input, context) => {
      const scope = contextScope(context);
      if (!scope) {
        throw new Error("Marshal authority authorization requires invocation context.");
      }
      return port.authorize({
        scope,
        capability: input.capability,
        permissions: input.permissions,
        input: input.input,
        signal: abortSignal(context),
      });
    },
  };
}

function publicBrowser(
  executor: MarshalRuntimeBrowserCommandExecutorPort,
  services: RuntimeServiceContainer,
): MarshalBrowserExecutionService {
  return {
    execute: async (input, context) => {
      const scope = contextScope(context);
      if (!scope) throw new Error("Marshal browser execution requires invocation context.");
      const resolved = await services
        .get(MarshalServiceSymbols.authority)
        .resolveScope({}, runtimeServiceContext(scope, abortSignal(context)));
      if (!resolved) throw new Error("Marshal browser execution scope was denied.");
      return executor.execute({
        command: input.command,
        input: input.input,
        context: input.context,
        scope: resolved,
        signal: abortSignal(context),
      });
    },
    dispose: () => executor.dispose(),
  };
}

export function publicUiDelivery(delivery: RuntimeUiDeliveryPorts): MarshalUiDeliveryService {
  const scopedDelivery = (
    input: RuntimeUiNotificationDelivery | RuntimeUiChatMessageDelivery | RuntimeUiChatCardDelivery,
    context: InvocationContext | undefined,
  ) => {
    const scope = contextScope(context);
    if (
      !scope ||
      input.owner.sessionId !== scope.sessionId ||
      input.owner.workspaceName !== scope.workspaceName
    ) {
      throw new Error("Marshal UI delivery owner does not match invocation scope.");
    }
    return scope;
  };
  return {
    notification: (input, context) => {
      scopedDelivery(input, context);
      return delivery.notification(input, abortSignal(context));
    },
    chatMessage: (input, context) => {
      scopedDelivery(input, context);
      return delivery.chatMessage(input, abortSignal(context));
    },
    chatCard: (input, context) => {
      scopedDelivery(input, context);
      return delivery.chatCard(input, abortSignal(context));
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("Marshal Runtime operation was aborted."), {
    code: "aborted",
  });
}

export class MarshalRuntimeHostStartupError extends Error {
  readonly code = "runtime_unavailable";

  constructor(cause: unknown) {
    super("Marshal Runtime host failed to start.", { cause });
    this.name = "MarshalRuntimeHostStartupError";
  }
}

async function decidePermission(
  authority: MarshalAuthorityService,
  approval: MarshalRuntimeApprovalPort | undefined,
  check: PermissionCheck,
): Promise<PermissionDecision> {
  const scope = contextScope(check.context);
  if (!scope) {
    return {
      decision: "deny",
      reason: "Marshal Runtime permission checks require a session and workspace scope.",
      code: "invalid_scope",
    };
  }
  const decision = await authority.authorize(
    {
      capability: check.capability.name,
      permissions: check.requirements.map((requirement) => requirement.permission),
      input: check.request.input,
    },
    check.context,
  );
  if (decision.decision !== "approval" || !approval) return decision;
  const approvalProof = check.context.approval;
  const approvalId =
    approvalProof && typeof approvalProof.approvalId === "string" && approvalProof.approvalId.trim()
      ? approvalProof.approvalId
      : undefined;
  if (approvalId && approvalProof) {
    const verified = await approval.permissionApproval.verifyApproval(approvalProof, check);
    return verified.approved
      ? {
          decision: "allow",
          reason: verified.reason,
          ...(verified.permissions ? { grants: verified.permissions } : {}),
        }
      : {
          decision: "deny",
          reason: verified.reason ?? "Marshal Runtime approval was rejected.",
          code: "permission_denied",
        };
  }
  const requested = await approval.permissionApproval.requestApproval(
    check,
    check.requirements.map((requirement) => requirement.permission),
    {
      reason: decision.reason,
      ...(decision.prompt ? { prompt: decision.prompt } : {}),
    },
  );
  return { decision: "approval", ...requested };
}

const UI_AUTHORITY = {
  "ui.open": {
    capability: "ui.application.open",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationOpen,
  },
  "ui.update": {
    capability: "ui.application.update",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationUpdate,
  },
  "ui.focus": {
    capability: "ui.application.focus",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationFocus,
  },
  "ui.close": {
    capability: "ui.application.close",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationClose,
  },
  "ui.list": {
    capability: "ui.application.list",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationList,
  },
  "ui.snapshot": {
    capability: "ui.application.list",
    permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationList,
  },
  "ui.notification.show": {
    capability: "ui.notification.show",
    permission: MARSHAL_RUNTIME_PERMISSION.uiNotificationShow,
  },
  "ui.chat.message.post": {
    capability: "ui.chat.message.post",
    permission: MARSHAL_RUNTIME_PERMISSION.uiChatMessagePost,
  },
  "ui.chat.card.show": {
    capability: "ui.chat.card.show",
    permission: MARSHAL_RUNTIME_PERMISSION.uiChatCardShow,
  },
} as const satisfies Record<
  RuntimeUiPermission,
  { readonly capability: string; readonly permission: string }
>;

function runtimeServiceContext(scope: RuntimeUiScope, signal?: AbortSignal): InvocationContext {
  return {
    principal: { id: "marshal-runtime-host", kind: "agent" },
    scope: {
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      workspaceName: scope.workspaceName,
      ...(scope.applicationScope ? { applicationScope: scope.applicationScope } : {}),
    },
    ...(signal ? { signal } : {}),
    metadata: {
      [WORKSPACE_METADATA_KEY]: scope.workspaceName,
      ...(scope.applicationScope ? { marshalApplicationScope: scope.applicationScope } : {}),
    },
  };
}

function createRuntimeUiAuthority(
  services: RuntimeServiceContainer,
  ensureServices: () => Promise<void>,
  resolvePersistentWorkspace?: (scope: RuntimeUiScope) => Promise<string | null>,
): RuntimeUiAuthority {
  return async (request: RuntimeUiAuthorityRequest, signal?: AbortSignal) => {
    await ensureServices();
    if (request.scope.applicationScope) {
      const workspace = await resolvePersistentWorkspace?.(request.scope);
      if (!workspace || !path.isAbsolute(workspace))
        return { allowed: false, reason: "Persistent application workspace is unavailable." };
      if (request.owner) {
        const publication = services.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
        const applications = await publication.listApplications(
          runtimeServiceContext(request.scope, signal),
        );
        if (
          !applications.some(
            (application) =>
              application.ownerId === request.owner?.extensionId &&
              application.id === request.owner?.applicationId,
          )
        ) {
          return { allowed: false, reason: "The extension application is no longer published." };
        }
      }
      return { allowed: true, scope: request.scope };
    }
    const authority = services.get(MarshalServiceSymbols.authority);
    const resolved = await authority.resolveScope({}, runtimeServiceContext(request.scope, signal));
    if (!resolved) {
      return {
        allowed: false,
        reason: "Marshal Runtime UI session or workspace scope was denied.",
      };
    }

    const requirement = UI_AUTHORITY[request.permission];
    const decision = await authority.authorize(
      {
        capability: requirement.capability,
        permissions: [requirement.permission],
        input: {
          ...(request.owner ? { owner: request.owner } : {}),
          ...(request.instanceId ? { instanceId: request.instanceId } : {}),
        },
      },
      runtimeServiceContext(request.scope, signal),
    );
    return decision.decision === "allow"
      ? { allowed: true, scope: request.scope }
      : { allowed: false, reason: decision.reason };
  };
}

function createRuntimeUiDelivery(
  services: RuntimeServiceContainer,
  ensureServices: () => Promise<void>,
  persistentDelivery?: RuntimeUiDeliveryPorts,
): RuntimeUiDeliveryPorts {
  return {
    notification: async (delivery, signal) => {
      await ensureServices();
      if (delivery.owner.applicationScope && persistentDelivery)
        return persistentDelivery.notification(delivery, signal);
      return services
        .get(MarshalServiceSymbols.uiDelivery)
        .notification(delivery, runtimeServiceContext(delivery.owner, signal));
    },
    chatMessage: async (delivery, signal) => {
      await ensureServices();
      return services
        .get(MarshalServiceSymbols.uiDelivery)
        .chatMessage(delivery, runtimeServiceContext(delivery.owner, signal));
    },
    chatCard: async (delivery, signal) => {
      await ensureServices();
      return services
        .get(MarshalServiceSymbols.uiDelivery)
        .chatCard(delivery, runtimeServiceContext(delivery.owner, signal));
    },
  };
}

function callTimeAuthorityPort(services: RuntimeServiceContainer): MarshalRuntimeAuthorityPort {
  return {
    resolveScope: (scope, signal) =>
      services
        .get(MarshalServiceSymbols.authority)
        .resolveScope({}, runtimeServiceContext(scope, signal)),
    authorize: (request) =>
      services.get(MarshalServiceSymbols.authority).authorize(
        {
          capability: request.capability,
          permissions: request.permissions,
          input: request.input,
        },
        runtimeServiceContext(request.scope, request.signal),
      ),
  };
}

function callTimeBrowserExecutor(
  services: RuntimeServiceContainer,
): MarshalRuntimeBrowserCommandExecutorPort {
  return {
    execute: async (request) => {
      const result = await services.get(MarshalServiceSymbols.browserExecution).execute(
        {
          command: request.command,
          input: request.input,
          context: request.context,
        },
        runtimeServiceContext(request.scope, request.signal),
      );
      return result;
    },
    dispose: () => services.get(MarshalServiceSymbols.browserExecution).dispose(),
  };
}

const LOCAL_EXTENSION_IMPORT_ERROR = "Local extension packages cannot contain symbolic links.";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path
      .normalize(value)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

function isSameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function runtimeExtensionDiscoveryRoots(
  location: RuntimePackageLocation,
  trustedExtensionRoot: string,
): Promise<readonly string[]> {
  return resolveRuntimeExtensionDiscoveryRoots(location, trustedExtensionRoot);
}

async function importLocalExtension(source: string, trustedRoot: string): Promise<string> {
  const canonicalTrustedRoot = await realpath(trustedRoot);
  const canonicalSource = await realpath(source);
  if (isSameOrInside(canonicalTrustedRoot, canonicalSource)) return canonicalSource;
  if (isSameOrInside(canonicalSource, canonicalTrustedRoot)) {
    throw new Error(
      "The selected local extension directory cannot contain the trusted extension root.",
    );
  }
  for (const requiredFile of ["package.json", "runtime-extension.json"]) {
    const requiredPath = path.join(canonicalSource, requiredFile);
    // Validate both required files deterministically before copying any package content.
    // eslint-disable-next-line no-await-in-loop -- sequential validation keeps the reported missing file stable
    const requiredStat = await lstat(requiredPath).catch(() => null);
    if (!requiredStat?.isFile() || requiredStat.isSymbolicLink()) {
      throw new Error(`The selected local extension is missing a regular ${requiredFile} file.`);
    }
  }

  const destination = path.join(canonicalTrustedRoot, `.local-extension-${randomUUID()}`);
  try {
    await copyLocalExtensionTree(source, destination);
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Every local install/update imports a fresh `.local-extension-<uuid>` copy;
 * without this the superseded copies accumulate forever (45 copies of one
 * extension were found on a dev profile).
 */
async function removeSupersededLocalCopy(
  previousRoot: string | undefined,
  currentRoot: string,
  trustedRoot: string,
): Promise<void> {
  if (!previousRoot || samePath(previousRoot, currentRoot)) return;
  const resolved = path.resolve(previousRoot);
  if (
    path.dirname(resolved) !== path.resolve(trustedRoot) ||
    !path.basename(resolved).startsWith(".local-extension-")
  ) {
    return;
  }
  await rm(resolved, { recursive: true, force: true });
}

async function copyLocalExtensionTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error(LOCAL_EXTENSION_IMPORT_ERROR);
  if (!sourceStat.isDirectory()) {
    throw new Error("The selected local extension path is not a directory.");
  }
  if (!samePath(await realpath(source), path.resolve(source))) {
    throw new Error(LOCAL_EXTENSION_IMPORT_ERROR);
  }
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const sourceChild = path.join(source, entry.name);
    const destinationChild = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop -- bounded sequential copying avoids import-time I/O bursts
      await copyLocalExtensionTree(sourceChild, destinationChild);
    } else if (entry.isFile()) {
      // eslint-disable-next-line no-await-in-loop -- preserve deterministic traversal and partial-copy cleanup
      await copyFile(sourceChild, destinationChild);
    } else {
      throw new Error(LOCAL_EXTENSION_IMPORT_ERROR);
    }
  }
}

export interface MarshalRuntimeHostOptions {
  readonly applicationAuthority?: RuntimeApplicationAuthority;
  readonly extensionSecrets?: RuntimeExtensionSecrets;
  readonly onApplicationInvalidated?: (owner: RuntimeUiOwnerIdentity) => Promise<void>;
  readonly resolveApplicationWorkspace?: (scope: RuntimeUiScope) => Promise<string | null>;
  readonly resolveDelegationIdentity?: (
    sessionId: string,
  ) => Promise<string | { delegationId: string; taskController?: string } | undefined>;
  readonly location: RuntimePackageLocation;
  readonly hostWorkspacePath: string;
  readonly protectedLifecycleResultRoot: string;
  readonly worktreeRoot: string;
  readonly trustedExtensionRoot: string;
  readonly authority: MarshalRuntimeAuthorityPort;
  readonly approval?: MarshalRuntimeApprovalPort;
  readonly catalog: MarshalRuntimeCatalogPort;
  readonly agents?: MarshalRuntimeAgentPort;
  readonly brain?: MarshalRuntimeBrainPort;
  readonly memory?: MarshalRuntimeMemoryPort;
  readonly memoryProviderRegistry?: MemoryProviderRegistrationService;
  readonly ui?: {
    readonly delivery: RuntimeUiDeliveryPorts;
    readonly clock?: RuntimeUiClock;
    readonly limits?: RuntimeUiControllerLimits;
    readonly issueDocumentAccess?: RuntimeUiDocumentAccessIssuer;
    readonly overlayReview?: MarshalUiReviewService & OverlayReviewPackageHost;
  };
  readonly packageLoader?: MarshalRuntimePackageLoader;
  readonly additionalProviderSources?: readonly RuntimeHostProviderSource[];
  readonly nodeExecutable?: string;
  /** Enables full-Node TypeScript imports for authored modules. See trusted-typescript.ts. */
  readonly trustedTypeScript?: boolean;
  readonly startupDelayMs?: number;
  readonly agenticBrowser?: {
    readonly executor: MarshalRuntimeBrowserCommandExecutorPort;
  };
  readonly firstPartyExtensions?: readonly ResolvedFirstPartyExtension[];
  readonly serviceContainer: RuntimeServiceContainer;
  readonly compositionRegistry?: RuntimeCompositionRegistry;
  readonly ownedServiceBindings?: Promise<readonly RuntimeServiceBindingHandle[]>;
  readonly diagnostics?: MarshalRuntimeDiagnostics;
}

export class MarshalRuntimeHost {
  private readonly loader: MarshalRuntimePackageLoader;
  private readonly serviceContainer: RuntimeServiceContainer;
  private readonly compositionRegistry: RuntimeCompositionRegistry;
  readonly ui: MarshalRuntimeUiController | null;
  private lifecycle: MarshalRuntimeLifecycleState = "stopped";
  private bindings: AgentRuntimeBindings | null = null;
  private extensionManager: RuntimeExtensionManager | null = null;
  private extensionOperationQueue: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private readonly lifecyclePins = new LifecycleWorkspacePins<MarshalRuntimeHostWorkspaceScope>();
  private blockedStartup: MarshalRuntimeHostStartupError | null = null;
  private runtimeLifecycleSubscription: { dispose(): void } | null = null;
  private serviceBindingHandles: RuntimeServiceBindingHandle[] = [];
  private defaultServicesReady: Promise<void> | null = null;
  private extensionMaterializer: RuntimeHostMaterializer | null = null;
  private extensionDiscovery: MarshalRuntimeExtensionDiscovery | null = null;

  constructor(private readonly options: MarshalRuntimeHostOptions) {
    this.serviceContainer = options.serviceContainer;
    this.compositionRegistry =
      options.compositionRegistry ??
      new RuntimeCompositionRegistry({
        container: this.serviceContainer,
      });
    this.loader =
      options.packageLoader ??
      new PinnedMarshalRuntimePackageLoader({ location: options.location });
    void this.ensureDefaultServices().catch(() => undefined);
    this.ui = options.ui
      ? new MarshalRuntimeUiController(
          options.ui.clock ?? Date.now,
          createRuntimeUiAuthority(
            this.serviceContainer,
            () => this.ensureDefaultServices(),
            options.resolveApplicationWorkspace,
          ),
          createRuntimeUiDelivery(
            this.serviceContainer,
            () => this.ensureDefaultServices(),
            options.ui.delivery,
          ),
          options.ui.limits,
          options.ui.issueDocumentAccess,
        )
      : null;
    this.emitDiagnostic("host.constructed");
  }

  start(): Promise<void> {
    if (this.lifecycle === "disposed" || this.lifecycle === "disposing") {
      return Promise.reject(runtimeUnavailable("Marshal Runtime host is disposed."));
    }
    if (this.blockedStartup) return Promise.reject(this.blockedStartup);
    if (this.bindings) return Promise.resolve();
    if (!this.starting) {
      this.emitDiagnostic("host.start.requested");
      this.starting = this.startOnce();
    }
    return this.starting;
  }

  getExtensionDiscovery(): MarshalRuntimeExtensionDiscovery | undefined {
    return this.extensionDiscovery ?? undefined;
  }

  blockStartup(error: unknown): void {
    if (this.lifecycle === "disposing" || this.lifecycle === "disposed") return;
    if (this.lifecycle !== "stopped" && this.lifecycle !== "failed") {
      throw new Error(`Cannot block Marshal Runtime startup while host is ${this.lifecycle}.`);
    }
    this.blockedStartup =
      error instanceof MarshalRuntimeHostStartupError
        ? error
        : new MarshalRuntimeHostStartupError(error);
    if (this.lifecycle !== "failed") {
      this.lifecycle = "failed";
      this.emitDiagnostic("host.failed", diagnosticError(error));
    }
  }

  dispose(): Promise<void> {
    this.disposing ??= this.disposeOnce();
    return this.disposing;
  }

  private async disposeOnce(): Promise<void> {
    this.lifecycle = "disposing";
    this.emitDiagnostic("host.dispose.started");
    this.options.approval?.dispose();
    try {
      if (this.starting) {
        try {
          await this.starting;
        } catch {
          // The original startup caller owns the startup error.
        }
      }
      let bindingDisposalError: unknown;
      if (this.defaultServicesReady) {
        try {
          await this.defaultServicesReady;
        } catch (error) {
          bindingDisposalError = error;
        }
      }
      const bindings = this.bindings;
      const extensionManager = this.extensionManager;
      const extensionDiscovery = this.extensionDiscovery;
      this.bindings = null;
      this.extensionManager = null;
      this.extensionDiscovery = null;
      const serviceBindingHandles = this.serviceBindingHandles;
      this.serviceBindingHandles = [];
      this.runtimeLifecycleSubscription?.dispose();
      this.runtimeLifecycleSubscription = null;
      try {
        await this.invalidatePublishedApplications();
      } catch (error) {
        bindingDisposalError ??= error;
      }
      if (extensionManager) {
        this.emitDiagnostic("extension-manager.dispose.started");
        try {
          await extensionManager.dispose();
          this.emitDiagnostic("extension-manager.dispose.completed");
        } catch (error) {
          bindingDisposalError ??= error;
          this.emitDiagnostic("extension-manager.dispose.failed", diagnosticError(error));
        }
      }
      if (extensionDiscovery) {
        this.emitDiagnostic("extension-discovery.dispose.started");
        try {
          await extensionDiscovery.dispose();
          this.emitDiagnostic("extension-discovery.dispose.completed");
        } catch (error) {
          bindingDisposalError ??= error;
          this.emitDiagnostic("extension-discovery.dispose.failed", diagnosticError(error));
        }
      }
      this.emitDiagnostic("ui-controller.dispose.started");
      this.ui?.dispose();
      this.emitDiagnostic("ui-controller.dispose.completed");
      if (bindings) {
        this.emitDiagnostic("runtime-bindings.dispose.started");
        try {
          await bindings.dispose();
          this.emitDiagnostic("runtime-bindings.dispose.completed");
        } catch (error) {
          bindingDisposalError = error;
          this.emitDiagnostic("runtime-bindings.dispose.failed", diagnosticError(error));
        }
      }
      for (const handle of serviceBindingHandles.reverse()) {
        try {
          // Binding ownership must unwind in reverse registration order.
          // eslint-disable-next-line no-await-in-loop
          await handle.dispose();
        } catch (error) {
          bindingDisposalError ??= error;
        }
      }
      if (bindingDisposalError) throw bindingDisposalError;
    } finally {
      this.lifecycle = "disposed";
      this.emitDiagnostic("host.disposed");
    }
  }

  getStatus(): MarshalRuntimeStatus {
    return Object.freeze({
      lifecycle: this.lifecycle,
      runtimePackage: this.loader.metadata(),
    });
  }

  async resolveScope(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<ResolvedMarshalRuntimeScope> {
    throwIfAborted(signal);
    if (this.lifecycle === "disposing" || this.lifecycle === "disposed") {
      throw runtimeUnavailable("Marshal Runtime host is disposed.");
    }
    await this.ensureDefaultServices();
    const resolved = await this.serviceContainer
      .get(MarshalServiceSymbols.authority)
      .resolveScope({}, runtimeServiceContext(scope, signal));
    throwIfAborted(signal);
    if (!resolved) {
      throw Object.assign(new Error("Marshal Runtime session or workspace scope was denied."), {
        code: "permission_denied",
      });
    }
    return resolved;
  }

  async authorize(request: MarshalRuntimeAuthorityRequest): Promise<PermissionDecision> {
    throwIfAborted(request.signal);
    if (this.lifecycle === "disposing" || this.lifecycle === "disposed") {
      throw runtimeUnavailable("Marshal Runtime host is disposed.");
    }
    await this.ensureDefaultServices();
    const decision = await this.serviceContainer.get(MarshalServiceSymbols.authority).authorize(
      {
        capability: request.capability,
        permissions: request.permissions,
        input: request.input,
      },
      runtimeServiceContext(request.scope, request.signal),
    );
    throwIfAborted(request.signal);
    return decision;
  }

  async search(request: RuntimeSearchRequest, context: RuntimeCallContext) {
    const bindings = await this.requireBindings();
    return bindings.kernel.search(request, context);
  }

  /** Runtime `startSession` for a Marshal session; pins its workspace for `endRuntimeSession`. */
  async startRuntimeSession(request: {
    sessionId: string;
    workspaceName: string;
    parentSessionId?: string;
  }): Promise<unknown> {
    const bindings = await this.requireBindings();
    const scope = await resolveRuntimeWorkspace(this.serviceContainer, {
      sessionId: request.sessionId,
      metadata: { [WORKSPACE_METADATA_KEY]: request.workspaceName },
    });
    this.lifecyclePins.remember(request.sessionId, scope);
    return this.lifecyclePins.withPin(request.sessionId, scope, (token) =>
      bindings.lifecycle.startSession({
        sessionId: request.sessionId,
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
        metadata: {
          [WORKSPACE_METADATA_KEY]: request.workspaceName,
          [LIFECYCLE_PIN_METADATA_KEY]: token,
        },
      }),
    );
  }

  /** Runtime `endSession` against the workspace pinned at start, so it works mid-delete. */
  async endRuntimeSession(request: {
    sessionId: string;
    parentSessionId?: string;
    outcome?: string;
  }): Promise<unknown> {
    const bindings = await this.requireBindings();
    const scope = this.lifecyclePins.take(request.sessionId);
    if (!scope) {
      throw runtimeUnavailable("Marshal Runtime session was not started in this app run.");
    }
    return this.lifecyclePins.withPin(request.sessionId, scope, (token) =>
      bindings.lifecycle.endSession({
        sessionId: request.sessionId,
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
        ...(request.outcome ? { outcome: request.outcome } : {}),
        metadata: { [LIFECYCLE_PIN_METADATA_KEY]: token },
      }),
    );
  }

  async execute(request: RuntimeExecutionRequest, context: RuntimeCallContext) {
    const bindings = await this.requireBindings();
    return bindings.kernel.execute(
      request,
      await trustedDelegationContext(context, this.options.resolveDelegationIdentity),
    );
  }

  /** Trusted native UI entry point; ordinary agent calls strip this authority. */
  async executeApplication(request: RuntimeExecutionRequest, context: RuntimeCallContext) {
    if (!this.options.applicationAuthority?.resolve(context))
      throw new Error("Application invocation authority is unavailable.");
    const bindings = await this.requireBindings();
    return bindings.kernel.execute(request, context);
  }

  async listRenderTools(
    context: RuntimeCallContext,
  ): Promise<readonly RuntimeResourceToolDescriptor[]> {
    const bindings = await this.requireBindings();
    return bindings.resources?.listTools?.(context) ?? [];
  }

  async invokeRenderTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    context: RuntimeCallContext,
  ): Promise<RuntimeResourceToolResult | undefined> {
    const bindings = await this.requireBindings();
    return bindings.resources?.callTool?.(name, input, context);
  }

  approvalStatus(approvalId: string): MarshalRuntimeApprovalStatus {
    return this.options.approval?.status(approvalId) ?? "missing";
  }

  cancelApproval(approvalId: string): void {
    this.options.approval?.cancel(approvalId);
  }

  cancelApprovalsForRequest(sessionId: string, requestId: string): void {
    this.options.approval?.cancelRequest(sessionId, requestId);
  }

  async listResources(context: RuntimeCallContext): Promise<readonly RuntimeResourceDescriptor[]> {
    const bindings = await this.requireBindings();
    const invocationContext = toInvocationContext(context);
    const publication = this.options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
    const [runtimeResources, extensionResources] = await Promise.all([
      bindings.resources?.listResources(context) ?? [],
      Promise.resolve(publication.listApplications(invocationContext)).then((applications) =>
        applications.map((application) => ({
          uri: application.resource.uri,
          name: application.title,
          description: application.description,
          mimeType: application.resource.mimeType,
        })),
      ),
    ]);
    const resources = [...runtimeResources, ...extensionResources];
    const owners = new Map<string, number>();
    for (const resource of resources) {
      owners.set(resource.uri, (owners.get(resource.uri) ?? 0) + 1);
    }
    const duplicate = [...owners].find(([, count]) => count > 1)?.[0];
    if (duplicate) {
      throw Object.assign(new Error(`Duplicate runtime resource URI: ${duplicate}`), {
        code: "DUPLICATE_RESOURCE",
      });
    }
    return Object.freeze(resources.sort((left, right) => left.uri.localeCompare(right.uri)));
  }

  async readResource(uri: string, context: RuntimeCallContext): Promise<RuntimeResourceContent> {
    const bindings = await this.requireBindings();
    const invocationContext = toInvocationContext(context);
    const publication = this.options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
    const [runtimeResources, extensionApplications] = await Promise.all([
      bindings.resources?.listResources(context) ?? [],
      publication.listApplications(invocationContext),
    ]);
    const runtimeMatch = runtimeResources.some((resource) => resource.uri === uri);
    const extensionMatches = extensionApplications.filter(
      (application) => application.resource.uri === uri,
    );
    if (Number(runtimeMatch) + extensionMatches.length > 1) {
      throw Object.assign(new Error(`Duplicate runtime resource URI: ${uri}`), {
        code: "DUPLICATE_RESOURCE",
      });
    }
    if (runtimeMatch && bindings.resources) return bindings.resources.readResource(uri, context);
    if (extensionMatches[0]) return extensionMatches[0].resource;
    throw Object.assign(new Error(`Runtime resource was not found: ${uri}`), {
      code: "RESOURCE_NOT_FOUND",
    });
  }

  async listExtensions(signal?: AbortSignal): Promise<readonly RuntimeExtensionRecord[]> {
    throwIfAborted(signal);
    await this.extensionOperationQueue;
    throwIfAborted(signal);
    const manager = await this.requireExtensionLifecycle();
    throwIfAborted(signal);
    return manager.list();
  }

  async ownsExtensionCapability(identity: string, name: string): Promise<boolean> {
    const bindings = await this.requireBindings();
    const extension = this.serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).get(identity);
    if (extension?.status !== "enabled" || !extension.capabilityProviderIds.length) return false;
    const found = await bindings.core.search(
      { protocolVersion: "1.0.0", name, providerIds: extension.capabilityProviderIds },
      { principal: { id: "marshal-application-jobs", kind: "system" } },
    );
    return found.matches.some((match) => match.capability.name === name);
  }

  /**
   * Reverse of ownsExtensionCapability, for SF2-2's extension-identity-
   * qualified permission policy buckets: given a capability's provider id
   * (RuntimeCapabilityDescriptor.provider.id, taken from a search match the
   * caller already resolved against its own session/workspace scope), find
   * which enabled extension registered it. Deliberately does not re-run
   * search() with a different (system) principal — that would risk resolving
   * against a different visibility scope than the caller's original match.
   * Capability names are globally unique (the kernel throws
   * DuplicateCapabilityError on registration collisions), so at most one
   * enabled extension can ever own a given provider id.
   */
  async resolveExtensionOwningProvider(providerId: string): Promise<string | null> {
    await this.requireBindings();
    const extension = this.serviceContainer
      .get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE)
      .list()
      .find(
        (candidate) =>
          candidate.status === "enabled" && candidate.capabilityProviderIds.includes(providerId),
      );
    return extension?.identity ?? null;
  }

  /**
   * Affirmative host provenance for a capability provider id (F-DEPLOY-5c):
   * true iff the provider was registered by the HOST at kernel bootstrap.
   * `bindings.providers` is the exact provider array the host module built
   * from `providerSources` and registered one-by-one via `kernel.register()`
   * (agent-runtime-host host.ts — `bundles.flatMap(...)` then
   * `kernel.register(provider)`), frozen into the bindings before any
   * authorize can run (every host operation gates on requireBindings()).
   * Extension providers register later through the extension manager's
   * `kernel.registerContributions()` and can never appear here; nor can an
   * extension spoof a host id — the kernel throws DuplicateProviderError on
   * any provider-id collision with an already-registered provider. This is
   * deliberately NOT "extension owner lookup returned null": during an
   * enable/disable/update window an extension's provider is kernel-visible
   * while its lifecycle projection (status/capabilityProviderIds) is not yet
   * (or no longer) populated, so null alone is ambiguous evidence.
   */
  async isHostRegisteredCapabilityProvider(providerId: string): Promise<boolean> {
    const bindings = await this.requireBindings();
    return bindings.providers.some((provider) => provider.id === providerId);
  }

  runExtensionCatalogOperation<T>(
    operation: (service: RuntimeExtensionCatalogService) => Promise<T>,
  ): Promise<T> {
    return this.runExtensionOperation(undefined, () =>
      operation(this.serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE)),
    );
  }

  async installExtension(
    request: RuntimeExtensionInstallRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, async (manager) => {
      const record = await manager.install(request, { signal });
      if (signal?.aborted) {
        await manager.remove(record.identity);
        throwIfAborted(signal);
      }
      return record;
    });
  }

  async installLocalExtension(
    packageRoot: string,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, async (manager) => {
      if (!this.extensionMaterializer) {
        throw new Error("Marshal Runtime extension materializer is unavailable.");
      }
      const sourceRoot = path.resolve(packageRoot);
      const destinationRoot = await importLocalExtension(
        sourceRoot,
        this.options.trustedExtensionRoot,
      );
      try {
        const materialized = await this.extensionMaterializer.materialize({
          packageRoot: destinationRoot,
        });
        const previousRoots = new Map(
          manager.list().map((entry) => [entry.identity, entry.request.packageRoot]),
        );
        const record = await manager.install(materialized, { signal });
        await removeSupersededLocalCopy(
          previousRoots.get(record.identity),
          manager.get(record.identity)?.request.packageRoot ?? destinationRoot,
          this.options.trustedExtensionRoot,
        );
        return record;
      } catch (error) {
        if (!samePath(destinationRoot, sourceRoot)) {
          await rm(destinationRoot, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  async updateExtension(
    identity: string,
    request: {
      readonly packageRoot: string;
      readonly integrity?: RuntimeExtensionInstallRequest["integrity"];
    },
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, async (manager) => {
      if (request.integrity) {
        return manager.update(
          identity,
          {
            packageRoot: request.packageRoot,
            integrity: request.integrity,
          },
          { signal },
        );
      }
      if (!this.extensionMaterializer) {
        throw new Error("Marshal Runtime extension materializer is unavailable.");
      }
      const sourceRoot = path.resolve(request.packageRoot);
      const destinationRoot = await importLocalExtension(
        sourceRoot,
        this.options.trustedExtensionRoot,
      );
      try {
        const materialized = await this.extensionMaterializer.materialize({
          packageRoot: destinationRoot,
        });
        const previous = manager.get(identity)?.request.packageRoot;
        const record = await manager.update(identity, materialized, { signal });
        await removeSupersededLocalCopy(
          previous,
          manager.get(identity)?.request.packageRoot ?? destinationRoot,
          this.options.trustedExtensionRoot,
        );
        return record;
      } catch (error) {
        if (!samePath(destinationRoot, sourceRoot)) {
          await rm(destinationRoot, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  async configureExtension(
    identity: string,
    configuration: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, (manager) => {
      return manager.configure(identity, configuration, { signal });
    });
  }

  async setProvider(
    identity: string,
    serviceId: string,
    providerId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, (manager) =>
      manager.setProviderOverride(identity, serviceId, providerId, { signal }),
    );
  }

  async clearProvider(
    identity: string,
    serviceId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, (manager) =>
      manager.clearProviderOverride(identity, serviceId, { signal }),
    );
  }

  async repairContractConflict(
    request: RuntimeExtensionContractRepairRequest,
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<RuntimeExtensionContractRepairResult> {
    throwIfAborted(signal);
    await this.start();
    const service = this.serviceContainer.tryGet(RUNTIME_EXTENSION_CATALOG_SERVICE);
    if (!service?.repairContractConflict) {
      throw new Error(
        "Runtime contract-conflict repair requires a newer Marshal Runtime. Update Marshal and try again.",
      );
    }
    const resolved = await this.resolveScope(scope, signal);
    throwIfAborted(signal);
    return service.repairContractConflict(request, {
      principal: { id: "marshal-runtime-host", kind: "agent" },
      scope: { sessionId: scope.sessionId },
      metadata: {
        marshalWorkspaceName: scope.workspaceName,
        workspacePath: resolved.workspacePath,
      },
      signal,
    });
  }

  async enableExtension(identity: string, signal?: AbortSignal): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, async (manager) => {
      const record = await manager.enable(identity, { signal });
      return record;
    });
  }

  async disableExtension(identity: string, signal?: AbortSignal): Promise<RuntimeExtensionRecord> {
    return this.runExtensionOperation(signal, async (manager) => {
      await this.prepareDebuggerNativeProviderRemoval(manager, identity, signal);
      return manager.disable(identity);
    });
  }

  async removeExtension(identity: string, signal?: AbortSignal): Promise<void> {
    await this.runExtensionOperation(signal, async (manager) => {
      await this.prepareDebuggerNativeProviderRemoval(manager, identity, signal);
      return manager.remove(identity);
    });
  }

  private async prepareDebuggerNativeProviderRemoval(
    manager: RuntimeExtensionLifecycleService,
    identity: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (identity !== BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY) return;
    const service = AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE;
    const providerId = this.compositionRegistry.snapshot().overrides[service.key];
    if (!isAgenticDebuggerNativeProviderId(providerId)) return;

    await manager.clearProviderOverride(identity, service.key, { signal });
    const registryService = this.compositionRegistry
      .snapshot()
      .services.find(({ service: candidate }) => candidate.key === service.key)?.service;
    if (!registryService) return;
    const providerStillRegistered = this.compositionRegistry
      .inspect(registryService)
      ?.providers.some(({ provider }) => provider.id === providerId);
    if (providerStillRegistered) {
      await this.compositionRegistry.setProviderOverride(registryService, providerId);
    }
  }

  private async startOnce(): Promise<void> {
    this.lifecycle = "starting";
    let bindings: AgentRuntimeBindings | null = null;
    let extensionManager: RuntimeExtensionManager | null = null;
    let extensionDiscovery: MarshalRuntimeExtensionDiscovery | null = null;
    try {
      await this.ensureDefaultServices();
      if (this.options.startupDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.startupDelayMs));
      }
      const runtimeModule = await this.loader.load();
      const serviceContainer = this.serviceContainer;
      bindings = await runtimeModule.createAgentRuntime({
        serviceContainer,
        compositionRegistry: this.compositionRegistry,
        extensions: false,
        workspacePath: this.options.hostWorkspacePath,
        resolveWorkspace: async (context) => {
          const pinned = this.lifecyclePins.resolve(context.sessionId, context.metadata);
          if (pinned) return pinned;
          const application = this.options.applicationAuthority?.resolve(context);
          if (!application) return resolveRuntimeWorkspace(serviceContainer, context);
          if (!(await application.isActive()))
            throw invalidRuntimeWorkspace("Application is no longer active.");
          const workspace = captureWorkspaceBinding(
            application.owner.workspaceName,
            application.workspacePath,
          );
          const ids = await resolveRuntimeWorkspaceIds(
            workspace.canonicalPath,
            workspace.binding.identity,
          );
          return { workspacePath: workspace.canonicalPath, ...ids };
        },
        stateDirectory: "state",
        protectedLifecycleResultRoot: this.options.protectedLifecycleResultRoot,
        worktreeRoot: this.options.worktreeRoot,
        ...(this.options.trustedTypeScript
          ? { importPolicy: TRUSTED_TYPESCRIPT_IMPORT_POLICY }
          : {}),
        identity: { harnessId: "marshal-desktop" },
        principal: { id: "marshal-runtime-host", kind: "agent" },
        permissionBroker: {
          decide: async (check) =>
            (await this.options.applicationAuthority?.decide(check)) ??
            decidePermission(
              this.serviceContainer.get(MarshalServiceSymbols.authority),
              this.options.approval,
              check,
            ),
        },
        ...(this.options.approval
          ? { permissionApproval: this.options.approval.permissionApproval }
          : {}),
        providerSources: [
          ...(this.options.additionalProviderSources ?? []),
          runtimeModule.createRuntimeBuiltinsSource({
            artifacts: false,
            effects: false,
            scheduling: false,
            typescript: true,
            reactUi: {},
            declarativeUi: false,
            ...(this.options.nodeExecutable ? { nodeExecutable: this.options.nodeExecutable } : {}),
            inlineMaxOutputBytes: 64 * 1024,
            inlineMaxSourceCharacters: 2 * 1024 * 1024,
            moduleMaxBrokerInvocations: 64,
            moduleMaxConcurrentBrokerInvocations: 8,
          }),
          createMarshalHostProviderSource(
            serviceContainer,
            this.ui ?? undefined,
            (context) => this.options.applicationAuthority?.resolve(context)?.owner,
            (context) => this.listAuthoredUiApplications(context),
          ),
          () => ({
            providers: [],
            catalog: createRuntimeExtensionCatalogProvider(
              serviceContainer,
              this.compositionRegistry,
            ),
            resources: createRuntimeExtensionResourcePort(
              serviceContainer,
              this.compositionRegistry,
            ),
          }),
        ],
      });
      this.options.diagnostics?.onRuntimeObject?.("kernel", bindings.kernel);
      this.runtimeLifecycleSubscription = bindings.core.observeLifecycle((event) => {
        this.emitDiagnostic(`kernel.${event.type}`, diagnosticLifecycleDetails(event));
      });
      this.emitDiagnostic("kernel.providers.inventory", {
        providers: bindings.providers.map((provider) => ({
          id: provider.id,
          version: provider.version,
        })),
      });
      if (this.options.agenticBrowser) {
        this.emitDiagnostic("agentic-browser.resolve.started", {
          identity: AGENTIC_BROWSER_EXTENSION_IDENTITY,
        });
      }
      const firstPartyExtensions = this.options.firstPartyExtensions ?? [];
      const builtInAgenticBrowser =
        firstPartyExtensions.find(
          ({ identity }) => identity === AGENTIC_BROWSER_EXTENSION_IDENTITY,
        ) ?? null;
      if (builtInAgenticBrowser) {
        this.emitDiagnostic("agentic-browser.resolve.completed", {
          identity: builtInAgenticBrowser.identity,
          version: builtInAgenticBrowser.version,
        });
      }
      if (builtInAgenticBrowser && !this.ui) {
        throw new Error("The built-in agentic browser extension requires Marshal Runtime UI.");
      }
      if (
        serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE) ||
        serviceContainer.tryGet(RUNTIME_EXTENSION_CATALOG_SERVICE)
      ) {
        throw new Error("Marshal Runtime extension services were already configured.");
      }
      const agenticBrowserHost =
        builtInAgenticBrowser && this.ui
          ? createMarshalAgenticBrowserRuntimeHostModule({
              authority: callTimeAuthorityPort(serviceContainer),
              executor: callTimeBrowserExecutor(serviceContainer),
              ui: this.ui,
              onLifecycleEvent: (event) =>
                this.emitDiagnostic(`agentic-browser.lifecycle.${event.type}`, {
                  browserSessionId: event.context.browserSessionId,
                  executionId: event.context.executionId,
                  command: event.command,
                }),
            })
          : null;
      const injectedModules = {
        ...(this.options.extensionSecrets
          ? { "@marshal/runtime-secrets": this.options.extensionSecrets }
          : {}),
        ...(agenticBrowserHost ? { "@agentic-browser/runtime-host": agenticBrowserHost } : {}),
      };
      const discoveryRoots = await runtimeExtensionDiscoveryRoots(
        this.options.location,
        this.options.trustedExtensionRoot,
      );
      const materializer = await createRuntimeHostMaterializer({
        allowedRoots: [
          this.options.trustedExtensionRoot,
          ...firstPartyExtensions.map(({ request }) => request.packageRoot),
          ...discoveryRoots,
        ],
      });
      this.extensionMaterializer = materializer;
      const baseExtensionLoader = new LocalRuntimeExtensionPackageLoader({
        allowedRoots: materializer.allowedRoots,
        modules: createNodeBuiltinModuleMap(injectedModules),
      });
      const extensionLoader = createFirstPartyExtensionPackageLoader({
        loader: baseExtensionLoader,
        compositionRegistry: this.compositionRegistry,
        ...(this.options.ui?.overlayReview ? { overlayReview: this.options.ui.overlayReview } : {}),
      });
      if (!serviceContainer.tryGet(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)) {
        this.serviceBindingHandles.push(
          await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
            useValue: new RuntimeExtensionUiPublicationRegistry(
              RUNTIME_UI_EXTENSION_HOST_PLACEMENTS,
            ),
          }),
        );
      }
      if (!bindings.extensionHost) {
        throw new Error("Runtime extension lifecycle and background jobs are unavailable.");
      }
      const extensionStateStore = new JsonFileRuntimeExtensionStateStore(
        path.join(bindings.stateRoot, "extensions", "state.json"),
      );
      for (const extension of firstPartyExtensions) {
        // Extension state is persisted through one JSON store; preserve catalog order.
        // eslint-disable-next-line no-await-in-loop
        await reconcileBundledExtensionState(extensionStateStore, extension);
      }
      extensionManager = new RuntimeExtensionManager({
        kernel: bindings.core,
        services: serviceContainer,
        compositionRegistry: this.compositionRegistry,
        loader: extensionLoader,
        stateStore: extensionStateStore,
        activationContext: {
          principal: { id: "marshal-runtime-host", kind: "agent" },
          identity: { harnessId: "marshal-desktop" },
          scope: { sessionId: "marshal-runtime-host" },
          metadata: { marshalWorkspaceName: this.options.hostWorkspacePath },
        },
        uiPlacementDefinitions: RUNTIME_UI_EXTENSION_HOST_PLACEMENTS,
        registerDurableEventConsumer: bindings.registerDurableEventConsumer,
        ...bindings.extensionHost,
      });
      this.options.diagnostics?.onRuntimeObject?.("extension-manager", extensionManager);
      this.serviceBindingHandles.push(
        await serviceContainer.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
          useValue: extensionManager,
        }),
      );
      const nativeRoot = materializer.allowedRoots[0];
      if (!nativeRoot) throw new Error("Marshal Runtime trusted extension root is unavailable.");
      const nativeRoots = [nativeRoot, ...discoveryRoots];
      extensionDiscovery = runtimeModule.createRuntimeNativeExtensionDiscoveryService
        ? await runtimeModule.createRuntimeNativeExtensionDiscoveryService({ roots: nativeRoots })
        : null;
      const nativeSource = createRuntimeNativeExtensionCatalogSource(nativeRoots);
      this.serviceBindingHandles.push(
        await serviceContainer.bindMany(RUNTIME_EXTENSION_CATALOG_SOURCE, {
          useValue: nativeSource,
        }),
      );
      this.serviceBindingHandles.push(
        await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, {
          useValue: new RuntimeExtensionCatalog({
            services: serviceContainer,
            sources: serviceContainer.getAll(RUNTIME_EXTENSION_CATALOG_SOURCE),
            projectInstalledEntry: (entry) => {
              const projected = projectRuntimeExtensionCatalogEntry(
                entry,
                this.compositionRegistry.snapshot(),
              );
              const appServicesSnippet = projected.metadata?.appServicesSnippet;
              return typeof appServicesSnippet === "string"
                ? { ...entry, appServicesSnippet }
                : entry;
            },
          }),
        }),
      );
      await extensionManager.restore();
      for (const extension of firstPartyExtensions) {
        // Activation order is the catalog's deterministic composition order.
        // eslint-disable-next-line no-await-in-loop
        await ensureRequiredBundledExtension(
          extensionManager,
          extension,
          "first-party-extension",
          (type, details) => this.emitDiagnostic(type, details),
        );
      }
      this.bindings = bindings;
      this.extensionManager = extensionManager;
      this.extensionDiscovery = extensionDiscovery;
      this.lifecycle = "running";
      this.emitDiagnostic("host.running");
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await extensionManager?.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await extensionDiscovery?.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await bindings?.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      for (const handle of this.serviceBindingHandles.splice(0).reverse()) {
        try {
          // Binding ownership must unwind in reverse registration order.
          // eslint-disable-next-line no-await-in-loop
          await handle.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      this.defaultServicesReady = null;
      this.lifecycle = "failed";
      this.runtimeLifecycleSubscription?.dispose();
      this.runtimeLifecycleSubscription = null;
      this.emitDiagnostic("host.failed", diagnosticError(error));
      if (cleanupErrors.length > 0) {
        this.emitDiagnostic("host.cleanup.failed", { failures: cleanupErrors.length });
      }
      throw new MarshalRuntimeHostStartupError(error);
    } finally {
      this.starting = null;
    }
  }

  private async bindDefaultServices(): Promise<void> {
    const ownedServiceBindings = await (this.options.ownedServiceBindings ?? Promise.resolve([]));
    const defaultBindings: Array<Promise<RuntimeServiceBindingHandle>> = [
      registerHostService(
        this.compositionRegistry,
        MarshalRuntimeCompositionServices.authority,
        "authority",
        publicAuthority(this.options.authority),
      ),
      registerHostService(
        this.compositionRegistry,
        MarshalRuntimeCompositionServices.catalog,
        "catalog",
        createRuntimeCatalogService(this.options.catalog),
      ),
    ];
    if (this.options.agents) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.agents,
          "agents",
          createRuntimeAgentService(this.options.agents),
        ),
      );
    }
    if (this.options.brain) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.brain,
          "brain",
          createRuntimeBrainService(this.options.brain),
        ),
      );
    }
    if (this.options.memory) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.memory,
          "memory",
          createRuntimeMemoryService(this.options.memory),
        ),
      );
    }
    if (this.options.memoryProviderRegistry) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.memoryProviderRegistry,
          "memory-provider-registry",
          this.options.memoryProviderRegistry,
        ),
      );
    }
    if (this.options.agenticBrowser) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.browserExecution,
          "browser.execution",
          publicBrowser(this.options.agenticBrowser.executor, this.serviceContainer),
        ),
      );
    }
    if (
      this.options.firstPartyExtensions?.some(
        ({ hostComposition }) => hostComposition === "agentic-debugger-host-adapter",
      )
    ) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE,
          "agentic-debugger.host-adapter",
          unavailableDebuggerHostAdapter,
        ),
      );
    }
    if (this.options.ui) {
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.uiDelivery,
          "ui.delivery",
          publicUiDelivery(this.options.ui.delivery),
        ),
      );
    }
    if (this.options.ui?.overlayReview) {
      const overlayReview = this.options.ui.overlayReview;
      defaultBindings.push(
        registerHostService(
          this.compositionRegistry,
          MarshalRuntimeCompositionServices.uiReview,
          "ui.review",
          {
            launch: (request) => overlayReview.launch(request),
          },
        ),
      );
    }
    const settledBindings = await Promise.allSettled(defaultBindings);
    this.serviceBindingHandles = [
      ...ownedServiceBindings,
      ...settledBindings.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ];
    const rejectedBinding = settledBindings.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejectedBinding) throw rejectedBinding.reason;
  }

  private ensureDefaultServices(): Promise<void> {
    this.defaultServicesReady ??= this.bindDefaultServices();
    return this.defaultServicesReady;
  }

  private async requireBindings(): Promise<AgentRuntimeBindings> {
    await this.start();
    if (!this.bindings) throw runtimeUnavailable("Marshal Runtime host is unavailable.");
    return this.bindings;
  }

  private async requireExtensionLifecycle(): Promise<RuntimeExtensionLifecycleService> {
    await this.start();
    const extensionLifecycle = this.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    if (!extensionLifecycle) {
      throw runtimeUnavailable("Marshal Runtime extension lifecycle is unavailable.");
    }
    return extensionLifecycle;
  }

  /**
   * Authored-render placement bridge: resolves the runtime's PUBLIC
   * `ui.applications.list` capability through the host's normal `execute`
   * route — the same kernel path every agent `runtimeInvoke` takes — so the
   * capability's declared permission (`ui.applications.list`, risk low),
   * input/output schema validation, receipts, and scope derivation are all
   * enforced identically to a direct agent invocation. The caller's
   * InvocationContext scope is carried into the RuntimeCallContext; the kernel
   * re-derives the principal exactly as it did for the render-creating
   * invocation, so the projection's scope key matches.
   */
  private async listAuthoredUiApplications(
    context: InvocationContext,
  ): Promise<readonly RuntimeExtensionUiPublishedApplication[]> {
    const callContext: RuntimeCallContext = {
      ...(context.scope?.sessionId ? { sessionId: context.scope.sessionId } : {}),
      ...(context.scope?.workspacePath ? { workspacePath: context.scope.workspacePath } : {}),
      ...(context.metadata ? { metadata: context.metadata as RuntimeCallContext["metadata"] } : {}),
      ...(context.signal instanceof AbortSignal ? { signal: context.signal } : {}),
    };
    const response = await this.execute(
      { targetType: "operation", target: "ui.applications.list", input: {} },
      callContext,
    );
    if (response.status !== "success" || !response.result) {
      const failure = response.error;
      throw Object.assign(
        new Error(failure?.message ?? `ui.applications.list ended with status ${response.status}.`),
        { code: failure?.code ?? "operation-failed" },
      );
    }
    const applications = readOutputField(response.result.output, "applications");
    if (!Array.isArray(applications)) {
      throw runtimeUnavailable(
        "Authored-render placement requires a runtime exposing ui.applications.list.",
      );
    }
    return applications as readonly RuntimeExtensionUiPublishedApplication[];
  }

  private async publishedApplications(): Promise<
    readonly RuntimeExtensionUiPublishedApplication[]
  > {
    const publication = this.serviceContainer.tryGet(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
    if (!publication) return [];
    return publication.listApplications({
      principal: { id: "marshal-runtime-host", kind: "agent" },
      metadata: { marshalWorkspaceName: this.options.hostWorkspacePath },
    });
  }

  private async invalidatePublishedApplications(
    before?: readonly RuntimeExtensionUiPublishedApplication[],
  ): Promise<void> {
    const after = await this.publishedApplications();
    const invalidatedOwners: RuntimeUiOwnerIdentity[] = [];
    for (const application of before ?? after) {
      const current =
        before &&
        after.find(
          (candidate) =>
            candidate.ownerId === application.ownerId && candidate.id === application.id,
        );
      if (current?.revisionId === application.revisionId) continue;
      const owner = { extensionId: application.ownerId, applicationId: application.id };
      // Shutdown closes views but must preserve already-accepted durable deliveries.
      if (before && !current) invalidatedOwners.push(owner);
      const result = current
        ? this.ui?.refreshApplication(owner, {
            kind: "application",
            renderId: current.renderId,
            resource: {
              uri: current.resource.uri,
              mimeType: current.resource.mimeType ?? "text/plain",
              name: current.title,
            },
            descriptor: current.application,
          })
        : this.ui?.invalidateOwner(owner);
      if (result && !result.ok) throw new Error(result.error.message);
    }
    await Promise.all(
      invalidatedOwners.map(async (owner) => this.options.onApplicationInvalidated?.(owner)),
    );
  }

  private runExtensionOperation<T>(
    signal: AbortSignal | undefined,
    operation: (manager: RuntimeExtensionLifecycleService) => T | Promise<T>,
  ): Promise<T> {
    const run = async () => {
      throwIfAborted(signal);
      const manager = await this.requireExtensionLifecycle();
      throwIfAborted(signal);
      const before = await this.publishedApplications();
      const result = await operation(manager);
      await this.invalidatePublishedApplications(before);
      return result;
    };
    const result = this.extensionOperationQueue.then(run, run);
    this.extensionOperationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private emitDiagnostic(type: string, details?: Readonly<Record<string, unknown>>): void {
    this.options.diagnostics?.onEvent({ type, ...(details ? { details } : {}) });
  }
}

export type {
  MarshalRuntimeExtensionDiscovery,
  MarshalRuntimeExtensionDiscoveryCandidate,
  MarshalRuntimeExtensionDiscoveryDiagnostic,
  MarshalRuntimeExtensionDiscoverySnapshot,
} from "./contracts";

function toInvocationContext(context: RuntimeCallContext): InvocationContext {
  return {
    principal: {
      id: context.agentId ?? context.sessionId ?? "marshal-runtime",
      kind: context.agentId ? "agent" : "user",
    },
    ...(context.sessionId || context.threadId
      ? {
          scope: {
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.threadId ? { threadId: context.threadId } : {}),
          },
        }
      : {}),
    ...(context.requestId ? { executionId: context.requestId } : {}),
    ...(context.receiptCorrelationContext
      ? { receiptCorrelationContext: context.receiptCorrelationContext }
      : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

function diagnosticLifecycleDetails(event: {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> | undefined {
  const data = event.data;
  if (!data) return undefined;
  const allowed = ["providerId", "providerVersion", "resultCount", "executionId", "status"];
  const entries = allowed
    .filter((key) => Object.hasOwn(data, key))
    .map((key) => [key, data[key]] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function diagnosticError(error: unknown): Readonly<Record<string, unknown>> {
  return {
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "runtime_unavailable",
    message:
      error instanceof Error && error.message.trim()
        ? error.message.slice(0, 512)
        : "Marshal Runtime startup failed.",
  };
}

function readOutputField(output: unknown, field: string): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  return Reflect.get(output, field);
}

function runtimeUnavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "runtime_unavailable" });
}

/** Only durable host session state can grant a Runtime invocation delegation identity. */
export async function trustedDelegationContext(
  context: RuntimeCallContext,
  resolveIdentity?: (
    sessionId: string,
  ) => Promise<string | { delegationId: string; taskController?: string } | undefined>,
): Promise<RuntimeCallContext> {
  const identity = context.sessionId ? await resolveIdentity?.(context.sessionId) : undefined;
  const delegationId = typeof identity === "string" ? identity : identity?.delegationId;
  const taskController = typeof identity === "object" ? identity.taskController : undefined;
  const metadata = { ...context.metadata };
  delete metadata.delegationId;
  delete metadata.marshalLaunchDelegationId;
  delete metadata.marshalLaunchTaskController;
  delete metadata.runtimeExtensionIdentity;
  stripApplicationAuthority(metadata);
  delete metadata.runtimeTaskController;
  if (delegationId) metadata.delegationId = delegationId;
  if (taskController) metadata.runtimeTaskController = taskController;
  return { ...context, metadata };
}

/** @internal test seam — the native permission chain (decidePermission → MarshalAuthorityService) is exercised directly by native-permission-routing.test.ts. */
export const __hostTesting = { decidePermission };
