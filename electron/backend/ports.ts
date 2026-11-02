// electron/backend/ports.ts
//
// Port interfaces for `IToolBackend.attachApprovalRouter` deps. These are
// minimal, role-typed views of the concrete electron-side classes
// (`ApprovalBroker`, `PermissionPolicy`, `SessionManager`) — they expose only
// the surface that copilot's approval adapter and gateway's WS handlers
// actually need. Backends consume the ports; `main.ts` (the composition root)
// passes the concrete classes that `implements` them.
//
// Why ports instead of `unknown` slots: a uniform interface that downstream
// code has to `as`-cast back to a concrete class is no better than a union of
// `instanceof` checks — the type system can't catch a wiring mistake until it
// surfaces as a runtime error. Port interfaces give us a checked contract on
// both sides without making `types.ts` depend on the full electron-side
// modules at runtime (these imports are erased; only the type shapes flow).

import type {
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
} from "../../common/external-operation-contract";
import type {
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalFence,
  GoalRecord,
  GoalRuntimeSnapshot,
  GoalTransitionProposal,
} from "../../common/goal-contract";
import type {
  ReviewerValidationAuthorizationResult,
  ReviewerValidationCommandSpec,
  ReviewerValidationPermissionRequest,
  ReviewerValidationReceipt,
  ReviewerValidationRequest,
} from "../../common/goal-infrastructure-contract";
import type { PermissionAction } from "../../common/marshal-constants";
import type {
  AgentMessageApiResult,
  AgentMessageQueueCancellationResult,
  GoalState,
  MemoryCategory,
  MemoryEntry,
  MSettings,
  ModelInfo,
  ReasoningEffort,
  ReviewerSessionPermissionScope,
  CommandCenterTodoStatus,
  SessionMetadata,
  SessionPermissionMode,
  SessionRepositoryAgent,
  SessionRuntimeAgentRole,
  SessionSource,
} from "../../common/marshal-ipc-contract";
import type { RelayPublishKind } from "../../common/relay-contract";
import type { ApprovalListener, BrokerRequest, PromptResult } from "../approval-broker";
import type { RuntimeOneOffWakes } from "../automations/runtime-wakes-types";
import type { CommandClassification } from "../permission-classification-contracts";
import type { PermissionDecision, PolicyEvaluation } from "../permission-policy";
import type { PersistedSession } from "../session-store";
import type { SessionDeletedCause } from "../sessions";
import type { Skill } from "../skills";
import type { WorkServiceProviders } from "../work-services/contracts";
import type { WorkflowRunManager } from "../workflows/types";
import type { IMemoryForgetPort, MemoryPurgeResult } from "./memory-forget-port";
import type { RuntimeTool } from "./runtime-contract";
import type {
  ApprovalDecision,
  ApprovalRequest,
  IAutomationManager,
  IHeartbeatManager,
} from "./types";

/**
 * Subset of `ApprovalBroker` that copilot's adapter touches: open a blocking
 * prompt, check whether it is still pending, and push a late-arriving
 * classification onto an already-rendered card.
 */
export interface IApprovalBroker {
  requestPrompt(request: BrokerRequest): Promise<PromptResult>;
  hasPending(requestId: string): boolean;
  reportClassification(requestId: string, classification: CommandClassification): void;
  /**
   * Subscribe is part of the broker contract because the gateway adapter
   * (Phase 2b-2) listens for `onResolved` to forward the decision
   * back to marshal. Copilot's adapter does not subscribe — the SDK
   * callback path resolves the prompt via the awaited `requestPrompt`.
   */
  subscribe(listener: Partial<ApprovalListener>): () => void;
}

/**
 * Subset of `PermissionPolicy` that the adapter consults: evaluate the
 * auto-approve / auto-deny pipeline, record the user's interactive outcome
 * for audit, and log infrastructure-level failures (no-window, timeout).
 */
export interface IPermissionPolicy {
  evaluate(request: ApprovalRequest): PermissionDecision;
  /**
   * Optional richer evaluation: same decision as {@link evaluate} plus a
   * model-facing `denyReason` for hard `deny` outcomes. The CopilotBackend
   * adapter prefers this (falling back to {@link evaluate}) so policy denials
   * surface an accurate, actionable message instead of "could not request
   * permission from user". Optional so gateway-side doubles need not implement it.
   */
  evaluateDetailed?(request: ApprovalRequest): PolicyEvaluation;
  recordInteractiveOutcome(
    request: ApprovalRequest,
    action: PermissionAction,
    decision: ApprovalDecision,
  ): boolean;
  logInfraFailure(request: ApprovalRequest, source: "no-window" | "timeout"): void;
}

/**
 * Subset of `SessionManager` that the adapter uses for shell-command
 * classification. Naming the port for the role (classifier) — not the
 * concrete owner — lets us hand the adapter just the LLM-backed classifier
 * without dragging in the rest of `SessionManager`.
 */
export interface ICommandClassifier {
  classifyForPermission(command: string): Promise<CommandClassification>;
}

export interface MarshalPromptFiles {
  soul?: string;
  tools?: string;
  memory?: string;
  identity?: string;
  bootstrap?: string;
}

/**
 * Backend-owned source for Workspace 1.0 prompt content. The local Copilot
 * backend returns bundled app defaults; gateway mode returns null because the
 * cloud runtime owns per-workspace prompt construction.
 */
export interface WorkspaceConfigPort {
  loadWorkspaceFiles(): MarshalPromptFiles | null;
}

/**
 * Complete contract for memory storage backends (strategy pattern).
 *
 * Built-in implementations:
 * - FilesystemMemoryStore: File-based persistence (~/.marshal/marshal-memory.json)
 * - extension providers registered through the Marshal Runtime host service
 *
 * Both implement identical behavior. Backends differ only in storage strategy.
 * No branching logic in shared code; composition root (main.ts) selects implementation.
 *
 */
export interface IMemoryStore extends IMemoryForgetPort {
  // ─────────────────────────────────────────────────────────────────
  // Core CRUD Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * List all memories.
   * @returns Array of all memory entries
   */
  list(): MemoryEntry[];

  /**
   * Count total memories.
   * @returns Number of memories
   */
  count(): number;

  /**
   * Add a single memory entry.
   * Deduplicates on case-insensitive fact match.
   * @param fact - Memory text (required, max 500 chars after trim)
   * @param category - Memory category (default: "fact")
   * @param source - Where memory came from, e.g. session ID (default: "session")
   * @param options - Optional replacement target and project scoping; old providers may ignore it
   * @returns Created entry, or null if fact is empty
   */
  add(
    fact: string,
    category?: MemoryCategory,
    source?: string,
    options?: MemoryAddOptions,
  ): MemoryEntry | null | Promise<MemoryEntry | null>;

  /**
   * Delete a memory by ID.
   * @param id - Memory ID
   * @returns true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Optional batch delete: removes every id in one durable rewrite, plus the
   * write that rotates them out of the backup copy. Returns how many were removed.
   */
  deleteMany?(ids: readonly string[]): Promise<number>;

  /**
   * Clear all memories.
   * Clears both local and remote storage (if applicable).
   */
  clear(): void | Promise<void>;

  /**
   * Add multiple memories in batch.
   * @param entries - Array of { fact, source? }
   * @param source - Default source if not specified per entry
   * @returns Array of created entries
   */
  addBatch(
    entries: Array<{ fact: string; source?: string }>,
    source?: string,
  ): MemoryEntry[] | Promise<MemoryEntry[]>;

  // ─────────────────────────────────────────────────────────────────
  // Recall & Search
  // ─────────────────────────────────────────────────────────────────

  /**
   * Search memories by query text using the selected provider.
   * @param query - Search query
   * @param limit - Max results (default: 20)
   * @param options - Optional inclusive `createdAt` window
   * @returns Ranked memories matching query
   */
  recall(
    query: string,
    limit?: number,
    source?: string,
    options?: MemoryRecallOptions,
  ): Promise<MemoryEntry[]>;

  /**
   * Get N most recent memories, sorted by lastAccessedAt descending.
   * MUST sort by timestamp on both implementations.
   * @param n - Number of memories to return
   * @returns Recent memories in chronological order (newest first)
   */
  getRecent(n: number): MemoryEntry[];

  /**
   * Retrieve contextually relevant memories.
   * Local providers may use keyword matching as a fallback.
   * @param query - Semantic query context
   * @param limit - Max results (default: 20)
   * @returns Memories selected by semantic relevance
   */
  retrieveSemanticSubset(query: string, limit?: number): Promise<MemoryEntry[]>;

  // ─────────────────────────────────────────────────────────────────
  // Serialization & Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /**
   * Export all memories as JSON string.
   * Format compatible with Claude, ChatGPT, Gemini exports.
   * @returns JSON string with memories array
   */
  export(): string;

  /**
   * Import memories from JSON string.
   * Handles foreign formats from other AI assistants.
   * @param jsonStr - JSON string with memories
   * @returns { added, skipped } counts, optional error if import not supported
   */
  import(
    jsonStr: string,
  ):
    | { added: number; skipped: number; error?: string }
    | Promise<{ added: number; skipped: number; error?: string }>;

  /**
   * Reload memories from persistent storage.
   * Providers without a reloadable local cache may implement this as a no-op.
   */
  reload(): void;

  /**
   * Initialize the selected provider for a session and optionally seed local entries.
   * Filesystem providers may implement this as a no-op.
   * @param localMemories - Current local memories (for first-time sync)
   */
  initializeSessionStart(localMemories?: MemoryEntry[]): Promise<void>;

  // ─────────────────────────────────────────────────────────────────
  // System Prompt Formatting
  // ─────────────────────────────────────────────────────────────────

  /**
   * Format memories as untrusted markdown data for the system prompt.
   * Selection follows `selectForPrompt` (or the host fallback with the same
   * rule); `budgetBytes` defaults to 8192.
   * @returns Markdown string, or empty if no memories
   */
  formatForSystemPrompt(request?: Partial<MemoryPromptSelectionRequest>): string;

  /**
   * Optional provider-owned selection for the always-on prompt. Order:
   * preference → decision → fact → context, newest `createdAt` first inside a
   * category; entries whose rendered line would exceed the budget are skipped
   * (not a stop) and counted in `omitted.count`. Providers without it get the
   * host fallback in `marshal-runtime/memory/prompt-selection.ts`.
   */
  selectForPrompt?(request: MemoryPromptSelectionRequest): MemoryPromptSelection;
}

export interface MemoryAddOptions {
  /** Id of an existing memory this fact corrects or updates. */
  replaces?: string;
  /** `"global"` (default) or the git project id the memory applies to. */
  appliesTo?: string;
  /** Workspace the memory was stated in, when `appliesTo` is a project. */
  workspacePath?: string;
}

export type { MemoryPurgeResult };
export type {
  MemoryForgetOutcome,
  MemoryForgetTarget,
  MemorySessionScope,
} from "./memory-forget-port";

export interface MemoryRecallOptions {
  /** Inclusive lower bound on `createdAt` (ISO datetime). */
  since?: string;
  /** Inclusive upper bound on `createdAt` (ISO datetime). */
  until?: string;
}

export interface MemoryPromptSelectionRequest {
  /** UTF-8 byte budget for the rendered fact lines (default 8192). */
  budgetBytes: number;
  /** Session's workspace path and git project id, when known (used from wave 2 on). */
  workspacePath?: string;
  projectId?: string;
}

export interface MemoryPromptSelection {
  /** In render order. */
  entries: MemoryEntry[];
  /** Active memories that did not fit. */
  omitted: { count: number };
}

/**
 * Backward compatibility alias.
 * @deprecated Use IMemoryStore directly.
 */
export type IMemoryManager = IMemoryStore;

// ── Self-tool ports ─────────────────────────────────────────────────────
//
// `ISelfToolDeps` (in `types.ts`) used to be `Record<string, unknown>`,
// forcing a double-cast on both the producer (`SessionManager.setSelfTools`)
// and the consumer (`CopilotBackend.buildAllTools`). The TODO in the comment
// pointed at the right fix — extract a `SessionSendPort` — and these ports
// are that, generalised to every field on `SelfToolDeps`.

/**
 * Subset of `SessionManager` that `getSelfTools` calls. Listed here as the
 * narrowest port the self-tools layer needs — model + soul + session
 * search/lookup. Anything else on `SessionManager` belongs elsewhere.
 */
export interface IBackgroundToolInvocationManager {
  /** Claim must durably commit before the caller starts any external side effect. */
  claimBackgroundToolDispatch(
    request: BackgroundToolDispatchClaimRequest,
  ): Promise<BackgroundToolDispatchClaimResult>;
  /** Registration must resolve before the claimed tool starts its external side effect. */
  beginBackgroundToolInvocation(
    args: BackgroundToolInvocationStart,
  ): Promise<BackgroundToolInvocationRegistrationResult>;
  attachBackgroundToolProcess(
    handle: string,
    process: BackgroundToolProcessAttachment,
  ): Promise<RunningToolCallInfo | null>;
  detachBackgroundToolInvocation(handle: string): Promise<RunningToolCallInfo | null>;
  completeBackgroundToolInvocation(
    handle: string,
    result: BackgroundToolInvocationCompletion,
  ): Promise<RunningToolCallInfo | null>;
  requestBackgroundToolCancellation(
    request: BackgroundToolCancellationRequest,
  ): Promise<RunningToolCancelResult>;
}

export interface ISelfToolsSessionManager extends IBackgroundToolInvocationManager {
  getExclusiveSessionTools(sessionId: string): readonly RuntimeTool[] | undefined;
  listRunningTools(sessionId?: string): RunningToolCallInfo[];
  inspectRunningTool(handle: string): RunningToolInspectResult;
  cancelRunningTool(handle: string): Promise<RunningToolCancelResult>;
  listModels(): Promise<ModelInfo[]>;
  setDefaultModel(model: string): Promise<{ success: boolean; error?: string }>;
  getDefaultModel(): string;
  setDefaultSoul(soul: string): Promise<void>;
  listWorkspacesForSelfTools(): Array<{ name: string; path: string }>;
  registerWorkspaceForSelfTools(args: {
    name: string;
    path?: string;
    sourceSessionId?: string;
  }): Promise<{
    name: string;
    path: string;
    origin: "user-created" | "user-added";
  }>;
  listRepositoryAgentsForSelfTools(args: {
    workspaceName?: string;
    repoPath?: string;
    sessionId?: string;
  }): SessionRepositoryAgent[];
  createSubagentSession(args: {
    task: string;
    name?: string;
    agentName?: string;
    workspaceName?: string;
    repoPath?: string;
    createWorktree?: boolean;
    worktreeName?: string;
    branchName?: string;
    baseRef?: string;
    permissionMode?: SessionPermissionMode;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    soul?: string;
    parentSessionId?: string;
    runtimeAgentRole?: SessionRuntimeAgentRole;
    allowedTools?: string[];
    suppressInitialTodoInstruction?: boolean;
    returnAfterBackendAcceptance?: boolean;
    suppressParentReadinessWake?: boolean;
    skills?: string[];
    mcp?: string[];
    cloudSyncEnabled?: boolean;
    source?: SessionSource;
  }): Promise<{
    session: SessionMetadata;
    workspacePath?: string;
    worktree?: { branchName: string; path: string; workspaceName: string };
    repositoryAgent?: SessionRepositoryAgent;
    availableRepositoryAgents?: SessionRepositoryAgent[];
  }>;
  listSubagentSessions(parentSessionId?: string): SessionMetadata[];
  isSessionBusy(sessionId: string): boolean;
  sendMessageToSubagent(args: {
    sessionId: string;
    message: string;
    deliveryMode?: "wait-if-idle" | "queue" | "interrupt";
    waitForResponse?: boolean;
    timeoutMs?: number;
    sourceSessionId?: string;
    replaceQueued?: boolean;
  }): Promise<AgentMessageApiResult>;
  cancelQueuedSubagentMessages(args: {
    sessionId: string;
    sourceSessionId: string;
    messageIds?: readonly string[];
  }): Promise<AgentMessageQueueCancellationResult>;
  countQueuedAgentMessages(targetSessionId: string): number;
  sendMessageToParent(args: {
    sessionId: string;
    message: string;
    deliveryMode?: "queue" | "interrupt";
    waitForResponse?: boolean;
    timeoutMs?: number;
  }): Promise<AgentMessageApiResult>;
  searchSessions(
    query: string,
    maxResults?: number,
  ): Promise<Array<{ id: string; name: string; createdAt: string; snippets: string[] }>>;
  getSession(id: string): PersistedSession | null;
  /** Per-session skill allowlist for `listSkills` / `getSkill`
   *  list-time filtering. Undefined = inherit global; `[]` = no skills.
   *  See R1-FIXES A13. */
  getSessionSkillsScope(id: string): readonly string[] | undefined;
  /** Async counterpart of getSession that also honors pending deletions and
   *  repairs the stored copy (workspace-binding flag, stale live-turn
   *  checkpoint) before returning it. */
  getSessionAsync(id: string): Promise<PersistedSession | null>;
  isSessionActive(id: string): boolean;
  deleteSession(id: string, opts: { cause: SessionDeletedCause }): Promise<unknown>;
}

export interface RunningToolCallInfo {
  handle: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  startedAt: string;
  elapsedMs: number;
  status: RunningToolStatus;
  backgrounded: boolean;
  resultAvailable: boolean;
  completedAt?: string;
  outputPreview?: string;
  resultTruncated?: boolean;
  error?: string;
  longRunning: boolean;
  cancellable: boolean;
  cancellationScope?: RunningToolCancellationScope;
  process?: RunningToolProcessInfo;
}

export type RunningToolStatus =
  | "unknown"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunningToolInspectResult {
  success: boolean;
  handle: string;
  tool?: RunningToolCallInfo & { result?: unknown };
  error?: string;
}

export interface RunningToolCancelResult {
  success: boolean;
  handle?: string;
  sessionId?: string;
  toolCallId?: string;
  status?: RunningToolStatus;
  cancellationScope?: RunningToolCancellationScope | "unsupported";
  error?: string;
}

export type RunningToolCancellationScope =
  | "process-tree"
  | "process-group"
  | "tool"
  | "turn"
  | "none";

export interface BackgroundToolInvocationStart {
  claim: BackgroundToolDispatchClaim;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  startedAtMs?: number;
  cancel?: () => Promise<void> | void;
  cancellationScope?: "tool" | "turn" | "none";
}

export interface BackgroundToolProcessAttachment {
  ownerSessionId: string;
  rootPid: number;
  spawnedAtMs: number;
  cancellationScope: "process-tree" | "process-group";
  cancel: () => Promise<void> | void;
}

export type BackgroundToolProcessAttacher = (
  process: BackgroundToolProcessAttachment,
) => Promise<RunningToolCallInfo | null>;

export interface RunningToolProcessInfo {
  ownerSessionId: string;
  rootPid: number;
  spawnedAtMs: number;
  identitySource: "spawned-child";
  cancellationScope: "process-tree" | "process-group";
}

export interface BackgroundToolInvocationCompletion {
  success: boolean;
  result?: unknown;
  error?: string;
  completedAtMs?: number;
}

export interface BackgroundToolDispatchClaimRequest {
  ownerSessionId: string;
  toolCallId: string;
  toolName: string;
  requestedAtMs: number;
  idempotencyKey: string;
}

export interface BackgroundToolCancellationRequestToken {
  tokenId: string;
  ownerSessionId: string;
  claimId: string;
  issuedAtMs: number;
}

export interface BackgroundToolDispatchClaim {
  claimId: string;
  ownerSessionId: string;
  toolCallId: string;
  claimedAtMs: number;
  cancellationToken: BackgroundToolCancellationRequestToken;
}

export type BackgroundToolDispatchClaimResult =
  | { kind: "claimed"; claim: BackgroundToolDispatchClaim }
  | {
      kind: "conflict";
      reason: "already-claimed" | "already-completed" | "owner-mismatch";
      existingHandle?: string;
    };

export interface BackgroundToolInvocationRegistrationResult {
  handle: string;
  claim: BackgroundToolDispatchClaim;
  invocation: RunningToolCallInfo;
}

export interface BackgroundToolCancellationRequest {
  token: BackgroundToolCancellationRequestToken;
  handle: string;
  requestedAtMs: number;
}

/** Durable registry for fenced, idempotent operations that can outlive one turn. */
export interface IExternalOperationRegistryPort {
  reserve(request: ExternalOperationRequest): Promise<{
    record: ExternalOperationRecord;
    created: boolean;
  }>;
  get(identity: ExternalOperationIdentity): Promise<ExternalOperationRecord | null>;
  listForGoal(fence: GoalFence): Promise<ExternalOperationRecord[]>;
  inspect(identity: ExternalOperationIdentity): Promise<ExternalOperationSnapshot | null>;
  listSnapshotsForGoal(fence: GoalFence): Promise<ExternalOperationSnapshot[]>;
  update(
    identity: ExternalOperationIdentity,
    update: ExternalOperationRecordUpdate,
  ): Promise<ExternalOperationRecord>;
}

// Note: IMemoryManager interface moved into IMemoryStore above.
// Use the type alias below for backward compatibility.

/** Subset of `SettingsManager` used by the self-tools' settings verbs. */
export interface ISettingsManager {
  get(): MSettings;
  save(settings: MSettings): void;
}

/**
 * Narrow view of `GoalManager` the self-tools need. Tools READ the goal for the
 * CALLING session id (resolved per-session at tool-build time — not the UI
 * foreground). Mutations are applied by the per-session event handler in
 * sessions.ts using the event's sessionId, so tool calls in background /
 * multi-session runs read and mutate the correct session.
 */
export interface IGoalToolsManager {
  getGoal(sessionId: string): GoalState | null;
  getGoalRuntimeSnapshot(sessionId: string): Promise<GoalRuntimeSnapshot>;
  setGoal(
    sessionId: string,
    input: { objective: string; criteria?: string[] },
  ): Promise<GoalRecord>;
  updateGoalDefinition(
    sessionId: string,
    expectedFence: GoalFence,
    patch: GoalDefinitionPatch,
  ): Promise<GoalRecord | null>;
  updateGoalContext(
    sessionId: string,
    expectedFence: GoalFence,
    patch: GoalContextPatch,
  ): Promise<GoalRecord | null>;
  proposeGoalTransition(
    sessionId: string,
    expectedFence: GoalFence,
    proposal: GoalTransitionProposal,
  ): Promise<boolean>;
}

/** Reviewer creation requires the dedicated non-inheriting permission literal. */
export interface IReviewerSessionFactoryPort {
  createReviewerSession(scope: ReviewerSessionPermissionScope): Promise<string>;
}

/** Dedicated validation executor resolves registry IDs; requests never carry raw commands. */
export interface IReviewerValidationExecutorPort {
  getCommandSpec(commandId: string): Promise<ReviewerValidationCommandSpec | null>;
  executeValidation(request: ReviewerValidationRequest): Promise<ReviewerValidationReceipt>;
}

/** Synchronous permission precheck; the async executor still revalidates and claims. */
export interface IReviewerValidationAuthorizationPort {
  authorizeReviewerValidation(
    sessionId: string,
    request: ReviewerValidationPermissionRequest,
  ): ReviewerValidationAuthorizationResult;
}

/** Durable registry for fenced, idempotent operations that can outlive one turn. */
export interface IExternalOperationRegistryPort {
  reserve(request: ExternalOperationRequest): Promise<{
    record: ExternalOperationRecord;
    created: boolean;
  }>;
  get(identity: ExternalOperationIdentity): Promise<ExternalOperationRecord | null>;
  listForGoal(fence: GoalFence): Promise<ExternalOperationRecord[]>;
  inspect(identity: ExternalOperationIdentity): Promise<ExternalOperationSnapshot | null>;
  listSnapshotsForGoal(fence: GoalFence): Promise<ExternalOperationSnapshot[]>;
  update(
    identity: ExternalOperationIdentity,
    update: ExternalOperationRecordUpdate,
  ): Promise<ExternalOperationRecord>;
}

/**
 * Composite deps for the LLM-facing self-tools (`getSelfTools`). Each field
 * is the narrowest port the corresponding tool group needs, so the type
 * system catches a stale rename across boundaries.
 *
 * Lives here (not in `types.ts`) because some field shapes need
 * electron-side types (`Skill`). `types.ts` re-exports it.
 *
 * `sessionManager` is filled in by `SessionManager.setSelfTools` (which
 * passes `this`); main.ts supplies the rest.
 */
/** Shape of the old-vs-new diff passed to the permissions escalation card.
 *  Only fields that actually change are present. `tools.changed` contains only
 *  the entries being modified, not the full tools map. */
export interface PermissionsEscalationDiff {
  allow?: { from: string[]; to: string[] };
  autoApproveReadOnly?: { from: boolean; to: boolean };
  tools?: { changed: Record<string, { from: boolean; to: boolean }> };
  servers?: Record<string, { autoApprove: { from: boolean; to: boolean } }>;
  /** `forget { completely: true }`: the user's own memory text, shown only on their card. */
  forgetCompletely?: { memoryText: string };
}

export interface ISelfToolDeps {
  sessionManager: ISelfToolsSessionManager;
  /** Additional backend-neutral tools composed by the Electron host. */
  additionalTools?: (sessionId: string | undefined) => readonly RuntimeTool[];
  heartbeatManager: IHeartbeatManager;
  automationManager: IAutomationManager;
  /** Fires a one-off session wake through the runtime scheduler; absent when the scheduler is not running. */
  runtimeOneOffWakes?: RuntimeOneOffWakes;
  memoryManager: IMemoryManager;
  settingsManager: ISettingsManager;
  goalManager: IGoalToolsManager;
  skillsManager: {
    list: (options?: { sessionId?: string }) => Skill[];
    add: (name: string, description: string, instructions?: string) => Skill;
    update: (
      id: string,
      updates: Partial<Pick<Skill, "name" | "description" | "instructions" | "enabled">>,
    ) => Skill | null;
    delete: (id: string) => boolean;
    getInstructions: (
      name: string,
      preloaded?: Skill[],
      options?: { sessionId?: string },
    ) => { instructions: string; resourceDir: string | null } | null;
  };
  workServices: WorkServiceProviders;
  relay?: {
    publishSessionMessage: (input: {
      sessionId: string;
      text: string;
      idempotencyKey: string;
      accessPointIds?: readonly string[];
      kind?: RelayPublishKind;
      replyToProviderMessageId?: string;
      sourceTurnId?: string;
    }) => Promise<{
      publications: readonly {
        publicationId: string;
        correlationId: string;
        disposition: "queued" | "deduplicated";
        acceptedAt: string;
      }[];
    }>;
  };
  /** Broadcast workspace registry changes caused by agent self-tools. */
  broadcastWorkspaceRegistryChanged?: () => void;
  /** Git project of a session's workspace, for project-scoped `remember`. */
  memoryProjectForSession?: (
    sessionId: string,
  ) => Promise<{ workspacePath: string; projectId: string; workspaceId?: string } | undefined>;
  /** True while a healthy extension offers code-linked memories (`memory.link`). */
  codeLinkedMemoryAvailable?: () => boolean;
  /** Workflow run manager — produced by IMPL-ENGINE. Optional so existing
   *  callers (and test harnesses) keep compiling while the engine is
   *  staged. The `workflow*` self-tools handle `undefined` by
   *  throwing `NotImplemented`. See r1-fixes.md A4. */
  workflowManager?: WorkflowRunManager;
  /** Command Center progress/todo writer used by the chat-facing todo self-tool. */
  commandCenter?: {
    upsertSessionTodo: (input: {
      sessionId: string;
      todoId: string;
      title: string;
      status: CommandCenterTodoStatus;
    }) => Promise<void>;
    /** Replace the active goal's todo list for a session, optionally
     *  starting a new goal. Returns the resolved goal label/id so the
     *  tool handler can echo it back to the model. */
    replaceSessionGoalTodos: (input: {
      sessionId: string;
      startNewGoal?: boolean;
      goalLabel?: string;
      todos: ReadonlyArray<{
        localId: string;
        title: string;
        status: CommandCenterTodoStatus;
      }>;
    }) => Promise<{ goalId: string; goalLabel?: string }>;
  };
  /** Injected per-session by the Copilot session backend's buildAllTools — never
   *  set from main.ts. Used by requestPermissionEscalation to attach its
   *  consent card to the correct session. Optional so tests that don't exercise
   *  permission escalation don't need to provide it. */
  currentSessionId?: string;
  /** Called by requestPermissionEscalation before persisting any escalating
   *  permission change. Returns true if the user approved the card, false on
   *  deny or timeout. The callback is responsible for showing the card and
   *  awaiting the user's response. */
  confirmPermissionsEscalation: (
    sessionId: string,
    diff: PermissionsEscalationDiff,
  ) => Promise<boolean>;
}
