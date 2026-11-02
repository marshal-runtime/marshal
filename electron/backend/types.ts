// electron/backend/types.ts

import type {
  AutomationCreateInput,
  AutomationData,
  AutomationRunData,
  BackendOrigin,
  ConditionStatusRecord,
  CustomMcpServer,
  GatewayAuthIdentity,
  GatewayAuthState,
  HeartbeatControllableMap,
  HeartbeatSettings,
  HeartbeatSettingsEnvelope,
  HeartbeatStatus,
  HeartbeatStatusEnvelope,
  IpcEventMap,
  IpcHandler,
  IpcInvokeMap,
  MSettings,
  McpServerInfo,
  ModelInfo,
  PermissionKind,
  PermissionsConfig,
  PermissionsEnvelope,
  SessionHydrationEvent,
  SessionMessage,
  SessionMetadata,
  SessionRepositoryAgent,
  SessionSandboxConfig,
  SessionSource,
  StoredSession,
} from "../../common/marshal-ipc-contract";
import { normalizeRuntimeId, resolveSessionRuntimeId } from "../../common/runtime-config";
import type { WorkspaceConfigPort } from "./ports";
import type { RuntimeClientFactory, RuntimeSendOptions } from "./runtime-contract";

export type {
  AutomationRunData,
  CustomMcpServer,
  HeartbeatControllableMap,
  HeartbeatSettingsEnvelope,
  HeartbeatSettings,
  HeartbeatStatus,
  HeartbeatStatusEnvelope,
  PermissionKind,
  SessionHydrationEvent,
  SessionMessage,
  SessionMetadata,
  StoredSession,
};

// ── BackendEvent (normalized event contract) ────────────────────────────

export type BackendEvent =
  | { type: "history-snapshot"; messages: SessionMessage[] }
  | { type: "context-imported" }
  | {
      type: "context-checkpoint";
      state: import("../../common/runtime-conversation-state").RuntimeConversationState;
    }
  | { type: "text-delta"; text: string; messageId?: string }
  | { type: "text-snapshot"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-start";
      toolCallId: string;
      toolName: string;
      description?: string;
      args?: unknown;
      serverName?: string;
      startedAtMs?: number;
      activityOnly?: boolean;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      result: unknown;
      success: boolean;
      error?: string;
      completedAtMs?: number;
      activityOnly?: boolean;
      /**
       * Question data from askUser tool results.
       */
      question?: {
        title?: string;
        options?: string[];
        type?: string;
        answers?: Array<{ title: string; description?: string }>;
        recommendedIndex?: number;
      };
    }
  | { type: "turn-complete"; message: CommittedMessage }
  | {
      type: "turn-error";
      error: string;
      recoverable: boolean;
      /** True when the backend is retrying THIS turn (transient recoverable
       *  error). Set by adapters whose runtime retries the current turn; collectors and the
       *  session view treat these as non-fatal rather than terminal. */
      retrying?: boolean;
      code?: string;
      retryAfterMs?: number;
      /** Epoch milliseconds when a usage limit (`code: "usage_limit"`) resets. */
      retryAt?: number;
    }
  | { type: "token-usage"; currentTokens: number; tokenLimit: number }
  /**
   * Real per-turn token spend from a runtime `assistant.usage` event (input +
   * output tokens for the LLM call). Distinct from `token-usage`, which is
   * CONTEXT SIZE (currentTokens/tokenLimit), not incremental spend. Consumed by
   * the GoalEngine to accumulate `GoalState.tokensUsed`.
   */
  | { type: "turn-usage"; inputTokens: number; outputTokens: number }
  | {
      type: "llm-usage";
      usageAvailability?: {
        inputTokens: boolean;
        outputTokens: boolean;
        cachedInputTokens: boolean;
        costUsd: boolean;
      };
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      cost: number;
      duration: number;
      ttftMs: number;
      interTokenLatencyMs: number;
      initiator: string | undefined;
      apiCallId: string | undefined;
      providerCallId: string | undefined;
    }
  | { type: "status"; text: string | null }
  | { type: "metadata-updated"; model?: string; provider?: string }
  | {
      /**
       * MCP server connection status changed (incl. plugin-declared remote servers
       * that require OAuth). Surfaced to the UI so users see when a server is
       * connecting, needs auth, or has failed. Not consumed by TurnAccumulator —
       * forwarded directly via SessionManager.setMcpStatusCallback.
       */
      type: "mcp-server-status";
      serverName: string;
      status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured";
      error?: string;
      source?: string;
    }
  | {
      /**
       * Bundled CLI emits this when an MCP server requires OAuth. The CLI handles
       * the entire OAuth flow internally (browser open, callback server, token
       * persistence) — Marshal only surfaces a notification so the user knows
       * a browser tab is opening.
       */
      type: "mcp-oauth-required";
      requestId: string;
      serverName: string;
      serverUrl: string;
      /**
       * Originating session — added by `SessionManager.subscribeToBackendEvents`
       * BEFORE the event reaches normalize-event consumers. The runtime payload
       * itself does not carry this, but the per-session subscription does, so
       * the SessionManager stamps the id from its closure. Used by the OAuth
       * IPC handler to pick the same session as the executor for
       * `oauth.login`, so the runtime resolves `serverName` against the
       * session config that actually triggered the prompt.
       *
       * Optional because (a) the normalizer cannot supply it (intentionally
       * session-agnostic), and (b) callers that synthesize this event in
       * tests / mocks need not provide it.
       */
      sessionId?: string;
    }
  | {
      /** Bundled CLI completed the OAuth flow for an MCP server. */
      type: "mcp-oauth-completed";
      requestId: string;
    }
  | {
      /**
       * A backgrounded task (backgrounded Bash command, backgrounded Agent
       * subagent) changing state. Not consumed by TurnAccumulator — forwarded
       * directly via SessionManager.setBackgroundTaskCallback, mirroring
       * mcp-server-status.
       */
      type: "background-task-update";
      taskId: string;
      toolCallId?: string;
      status: "started" | "completed" | "failed" | "stopped";
      description?: string;
      summary?: string;
      outputFile?: string;
    }
  | {
      /**
       * The runtime's own machinery submitted its own continuation turn for
       * a finished backgrounded task, on its own initiative — not something
       * SessionManager sent. Lets BackgroundTaskManager skip its own
       * explicit tryWakeSessionForBackgroundTask wake for the same
       * completion instead of racing it into a second, redundant turn. See
       * RuntimeUserPromptSubmittedHookInput.isBackgroundTaskAutoContinuation
       * for the per-backend detection this is derived from.
       */
      type: "background-task-auto-continuation-observed";
    }
  | { type: "idle" };

/**
 * Remote-initiated session index changes. Emitted by backends that hold a
 * server-side authoritative session list (gateway) and consumed by
 * SessionManager.applyRemoteEvent to mutate the local index.
 *
 * CopilotBackend never emits these (no remote authority). GatewayBackend
 * emits `index-snapshot` on connect + `session-upsert`/`session-delete` on
 * live `sessions.changed` events.
 */
export type RemoteSessionEvent =
  | { type: "index-snapshot"; sessions: SessionMetadata[] }
  | { type: "session-upsert"; session: SessionMetadata }
  | { type: "session-delete"; backendId: string };

interface CommittedMessage {
  id: string;
  role: "assistant";
  content: string;
  reasoning?: { text: string; durationSeconds: number | null };
  toolCalls?: MessageToolCall[];
  toolProvenance?: Array<Record<string, unknown>>;
  question?: { title?: string; options?: string[]; type?: string };
}

// ── BackendCapabilities ─────────────────────────────────────────────────
// Canonical definition lives in common/marshal-ipc-contract.ts; re-exported here
// for consumers that import from backend/types.ts.

import type {
  BackendCapabilities,
  ContextTier,
  MessageToolCall,
  ReasoningEffort,
  SessionRuntimeAgentRole,
} from "../../common/marshal-ipc-contract";
export type { BackendCapabilities };

// ── Session types ───────────────────────────────────────────────────────

export interface CreateSessionOpts {
  conversationState?: import("../../common/runtime-conversation-state").RuntimeConversationState;
  importConversationState?: boolean;
  sessionId: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
  systemMessage?: string;
  /** How the runtime should apply systemMessage. "replace" passes it as the
   *  entire system prompt (Claude adapter implements this); adapters that do
   *  not support a mode ignore the field and keep their existing behavior. */
  systemMessageMode?: "append" | "replace";
  /** Session metadata used only by local backend diagnostics. It is not
   *  forwarded to the model or included in the runtime session config. */
  sessionSource?: SessionSource;
  runtimeAgentRole?: SessionRuntimeAgentRole;
  /** Exact host tool names the session may call; undefined = unrestricted. */
  allowedTools?: readonly string[];
  /** False keeps repository rules, skills, memory and agents out of the session; undefined = loaded. */
  projectContext?: boolean;
  /** Native built-in tools to remove from the model's context; adapters without such tools ignore it. */
  disabledBuiltInTools?: readonly string[];
  systemMessageProfile?: "marshal-full" | "sdk-default-subagent-guidance";
  hasRepositoryAgent?: boolean;
  isAutomatedSession?: boolean;
  workspaceDir?: string;
  /** Local fail-closed guard invoked immediately before backend cwd consumption.
   * Never forwarded to the model or serialized into backend requests. */
  assertWorkspaceCurrent?: () => void;
  /** When true, Playwright MCP for this session launches Chromium with
   *  --headless. Used by automation runs that opted in. */
  playwrightHeadless?: boolean;
  /** Backend session id for resume. Server-side identity used by the backend
   *  (local runtime checkpoint id for Copilot, cloud UUID for Gateway). Populated on
   *  subsequent creates to resume rather than create anew. */
  backendId?: string;
  /** Explicit per-session sandbox override forwarded to the runtime adapter. */
  sandbox?: SessionSandboxConfig;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly backendId: string; // server-side identity
}

export interface SessionAbortResult {
  /**
   * Logical session ids whose backend runtime handles were invalidated while
   * satisfying this abort. Usually this is just the aborted session; shared
   * local runtimes may include collateral active sessions.
   */
  invalidatedSessionIds?: string[];
}

export interface McpOAuthLoginResult {
  authorizationUrl?: string;
}

export interface RepositoryAgentDefinition extends SessionRepositoryAgent {
  instructions: string;
  /** Repository convention that contributed this agent definition. */
  source?: "copilot" | "cursor" | "claude";
  /** Optional runtime model declared by the source file's frontmatter. */
  model?: string;
}

export interface SkillProviderRoot {
  id: string;
  directory: string;
  idPrefix: string;
  scope: "local" | "global";
  /** Skill folders are the portable default; command files are normalized as invocable skills. */
  format?: "skill-directories" | "command-files";
  /** File suffix used when format is command-files. */
  fileSuffix?: string;
}

export type SendPayload = RuntimeSendOptions;

export type Unsubscribe = () => void;

// ── Execution plane ────────────────────────────────────────────────────

export const EXECUTION_ENVELOPE_VERSION = 1 as const;

export interface ExecutionCapabilitiesV1 {
  version: typeof EXECUTION_ENVELOPE_VERSION;
  /** null means the backend owns admission and publishes no provider-wide cap. */
  maxConcurrentRuns: number | null;
  concurrency: "backend-managed" | "negotiated" | "legacy-single-run";
  correlation: "session-native" | "backend-run-id";
  cancellation: "exact-run";
  idempotency: "local-run-id" | "wire-key";
  eventSequence: "transport-order" | "monotonic";
}

export type ExecutionCapabilities = ExecutionCapabilitiesV1;

export interface ExecutionRunEnvelopeV1 {
  version: typeof EXECUTION_ENVELOPE_VERSION;
  /** Stable client-side identity. Callers may supply it to make retries idempotent. */
  localRunId: string;
  /** Backend correlation identity; local backends may use localRunId. */
  backendRunId: string;
  sessionId: string;
  /** Present only when the backend forwards an idempotency key on its protocol. */
  idempotencyKey?: string;
  startedAtMs: number;
}

export type ExecutionRunEnvelope = ExecutionRunEnvelopeV1;

export interface ExecutionEventEnvelopeV1 {
  version: typeof EXECUTION_ENVELOPE_VERSION;
  localRunId: string;
  backendRunId: string;
  sessionId: string;
  /** Backend-provided sequence. Absent when only transport ordering is guaranteed. */
  sequence?: number;
  event: BackendEvent;
}

export type ExecutionEventEnvelope = ExecutionEventEnvelopeV1;

export interface StartExecutionRunOptions {
  localRunId?: string;
  idempotencyKey?: string;
}

export interface ExecutionCancelResult extends SessionAbortResult {
  localRunId: string;
  cancelled: boolean;
}

export class ExecutionConcurrencyLimitError extends Error {
  readonly code = "execution-concurrency-limit";

  constructor(
    readonly activeRuns: number,
    readonly maxConcurrentRuns: number,
  ) {
    super(
      `Execution backend admits at most ${maxConcurrentRuns} concurrent run${maxConcurrentRuns === 1 ? "" : "s"}; ${activeRuns} already active`,
    );
    this.name = "ExecutionConcurrencyLimitError";
  }
}

export interface IExecutionBackend {
  getCapabilities(): ExecutionCapabilities;
  startRun(
    sessionId: string,
    payload: SendPayload,
    options?: StartExecutionRunOptions,
  ): Promise<ExecutionRunEnvelope>;
  cancelRun(localRunId: string): Promise<ExecutionCancelResult>;
  subscribeRun(localRunId: string, listener: (event: ExecutionEventEnvelope) => void): Unsubscribe;
}

// ── Infer ───────────────────────────────────────────────────────────────

export interface InferOpts {
  model?: string;
  systemPrompt: string;
  userMessage: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ── Approval ────────────────────────────────────────────────────────────

import type { NormalizedPermissionRequest } from "../permission-request-types";

/**
 * A fully-typed permission request: the normalized discriminated union plus
 * identity fields.
 */
export type ApprovalRequest = NormalizedPermissionRequest & {
  id: string;
  sessionId: string;
  /** Set by the local approval adapter / permission-card-manager after construction. */
  approvalPattern?: string;
};

/** Marshal-owned approval vocabulary; each backend translates at its own boundary. */
export type ApprovalDecision = "approved" | "denied-by-rules" | "denied-interactively-by-user";

/**
 * A policy/security hard-deny that carries an actionable, model-facing reason.
 * The CopilotBackend translates this to the SDK's `reject` result with
 * `feedback`, so the model sees WHY it was blocked (and that it should not
 * retry/work around it) instead of the generic "could not request permission
 * from user" message reserved for genuine no-approver situations.
 */
export type PolicyDenyWithFeedback = {
  kind: "denied-by-policy-with-feedback";
  feedback: string;
};

export type ApprovalResult = ApprovalDecision | PolicyDenyWithFeedback;

export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalResult>;

/**
 * Dependencies passed to `IToolBackend.attachApprovalRouter`. The backend
 * uses these to wire its approval transport into the shared broker:
 *   - `broker`: shared `IApprovalBroker` — both backends route prompts through it.
 *   - `policy`: `IPermissionPolicy` — auto-approve/deny rules + audit hooks.
 *   - `classifier`: LLM-backed shell command classifier (copilot's adapter
 *     uses it to broaden the auto-suggested allow pattern).
 *   - `canShowUI`: gate for whether an interactive prompt can be displayed
 *     (e.g., Electron window not destroyed).
 *
 * Each field is typed as a port interface (`./ports`) — a minimal,
 * role-typed view of the concrete electron-side class. `main.ts` passes the
 * concrete classes that `implements` the port, so the wiring is checked
 * end-to-end without backends having to `as`-cast to recover the surface.
 */
import type {
  IApprovalBroker,
  IBackgroundToolInvocationManager,
  ICommandClassifier,
  IPermissionPolicy,
} from "./ports";
export type {
  IApprovalBroker,
  IBackgroundToolInvocationManager,
  ICommandClassifier,
  IPermissionPolicy,
};

export interface AttachApprovalRouterDeps {
  broker: IApprovalBroker;
  policy: IPermissionPolicy;
  classifier: ICommandClassifier;
  canShowUI: () => boolean;
}

/**
 * Dependencies passed to `IToolBackend.attachDesktopCapabilities`. Drives
 * gateway's `desktop.*` RPC bridge — `executeShell`'s defense-in-depth
 * policy gate and the optional notification click router. Copilot is a
 * no-op (its SDK owns the same surface in-process), so the deps are
 * gateway-load-bearing only.
 */
export interface AttachDesktopCapabilitiesDeps {
  policy: IPermissionPolicy;
  toolInvocationManager: IBackgroundToolInvocationManager;
  /**
   * Click router for `showNotification({ onClickAction.type === "openSession" })`.
   * Optional — absent → click silently ignored (the OS notification still
   * dismisses). Not yet wired in main.ts because the renderer's
   * session-activate IPC contract doesn't exist; the `notifications`
   * capability flag stays `false` until it does.
   */
  onSessionOpenRequested?: (sessionId: string) => void;
}

// ── Sub-interfaces ──────────────────────────────────────────────────────

export interface ISessionBackend {
  defaultModelForRuntime(
    target: import("../../common/runtime-accounts").RuntimeTarget,
  ): Promise<string>;
  /**
   * The model catalog of one runtime account, mapped like the active runtime's own list.
   * Rejects when that account's client cannot list models (typically not signed in).
   */
  listModelsForRuntime(
    target: import("../../common/runtime-accounts").RuntimeTarget,
  ): Promise<ModelInfo[]>;
  exportConversationState(
    sessionId: string,
    source?: {
      runtimeId: string;
      accountId?: string;
      backendId: string;
      workingDirectory: string;
    },
    options?: { allowCompaction?: boolean },
  ): Promise<import("../../common/runtime-conversation-state").RuntimeConversationState | null>;
  listRepositoryAgents(repoRoot: string): RepositoryAgentDefinition[];
  getRepositoryAgentByPath(
    repoRoot: string,
    relativeAgentPath: string,
  ): RepositoryAgentDefinition | null;
  getRepositoryCustomizationsForSystemPrompt(
    repoRoot?: string,
    options?: { lean?: boolean },
  ): string;
  getSkillProviderRoots(repoRoot?: string): SkillProviderRoot[];
  create(opts: CreateSessionOpts): Promise<SessionHandle>;
  resume(sessionId: string, opts: CreateSessionOpts): Promise<SessionHandle>;
  destroy(sessionId: string): Promise<void>;
  send(sessionId: string, payload: SendPayload, options?: StartExecutionRunOptions): Promise<void>;
  abort(sessionId: string): Promise<SessionAbortResult>;
  /** Compact the active session's context without changing its logical identity. */
  compact(sessionId: string): Promise<void>;
  initiateMcpOAuth(
    sessionId: string,
    serverName: string,
    options?: McpOAuthLoginOptions,
  ): Promise<McpOAuthLoginResult>;
  subscribe(sessionId: string, listener: (event: BackendEvent) => void): Unsubscribe;
  /**
   * Set the model for an active session in place, on the session's current
   * runtime. SessionManager uses it for automation model pins and live
   * same-runtime agent switches; UI and cross-runtime switches destroy and
   * recreate the backend session instead (see SessionManager.switchSessionModel).
   */
  setModel(
    sessionId: string,
    model: string,
    options?: { reasoningEffort?: ReasoningEffort },
  ): Promise<void>;

  /**
   * Get message history for a session. Rule-3 symmetric: both backends
   * implement this, copilot as a no-op (returns `[]`) because messages
   * persist locally to disk and SessionManager already reads from there.
   * Gateway delegates to the cloud `chat.history` RPC. Called by the
   * shared `hydrateRemoteSessionHistory` path when a snapshot-discovered
   * session has no local data file yet.
   */
  getHistory(id: string): Promise<SessionMessage[]>;

  /**
   * Fetch a full StoredSession for an index entry whose local data file is
   * missing. Backends with a remote source synthesize the row; local-only
   * backends return null (atomic writes = missing file is corruption).
   * Errors must be swallowed to null so transient failures don't block
   * navigation. Rule-3 symmetric.
   */
  fetchSessionData(indexEntry: SessionMetadata): Promise<StoredSession | null>;

  /**
   * Number of active backend sessions (for pool management).
   * CopilotBackend: count of live SDK session handles.
   * GatewayBackend: 0 (no local session pool).
   */
  activeSessionCount(): number;
  /**
   * IDs represented by activeSessionCount(). Used by shared pool admission to
   * reconcile backend handles that no longer have a SessionManager owner.
   * Gateway returns an empty list because it has no local session pool.
   */
  activeSessionIds(): string[];
  /**
   * Disconnect an SDK session without destroying the logical session.
   * CopilotBackend: pauses the SDK session object to free resources.
   * GatewayBackend: drops local routing state; the durable cloud session can
   * be reconciled and resumed on the next demand.
   */
  disconnect(sessionId: string): Promise<void>;

  // ── Symmetric lifecycle / sync hooks (REQUIRED) ──────────────────────
  // Both backends must implement these. A no-op is allowed when the answer
  // is "nothing to do"; document the reason in a comment on the method body.

  /**
   * Subscribe to remote-initiated session events.
   *
   * Implementations:
   *   - Return a concrete unsubscribe function (never null).
   *   - Handle reconnect internally (re-snapshot + re-subscribe on the new socket).
   *   - Emit `index-snapshot` once immediately if a remote snapshot exists;
   *     otherwise never emit anything.
   *
   * Called once from SessionManager.initClient after backend.init() resolves.
   * Copilot: returns an immediate no-op unsubscribe.
   * Gateway: snapshots sessions.list + subscribes to sessions.changed.
   */
  subscribeToRemoteEvents(listener: (evt: RemoteSessionEvent) => void): Promise<() => void>;

  /**
   * Local config (skills, MCP toggles, file chooser, soul) changed.
   * Backends decide what that means:
   *   - Copilot: SDK config is locked at create time. Calls `recreate()` to tear
   *     down and rebuild the SDK session with fresh config.
   *   - Gateway: config lives server-side. No-op today; becomes the pushConfig()
   *     call site in the follow-up slice.
   *
   * IMPORTANT — concurrency: `recreate` is a callback SessionManager constructs
   * with all its existing `pendingSessionCreations` + `sessionHandles.has(id)`
   * guards in place. Backends must NOT perform recreate work themselves —
   * they only decide whether to invoke the callback.
   */
  applyConfigChange(sessionId: string, recreate: () => Promise<void>): Promise<void>;

  /**
   * A local rename was just persisted by SessionManager. Propagate if needed:
   *   - Copilot: no-op (local disk is authoritative).
   *   - Gateway: fire sessions.patch { label } RPC.
   */
  notifyRenamed(sessionId: string, newName: string): Promise<void>;
}

export interface HeartbeatOperationResult {
  ok: boolean;
  reason?: "not-supported" | "not-ready" | "config-conflict" | "unknown-error";
  message?: string;
}

/** Result of `IPermissionsBackend.updatePermissions`. */
export type PermissionsOperationResult =
  | { ok: true; rejectedShellPatterns?: string[] }
  | { ok: false; reason: "cas-conflict"; latest: PermissionsEnvelope }
  | { ok: false; reason: "validation-error"; message: string }
  | { ok: false; reason: "not-supported" };

export interface IAutomationBackend {
  getHeartbeatConfig(): Promise<HeartbeatSettingsEnvelope>;
  updateHeartbeatConfig(config: Partial<HeartbeatSettings>): Promise<HeartbeatOperationResult>;
  getHeartbeatStatus(): Promise<HeartbeatStatusEnvelope>;
  triggerHeartbeatNow(): Promise<HeartbeatOperationResult>;

  listAutomations(): Promise<AutomationData[]>;
  /**
   * Returns the canonical `AutomationData` (including backend-assigned id,
   * timestamps, any server-normalized fields) so callers don't have to
   * follow up with a `listAutomations()` round-trip. Input is the narrow
   * creation-time subset — the backend fills in id/createdAt/updatedAt and
   * defaults `enabled`.
   */
  createAutomation(def: AutomationCreateInput): Promise<AutomationData>;
  updateAutomation(id: string, patch: Partial<AutomationData>): Promise<void>;
  toggleAutomation(id: string, enabled: boolean): Promise<void>;
  deleteAutomation(id: string): Promise<void>;
  getAutomationRuns(id: string): Promise<AutomationRunData[]>;
  /**
   * Bulk variant of `getAutomationRuns` for the activities panel's
   * "all history" view. Copilot implements as a single O(1) disk scan;
   * gateway fans out to `cron.runs` per automation as a fallback (no bulk
   * RPC exists server-side today — see PR description follow-ups).
   */
  getAllAutomationRuns(): Promise<AutomationRunData[]>;
  /**
   * The run currently executing against this backend (if any). Copilot
   * tracks this via the in-process scheduler; gateway returns null because
   * cron fires asynchronously on marshal and we don't observe a
   * "currently running" state from the operator protocol. Keeping the
   * method on the interface (rule 3: implementable by any backend) means
   * `automations-ipc.ts` routes it polymorphically instead of branching
   * on `backend.origin` — see spec section 4.
   */
  getCurrentRun(): Promise<AutomationRunData | null>;
  /**
   * Fire an automation immediately. Copilot returns the in-process run
   * record (the activities panel's live-run indicator reads from it);
   * gateway returns null because marshal fires cron async and the
   * operator protocol has no synchronous run record.
   */
  triggerAutomationNow(id: string): Promise<AutomationRunData | null>;

  /** Serialize an automation as JSON for round-trip through `importAutomations`. */
  exportAutomation(id: string): Promise<string | null>;

  /**
   * Import automations from JSON (single object or array). On name
   * collision: overwrite when `opts.overwrite`, else skip silently.
   * Returns imported rows (skipped duplicates excluded). UI conflict
   * detection lives at the IPC layer; this commits the decision.
   */
  importAutomations(json: string, opts?: { overwrite?: boolean }): Promise<AutomationData[]>;

  /** Condition-trigger status (all-nulls on backends without conditions). */
  getConditionStatus(automationId: string): Promise<ConditionStatusRecord>;
}

export interface IPermissionsBackend {
  /**
   * Read the effective permissions config for the active backend.
   * Copilot reads from `HeartbeatSettings.permissions` (creating the
   * default shape if absent). Gateway reads marshal's root `tools`
   * subtree via `config.get` and maps it to `PermissionsConfig`.
   */
  getPermissions(): Promise<PermissionsEnvelope>;

  /**
   * Update permissions. Copilot persists via the heartbeat settings
   * file (no concurrency story — local file). Gateway uses
   * `config.patch` with base-hash CAS; on hash conflict, returns
   * `{ ok: false, reason: "cas-conflict", latest }` so the renderer
   * can re-pull and re-apply.
   *
   * Patches are partial: omitted fields stay unchanged. Fields that
   * the backend reports as non-controllable (in `PermissionsControllableMap`)
   * are silently dropped from the patch — the renderer should never
   * write them, but defense-in-depth makes the contract robust.
   */
  updatePermissions(patch: Partial<PermissionsConfig>): Promise<PermissionsOperationResult>;
}

export interface ToolPolicyConfig {
  autoApproveAll: boolean;
  autoApproveReadOnly: boolean;
  allow: string[];
  tools: Record<string, boolean>;
  servers: Record<string, { enabled: boolean; autoApprove: boolean }>;
}

export interface IToolBackend {
  /**
   * Wire this backend's approval transport into the shared broker.
   * Copilot calls into the SDK's permission callback path; gateway
   * registers `desktop.evaluateLocalPolicy` + `desktop.showApprovalCard`
   * WS inbound handlers. Returns a detach fn for shutdown / sign-out.
   *
   * Replaces the older `onApprovalNeeded` / `resolveApproval` pair —
   * neither was implementable by both backends without forking on
   * `backend.origin`. `attachApprovalRouter` is the single polymorphic
   * entry point for all approval-routing wiring.
   */
  attachApprovalRouter(deps: AttachApprovalRouterDeps): () => void;
  /**
   * Wire desktop-only capabilities — the policy gate consulted by
   * `executeShell`'s defense-in-depth re-check, and the optional
   * notification click router. Copilot is a no-op (Rule 3 symmetric):
   * `DesktopCapabilities` is gateway-only — copilot's SDK handles these
   * concerns in-process. Gateway constructs the `desktop.*` RPC bridge
   * lazily on the next `init()`. Returns a detach fn for shutdown / sign-out.
   *
   * Mirrors `attachApprovalRouter`'s shape so `main.ts` doesn't have to
   * downcast on `instanceof GatewayBackend` for backend-specific wiring.
   */
  attachDesktopCapabilities(deps: AttachDesktopCapabilitiesDeps): () => void;
  getToolPolicy(): Promise<ToolPolicyConfig>;
  updateToolPolicy(patch: Partial<ToolPolicyConfig>): Promise<void>;
  getMcpServers(): Promise<McpServerInfo[]>;
  registerLocalMcp(config: LocalMcpConfig): Promise<void>;
  unregisterLocalMcp(name: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;

  /** Synchronous access to cached model list (null if not yet fetched). */
  getCachedModels(): ModelInfo[] | null;

  /** This backend's preferred default — used when there's no stored choice
   *  or the stored one isn't on this backend. Synchronous, cache-only —
   *  must not block on RPC; returns `undefined` if the cache isn't ready. */
  getDefaultModel(): string | undefined;
}

export interface McpOAuthLoginOptions {
  forceReauth?: boolean;
}

export interface LocalMcpConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ── Attachment ──────────────────────────────────────────────────────────

export interface AttachmentUpload {
  type: "file" | "directory";
  path: string;
  displayName?: string;
}

export interface AttachmentRef {
  id: string;
  type: "file" | "directory";
  displayName?: string;
}

// ── RuntimeConfig (pushConfig) ──────────────────────────────────────────

export interface RuntimeConfigPayload {
  skills?: Array<{ name: string; instructions: string }>;
  soul?: { id: string; systemPrompt: string } | null;
  memories?: Array<{ id: string; fact: string; category: string }>;
  disabledServers?: string[];
  browserEnabled?: boolean;
  timezone?: string;
  workspace?: string;
}

// ── DesktopCapabilities (Phase 2 contract) ──────────────────────────────
// 2 RPCs that marshal invokes on the desktop side via the gateway WS:
//   - executeLocalTool:    run a tool locally (filesystem MCP, Playwright, shell, self-tools)
//   - showNotification:    native OS notification
//
// Approval routing — `evaluateLocalPolicy` and `showApprovalCard` — used to
// live here too, but moved to `IToolBackend.attachApprovalRouter` (a single
// polymorphic entry point shared with the copilot backend). Their handler
// factories still live alongside this composition, but they're registered as
// inbound WS RPCs by the gateway's `attachApprovalRouter` impl rather than
// dispatched through this interface + the bridge's RPC list. See spec §5.1
// and `docs/architecture/14-marshal-backend-abstraction.md` for the broader rationale.
//
// Spec authority: docs/specs/gateway-automations-phase-2b-design.md §5.1
// Interface authority: docs/architecture/14-marshal-backend-abstraction.md §269-296.

export interface DesktopCapabilities {
  /** Execute a tool locally (filesystem MCP, Playwright, shell, self-tools). */
  executeLocalTool(request: LocalToolRequest): Promise<LocalToolResult>;

  /** Show native OS notification (heartbeat alerts, task completion). */
  showNotification(notification: NotificationRequest): Promise<void>;

  /** Electron safeStorage for encrypting credentials. */
  safeStorage?: {
    encrypt(plaintext: string): Promise<string>;
    decrypt(encrypted: string): Promise<string>;
  };
}

export interface LocalPolicyRequest {
  /**
   * Permission category — drives the policy pipeline. Cloud-side must classify
   * the tool call before sending: MCP tools → "mcp", shell commands → "shell",
   * first-party host tools → "custom-tool", file reads → "read", file writes →
   * "write", URL navigations → "url". The desktop's PermissionPolicy.evaluate
   * branches on this value, so misclassification skips the right rules.
   */
  kind: PermissionKind;
  toolName: string;
  serverName?: string;
  toolArgs?: unknown;
  sessionId: string;
}

export type PolicyDecision =
  | { action: "approve" }
  | { action: "deny"; reason: string }
  | { action: "prompt" };

export interface ApprovalCardRequest {
  requestId: string;
  /** Permission category — see `LocalPolicyRequest.kind`. */
  kind: PermissionKind;
  toolName: string;
  serverName?: string;
  toolArgs?: unknown;
  sessionId: string;
}

export interface ApprovalCardDecision {
  action: "approve" | "deny";
  rememberFor?: "session" | "always";
}

export interface LocalToolRequest {
  /**
   * Tool category — drives the dispatch path inside `executeLocalTool`. The
   * cloud must classify each call before sending: MCP tools → "mcp", shell
   * commands → "shell", first-party host tools → "custom-tool". Mirrors the
   * `kind` field on `LocalPolicyRequest` and `ApprovalCardRequest` so the
   * three RPCs share a uniform classification.
   */
  kind: PermissionKind;
  toolName: string;
  serverName?: string;
  toolArgs?: unknown;
  sessionId: string;
  toolCallId?: string;
}

export interface LocalToolResult {
  output: unknown;
  success: boolean;
  error?: string;
  backgrounded?: boolean;
  handle?: string;
}

export interface NotificationRequest {
  title: string;
  body: string;
  onClickAction?: { type: "openSession"; sessionId: string };
}

/**
 * Standard error envelope returned by all 5 DesktopCapabilities RPCs when an
 * operation fails. `code` is a closed enum so callers can branch on category;
 * `retryable` lets the cloud decide whether to retry without re-asking the user.
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.4.
 *
 * Wire-format note: today the WS layer only writes `{ code, message }` onto
 * the response envelope. `retryable` and `details` are reserved by the type
 * for the future wire-rev that surfaces them; absence on the wire MUST be
 * treated by the cloud as `retryable = false`. When the wire piping lands,
 * update `ws-client.sendInboundResponse` and the spec to declare them
 * observable.
 */
export type DesktopCapabilityError = {
  code: DesktopCapabilityErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type DesktopCapabilityErrorCode =
  | "policy-deny"
  | "user-deny"
  | "tool-error"
  | "auth-failed"
  | "not-supported"
  | "timeout"
  | "internal";

/**
 * Throwable shape for desktop-capability handlers that have a known error
 * category. The bridge (and ws-client.handleInboundRequest) unwrap `code`
 * onto the wire so the cloud sees `{ code, message }` matching the
 * `DesktopCapabilityError` envelope. Plain `Error` throws fall back to
 * `code: "internal"`.
 *
 * Use `DesktopCapabilityErrorThrow` whenever the handler can classify the
 * failure (e.g. unknown MCP server → `not-supported`, defense-in-depth shell
 * deny → `policy-deny`, credential failure → `auth-failed`). Generic / unknown
 * failures should keep throwing plain `Error` so they bucket as `internal`.
 */
export class DesktopCapabilityErrorThrow extends Error {
  readonly code: DesktopCapabilityErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DesktopCapabilityErrorCode,
    message: string,
    opts?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "DesktopCapabilityErrorThrow";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.details !== undefined) this.details = opts.details;
  }
}

/** Type guard. `DesktopCapabilityErrorThrow` is a real class with a `code`
 *  field set in the constructor — `instanceof` is the natural check. The
 *  prior duck-typed lookup on a runtime code-list defended against a danger
 *  (cross-realm `instanceof`) that doesn't exist in a single Electron main
 *  process. If that ever becomes a real concern, switch to a sentinel
 *  symbol on the prototype rather than a stringly-typed allow-list. */
export function isDesktopCapabilityErrorThrow(
  value: unknown,
): value is DesktopCapabilityErrorThrow {
  return value instanceof DesktopCapabilityErrorThrow;
}

// ── Auth ─────────────────────────────────────────────────────────────────

export interface AuthStatus {
  authenticated: boolean;
  username?: string;
  statusMessage?: string;
  /** Copilot subscription tier (e.g. "enterprise", "business", "individual_pro", "free").
   *  Populated by CopilotBackend via a session-level `auth.getStatus` probe; the renderer
   *  uses this to gate sign-in on enterprise tier. Undefined for backends that don't
   *  expose a plan concept (e.g. GatewayBackend uses AAD, not GitHub Copilot). */
  copilotPlan?: string;
}

/**
 * Result of a backend login flow. The two-phase shape supports both
 * immediate auth (GatewayBackend AAD) and device-flow auth (CopilotBackend):
 * - `login()` resolves with the device code so the UI can display it
 * - `completion` resolves later when the user actually authorizes
 */
export interface LoginResult {
  method?: "browser" | "device-code";
  deviceCode?: string;
  verificationUri?: string;
  /**
   * Resolves when the auth flow completes (e.g., user authorized via device flow).
   * Rejects on failure/timeout. Undefined if login completes synchronously.
   */
  completion?: Promise<void>;
}

// ── Narrow dependency interfaces for IBackendProvider setters ────────────
// Each interface declares only the methods CopilotBackend actually calls,
// so alternative backends (GatewayBackend) can accept narrower types or no-op.

/** Subset of PermissionPolicy used by CopilotBackend's pre-hook and audit paths. */
export interface IPermissionPolicyProvider {
  evaluatePreHook(opts: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    toolArgs?: unknown;
    fileUploadEnabled?: boolean;
  }): { permissionDecision: "deny"; permissionDecisionReason: string } | null;
  logPreHookDecision?(opts: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    serverName: string;
    kind: string;
    decision: "approved" | "denied";
    source: string;
    sdkResult: string;
  }): void;
  /** Effective out-of-workspace folder grants for a session (global + session/entity
   *  additions). Used by the Marshal filesystem tools' realpath guard. */
  getEffectiveFolderGrants(sessionId: string): { read: string[]; write: string[] };
  /** Read-only config-time/live-revocation check for a concrete MCP server key. */
  isMcpServerEnabledForSession?(sessionId: string, serverKey: string): boolean;
}

/** Subset of TenantPolicyProvider used by CopilotBackend for model filtering and MCP config. */
export interface ITenantPolicyProvider {
  get(): {
    restrictToWorkspace?: boolean;
    disabledModels?: string[];
    disabledProviders?: string[];
    disabledServers?: string[];
    browserEgressBlockedOrigins?: string[];
  };
  isTenantManaged(): boolean;
}

/**
 * Subset of HeartbeatManager used by CopilotAutomationBackend and the
 * self-tools layer. `start`/`stop` are only called by the self-tools; the
 * automation backend never touches them. Kept on a single port to avoid a
 * second port class on the same concrete object.
 */
export interface IHeartbeatManager {
  getSettings(): HeartbeatSettings;
  saveSettings(config: Partial<HeartbeatSettings>): boolean | void;
  getStatus(): HeartbeatStatus;
  runNow(): Promise<boolean | void>;
  start(): void;
  stop(): void;
}

/** Subset of AutomationManager used by CopilotAutomationBackend. */
export interface IAutomationManager {
  list(): AutomationData[];
  create(def: AutomationCreateInput): AutomationData;
  update(id: string, patch: Partial<AutomationData>): AutomationData | null;
  toggle(id: string, enabled: boolean): boolean;
  delete(id: string): boolean;
  getHistory(id: string): AutomationRunData[];
  getAllHistory(): AutomationRunData[];
  getCurrentRun(): AutomationRunData | null;
  runNow(id: string, options?: { focus?: boolean }): Promise<AutomationRunData | null>;
  exportAutomation(id: string): string | null;
  importAutomations(
    json: string,
    opts?: { overwrite?: boolean; workingDir?: string; skillNames?: string[] },
  ): AutomationData[];
  getConditionStatus(automationId: string): ConditionStatusRecord;
}

/**
 * Self-tool dependencies — ports for every field the LLM-facing self-tools
 * call. Definition lives in `./ports` (it needs electron-side type imports
 * for `Skill`, `PersistedSession`); re-exported here so
 * existing `import { ISelfToolDeps } from "./types"` consumers keep working.
 *
 * Replaces the prior `Record<string, unknown>` shape.
 */
import type { ISelfToolDeps } from "./ports";
export type { ISelfToolDeps };

/** Factory that creates and starts a runtime client (or mock). */
export type ClientFactory = RuntimeClientFactory;

// ── SessionIndex access primitives ──────────────────────────────────────

/** Per-tier default model, reasoning effort, and context tier. Used for the `subagent` and
 *  `workflow` tiers (the `chat` tier keeps the legacy `defaultModel` +
 *  per-model default maps for backward compatibility).
 *  All fields are optional: an unset model falls back to the chat default
 *  (ultimately `DEFAULT_MODEL` = gpt-5.6-sol); unset effort/context values
 *  fall back to the model-aware system defaults. */
export interface TierModelDefaults {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
}

/** Canonical shape of the on-disk session index. Single source of truth;
 *  electron/session-store.ts re-exports this type for backward compatibility. */
export interface SessionsIndex {
  sessions: SessionMetadata[];
  activeSessionId: string | null;
  defaultModel?: string;
  defaultReasoningEfforts?: Record<string, ReasoningEffort>;
  defaultContextTiers?: Record<string, ContextTier>;
  defaultSoul?: string;
  /** Default model + reasoning for plain `spawnSubagent` subagents. */
  subagentDefaults?: TierModelDefaults;
  /** Default model + reasoning for workflow host + worker sessions. */
  workflowDefaults?: TierModelDefaults;
}

/** Narrow accessor SessionManager exposes so backend-side sync adapters can
 *  write into the index without depending on concrete SessionManager. */
export interface IndexOperations {
  withLock<T>(fn: (idx: SessionsIndex) => T): Promise<T>;
  emitChanged(): void;
}

/**
 * Runtime-scoped writer. Runtime identity partitions rows; backend origin is
 * validated separately as a compatibility/transport invariant.
 */
export class SessionIndexWriter {
  constructor(
    runtimeId: string,
    private readonly origin: BackendOrigin,
    private readonly ops: IndexOperations,
  ) {
    this.runtimeId = normalizeRuntimeId(runtimeId);
  }

  private readonly runtimeId: string;

  async upsert(meta: SessionMetadata): Promise<void> {
    this.assertPartition(meta);
    const normalized = { ...meta, runtimeId: this.runtimeId };
    await this.ops.withLock((idx) => {
      const i = this.findMatch(idx.sessions, normalized);
      if (i >= 0) {
        // Preserve the existing local id — locally-created sessions keep
        // the marshal-assigned UUID across remote reconciles even when
        // the incoming row's id equals the backend identifier.
        idx.sessions[i] = { ...idx.sessions[i], ...normalized, id: idx.sessions[i].id };
      } else {
        idx.sessions.push(normalized);
      }
    });
    this.ops.emitChanged();
  }

  async remove(backendId: string): Promise<void> {
    await this.ops.withLock((idx) => {
      idx.sessions = idx.sessions.filter(
        (s) => !(resolveSessionRuntimeId(s) === this.runtimeId && s.backendId === backendId),
      );
    });
    this.ops.emitChanged();
  }

  async replaceAll(list: SessionMetadata[]): Promise<void> {
    for (const meta of list) this.assertPartition(meta);
    const normalizedList = list.map((meta) => ({ ...meta, runtimeId: this.runtimeId }));
    await this.ops.withLock((idx) => {
      const otherRuntime = idx.sessions.filter(
        (s) => resolveSessionRuntimeId(s) !== this.runtimeId,
      );
      const existingOwn = idx.sessions.filter((s) => resolveSessionRuntimeId(s) === this.runtimeId);
      const reconciled = normalizedList.map((incoming) => {
        const i = this.findMatch(existingOwn, incoming);
        if (i >= 0) return { ...existingOwn[i], ...incoming, id: existingOwn[i].id };
        return incoming;
      });
      idx.sessions = [...otherRuntime, ...reconciled];
    });
    this.ops.emitChanged();
  }

  /** Match by (runtimeId, backendId) primary; fall back to id match when
   *  backendId is missing on either side (legacy rows / newly-created rows
   *  whose backendId isn't persisted yet). */
  private findMatch(rows: readonly SessionMetadata[], meta: SessionMetadata): number {
    if (meta.backendId) {
      const byBackend = rows.findIndex(
        (s) => resolveSessionRuntimeId(s) === this.runtimeId && s.backendId === meta.backendId,
      );
      if (byBackend >= 0) return byBackend;
    }
    return rows.findIndex((s) => resolveSessionRuntimeId(s) === this.runtimeId && s.id === meta.id);
  }

  private assertPartition(meta: SessionMetadata): void {
    const metaRuntimeId = resolveSessionRuntimeId(meta);
    if (metaRuntimeId !== this.runtimeId) {
      throw new Error(
        `SessionIndexWriter: mismatched runtime — writer bound to "${this.runtimeId}", meta has "${metaRuntimeId}"`,
      );
    }
    if ((meta.backendOrigin ?? "copilot") !== this.origin) {
      throw new Error(
        `SessionIndexWriter: mismatched origin — writer bound to "${this.origin}", meta has "${meta.backendOrigin ?? "copilot"}"`,
      );
    }
  }
}

// ── Auth machinery (per-backend wiring of the renderer auth surface) ──

export interface AuthMachineryDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  /** Wired to `win?.webContents.send("gatewayAuth:stateChange", state)`. */
  sendStateChange: (state: GatewayAuthState) => void;
  /** Fired AFTER backend.signOut() — main.ts uses it to drop stale
   *  SessionManager state so the next sign-in starts clean. */
  onSignOut: () => void | Promise<void>;
  /** Fired AFTER a successful sign-in (or auto-sign-in) — main.ts uses it
   *  to bring up the node-role connection when the saved identity has
   *  ``roleMode`` including ``node``. Symmetric to ``onSignOut``. The
   *  controller passes the just-validated identity so the wiring layer can
   *  branch on ``roleMode`` without re-reading the cred from disk. */
  onSignedIn?: (identity: GatewayAuthIdentity) => void | Promise<void>;
}

export interface AuthMachineryHandle {
  /** `null` for backends whose auth surface lives outside this machinery. */
  getState(): GatewayAuthState | null;
  tryAutoSignIn(): Promise<void>;
  /** Drive the ``reconnecting`` flag on the published auth state. Called by
   *  main.ts as it OR-s the operator + node backends' reconnect-loop
   *  transitions. No-op for backends whose connection model has no
   *  notion of a "post-sign-in reconnect" (e.g. CopilotBackend's stub). */
  setReconnecting(reconnecting: boolean): void;
}

// ── Top-level provider ──────────────────────────────────────────────────

export interface IBackendProvider extends WorkspaceConfigPort {
  readonly sessions: ISessionBackend;
  readonly execution: IExecutionBackend;
  readonly automation: IAutomationBackend;
  readonly tools: IToolBackend;
  readonly permissions: IPermissionsBackend;
  /** Registry key used to construct this adapter. Unlike origin, this is open-ended. */
  readonly runtimeId: string;

  /** Compatibility/transport family. Runtime isolation uses `runtimeId`. */
  readonly origin: BackendOrigin;

  /**
   * Initialize the backend. Idempotent — safe to call multiple times.
   * Implementations must handle concurrent sign-out: if signOut() is called
   * during init(), the initialization should abort and leave the backend
   * in a stopped state rather than completing with stale credentials.
   */
  init(config?: Record<string, unknown>): Promise<void>;
  destroy(): Promise<void>;
  isReady(): boolean;
  capabilities(): BackendCapabilities;

  /**
   * One-shot inference (title generation, summarization).
   * Note: Auth errors during infer() are not caught by per-session event
   * subscribers. Callers should handle auth errors explicitly or accept
   * silent failure for non-critical operations like title generation.
   */
  infer(opts: InferOpts): Promise<string>;
  uploadAttachment(file: AttachmentUpload): Promise<AttachmentRef>;
  pushConfig(config: RuntimeConfigPayload): Promise<void>;

  /** Auth lifecycle — backend-specific (GitHub device flow vs. AAD). */
  checkAuthStatus(): Promise<AuthStatus>;
  /**
   * Trigger the backend's auth flow. Returns a LoginResult with optional
   * device code for UI display and a completion promise for async flows.
   * Backends that use implicit/auto auth should return an empty LoginResult.
   *
   * `credentials` lets renderer-driven flows pass a user-picked identity
   * (e.g. GatewayBackend receives a `GatewayAuthIdentity`). Device-flow
   * backends (CopilotBackend) ignore this parameter. Typed as `unknown` so
   * the interface is agnostic to any specific backend's credential shape —
   * each implementation narrows at its own boundary.
   */
  login(credentials?: unknown): Promise<LoginResult>;
  signOut(): Promise<void>;

  /**
   * Set the callback for approval requests that require user interaction.
   * Called by SessionManager after construction to wire up PermissionCardManager.
   */
  setApprovalCallback(callback: ApprovalCallback): void;

  // ── Configuration setters ──────────────────────────────────────────────
  // Called by SessionManager to push runtime configuration into the backend.
  // Narrow interfaces (I*Provider) define only the methods the backend calls.
  // GatewayBackend may no-op or translate to RPC calls.

  setHeartbeatManager(hm: IHeartbeatManager): void;
  setAutomationManager(am: IAutomationManager): void;
  /** Tick-source for `triggerAutomationNow`'s rolling-inactivity timeout. */
  setRunActivitySubscriber(subscriber: (listener: () => void) => () => void): void;
  setSettingsManager(sm: { get(): MSettings; update(patch: Partial<MSettings>): void }): void;
  setPermissionPolicy(policy: IPermissionPolicyProvider): void;
  setCustomMcpServers(servers: CustomMcpServer[]): void;
  setInterceptFileChooser(enabled: boolean): void;
  setSelfToolDeps(deps: ISelfToolDeps): void;
  setTimezoneProvider(fn: () => string): void;
  setTenantPolicyProvider(provider: ITenantPolicyProvider): void;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Force-restart the backend (kill process + reinitialize). */
  restart(): Promise<void>;

  /** Force-terminate the backend process. Guaranteed to succeed (best-effort kill). */
  forceKill(): Promise<void>;

  /** Check if the backend process/connection is actually alive. */
  isHealthy(): boolean;

  /** Polymorphic per Rule 1 — each backend wires its own gatewayAuth:* IPC
   *  surface from inside this call (gateway: real controller; copilot:
   *  "restart required" stubs). Returns the handle main.ts uses for
   *  auto-sign-in and identity-composer state. */
  attachAuthMachinery(deps: AuthMachineryDeps): AuthMachineryHandle;

  /** Out-of-band automation-state-change broadcaster (e.g. gateway
   *  condition-trigger watcher firing). Pass `null` to detach. */
  setOnAutomationsChangedBroadcaster(fn: (() => void) | null): void;

  /** Register per-backend IPC handlers that require a broadcast channel
   *  (e.g. gateway-node activity log). Called once at startup from main.ts.
   *  No-op for backends that have no such handlers. */
  registerNodeIpcHandlers(deps: {
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
    broadcast: <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]) => void;
  }): void;

  /** Permanent tear-down called from before-quit. Distinct from signOut
   *  (which is user-initiated and reversible) — dispose releases all
   *  resources including the node subsystem's MCP connections. */
  dispose(): Promise<void>;
}
