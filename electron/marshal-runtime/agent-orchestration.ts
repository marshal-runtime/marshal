import {
  isToolFreeRuntimeAgentRole,
  isUserVisibleSessionMessage,
  type AgentMessageApiResult,
  type ReasoningEffort,
  type SessionMessage,
  type SessionMetadata,
  type SessionRuntimeAgentRole,
  type TurnEvent,
} from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";
import { assertLaunchOverride } from "./agent-launch-override";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE, type MarshalRuntimeScope } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";
import type { SessionExecutionEvidence } from "./session-execution-evidence";

const DEFAULT_ADOPTED_RUNTIME_AGENT_ROLE: SessionRuntimeAgentRole = "swarm";
const MAX_WAIT_TIMEOUT_MS = 300_000;
const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 2_000;

export type MarshalRuntimeAgentState = "running" | "idle";

export interface MarshalRuntimeAgentSummary extends Partial<SessionExecutionEvidence> {
  readonly id: string;
  readonly name: string;
  readonly state: MarshalRuntimeAgentState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspaceName?: string;
  readonly repoPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly soul?: string;
  readonly runtimeAgentRole?: SessionRuntimeAgentRole;
  readonly runtimeDelegationId?: string;
  readonly runtimeTaskController?: string;
}

export interface MarshalRuntimeAgentLaunchRequest {
  readonly scope: MarshalRuntimeScope;
  readonly task: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string;
  readonly workspaceName?: string;
  readonly repoPath?: string;
  readonly name?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly runtime?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly soul?: string;
  readonly runtimeAgentRole?: SessionRuntimeAgentRole;
  readonly runtimeDelegationId?: string;
  readonly runtimeTaskController?: string;
  /** Host tool names the child may call; every other tool, MCP server, and skill is excluded. */
  readonly allowedTools?: readonly string[];
  /** Replaces Marshal's assembled system prompt and excludes repository context. */
  readonly systemPrompt?: string;
  /** Absolute file paths attached to the child's first message. */
  readonly attachments?: readonly string[];
  readonly createWorktree?: boolean;
  readonly worktreeName?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeAgentMessageResult {
  readonly agent: MarshalRuntimeAgentSummary;
  readonly accepted: true;
  readonly messageId?: string;
  readonly deliveryState?: string;
}

export interface MarshalRuntimeAgentTranscriptMessage {
  readonly id: string;
  readonly role: SessionMessage["role"];
  readonly content: string;
  readonly timestamp: string;
  readonly error?: boolean;
}

export interface MarshalRuntimeAgentTranscript {
  readonly agent: MarshalRuntimeAgentSummary;
  readonly messageCount: number;
  readonly showing: number;
  readonly messages: readonly MarshalRuntimeAgentTranscriptMessage[];
  readonly result?: string;
}

export interface MarshalRuntimeAgentWaitResult extends Omit<
  Partial<SessionExecutionEvidence>,
  "usage"
> {
  readonly state: "completed" | "timeout";
  readonly agent: MarshalRuntimeAgentSummary;
  readonly result?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly tokens?: number;
    readonly costUsd?: number;
  };
}

export interface MarshalRuntimeAgentPort {
  launch(request: MarshalRuntimeAgentLaunchRequest): Promise<MarshalRuntimeAgentSummary>;
  list(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<readonly MarshalRuntimeAgentSummary[]>;
  get(
    scope: MarshalRuntimeScope,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary | null>;
  send(
    scope: MarshalRuntimeScope,
    agentId: string,
    message: string,
    deliveryMode: "queue" | "interrupt",
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentMessageResult>;
  transcript(
    scope: MarshalRuntimeScope,
    agentId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentTranscript>;
  wait(
    scope: MarshalRuntimeScope,
    agentId: string,
    options?: {
      readonly messageId?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<MarshalRuntimeAgentWaitResult>;
  cancel(
    scope: MarshalRuntimeScope,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary>;
  /** Switch an idle owned agent's model in place; the summary reports the effective model. */
  setModel(
    scope: MarshalRuntimeScope,
    agentId: string,
    model: string,
    reasoningEffort?: ReasoningEffort,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary>;
}

export interface MarshalRuntimeAgentSessionPort {
  getSessionAsync(id: string): Promise<PersistedSession | null>;
  getRuntimeExecutionEvidence?(
    sessionId: string,
    executionId?: string,
  ): SessionExecutionEvidence | undefined;
  listSubagentSessions(parentSessionId?: string): SessionMetadata[];
  isSessionBusy(sessionId: string): boolean;
  /** Optional for older test/embedded session ports; native production wiring supplies both. */
  isSessionCancellationRequested?(sessionId: string): boolean;
  hasPendingAgentMessage?(sessionId: string): boolean;
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
    permissionMode?: "default" | "allow-all";
    model?: string;
    runtime?: string;
    reasoningEffort?: ReasoningEffort;
    soul?: string;
    parentSessionId?: string;
    runtimeAgentRole?: SessionRuntimeAgentRole;
    runtimeDelegationId?: string;
    runtimeTaskController?: string;
    skills?: string[];
    mcp?: string[];
    allowedTools?: string[];
    systemPrompt?: string;
    attachments?: string[];
    /** Runtime-managed agents must not enter the chat subagent todo/goal
     *  lifecycle; the owning extension manages the assignment explicitly. */
    suppressInitialTodoInstruction?: boolean;
    returnAfterBackendAcceptance?: boolean;
    suppressParentReadinessWake?: boolean;
    source?: "subagent";
  }): Promise<{ session: SessionMetadata }>;
  sendMessageToSubagent(args: {
    sessionId: string;
    message: string;
    deliveryMode?: "queue" | "interrupt";
    sourceSessionId?: string;
  }): Promise<AgentMessageApiResult>;
  assignRuntimeAgentRole(
    sessionId: string,
    role: SessionRuntimeAgentRole,
    delegationId?: string,
    taskController?: string,
  ): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  waitForAgentMessageBackendAccepted(messageId: string): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  /** Optional for older test/embedded session ports; SessionManager supplies both. */
  switchSessionModel?(
    sessionId: string,
    model: string,
    options: { reasoningEffort?: ReasoningEffort; liveSwitch?: boolean },
  ): Promise<string>;
  getEffectiveSessionModel?(sessionId: string): string | undefined;
  addEventListener(listener: (sessionId: string, event: TurnEvent) => void): () => void;
}

interface WaitSnapshot {
  readonly result?: string;
  /** The persisted error entry the turn ended with; the wait fails instead of completing. */
  readonly failure?: string;
  readonly messageFound: boolean;
  readonly canCompleteWhileIdle: boolean;
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw runtimeError("aborted", "Marshal Runtime agent operation was aborted.");
}

function normalizedWorkspaceName(session: SessionMetadata): string {
  return (
    session.workspaceName?.trim() ||
    session.originWorkspaceName?.trim() ||
    MARSHAL_RUNTIME_DEFAULT_WORKSPACE
  );
}

/**
 * Without a worktree, SessionManager pins the workspace root from one source
 * and rejects a workspaceName/repoPath pair that resolves to different roots.
 * A launch therefore names its root through exactly one source. A fresh
 * worktree is the exception: workspaceName picks the source workspace and
 * repoPath the source checkout, so both may accompany each other.
 */
export function resolveLaunchWorkspace(
  request: Pick<
    MarshalRuntimeAgentLaunchRequest,
    "workspaceName" | "repoPath" | "scope" | "createWorktree"
  >,
  owner: Pick<SessionMetadata, "workspaceName" | "repoPath">,
): { workspaceName?: string; repoPath?: string } {
  const pair = (workspaceName: string | undefined, repoPath: string | undefined) => ({
    ...(workspaceName ? { workspaceName } : {}),
    ...(repoPath ? { repoPath } : {}),
  });
  if (request.createWorktree) {
    return pair(
      request.workspaceName ?? request.scope.workspaceName,
      request.repoPath ?? owner.repoPath,
    );
  }
  if (request.workspaceName || request.repoPath) {
    return pair(request.workspaceName, request.repoPath);
  }
  if (!owner.workspaceName?.trim() && owner.repoPath) return pair(undefined, owner.repoPath);
  return pair(request.scope.workspaceName, undefined);
}

function workspaceKey(value: string): string {
  return value.trim().toLowerCase();
}

function boundedWaitTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw invalidRuntimeRequest(
      new RangeError(`Agent wait timeout must be between 1 and ${MAX_WAIT_TIMEOUT_MS}ms.`),
    );
  }
  return timeoutMs;
}

function boundedTranscriptLimit(limit?: number): number {
  if (limit === undefined) return MAX_TRANSCRIPT_MESSAGES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_MESSAGES) {
    throw invalidRuntimeRequest(
      new RangeError(`Agent transcript limit must be between 1 and ${MAX_TRANSCRIPT_MESSAGES}.`),
    );
  }
  return limit;
}

function visibleMessages(session: PersistedSession): SessionMessage[] {
  return session.messages.filter(isUserVisibleSessionMessage);
}

function messageMatches(message: SessionMessage, messageId: string): boolean {
  return message.id === messageId || message.agentMessage?.messageId === messageId;
}

function findLastMatchingIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function findLastMatching<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): T | undefined {
  const index = findLastMatchingIndex(values, predicate);
  return index >= 0 ? values[index] : undefined;
}

function snapshotForWait(session: PersistedSession, messageId?: string): WaitSnapshot {
  const messages = visibleMessages(session);
  if (!messageId) {
    const latestAssistantIndex = findLastMatchingIndex(
      messages,
      (message) => message.role === "assistant" && Boolean(message.content),
    );
    const latestUserIndex = findLastMatchingIndex(messages, (message) => message.role === "user");
    const latestAssistant = messages[latestAssistantIndex];
    const hasCompletedAssistantTurn = latestAssistantIndex > latestUserIndex;
    if (hasCompletedAssistantTurn && latestAssistant?.error === true) {
      return { failure: latestAssistant.content, messageFound: true, canCompleteWhileIdle: true };
    }
    return {
      result:
        hasCompletedAssistantTurn && latestAssistant?.content ? latestAssistant.content : undefined,
      messageFound: true,
      canCompleteWhileIdle: hasCompletedAssistantTurn,
    };
  }

  const messageIndex = messages.findIndex((message) => messageMatches(message, messageId));
  if (messageIndex < 0) {
    return { messageFound: false, canCompleteWhileIdle: false };
  }
  const reply = findLastMatching(
    messages.slice(messageIndex + 1),
    (message) => message.role === "assistant" && Boolean(message.content),
  );
  if (reply?.error === true) {
    return { failure: reply.content, messageFound: true, canCompleteWhileIdle: true };
  }
  const result = reply?.content;
  return {
    result,
    messageFound: true,
    canCompleteWhileIdle: Boolean(result),
  };
}

type CancellationDisposition = "none" | "continuation-pending" | "cancelled";

function cancellationDisposition(
  sessions: MarshalRuntimeAgentSessionPort,
  sessionId: string,
): CancellationDisposition {
  if (sessions.isSessionCancellationRequested?.(sessionId) !== true) return "none";
  return sessions.hasPendingAgentMessage?.(sessionId) === true
    ? "continuation-pending"
    : "cancelled";
}

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(runtimeError("aborted", "Marshal Runtime agent operation was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class SessionManagerRuntimeAgentAdapter implements MarshalRuntimeAgentPort {
  private activeWaitListeners = 0;
  private activeWaitTimers = 0;
  private activeWaitAbortListeners = 0;
  private readonly launches = new Map<string, Promise<MarshalRuntimeAgentSummary>>();

  constructor(private readonly sessions: MarshalRuntimeAgentSessionPort) {}

  dispose(): void {
    this.launches.clear();
  }

  async launch(request: MarshalRuntimeAgentLaunchRequest): Promise<MarshalRuntimeAgentSummary> {
    const owner = await this.requireOwner(request.scope, request.signal);
    throwIfAborted(request.signal);
    if (
      owner.runtimeTaskController &&
      request.runtimeTaskController !== owner.runtimeTaskController
    ) {
      throw runtimeError(
        "permission_denied",
        "Task-managed sessions must launch work through their owning extension task operations.",
      );
    }
    const key = `${owner.id}:${request.idempotencyKey}`;
    const existing = request.runtimeDelegationId
      ? [owner, ...this.sessions.listSubagentSessions(owner.id)].find(
          (session) =>
            session.runtimeDelegationId === request.runtimeDelegationId &&
            this.isOwnedMetadata(request.scope, session),
        )
      : undefined;
    if (existing) return this.toSummary(existing);
    const active = this.launches.get(key);
    if (active) return awaitAbortable(active, request.signal);
    const launch = this.createOwnedAgent(request, owner).finally(() => this.launches.delete(key));
    this.launches.set(key, launch);
    return awaitAbortable(launch, request.signal);
  }

  async list(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<readonly MarshalRuntimeAgentSummary[]> {
    await this.requireOwner(scope, signal);
    throwIfAborted(signal);
    return this.sessions
      .listSubagentSessions(scope.sessionId)
      .filter((session) => this.isOwnedMetadata(scope, session))
      .map((session) => this.toSummary(session));
  }

  async get(
    scope: MarshalRuntimeScope,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary | null> {
    await this.requireOwner(scope, signal);
    throwIfAborted(signal);
    if (agentId === scope.sessionId) {
      const owner = await this.sessions.getSessionAsync(scope.sessionId);
      return owner ? this.toSummary(owner) : null;
    }
    const session = this.findOwnedMetadata(scope, agentId);
    return session ? this.toSummary(session) : null;
  }

  async send(
    scope: MarshalRuntimeScope,
    agentId: string,
    message: string,
    deliveryMode: "queue" | "interrupt",
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentMessageResult> {
    await this.requireOwnedSession(scope, agentId, signal);
    throwIfAborted(signal);
    if (agentId === scope.sessionId) {
      await this.sessions.sendMessage(agentId, message);
      const agent = await this.requireOwnedSession(scope, agentId, signal);
      return { agent: this.toSummary(agent), accepted: true };
    }
    const result = await this.sessions.sendMessageToSubagent({
      sessionId: agentId,
      message,
      deliveryMode,
      sourceSessionId: scope.sessionId,
    });
    if (!result.success || result.accepted !== true) {
      throw runtimeError(
        "operation_failed",
        result.error ?? "Marshal agent message was not accepted.",
      );
    }
    if (!result.messageId) {
      throw runtimeError("operation_failed", "Marshal agent message has no durable message ID.");
    }
    await awaitAbortable(
      this.sessions.waitForAgentMessageBackendAccepted(result.messageId),
      signal,
    );
    const agent = await this.requireOwnedSession(scope, agentId, signal);
    return {
      agent: this.toSummary(agent),
      accepted: true,
      messageId: result.messageId,
      deliveryState: "backend-accepted",
    };
  }

  async transcript(
    scope: MarshalRuntimeScope,
    agentId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentTranscript> {
    const session = await this.requireOwnedSession(scope, agentId, signal);
    throwIfAborted(signal);
    return this.toTranscript(session, boundedTranscriptLimit(limit));
  }

  async wait(
    scope: MarshalRuntimeScope,
    agentId: string,
    options: {
      readonly messageId?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<MarshalRuntimeAgentWaitResult> {
    const initialSession = await this.requireOwnedSession(scope, agentId, options.signal);
    throwIfAborted(options.signal);
    const timeoutMs =
      options.timeoutMs === undefined ? undefined : boundedWaitTimeout(options.timeoutMs);
    const initialSnapshot = snapshotForWait(initialSession, options.messageId);
    const initialEvidence = this.sessions.getRuntimeExecutionEvidence?.(agentId);
    const executionId = initialEvidence?.executionId;
    const initialCancellation = cancellationDisposition(this.sessions, agentId);
    if (initialCancellation === "cancelled") {
      throw runtimeError(
        "cancelled",
        `Native agent "${agentId}" was cancelled before producing a completed result.`,
      );
    }
    if (
      initialCancellation === "none" &&
      !this.sessions.isSessionBusy(agentId) &&
      initialSnapshot.canCompleteWhileIdle &&
      (!options.messageId || initialSnapshot.messageFound)
    ) {
      if (initialSnapshot.failure !== undefined) {
        throw runtimeError("operation_failed", initialSnapshot.failure);
      }
      return {
        state: "completed",
        agent: this.toSummary(initialSession),
        ...(initialSnapshot.result ? { result: initialSnapshot.result } : {}),
        ...(this.sessions.getRuntimeExecutionEvidence?.(agentId, executionId) ?? initialEvidence),
      };
    }

    return new Promise<MarshalRuntimeAgentWaitResult>((resolve, reject) => {
      let settled = false;
      let finishing = false;
      let matchedMessage = false;
      let latestSession = initialSession;
      let unsubscribe = (): void => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listenerActive = false;
      let abortListenerActive = false;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          this.activeWaitTimers--;
        }
        timer = undefined;
        unsubscribe();
        unsubscribe = (): void => {};
        if (listenerActive) {
          listenerActive = false;
          this.activeWaitListeners--;
        }
        if (abortListenerActive) {
          options.signal?.removeEventListener("abort", onAbort);
          abortListenerActive = false;
          this.activeWaitAbortListeners--;
        }
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = (
        state: MarshalRuntimeAgentWaitResult["state"],
        session: PersistedSession,
      ) => {
        if (settled) return;
        const snapshot = snapshotForWait(session, options.messageId);
        settled = true;
        cleanup();
        resolve({
          state,
          agent: this.toSummary(session),
          ...(snapshot.result ? { result: snapshot.result } : {}),
          ...(this.sessions.getRuntimeExecutionEvidence?.(agentId, executionId) ?? initialEvidence),
        });
      };
      const finishCompleted = async () => {
        if (settled || finishing) return;
        finishing = true;
        try {
          const session = await this.requireOwnedSession(scope, agentId);
          if (settled) return;
          latestSession = session;
          const snapshot = snapshotForWait(session, options.messageId);
          const cancellation = cancellationDisposition(this.sessions, agentId);
          if (cancellation === "cancelled") {
            resolveOnce("completed", session);
            return;
          }
          if (
            cancellation !== "none" ||
            this.sessions.isSessionBusy(agentId) ||
            !snapshot.canCompleteWhileIdle ||
            (options.messageId !== undefined && !snapshot.messageFound)
          ) {
            finishing = false;
            return;
          }
          if (snapshot.failure !== undefined) {
            rejectOnce(runtimeError("operation_failed", snapshot.failure));
            return;
          }
          resolveOnce("completed", session);
        } catch (error) {
          rejectOnce(error);
        }
      };
      const onAbort = () =>
        rejectOnce(runtimeError("aborted", "Marshal Runtime agent wait was aborted."));

      unsubscribe = this.sessions.addEventListener((sessionId, event) => {
        if (settled || sessionId !== agentId) return;
        if (event.type === "turn:message-committed" && options.messageId) {
          if (messageMatches(event.message, options.messageId)) matchedMessage = true;
          return;
        }
        if (event.type === "turn:error" && event.retrying !== true) {
          rejectOnce(runtimeError("operation_failed", event.error));
          return;
        }
        if (event.type === "turn:idle" && (!options.messageId || matchedMessage)) {
          void finishCompleted();
        }
      });
      listenerActive = true;
      this.activeWaitListeners++;
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortListenerActive = true;
        this.activeWaitAbortListeners++;
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => resolveOnce("timeout", latestSession), timeoutMs);
        this.activeWaitTimers++;
      }

      void this.requireOwnedSession(scope, agentId)
        .then((session) => {
          if (settled) return;
          latestSession = session;
          const snapshot = snapshotForWait(session, options.messageId);
          matchedMessage = snapshot.messageFound;
          if (
            cancellationDisposition(this.sessions, agentId) === "none" &&
            !this.sessions.isSessionBusy(agentId) &&
            snapshot.canCompleteWhileIdle &&
            (!options.messageId || matchedMessage)
          ) {
            void finishCompleted();
          }
        })
        .catch(rejectOnce);
    });
  }

  async cancel(
    scope: MarshalRuntimeScope,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary> {
    await this.requireOwnedSession(scope, agentId, signal);
    throwIfAborted(signal);
    await this.sessions.cancelTurn(agentId);
    return this.toSummary(await this.requireOwnedSession(scope, agentId, signal));
  }

  async setModel(
    scope: MarshalRuntimeScope,
    agentId: string,
    model: string,
    reasoningEffort?: ReasoningEffort,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeAgentSummary> {
    await this.requireOwnedSession(scope, agentId, signal);
    throwIfAborted(signal);
    if (!this.sessions.switchSessionModel) {
      throw runtimeError("operation_failed", "Marshal agent model switching is unavailable.");
    }
    try {
      await this.sessions.switchSessionModel(agentId, model, {
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        liveSwitch: true,
      });
    } catch (error) {
      throw runtimeError(
        "operation_failed",
        error instanceof Error ? error.message : "Marshal agent model switch failed.",
      );
    }
    return this.toSummary(await this.requireOwnedSession(scope, agentId, signal));
  }

  getRuntimeAcceptanceDiagnostics(): {
    readonly activeWaitListeners: number;
    readonly activeWaitTimers: number;
    readonly activeWaitAbortListeners: number;
  } {
    return {
      activeWaitListeners: this.activeWaitListeners,
      activeWaitTimers: this.activeWaitTimers,
      activeWaitAbortListeners: this.activeWaitAbortListeners,
    };
  }

  private async createOwnedAgent(
    request: MarshalRuntimeAgentLaunchRequest,
    owner: PersistedSession,
  ): Promise<MarshalRuntimeAgentSummary> {
    await assertLaunchOverride(request);
    if (request.sessionId === owner.id) {
      return this.adoptCallerSession(request, owner);
    }
    const toolFree = isToolFreeRuntimeAgentRole(request.runtimeAgentRole);
    const restrictedTools = toolFree || request.allowedTools !== undefined;
    const created = await this.sessions.createSubagentSession({
      task: request.task,
      name: request.name,
      agentName: request.agentName,
      ...resolveLaunchWorkspace(request, owner),
      createWorktree: request.createWorktree,
      worktreeName: request.worktreeName,
      branchName: request.branchName,
      baseRef: request.baseRef,
      // Runtime-managed agents execute under a bounded swarm authority in an
      // isolated worktree. They cannot depend on an interactive permission
      // card owned by the conversational parent while the scheduler waits.
      permissionMode: "allow-all",
      model: request.model,
      runtime: request.runtime,
      reasoningEffort: request.reasoningEffort,
      soul: request.soul,
      parentSessionId: owner.id,
      runtimeAgentRole: request.runtimeAgentRole,
      runtimeDelegationId: request.runtimeDelegationId,
      runtimeTaskController: request.runtimeTaskController,
      ...(request.allowedTools ? { allowedTools: [...request.allowedTools] } : {}),
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
      ...(request.attachments?.length ? { attachments: [...request.attachments] } : {}),
      skills: restrictedTools ? [] : owner.scopedSkills ? [...owner.scopedSkills] : undefined,
      mcp: restrictedTools ? [] : owner.scopedMcp ? [...owner.scopedMcp] : undefined,
      suppressInitialTodoInstruction: true,
      returnAfterBackendAcceptance: true,
      suppressParentReadinessWake: true,
      source: "subagent",
    });
    if (!this.isOwnedMetadata(request.scope, created.session)) {
      throw runtimeError(
        "operation_failed",
        "Marshal created an agent outside the requested parent session.",
      );
    }
    return this.toSummary(created.session);
  }

  private async adoptCallerSession(
    request: MarshalRuntimeAgentLaunchRequest,
    owner: PersistedSession,
  ): Promise<MarshalRuntimeAgentSummary> {
    await this.sessions.assignRuntimeAgentRole(
      owner.id,
      request.runtimeAgentRole ?? DEFAULT_ADOPTED_RUNTIME_AGENT_ROLE,
      ...(request.runtimeDelegationId
        ? [request.runtimeDelegationId, request.runtimeTaskController]
        : []),
    );
    if (this.sessions.isSessionBusy(owner.id)) {
      await this.sessions.cancelTurn(owner.id);
    }
    await this.sessions.sendMessage(owner.id, request.task);
    const session = await this.sessions.getSessionAsync(owner.id);
    if (!session) {
      throw runtimeError("not_found", "Marshal agent was not found in this session.");
    }
    return this.toSummary(session);
  }

  private async requireOwner(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<PersistedSession> {
    throwIfAborted(signal);
    const owner = await this.sessions.getSessionAsync(scope.sessionId);
    throwIfAborted(signal);
    if (!owner) {
      throw runtimeError("permission_denied", "Marshal Runtime owner session is unavailable.");
    }
    if (workspaceKey(normalizedWorkspaceName(owner)) !== workspaceKey(scope.workspaceName)) {
      throw runtimeError(
        "permission_denied",
        "Marshal Runtime agent workspace authority no longer matches the owner session.",
      );
    }
    return owner;
  }

  private isOwnedMetadata(scope: MarshalRuntimeScope, session: SessionMetadata): boolean {
    return (
      session.id === scope.sessionId ||
      (session.source === "subagent" && session.parentSessionId === scope.sessionId)
    );
  }

  private findOwnedMetadata(scope: MarshalRuntimeScope, agentId: string): SessionMetadata | null {
    return (
      this.sessions
        .listSubagentSessions(scope.sessionId)
        .find((session) => session.id === agentId && this.isOwnedMetadata(scope, session)) ?? null
    );
  }

  private async requireOwnedSession(
    scope: MarshalRuntimeScope,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<PersistedSession> {
    const owner = await this.requireOwner(scope, signal);
    if (agentId === scope.sessionId) return owner;
    if (!this.findOwnedMetadata(scope, agentId)) {
      throw runtimeError("not_found", "Marshal agent was not found in this session.");
    }
    throwIfAborted(signal);
    const session = await this.sessions.getSessionAsync(agentId);
    throwIfAborted(signal);
    if (!session || session.id !== agentId || !this.isOwnedMetadata(scope, session)) {
      throw runtimeError("not_found", "Marshal agent was not found in this session.");
    }
    return session;
  }

  private toSummary(session: SessionMetadata): MarshalRuntimeAgentSummary {
    const model = this.sessions.getEffectiveSessionModel?.(session.id) ?? session.model;
    return {
      id: session.id,
      name: session.name,
      state: this.sessions.isSessionBusy(session.id) ? "running" : "idle",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}),
      ...(session.repoPath ? { repoPath: session.repoPath } : {}),
      ...(model ? { model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.soul ? { soul: session.soul } : {}),
      ...(session.runtimeAgentRole ? { runtimeAgentRole: session.runtimeAgentRole } : {}),
      ...this.sessions.getRuntimeExecutionEvidence?.(session.id),
    };
  }

  private toTranscript(session: PersistedSession, limit: number): MarshalRuntimeAgentTranscript {
    const all = visibleMessages(session);
    const messages = all.slice(-limit).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS),
      timestamp: message.timestamp,
      ...(message.error ? { error: true } : {}),
    }));
    const result = findLastMatching(
      all,
      (message) => message.role === "assistant" && Boolean(message.content),
    )?.content;
    return {
      agent: this.toSummary(session),
      messageCount: all.length,
      showing: messages.length,
      messages,
      ...(result ? { result } : {}),
    };
  }
}
