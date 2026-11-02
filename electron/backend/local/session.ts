import { createHash, randomUUID } from "crypto";
import * as nodePath from "node:path";

import { app } from "electron";

import { APP_NAME } from "../../../common/marshal-constants";
import {
  resolveSessionToolAllowlist,
  type ModelInfo,
  type ReasoningEffort,
} from "../../../common/marshal-ipc-contract";
import { isSdkHitlRequired } from "../../../common/marshal-sdk-builtin-tools";
import { toMcpServerKey } from "../../../common/mcp-server-key-normalization";
import { runtimeTargetKey } from "../../../common/runtime-accounts";
import { getAppDataDir } from "../../app-paths";
import { getSessionClientViewport } from "../../client-viewport";
import { coerceErrorText } from "../../error-formatting";
import { getSelfFsTools } from "../../marshal-fs/tools";
import { sanitizeForTelemetry } from "../../marshal-value-sanitization";
import { normalizeDiscoveredModels } from "../../model-manager";
import { normalizePermissionRequest } from "../../permission-request-normalizer";
import { secureAppendFile, secureMkdir } from "../../platform-security";
import { getBarePlaywrightToolName } from "../../platform/security/browser-tools/names";
import { extractBrowserWritePath } from "../../platform/security/browser-tools/write-path";
import { describeSessionViews } from "../../runtime-ui-turn-context";
import { AskUserToolResultSchema } from "../../schemas/session-schema";
import { getSelfTools } from "../../self-tools";
import { buildUserPromptContext } from "../../system-message";
import {
  backgroundToolObservation,
  NEVER_BACKGROUND_TOOL_NAMES,
  runToolWithBackgrounding,
} from "../../tool-backgrounding";
import { handoffUserPrompt } from "../conversation-state";
import { normalizeEvent } from "../normalize-event";
import type {
  RuntimePermissionHandler,
  RuntimePermissionResult,
  RuntimeAgentDefinition,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeSessionHooks,
  RuntimeTool,
  RuntimeToolInvocation,
} from "../runtime-contract";
import type {
  ApprovalRequest,
  BackendEvent,
  CreateSessionOpts,
  ExecutionCancelResult,
  ExecutionCapabilities,
  ExecutionEventEnvelope,
  ExecutionRunEnvelope,
  IExecutionBackend,
  ISessionBackend,
  McpOAuthLoginOptions,
  RemoteSessionEvent,
  RepositoryAgentDefinition,
  SendPayload,
  SessionAbortResult,
  SessionHandle,
  SessionMessage,
  SessionMetadata,
  SkillProviderRoot,
  StoredSession,
  StartExecutionRunOptions,
  Unsubscribe,
} from "../types";
import { EXECUTION_ENVELOPE_VERSION, ExecutionConcurrencyLimitError } from "../types";
import { isRuntimeClientDead } from "./client-process";
import {
  approvalResultToRuntimePermission,
  type LocalSessionSubset,
  type ErrorOccurredHookInput,
  type ILocalProviderForSession,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  RUNTIME_APPROVE_ONCE_PERMISSION_RESULT,
  RUNTIME_RULE_DENY_PERMISSION_RESULT,
  type UserPromptSubmittedHookInput,
  dynamicString,
  log,
} from "./internal";
import {
  getRepositoryAgentByPath,
  getRepositoryCustomizationsForSystemPrompt,
  getRepositorySkillProviderRoots,
  loadRepositoryAgents,
} from "./repository-customizations";
import {
  type SessionClientSelection,
  modelForSessionSwitch,
  selectSessionClient,
} from "./session-client";
import { restrictToolSurface } from "./tool-surface";

const DISCONNECT_TIMEOUT_MS = 5_000;
const SESSION_START_TIMEOUT_MS = 45_000;
const MAX_RETAINED_RUNS = 1_000;

function runtimeAgentDefinitions(
  repoRoot: string,
  projectContext: boolean | undefined,
): Record<string, RuntimeAgentDefinition> {
  const definitions: Record<string, RuntimeAgentDefinition> = {};
  if (projectContext === false) return definitions;
  for (const agent of loadRepositoryAgents(repoRoot)) {
    const baseName =
      agent.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "agent";
    let key = baseName;
    if (definitions[key]) key = `${agent.source ?? "repository"}-${baseName}`;
    let suffix = 2;
    while (definitions[key]) key = `${agent.source ?? "repository"}-${baseName}-${suffix++}`;
    definitions[key] = {
      description: agent.description || `${agent.name} from ${agent.path}`,
      prompt: agent.instructions,
    };
  }
  return definitions;
}
interface SessionConfigTraceArgs {
  sessionId: string;
  operation: "createSession" | "resumeSession";
  model: string | undefined;
  reasoningEffort: CreateSessionOpts["reasoningEffort"];
  contextTier: CreateSessionOpts["contextTier"];
  effectiveWorkspaceDir: string;
  tools: readonly unknown[];
  mcpServers: Readonly<Record<string, unknown>>;
  systemMessage: string | undefined;
  systemMessageMode: CreateSessionOpts["systemMessageMode"];
  sessionSource: CreateSessionOpts["sessionSource"];
  availableTools: readonly string[] | undefined;
  systemMessageProfile: CreateSessionOpts["systemMessageProfile"];
  hasRepositoryAgent: boolean | undefined;
  projectContext?: boolean;
}

export function buildSessionConfigTrace(args: SessionConfigTraceArgs): Record<string, unknown> {
  const systemMessage = args.systemMessage;
  return {
    sessionId: args.sessionId,
    operation: args.operation,
    sessionSource: args.sessionSource ?? null,
    systemMessageProfile: args.systemMessageProfile ?? "caller-supplied",
    hasRepositoryAgent: args.hasRepositoryAgent ?? false,
    projectContext: args.projectContext !== false,
    model: args.model ?? null,
    reasoningEffort: args.reasoningEffort ?? null,
    reasoningEffortForwarded: args.reasoningEffort !== undefined,
    contextTier: args.contextTier ?? null,
    contextTierForwarded: args.contextTier !== undefined,
    effectiveWorkspaceDir: sanitizeForTelemetry(args.effectiveWorkspaceDir),
    availableTools: args.availableTools ?? null,
    hostToolNames: args.tools
      .map((tool) => dynamicString(tool, "name"))
      .filter((name) => name.length > 0),
    mcpServerNames: Object.keys(args.mcpServers),
    sdkManagedTools: "not-enumerated-by-host",
    systemMessage: systemMessage
      ? {
          mode: args.systemMessageMode ?? "append",
          chars: systemMessage.length,
          bytes: Buffer.byteLength(systemMessage, "utf8"),
          sha256: createHash("sha256").update(systemMessage).digest("hex"),
          contentLogged: false,
        }
      : null,
  };
}

async function logSessionConfigTrace(
  args: SessionConfigTraceArgs,
  traceFilename: string,
): Promise<void> {
  const trace = buildSessionConfigTrace(args);
  log.with({ sessionId: args.sessionId }).info("[session-config-trace]", trace);
  if (process.env["VITEST_WORKER_ID"]) return;

  try {
    const appDataDir = getAppDataDir();
    await secureMkdir(appDataDir, 0o700);
    await secureAppendFile(
      nodePath.join(appDataDir, traceFilename),
      JSON.stringify({ timestamp: new Date().toISOString(), ...trace }) + "\n",
      { mode: 0o600 },
    );
  } catch (err) {
    log.with({ sessionId: args.sessionId }).warn("Failed to write session config trace:", err);
  }
}

async function withSessionStartTimeout<T>(
  sessionId: string,
  operationName: "createSession" | "resumeSession",
  operation: Promise<T>,
  discardLateResult: (result: T) => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${operationName} timed out after ${SESSION_START_TIMEOUT_MS}ms`));
    }, SESSION_START_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  void operation.then(
    (result) => {
      if (!timedOut) return;
      void discardLateResult(result).catch((err: unknown) => {
        log.with({ sessionId }).warn(`Late ${operationName} cleanup failed:`, err);
      });
    },
    (err: unknown) => {
      if (timedOut) log.with({ sessionId }).warn(`Late ${operationName} failed:`, err);
    },
  );

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForDisconnect(sessionId: string, operation: Promise<void>): Promise<void> {
  const slog = log.with({ sessionId });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, DISCONNECT_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    await Promise.race([operation, timeout]);
  } catch (err) {
    slog.warn("SDK session disconnect failed:", err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    slog.warn(`SDK session disconnect exceeded ${DISCONNECT_TIMEOUT_MS}ms; continuing`);
    operation.catch((err: unknown) => slog.warn("Late SDK session disconnect failed:", err));
  }
}

function shouldEmitFileActivity(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.includes("apply_patch") ||
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("move") ||
    lower.includes("mkdir") ||
    lower.includes("create")
  );
}

/**
 * Wrap the host-provided system message for the runtime contract, carrying the
 * optional apply mode ("replace" = the entire system prompt; Claude adapter
 * implements it, other adapters ignore the mode and keep existing behavior).
 * Used identically by the create and resume paths so a resumed replacement
 * session never silently falls back to preset+append.
 */
export function toRuntimeSystemMessage(
  systemMessage: string | undefined,
  mode: CreateSessionOpts["systemMessageMode"],
): { content: string; mode?: "append" | "replace" } | undefined {
  if (systemMessage === undefined) return undefined;
  return { content: systemMessage, ...(mode ? { mode } : {}) };
}

export class LocalSessionBackend implements ISessionBackend, IExecutionBackend {
  async defaultModelForRuntime(
    target: import("../../../common/runtime-accounts").RuntimeTarget,
  ): Promise<string> {
    let client;
    if (runtimeTargetKey(target) === this.backend.getRuntimeId?.()) {
      const current = this.backend.getClient();
      if (!current || isRuntimeClientDead(current)) await this.backend.initClient();
      client = this.backend.getClient();
    } else {
      const peers = this.backend.getPeerClients?.();
      if (!peers) throw new Error("This backend cannot launch agents on another runtime.");
      client = await peers.clientForRuntime(target);
    }
    if (!client) throw new Error("The selected runtime client is unavailable.");
    const models = await client.listModels();
    const model = models.find((entry) => entry.id === "default") ?? models[0];
    if (!model?.id) throw new Error("The selected runtime has no available default model.");
    return model.id;
  }

  async listModelsForRuntime(
    target: import("../../../common/runtime-accounts").RuntimeTarget,
  ): Promise<ModelInfo[]> {
    let models;
    if (runtimeTargetKey(target) === this.backend.getRuntimeId?.()) {
      if (!this.backend.getClient()) await this.backend.initClient();
      const client = this.backend.getClient();
      if (!client) throw new Error("The selected runtime client is unavailable.");
      models = await client.listModels();
    } else {
      const peers = this.backend.getPeerClients?.();
      if (!peers) throw new Error("This backend cannot launch agents on another runtime.");
      models = await peers.catalogForRuntime(target);
    }
    return normalizeDiscoveredModels(
      models.filter((model) => !model.policy?.state || model.policy.state === "enabled"),
    );
  }

  private readonly pendingHandoffs = new Map<
    string,
    import("../../../common/runtime-conversation-state").RuntimeConversationState
  >();
  private executionEpoch = 0;
  private readonly activeRunsByLocalId = new Map<string, ExecutionRunEnvelope>();
  private readonly activeLocalRunBySession = new Map<string, string>();
  private readonly completedRunsByLocalId = new Map<string, ExecutionRunEnvelope>();
  private readonly inflightStarts = new Map<string, Promise<ExecutionRunEnvelope>>();
  private readonly runSubscribers = new Map<string, Set<(event: ExecutionEventEnvelope) => void>>();
  /** Host tool names the session was created/resumed with; drives the per-turn availability line. */
  private readonly hostToolNamesBySession = new Map<string, readonly string[]>();

  constructor(private backend: ILocalProviderForSession) {}

  listRepositoryAgents(repoRoot: string): RepositoryAgentDefinition[] {
    return loadRepositoryAgents(repoRoot);
  }

  getRepositoryAgentByPath(
    repoRoot: string,
    relativeAgentPath: string,
  ): RepositoryAgentDefinition | null {
    return getRepositoryAgentByPath(repoRoot, relativeAgentPath);
  }

  getRepositoryCustomizationsForSystemPrompt(
    repoRoot?: string,
    options?: { lean?: boolean },
  ): string {
    return getRepositoryCustomizationsForSystemPrompt(
      repoRoot,
      this.backend.getRuntimeId?.(),
      options,
    );
  }

  getSkillProviderRoots(repoRoot?: string): SkillProviderRoot[] {
    return getRepositorySkillProviderRoots(repoRoot, this.backend.getRuntimeId?.());
  }

  async create(opts: CreateSessionOpts): Promise<SessionHandle> {
    const selection = await selectSessionClient(this.backend, opts.model);
    const actualClient = selection.client;

    opts.assertWorkspaceCurrent?.();
    const effectiveWorkspaceDir = opts.workspaceDir ?? this.backend.getWorkspaceDir();
    const mcpConfig = this.backend.prepareMcpConfig
      ? await this.backend.prepareMcpConfig(
          opts.sessionId,
          opts.workspaceDir,
          opts.playwrightHeadless,
        )
      : this.backend.getMcpConfig(opts.workspaceDir, opts.playwrightHeadless, opts.sessionId);
    const hooks = this.buildHooks(opts.sessionId, opts.isAutomatedSession ?? false);
    const permissionHandler = this.buildPermissionHandler(opts.sessionId);
    const { tools: allTools, availableTools } = restrictToolSurface(
      this.buildAllTools(opts.sessionId, effectiveWorkspaceDir),
      resolveSessionToolAllowlist(opts.runtimeAgentRole, opts.allowedTools),
      { failOnUnknown: true },
    );
    this.hostToolNamesBySession.set(
      opts.sessionId,
      allTools.map((tool) => tool.name),
    );

    const systemMessage = toRuntimeSystemMessage(opts.systemMessage, opts.systemMessageMode);
    const agents = runtimeAgentDefinitions(effectiveWorkspaceDir, opts.projectContext);

    await logSessionConfigTrace(
      {
        sessionId: opts.sessionId,
        operation: "createSession",
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        contextTier: opts.contextTier,
        effectiveWorkspaceDir,
        tools: allTools,
        availableTools,
        mcpServers: availableTools ? {} : mcpConfig,
        systemMessage: opts.systemMessage,
        systemMessageMode: opts.systemMessageMode,
        sessionSource: opts.sessionSource,
        systemMessageProfile: opts.systemMessageProfile,
        hasRepositoryAgent: opts.hasRepositoryAgent,
        projectContext: opts.projectContext,
      },
      this.backend.getSessionConfigTraceFilename?.() ?? "m-local-session-config-trace.jsonl",
    );

    opts.assertWorkspaceCurrent?.();
    const sessionConfig: RuntimeSessionConfig = {
      ...(opts.conversationState ? { conversationState: opts.conversationState } : {}),
      clientName: `${APP_NAME}/${app.getVersion()}`,
      model: selection.model,
      reasoningEffort: opts.reasoningEffort,
      contextTier: opts.contextTier,
      streaming: true,
      workingDirectory: effectiveWorkspaceDir,
      includeSubAgentStreamingEvents: false,
      ...(!availableTools && Object.keys(mcpConfig).length > 0 ? { mcpServers: mcpConfig } : {}),
      hooks,
      tools: allTools,
      ...(availableTools ? { availableTools } : {}),
      ...(opts.disabledBuiltInTools?.length
        ? { disabledBuiltInTools: [...opts.disabledBuiltInTools] }
        : {}),
      ...(Object.keys(agents).length > 0 ? { agents } : {}),
      ...(systemMessage ? { systemMessage } : {}),
      ...(opts.projectContext === false ? { projectContext: false } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      onPermissionRequest: permissionHandler,
    };

    let sdkSession: LocalSessionSubset;
    try {
      sdkSession = await withSessionStartTimeout(
        opts.sessionId,
        "createSession",
        actualClient.createSession(sessionConfig),
        (lateSession) => waitForDisconnect(opts.sessionId, lateSession.disconnect()),
      );
    } catch (error) {
      this.deleteHookTrackingForSession(opts.sessionId);
      await this.backend.releaseMcpSession?.(opts.sessionId);
      throw error;
    }

    this.wireEvents(opts.sessionId, sdkSession);
    this.backend.setActiveSession(opts.sessionId, sdkSession);
    if (opts.importConversationState && opts.conversationState)
      this.pendingHandoffs.set(opts.sessionId, opts.conversationState);
    this.bindPeerSession(opts.sessionId, selection);

    return {
      sessionId: opts.sessionId,
      backendId: sdkSession.sessionId,
    };
  }

  async resume(sessionId: string, opts: CreateSessionOpts): Promise<SessionHandle> {
    const selection = await selectSessionClient(this.backend, opts.model);
    const actualClient = selection.client;

    opts.assertWorkspaceCurrent?.();
    const effectiveWorkspaceDir = opts.workspaceDir ?? this.backend.getWorkspaceDir();
    const mcpConfig = this.backend.prepareMcpConfig
      ? await this.backend.prepareMcpConfig(sessionId, opts.workspaceDir, opts.playwrightHeadless)
      : this.backend.getMcpConfig(opts.workspaceDir, opts.playwrightHeadless, sessionId);
    const hooks = this.buildHooks(sessionId, opts.isAutomatedSession ?? false);
    const permissionHandler = this.buildPermissionHandler(sessionId);
    const { tools: allTools, availableTools } = restrictToolSurface(
      this.buildAllTools(sessionId, effectiveWorkspaceDir),
      resolveSessionToolAllowlist(opts.runtimeAgentRole, opts.allowedTools),
      { failOnUnknown: opts.backendId === undefined },
    );
    this.hostToolNamesBySession.set(
      sessionId,
      allTools.map((tool) => tool.name),
    );

    const systemMessage = toRuntimeSystemMessage(opts.systemMessage, opts.systemMessageMode);
    const agents = runtimeAgentDefinitions(effectiveWorkspaceDir, opts.projectContext);

    const sessionConfig: RuntimeSessionConfig = {
      ...(opts.conversationState ? { conversationState: opts.conversationState } : {}),
      clientName: `${APP_NAME}/${app.getVersion()}`,
      model: selection.model,
      reasoningEffort: opts.reasoningEffort,
      contextTier: opts.contextTier,
      streaming: true,
      workingDirectory: effectiveWorkspaceDir,
      includeSubAgentStreamingEvents: false,
      ...(!availableTools && Object.keys(mcpConfig).length > 0 ? { mcpServers: mcpConfig } : {}),
      hooks,
      tools: allTools,
      ...(availableTools ? { availableTools } : {}),
      ...(opts.disabledBuiltInTools?.length
        ? { disabledBuiltInTools: [...opts.disabledBuiltInTools] }
        : {}),
      ...(Object.keys(agents).length > 0 ? { agents } : {}),
      ...(systemMessage ? { systemMessage } : {}),
      ...(opts.projectContext === false ? { projectContext: false } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      onPermissionRequest: permissionHandler,
    };

    await logSessionConfigTrace(
      {
        sessionId,
        operation: opts.backendId ? "resumeSession" : "createSession",
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        contextTier: opts.contextTier,
        effectiveWorkspaceDir,
        tools: allTools,
        availableTools,
        mcpServers: availableTools ? {} : mcpConfig,
        systemMessage: opts.systemMessage,
        systemMessageMode: opts.systemMessageMode,
        sessionSource: opts.sessionSource,
        systemMessageProfile: opts.systemMessageProfile,
        hasRepositoryAgent: opts.hasRepositoryAgent,
        projectContext: opts.projectContext,
      },
      this.backend.getSessionConfigTraceFilename?.() ?? "m-local-session-config-trace.jsonl",
    );

    opts.assertWorkspaceCurrent?.();
    let sdkSession: LocalSessionSubset;

    // If a backendId is provided, try the SDK's native resumeSession
    // which restores full conversation history from disk.
    try {
      if (opts.backendId) {
        sdkSession = await withSessionStartTimeout(
          sessionId,
          "resumeSession",
          actualClient.resumeSession(opts.backendId, sessionConfig),
          (lateSession) => waitForDisconnect(sessionId, lateSession.disconnect()),
        );
      } else {
        // Fallback: create a new session with context injected via system message.
        sdkSession = await withSessionStartTimeout(
          sessionId,
          "createSession",
          actualClient.createSession(sessionConfig),
          (lateSession) => waitForDisconnect(sessionId, lateSession.disconnect()),
        );
      }
    } catch (error) {
      this.deleteHookTrackingForSession(sessionId);
      await this.backend.releaseMcpSession?.(sessionId);
      throw error;
    }

    this.wireEvents(sessionId, sdkSession);
    this.backend.setActiveSession(sessionId, sdkSession);
    const replacementHandoff = sdkSession.takeResumeHandoff?.();
    if (replacementHandoff) this.pendingHandoffs.set(sessionId, replacementHandoff);
    else if (opts.importConversationState && opts.conversationState)
      this.pendingHandoffs.set(sessionId, opts.conversationState);
    this.bindPeerSession(sessionId, selection);

    return {
      sessionId,
      backendId: sdkSession.sessionId,
    };
  }

  private bindPeerSession(sessionId: string, selection: SessionClientSelection): void {
    if (selection.peerRuntimeId) {
      this.backend
        .getPeerClients?.()
        .bindSession(sessionId, selection.peerRuntimeId, selection.client);
    }
  }

  async destroy(sessionId: string): Promise<void> {
    this.pendingHandoffs.delete(sessionId);
    this.deleteHookTrackingForSession(sessionId);
    const session = this.backend.getActiveSession(sessionId);
    const sessionClient =
      this.backend.getPeerClients?.().releaseSession(sessionId) ?? this.backend.getClient();
    // Remove the provider entry before fallible cleanup. SessionManager drops
    // its matching handle even when destroy rejects; retaining this entry would
    // permanently inflate activeSessionCount with an unevictable orphan.
    this.backend.deleteActiveSession(sessionId);
    this.dropExecutionForSession(sessionId);
    this.clearSdkEventSubscription(sessionId);
    try {
      await this.backend.releaseMcpSession?.(sessionId);
      if (session) {
        // Clean up SDK-persisted disk state
        try {
          await sessionClient?.deleteSession?.(session.sessionId);
        } catch {
          /* best-effort — session may not exist on disk */
        }
        await session.destroy();
      }
    } finally {
      this.backend.deleteSessionSubscribers(sessionId);
      this.mcpToolCallIdQueues.delete(sessionId);
      this.pendingBrowserWritePathsByName.delete(sessionId);
      this.pendingBrowserWritePathsById.delete(sessionId);
      this.clearInflightReads(sessionId);
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    this.pendingHandoffs.delete(sessionId);
    this.deleteHookTrackingForSession(sessionId);
    this.backend.getPeerClients?.().releaseSession(sessionId);
    await this.backend.releaseMcpSession?.(sessionId);
    const session = this.backend.getActiveSession(sessionId);
    this.dropExecutionForSession(sessionId);
    this.clearSdkEventSubscription(sessionId);
    if (session) {
      this.backend.deleteActiveSession(sessionId);
      await waitForDisconnect(sessionId, session.disconnect());
    }
    this.backend.deleteSessionSubscribers(sessionId);
    this.mcpToolCallIdQueues.delete(sessionId);
    this.pendingBrowserWritePathsByName.delete(sessionId);
    this.pendingBrowserWritePathsById.delete(sessionId);
    this.clearInflightReads(sessionId);
  }

  async compact(sessionId: string): Promise<void> {
    const session = this.backend.getActiveSession(sessionId);
    if (!session) {
      throw new Error(`No active runtime session for: ${sessionId}`);
    }
    if (!session.rpc?.history?.compact) {
      throw new Error("Provider does not support session compaction.");
    }
    await session.rpc.history.compact();
  }

  private clearInflightReads(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.inFlightReadPermissions.keys()) {
      if (key.startsWith(prefix)) this.inFlightReadPermissions.delete(key);
    }
  }

  private clearSdkEventSubscription(sessionId: string): void {
    this.sdkEventSubscriptionTokens.delete(sessionId);
    const unsubscribe = this.sdkEventUnsubscribers.get(sessionId);
    if (!unsubscribe) return;
    this.sdkEventUnsubscribers.delete(sessionId);
    try {
      unsubscribe();
    } catch (err) {
      log.with({ sessionId }).warn("SDK session event unsubscribe failed:", err);
    }
  }

  getCapabilities(): ExecutionCapabilities {
    return {
      version: EXECUTION_ENVELOPE_VERSION,
      maxConcurrentRuns: null,
      concurrency: "backend-managed",
      correlation: "session-native",
      cancellation: "exact-run",
      idempotency: "local-run-id",
      eventSequence: "transport-order",
    };
  }

  async startRun(
    sessionId: string,
    payload: SendPayload,
    options: StartExecutionRunOptions = {},
  ): Promise<ExecutionRunEnvelope> {
    const session = this.backend.getActiveSession(sessionId);
    if (!session) {
      throw new Error(`No active backend session for: ${sessionId}`);
    }

    const localRunId = options.localRunId ?? randomUUID();
    const existing =
      this.activeRunsByLocalId.get(localRunId) ?? this.completedRunsByLocalId.get(localRunId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error(
          `LocalBackend.startRun: localRunId ${localRunId} belongs to another session`,
        );
      }
      const inflight = this.inflightStarts.get(localRunId);
      if (inflight) return inflight;
      return existing;
    }
    if (this.activeLocalRunBySession.has(sessionId)) {
      throw new ExecutionConcurrencyLimitError(1, 1);
    }

    const handoff = this.pendingHandoffs.get(sessionId);
    const sendPayload: RuntimeSendOptions = {
      prompt: handoff ? handoffUserPrompt(handoff, payload.prompt) : payload.prompt,
      attachments: payload.attachments,
    };

    const envelope: ExecutionRunEnvelope = {
      version: EXECUTION_ENVELOPE_VERSION,
      localRunId,
      backendRunId: localRunId,
      sessionId,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      startedAtMs: Date.now(),
    };
    this.activeRunsByLocalId.set(localRunId, envelope);
    this.activeLocalRunBySession.set(sessionId, localRunId);
    const executionEpoch = this.executionEpoch;

    const promise = session
      .send(sendPayload)
      .then(() => {
        const accepted =
          this.activeRunsByLocalId.get(localRunId) === envelope ||
          this.completedRunsByLocalId.get(localRunId) === envelope;
        if (executionEpoch !== this.executionEpoch || !accepted) {
          throw new Error(
            `LocalBackend.startRun: runtime changed before ${localRunId} was acknowledged`,
          );
        }
        if (handoff && this.pendingHandoffs.get(sessionId) === handoff) {
          this.pendingHandoffs.delete(sessionId);
          this.backend
            .ensureSessionSubscribers(sessionId)
            .forEach((listener) => listener({ type: "context-imported" }));
        }
        return envelope;
      })
      .catch((error: unknown) => {
        this.dropExecutionRun(envelope);
        throw error;
      })
      .finally(() => {
        if (this.inflightStarts.get(localRunId) === promise) {
          this.inflightStarts.delete(localRunId);
        }
      });
    this.inflightStarts.set(localRunId, promise);
    return promise;
  }

  async cancelRun(localRunId: string): Promise<ExecutionCancelResult> {
    const envelope = this.activeRunsByLocalId.get(localRunId);
    if (!envelope) return { localRunId, cancelled: false };
    const session = this.backend.getActiveSession(envelope.sessionId);
    this.dropExecutionRun(envelope);
    if (!session) {
      return { localRunId, cancelled: false };
    }
    void session.abort().catch((err: unknown) => {
      log.with({ sessionId: envelope.sessionId }).warn("SDK abort failed:", err);
    });
    return { localRunId, cancelled: true };
  }

  subscribeRun(localRunId: string, listener: (event: ExecutionEventEnvelope) => void): Unsubscribe {
    let listeners = this.runSubscribers.get(localRunId);
    if (!listeners) {
      listeners = new Set();
      this.runSubscribers.set(localRunId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.runSubscribers.delete(localRunId);
    };
  }

  async send(
    sessionId: string,
    payload: SendPayload,
    options?: StartExecutionRunOptions,
  ): Promise<void> {
    if (
      this.activeLocalRunBySession.has(sessionId) &&
      options?.localRunId !== this.activeLocalRunBySession.get(sessionId) &&
      this.backend.capabilities?.().busyTurnSteer
    ) {
      const session = this.backend.getActiveSession(sessionId);
      if (!session) throw new Error(`No active backend session for: ${sessionId}`);
      await session.send({ prompt: payload.prompt, attachments: payload.attachments });
      return;
    }
    await this.startRun(sessionId, payload, options);
  }

  async abort(sessionId: string): Promise<SessionAbortResult> {
    const localRunId = this.activeLocalRunBySession.get(sessionId);
    if (localRunId) {
      const envelope = this.activeRunsByLocalId.get(localRunId);
      if (!envelope) return {};
      const session = this.backend.getActiveSession(sessionId);
      this.dropExecutionRun(envelope);
      if (session) await session.abort();
      return {};
    }
    return {};
  }

  async initiateMcpOAuth(
    sessionId: string,
    serverName: string,
    options?: McpOAuthLoginOptions,
  ): Promise<{ authorizationUrl?: string }> {
    const session = this.backend.getActiveSession(sessionId);
    if (!session) {
      throw new Error(`No active runtime session for ${sessionId}`);
    }
    const oauth = session.rpc?.mcp?.oauth;
    if (!oauth) {
      throw new Error("This runtime session does not expose MCP OAuth.");
    }
    // The SDK does a strict `mcpServers[serverName]` lookup against the keys we
    // registered in `buildMcpConfig`, which normalizes user-facing display
    // names ("Power BI") to config keys ("power_bi"). Normalize here so the
    // IPC layer can keep passing display names without leaking the SDK's
    // key convention.
    return oauth.login({
      serverName: toMcpServerKey(serverName),
      forceReauth: options?.forceReauth,
      clientName: "Marshal",
      callbackSuccessMessage:
        "Authentication successful. You can close this window and return to Marshal.",
    });
  }

  subscribe(sessionId: string, listener: (event: BackendEvent) => void): Unsubscribe {
    const subs = this.backend.ensureSessionSubscribers(sessionId);
    subs.add(listener);
    return () => {
      subs.delete(listener);
    };
  }

  async setModel(
    sessionId: string,
    model: string,
    options?: { reasoningEffort?: ReasoningEffort },
  ): Promise<void> {
    const session = this.backend.getActiveSession(sessionId);
    if (session) {
      await session.setModel(modelForSessionSwitch(this.backend, sessionId, model), options);
    }
  }

  activeSessionCount(): number {
    return this.backend.activeSessionCount();
  }

  activeSessionIds(): string[] {
    return this.backend.activeSessionIds();
  }

  async getHistory(_id: string): Promise<SessionMessage[]> {
    // Local runtimes persist messages locally; SessionManager reads them from disk
    // before ever calling into the backend. The shared hydrate helper
    // (hydrateRemoteSessionHistory in SessionManager) invokes this uniformly
    // across backends — returning `[]` lets that helper run unconditionally
    // without an optional-chain guard (rule 3: implementable by any backend).
    return [];
  }

  async exportConversationState(
    sessionId: string,
    source?: { runtimeId: string; accountId?: string; backendId: string; workingDirectory: string },
    options?: { allowCompaction?: boolean },
  ): Promise<import("../../../common/runtime-conversation-state").RuntimeConversationState | null> {
    const session = this.backend.getActiveSession(sessionId);
    if (session?.exportConversationState) return session.exportConversationState(options);
    if (!source) return null;
    const peers = this.backend.getPeerClients?.();
    if (!peers)
      throw new Error(`The ${source.runtimeId} runtime is unavailable for context export.`);
    const client = await peers.clientForRuntime({
      runtimeId: source.runtimeId,
      accountId: source.accountId,
    });
    if (client.readConversationState)
      return client.readConversationState(source.backendId, source.workingDirectory, options);
    // A requested handoff may need native compaction to expose retained context.
    // Keep the source detached from this chat's execution runtime.
    const retained = await withSessionStartTimeout(
      sessionId,
      "resumeSession",
      client.resumeSession(source.backendId, {
        workingDirectory: source.workingDirectory,
        cwd: source.workingDirectory,
        tools: [],
        availableTools: [],
        mcpServers: {},
        onPermissionRequest: async () => ({ kind: "reject" }),
      }),
      (lateSession) => waitForDisconnect(sessionId, lateSession.disconnect()),
    );
    try {
      return retained.exportConversationState
        ? await retained.exportConversationState(options)
        : null;
    } finally {
      await waitForDisconnect(sessionId, retained.disconnect());
    }
  }

  async fetchSessionData(_indexEntry: SessionMetadata): Promise<StoredSession | null> {
    // Rule-3 symmetric: both backends implement; local runtimes return null because
    // atomic index/data writes mean a missing data file = corruption, not a
    // remote-fetch opportunity.
    return null;
  }

  async subscribeToRemoteEvents(_listener: (evt: RemoteSessionEvent) => void): Promise<() => void> {
    // Local sessions have no remote → local event stream. Runtime session state
    // lives in memory + LocalSessionStore on disk; there is no push channel
    // from a remote authority. Returning a no-op unsubscribe keeps
    // SessionManager backend-agnostic.
    return () => {};
  }

  async applyConfigChange(_sessionId: string, recreate: () => Promise<void>): Promise<void> {
    // SDK session config (mcpServers, hooks, systemMessage, tool policy) is
    // locked at createSession time. The only way to apply changes is to
    // destroy the session and recreate it with fresh config. SessionManager
    // passes `recreate` — a closure around its destroy+createBackendSession
    // orchestration — so all the existing pendingSessionCreations /
    // sessionHandles guards stay in one place.
    await recreate();
  }

  async notifyRenamed(_sessionId: string, _newName: string): Promise<void> {
    // Local-first backend: SessionManager already persisted the new name to
    // disk. Nothing else to do — no remote label to push.
  }

  /** @internal */ clearExecutionState(): void {
    for (const reset of this.hookTrackingResetters.values()) reset();
    this.hookTrackingResetters.clear();
    this.hookExecutionCorrelators.clear();
    this.executionEpoch += 1;
    for (const sessionId of this.sdkEventUnsubscribers.keys()) {
      this.clearSdkEventSubscription(sessionId);
    }
    this.activeRunsByLocalId.clear();
    this.activeLocalRunBySession.clear();
    this.completedRunsByLocalId.clear();
    this.inflightStarts.clear();
    this.runSubscribers.clear();
    this.hostToolNamesBySession.clear();
    this.pendingHandoffs.clear();
  }

  private buildAllTools(
    sessionId: string,
    // The session's effective working directory (per-session for workspace-scoped
    // sessions; global otherwise) — the confinement boundary the Marshal filesystem
    // self-tools scope to, so a workspace-scoped session stays scoped to its folder.
    workspaceDir: string,
  ): RuntimeTool[] {
    const selfToolDeps = this.backend.getSelfToolDeps();
    const exclusiveTools = selfToolDeps?.sessionManager.getExclusiveSessionTools(sessionId);
    if (exclusiveTools) return [...exclusiveTools];
    const rawSelfTools = selfToolDeps
      ? getSelfTools({ ...selfToolDeps, currentSessionId: sessionId })
      : [];
    const selfTools = selfToolDeps
      ? rawSelfTools.map((tool) => {
          const abortAware = tool.supportsAbortSignal;
          if (!abortAware || !tool.handler || NEVER_BACKGROUND_TOOL_NAMES.has(tool.name)) {
            return tool;
          }
          const handler = tool.handler;
          return {
            ...tool,
            handler: (args: unknown, invocation: RuntimeToolInvocation) =>
              runToolWithBackgrounding({
                manager: selfToolDeps.sessionManager,
                sessionId,
                toolCallId: invocation.toolCallId,
                toolName: tool.name,
                enableAbortSignal: true,
                run: (signal) => handler(args, { ...invocation, signal }),
                detachedResult: ({ handle }) => backgroundToolObservation(tool.name, handle),
              }),
          };
        })
      : rawSelfTools;
    const policy = this.backend.getPermissionPolicy();
    const selfFsTools = selfToolDeps
      ? getSelfFsTools({
          getWorkspaceDir: () => workspaceDir,
          getEffectiveFolderGrants: () =>
            policy?.getEffectiveFolderGrants(sessionId) ?? { read: [], write: [] },
          settingsManager: selfToolDeps.settingsManager,
        })
      : [];
    return [...selfTools, ...selfFsTools];
  }

  // MCP toolCallId lookup — the CLI sends tool.execution_start (with toolCallId)
  // before calling onPermissionRequest (without toolCallId for MCP tools).
  // We capture IDs here so the permission handler can resolve them.
  // See: github/copilot-sdk#887, github/copilot-cli#989.
  //
  // Per-session, per-toolName queues. Entries from auto-approved tools that never
  // trigger onPermissionRequest stay unconsumed — this is harmless since MCP tool
  // names don't overlap with non-MCP tool names. Capped at 500 entries per tool
  // name as a safety bound; evicts the oldest half when full.
  private mcpToolCallIdQueues = new Map<string, Map<string, string[]>>();
  // Stage 1 (onPreToolUse): per-session FIFO paths by bare tool name — toolCallId not yet known.
  private pendingBrowserWritePathsByName = new Map<string, Map<string, string[]>>();
  // Stage 2 (tool.execution_start): per-session paths promoted to toolCallId key.
  private pendingBrowserWritePathsById = new Map<string, Map<string, string>>();
  private sdkEventUnsubscribers = new Map<string, () => void>();
  private sdkEventSubscriptionTokens = new Map<string, object>();
  // SDK fires onPermissionRequest twice per read; coalescing prevents a double card.
  private inFlightReadPermissions = new Map<string, Promise<RuntimePermissionResult>>();
  private hookTrackingResetters = new Map<string, () => void>();
  private hookExecutionCorrelators = new Map<
    string,
    {
      correlateStart: (
        toolNames: readonly string[],
        toolArgs: unknown,
        toolCallId: string,
      ) => boolean;
      takeCompletion: (toolCallId: string) => string | undefined;
    }
  >();

  private wireEvents(sessionId: string, sdkSession: LocalSessionSubset): void {
    this.clearSdkEventSubscription(sessionId);
    const subscriptionToken = {};
    this.sdkEventSubscriptionTokens.set(sessionId, subscriptionToken);
    const unsubscribe = sdkSession.on((event) => {
      if (this.sdkEventSubscriptionTokens.get(sessionId) !== subscriptionToken) return;
      // Capture toolCallId from tool.execution_start for MCP permission handler workaround
      if (event.type === "tool.execution_start") {
        const { toolName, toolCallId, arguments: toolArgs, mcpToolName } = event.data;
        if (toolName && toolCallId) {
          const correlator = this.hookExecutionCorrelators.get(sessionId);
          correlator?.correlateStart(
            mcpToolName ? [toolName, mcpToolName] : [toolName],
            toolArgs,
            toolCallId,
          );

          let sessionQueue = this.mcpToolCallIdQueues.get(sessionId);
          if (!sessionQueue) {
            sessionQueue = new Map();
            this.mcpToolCallIdQueues.set(sessionId, sessionQueue);
          }
          const queue = sessionQueue.get(toolName) ?? [];
          if (queue.length >= 500) {
            queue.splice(0, Math.floor(queue.length / 2));
          }
          queue.push(toolCallId);
          sessionQueue.set(toolName, queue);

          // Promote staged browser write path from name-based queue to toolCallId key.
          const bareName = getBarePlaywrightToolName(toolName);
          const sessionNameQueues = this.pendingBrowserWritePathsByName.get(sessionId);
          const nameQueue = sessionNameQueues?.get(bareName);
          if (nameQueue?.length) {
            let sessionIdQueues = this.pendingBrowserWritePathsById.get(sessionId);
            if (!sessionIdQueues) {
              sessionIdQueues = new Map();
              this.pendingBrowserWritePathsById.set(sessionId, sessionIdQueues);
            }
            sessionIdQueues.set(toolCallId, nameQueue.shift()!);
            if (nameQueue.length === 0) sessionNameQueues!.delete(bareName);
          }
        }
      }
      if (event.type === "tool.execution_complete")
        this.hookExecutionCorrelators.get(sessionId)?.takeCompletion(event.data.toolCallId);

      const backendEvents = normalizeEvent(event);
      for (const be of backendEvents) {
        // Log raw error for diagnostics before it gets formatted for the UI.
        // This is the only logging point for session.error events (CAPIError 499 etc.)
        // — they don't flow through onErrorOccurred.
        if (be.type === "turn-error") {
          log.with({ sessionId }).error(`turn-error: ${be.error}`);
        }
        this.emit(sessionId, be);
      }
    });
    this.sdkEventUnsubscribers.set(sessionId, unsubscribe);
  }

  private emit(sessionId: string, event: BackendEvent): void {
    const subs = this.backend.getSessionSubscribers(sessionId);
    if (subs) {
      for (const listener of subs) {
        try {
          listener(event);
        } catch (err) {
          log.with({ sessionId }).error(`Event listener error:`, err);
        }
      }
    }

    const localRunId = this.activeLocalRunBySession.get(sessionId);
    const envelope = localRunId ? this.activeRunsByLocalId.get(localRunId) : undefined;
    const runListeners = localRunId ? this.runSubscribers.get(localRunId) : undefined;
    if (envelope && runListeners) {
      const runEvent: ExecutionEventEnvelope = {
        version: EXECUTION_ENVELOPE_VERSION,
        localRunId: envelope.localRunId,
        backendRunId: envelope.backendRunId,
        sessionId: envelope.sessionId,
        event,
      };
      for (const listener of runListeners) {
        try {
          listener(runEvent);
        } catch (err) {
          log.with({ sessionId }).error("Run event listener error:", err);
        }
      }
    }
    if (
      envelope &&
      (event.type === "idle" || (event.type === "turn-error" && event.retrying !== true))
    ) {
      this.completeExecutionRun(envelope);
    }
  }

  private completeExecutionRun(envelope: ExecutionRunEnvelope): void {
    if (!this.dropExecutionRun(envelope)) return;
    this.completedRunsByLocalId.set(envelope.localRunId, envelope);
    while (this.completedRunsByLocalId.size > MAX_RETAINED_RUNS) {
      const oldest = this.completedRunsByLocalId.keys().next().value;
      if (oldest) this.completedRunsByLocalId.delete(oldest);
    }
  }

  private dropExecutionRun(envelope: ExecutionRunEnvelope): boolean {
    if (this.activeRunsByLocalId.get(envelope.localRunId) !== envelope) return false;
    this.activeRunsByLocalId.delete(envelope.localRunId);
    if (this.activeLocalRunBySession.get(envelope.sessionId) === envelope.localRunId) {
      this.activeLocalRunBySession.delete(envelope.sessionId);
    }
    this.runSubscribers.delete(envelope.localRunId);
    return true;
  }

  private dropExecutionForSession(sessionId: string): void {
    const localRunId = this.activeLocalRunBySession.get(sessionId);
    if (!localRunId) return;
    const envelope = this.activeRunsByLocalId.get(localRunId);
    if (envelope) this.dropExecutionRun(envelope);
  }

  private buildHooks(sessionId: string, isAutomated: boolean): RuntimeSessionHooks {
    const slog = log.with({ sessionId });
    type HookToolTracking = {
      keys: string[];
      toolName: string;
      toolCallId: string;
      startedAtMs: number;
      rawToolCallId?: string;
    };
    type RawToolTracking = {
      keys: string[];
      toolNames: string[];
      toolCallId: string;
    };
    const hookToolQueues = new Map<string, HookToolTracking[]>();
    const hookToolsById = new Map<string, HookToolTracking>();
    const hookToolsByRawId = new Map<string, HookToolTracking>();
    const unmatchedRawTools: RawToolTracking[] = [];

    this.hookTrackingResetters.get(sessionId)?.();
    this.hookTrackingResetters.set(sessionId, () => {
      hookToolQueues.clear();
      hookToolsById.clear();
      hookToolsByRawId.clear();
      unmatchedRawTools.length = 0;
    });

    function shouldTrackRunningTool(toolName: string): boolean {
      return toolName !== "report_intent" && toolName !== "askUser";
    }

    function hookToolKey(input: { toolName: string; toolArgs?: unknown }): string {
      // SDK passes toolArgs as string in pre-hook but parsed object in post-hook.
      // Normalize by always parsing then re-stringifying for stable keys.
      let args: string;
      if (typeof input.toolArgs === "string") {
        try {
          args = JSON.stringify(JSON.parse(input.toolArgs)); // eslint-disable-line @typescript-eslint/no-unsafe-argument -- SF-4: trusted SDK tool args from internal event; immediately re-serialized
        } catch {
          args = input.toolArgs;
        }
      } else {
        args = JSON.stringify(input.toolArgs) ?? "";
      }
      return `${input.toolName}:${args}`;
    }

    function recordToolStart(input: PreToolUseHookInput): HookToolTracking {
      const keys = [hookToolKey(input)];
      const toolCallId = input.toolCallId ?? randomUUID();
      const tracking = { keys, toolName: input.toolName, toolCallId, startedAtMs: Date.now() };
      for (const key of keys) {
        const queue = hookToolQueues.get(key) ?? [];
        queue.push(tracking);
        hookToolQueues.set(key, queue);
      }
      hookToolsById.set(toolCallId, tracking);
      const exactRawIndex = unmatchedRawTools.findIndex((raw) =>
        raw.keys.some((key) => keys.includes(key)),
      );
      const sameNameRawIndexes = unmatchedRawTools
        .map((raw, index) => (raw.toolNames.includes(input.toolName) ? index : -1))
        .filter((index) => index >= 0);
      const rawIndex =
        exactRawIndex >= 0
          ? exactRawIndex
          : sameNameRawIndexes.length === 1
            ? sameNameRawIndexes[0]
            : -1;
      if (rawIndex >= 0) {
        const [raw] = unmatchedRawTools.splice(rawIndex, 1);
        if (raw) linkHookTrackingToRaw(tracking, raw.toolCallId);
      }
      return tracking;
    }

    function shortToolCallId(toolCallId: string | undefined): string {
      return toolCallId ? toolCallId.slice(0, 12) : "missing";
    }

    function removeHookTracking(tracking: HookToolTracking): void {
      hookToolsById.delete(tracking.toolCallId);
      if (tracking.rawToolCallId) hookToolsByRawId.delete(tracking.rawToolCallId);
      for (const key of tracking.keys) {
        const queue = hookToolQueues.get(key);
        if (!queue) continue;
        const index = queue.indexOf(tracking);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0) hookToolQueues.delete(key);
      }
    }

    function takeHookTracking(input: PostToolUseHookInput | PostToolUseFailureHookInput): {
      toolCallId: string;
      elapsed: number;
    } {
      let tracking = input.toolCallId
        ? (hookToolsById.get(input.toolCallId) ?? hookToolsByRawId.get(input.toolCallId))
        : undefined;
      if (!tracking && !input.toolCallId) {
        const candidates = hookToolQueues.get(hookToolKey(input)) ?? [];
        const correlatedCandidates = candidates.filter(
          (candidate) => candidate.rawToolCallId !== undefined,
        );
        tracking =
          correlatedCandidates.length === 1
            ? correlatedCandidates[0]
            : correlatedCandidates.length === 0
              ? candidates[0]
              : undefined;
      }
      if (tracking) removeHookTracking(tracking);
      return {
        toolCallId: tracking?.toolCallId ?? input.toolCallId ?? input.toolName,
        elapsed: tracking ? Date.now() - tracking.startedAtMs : -1,
      };
    }

    function discardPreHookTracking(toolCallId: string): void {
      const tracking = hookToolsById.get(toolCallId);
      if (tracking) removeHookTracking(tracking);
    }

    function linkHookTrackingToRaw(tracking: HookToolTracking, rawToolCallId: string): void {
      tracking.rawToolCallId = rawToolCallId;
      hookToolsByRawId.set(rawToolCallId, tracking);
    }

    function correlateExecutionStart(
      toolNames: readonly string[],
      toolArgs: unknown,
      rawToolCallId: string,
    ): boolean {
      if (hookToolsByRawId.has(rawToolCallId)) return true;

      let tracking = hookToolsById.get(rawToolCallId);
      if (!tracking) {
        for (const toolName of toolNames) {
          tracking = hookToolQueues
            .get(hookToolKey({ toolName, toolArgs }))
            ?.find((candidate) => candidate.rawToolCallId === undefined);
          if (tracking) break;
        }
      }
      if (!tracking) {
        const candidates = [...hookToolsById.values()].filter(
          (candidate) =>
            candidate.rawToolCallId === undefined && toolNames.includes(candidate.toolName),
        );
        if (candidates.length === 1) tracking = candidates[0];
      }
      if (!tracking || tracking.rawToolCallId !== undefined) {
        if (!unmatchedRawTools.some((raw) => raw.toolCallId === rawToolCallId)) {
          const uniqueToolNames = [...new Set(toolNames)];
          unmatchedRawTools.push({
            keys: uniqueToolNames.map((toolName) => hookToolKey({ toolName, toolArgs })),
            toolNames: uniqueToolNames,
            toolCallId: rawToolCallId,
          });
          if (unmatchedRawTools.length > 500) unmatchedRawTools.shift();
        }
        return false;
      }

      linkHookTrackingToRaw(tracking, rawToolCallId);
      return true;
    }

    this.hookExecutionCorrelators.set(sessionId, {
      correlateStart: correlateExecutionStart,
      takeCompletion: (rawToolCallId) => {
        const tracking = hookToolsByRawId.get(rawToolCallId) ?? hookToolsById.get(rawToolCallId);
        if (!tracking) {
          const rawIndex = unmatchedRawTools.findIndex((raw) => raw.toolCallId === rawToolCallId);
          if (rawIndex >= 0) unmatchedRawTools.splice(rawIndex, 1);
          return undefined;
        }
        removeHookTracking(tracking);
        return tracking.toolCallId;
      },
    });

    // Self-tools (e.g. askUser) return a plain string, wrapped by toSdkTool into an MCP
    // CallToolResult ({ content: [{ type: "text", text }] }) before the SDK surfaces it here
    // as tool_response. `textResultForLlm` is a distinct, Copilot-mock-only shape (see
    // RuntimeToolResultObject) and never matches on the Claude/Codex/Cursor backends.
    function extractAskUserResultText(toolResult: unknown): string {
      if (typeof toolResult === "string") return toolResult;
      if (toolResult !== null && typeof toolResult === "object") {
        if ("content" in toolResult && Array.isArray(toolResult.content)) {
          for (const block of toolResult.content) {
            if (
              block !== null &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string"
            ) {
              return block.text;
            }
          }
        }
        if ("textResultForLlm" in toolResult && typeof toolResult.textResultForLlm === "string") {
          return toolResult.textResultForLlm;
        }
      }
      return "";
    }

    return {
      onPreToolUse: async (toolCall: PreToolUseHookInput) => {
        const { toolName, toolArgs } = toolCall;

        slog.info(`Pre-tool use: ${toolName}`);
        const tracking = recordToolStart(toolCall);
        const trackedToolCallId = tracking.toolCallId;
        slog.info(
          `Pre-tool tracked for policy/timing only: ${toolName} (${shortToolCallId(trackedToolCallId)}); SDK event stream owns tool activity`,
        );
        if (shouldEmitFileActivity(toolName)) {
          this.emit(sessionId, {
            type: "tool-start",
            toolCallId: trackedToolCallId,
            toolName,
            args: toolArgs,
            startedAtMs: Date.now(),
            activityOnly: true,
          });
        }

        const bareToolNameForWrite = getBarePlaywrightToolName(toolName);
        const browserWritePath = extractBrowserWritePath(bareToolNameForWrite, toolArgs);
        if (browserWritePath !== null) {
          let sessionQueues = this.pendingBrowserWritePathsByName.get(sessionId);
          if (!sessionQueues) {
            sessionQueues = new Map();
            this.pendingBrowserWritePathsByName.set(sessionId, sessionQueues);
          }
          const queue = sessionQueues.get(bareToolNameForWrite) ?? [];
          if (queue.length >= 50) queue.shift();
          queue.push(browserWritePath);
          sessionQueues.set(bareToolNameForWrite, queue);
        }

        // Pre-hook checks via PermissionPolicy
        const policy = this.backend.getPermissionPolicy();
        const preHookDeny = policy?.evaluatePreHook({
          sessionId,
          toolCallId: toolCall.toolCallId,
          toolName,
          toolArgs,
          fileUploadEnabled: this.backend.getInterceptFileChooser(),
        });
        if (preHookDeny) {
          slog.info(`Blocking tool ${toolName} — ${preHookDeny.permissionDecisionReason}`);
          discardPreHookTracking(trackedToolCallId);
          return {
            permissionDecision: "deny" as const,
            permissionDecisionReason: preHookDeny.permissionDecisionReason,
          };
        }

        // Block askUser in automated sessions
        if (toolName === "askUser" && isAutomated) {
          discardPreHookTracking(trackedToolCallId);
          return {
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              "askUser is not available in automated sessions. Present options as plain text instead.",
          };
        }

        return {};
      },

      onPostToolUse: async (toolCall: PostToolUseHookInput, _invocation: { sessionId: string }) => {
        const { toolName, toolResult } = toolCall;
        const tracking = takeHookTracking(toolCall);
        const elapsed = tracking.elapsed;
        slog.info(`Post-tool use: ${toolName} (${elapsed}ms)`);

        const trackedToolCallId = tracking.toolCallId;
        if (shouldTrackRunningTool(toolName))
          slog.info(
            `Post-tool tracked for timing only: ${toolName} (${shortToolCallId(trackedToolCallId)}); SDK event stream owns tool completion`,
          );
        if (shouldEmitFileActivity(toolName)) {
          this.emit(sessionId, {
            type: "tool-result",
            toolCallId: trackedToolCallId,
            result: toolResult,
            success: true,
            completedAtMs: Date.now(),
            activityOnly: true,
          });
        }

        // Emit tool-result event for askUser question buffering
        if (toolName === "askUser" && toolResult) {
          try {
            const resultText = extractAskUserResultText(toolResult);
            const parsed = AskUserToolResultSchema.safeParse(JSON.parse(resultText));
            if (parsed.success) {
              // Map AskUserToolResult → BackendEvent question shape
              const options = parsed.data.answers.map((a) => a.title);
              this.emit(sessionId, {
                type: "tool-result",
                toolCallId: toolCall.toolCallId ?? toolName,
                result: toolResult,
                success: true,
                question: {
                  title: parsed.data.question,
                  options,
                  type: "ask_user",
                  answers: parsed.data.answers,
                  recommendedIndex: parsed.data.recommendedIndex,
                },
              });
            } else {
              slog.warn(`Invalid askUser tool result: ${parsed.error.message}`);
            }
          } catch {
            // Malformed tool result (not valid JSON) — silently skip
          }
        }

        return undefined;
      },

      onPostToolUseFailure: async (
        toolCall: PostToolUseFailureHookInput,
        _invocation: { sessionId: string },
      ) => {
        const tracking = takeHookTracking(toolCall);
        slog.info(`Post-tool failure: ${toolCall.toolName} (${tracking.elapsed}ms)`);
        return undefined;
      },

      // Sole source of truth for the model's sense of "today". The system
      // message deliberately omits a date anchor because it's built once at
      // session creation and would disagree with this hook across midnight.
      // See buildUserPromptContext for SDK-level rationale (modifiedPrompt
      // vs. additionalContext).
      onUserPromptSubmitted: (input: UserPromptSubmittedHookInput) => {
        // The runtime already submitted its own continuation for a finished
        // backgrounded task — tell BackgroundTaskManager so it skips its own
        // redundant wake for the same completion instead of racing it into a
        // second turn (see the BackendEvent doc comment on this event type).
        if (input.isBackgroundTaskAutoContinuation) {
          this.emit(sessionId, { type: "background-task-auto-continuation-observed" });
        }
        return buildUserPromptContext(input.prompt, {
          timeZone: this.backend.getTimezone(),
          hostToolNames: this.hostToolNamesBySession.get(sessionId),
          clientViewport: getSessionClientViewport(sessionId),
          viewsSummary: describeSessionViews(sessionId),
        });
      },

      onErrorOccurred: async (error: ErrorOccurredHookInput) => {
        const recoverable = error.recoverable ?? false;
        // The raw SDK error value can be an object; coerce to a string so logs,
        // auth detection, and the user-facing formatter never see "[object Object]".
        const errorText = coerceErrorText(error.error);
        slog.error(
          `Session error: context=${error.errorContext} recoverable=${recoverable} error=${errorText}`,
        );
        // Emit turn-error so SessionManager can detect auth errors and other hook-level failures.
        // `retrying` marks that the SDK retries THIS turn for a recoverable hook error (e.g. a
        // transient model_call failure): collectors and the view treat it as transient, not a
        // terminal turn failure. Distinct from the gateway's `recoverable`, which flags terminal-
        // but-user-retryable errors — those carry no `retrying` and stay fatal for collectors.
        this.emit(sessionId, {
          type: "turn-error",
          error: errorText,
          recoverable,
          retrying: recoverable,
        });
      },
    };
  }

  private deleteHookTrackingForSession(sessionId: string): void {
    this.hookTrackingResetters.get(sessionId)?.();
    this.hookTrackingResetters.delete(sessionId);
    this.hookExecutionCorrelators.delete(sessionId);
  }

  private buildPermissionHandler(sessionId: string): RuntimePermissionHandler {
    return async (incoming, _invocation): Promise<RuntimePermissionResult> => {
      // Auto-approve getSkill — internal mechanism for on-demand skill loading.
      // PermissionRequest in the SDK is typed minimally (kind + toolCallId), but the
      // wire payload carries additional fields like `toolName` for custom-tool / mcp
      // kinds. Read them via property guards to stay lint-clean.
      const incomingToolName = dynamicString(incoming, "toolName");

      // The SDK fires kind:"hook" when onPreToolUse returns "ask"; the actual gate is the
      // subsequent kind:"write" request, so auto-approving the hook avoids a double card.
      if (incoming.kind === "hook" && isSdkHitlRequired(incomingToolName)) {
        this.backend.getPermissionPolicy()?.logPreHookDecision?.({
          sessionId,
          toolCallId: incoming.toolCallId,
          toolName: incomingToolName,
          serverName: "filesystem",
          kind: incoming.kind,
          decision: "approved",
          source: "internal-auto-approve",
          sdkResult: "approved",
        });
        return RUNTIME_APPROVE_ONCE_PERMISSION_RESULT;
      }

      if (incoming.kind === "custom-tool" && incomingToolName === "getSkill") {
        this.backend.getPermissionPolicy()?.logPreHookDecision?.({
          sessionId,
          toolCallId: incoming.toolCallId,
          toolName: "getSkill",
          serverName: "",
          kind: incoming.kind,
          decision: "approved",
          source: "internal-auto-approve",
          sdkResult: "approved",
        });
        return RUNTIME_APPROVE_ONCE_PERMISSION_RESULT;
      }

      const callback = this.backend.getApprovalCallback();
      if (callback) {
        // Resolve toolCallId from the lookup queue when the SDK omits it (MCP tools)
        let resolvedToolCallId = incoming.toolCallId;
        if (!resolvedToolCallId) {
          const sessionQueue = this.mcpToolCallIdQueues.get(sessionId);
          const queue = sessionQueue?.get(incomingToolName);
          if (queue?.length) {
            resolvedToolCallId = queue.shift();
            if (queue.length === 0) sessionQueue!.delete(incomingToolName);
          }
        }

        const resolvers = {
          resolvePendingBrowserPath: (bare: string): string | undefined => {
            // Prefer exact toolCallId match (promoted in wireEvents via tool.execution_start).
            // Fall back to FIFO name queue when execution_start hasn't fired yet (e.g. in tests).
            const sessionIdQueues = this.pendingBrowserWritePathsById.get(sessionId);
            const byId = resolvedToolCallId ? sessionIdQueues?.get(resolvedToolCallId) : undefined;
            if (byId !== undefined) {
              sessionIdQueues!.delete(resolvedToolCallId!);
              return byId;
            }
            const sessionNameQueues = this.pendingBrowserWritePathsByName.get(sessionId);
            const nameQueue = sessionNameQueues?.get(bare);
            if (nameQueue?.length) {
              const path = nameQueue.shift()!;
              if (nameQueue.length === 0) sessionNameQueues!.delete(bare);
              return path;
            }
            return undefined;
          },
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK permission request is a plain object; cast to record for normalizer spread
        const incomingRaw = incoming as unknown as Record<string, unknown>;
        const rawPayload: Record<string, unknown> = {
          ...incomingRaw,
          // Inject the resolved toolCallId so the normalizer captures it even
          // when the SDK omits it (MCP toolCallId lookup workaround).
          toolCallId: resolvedToolCallId,
        };
        const normalized = normalizePermissionRequest(rawPayload, resolvers);

        const request: ApprovalRequest = {
          id: randomUUID(),
          sessionId,
          ...normalized,
        };

        // Coalesce the SDK's duplicate onPermissionRequest calls for the same read.
        if (request.kind === "read" && resolvedToolCallId) {
          const key = `${sessionId}:${resolvedToolCallId}`;
          const inflight = this.inFlightReadPermissions.get(key);
          if (inflight) return inflight;
          const permResult = callback(request).then((decision) => {
            // Keep entry alive: the SDK re-fires the same toolCallId serially after the user responds.
            setTimeout(() => this.inFlightReadPermissions.delete(key), 30_000);
            return approvalResultToRuntimePermission(decision);
          });
          this.inFlightReadPermissions.set(key, permResult);
          return permResult;
        }

        return approvalResultToRuntimePermission(await callback(request));
      }

      // No approval callback set — deny by default for safety.
      // In production, main.ts always wires the callback before session creation.
      // If this fires, it means a wiring bug, not a normal path.
      log
        .with({ sessionId })
        .warn("Permission request with no approval callback — denying for safety");
      this.backend.getPermissionPolicy()?.logPreHookDecision?.({
        sessionId,
        toolCallId: incoming.toolCallId,
        toolName: incomingToolName,
        serverName: "",
        kind: incoming.kind,
        decision: "denied",
        source: "no-callback-fallback",
        sdkResult: "denied-by-rules",
      });
      return RUNTIME_RULE_DENY_PERMISSION_RESULT;
    };
  }
}
