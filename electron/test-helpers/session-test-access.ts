import type { SessionInternalControlMetadata } from "../../common/marshal-ipc-contract";
import type { BackendEvent, IBackendProvider } from "../backend/types";
/**
 * Typed accessor for SessionManager private members in tests.
 * Centralizes the single `as any` cast so test files don't need eslint-disable comments.
 */
import type { ISessionStore, PersistedSession } from "../session-store";
import type { SendAndCollectResult, SessionManager } from "../sessions";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */
// All private access is funneled through this one class — two lint suppresses instead of ~91.

type AnySessionManager = any;
type CreateBackendSessionForTest = (
  sessionId: string,
  isNew?: boolean,
  model?: string,
  soul?: string,
  options?: unknown,
) => Promise<void>;

export class SessionTestAccess {
  private readonly mgr: AnySessionManager;

  constructor(mgr: SessionManager) {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- this helper centralizes test-only private access.
    this.mgr = mgr as AnySessionManager;
    // Tests stub `loadIndex`; keep it the single index seam for read-only callers too.
    const store = this.mgr.store;
    if (store.loadIndexReadOnly) store.loadIndexReadOnly = () => store.loadIndex();
  }

  // -- Properties (read + write) --

  get backend() {
    return this.mgr.backend;
  }
  set backend(v: unknown) {
    this.mgr.backend = v;
  }

  /**
   * Convenience accessor for the CopilotBackend's internal `client` field.
   * Many tests do `access.client = { createSession: ... }` to inject a mock SDK client.
   */
  get client(): unknown {
    return this.mgr.backend?.client ?? null;
  }
  set client(v: unknown) {
    if (this.mgr.backend) {
      this.mgr.backend.client = v;
    }
  }

  prewarm(): void {
    this.mgr.prewarm();
  }

  setCreateBackendSessionForTest(fn: CreateBackendSessionForTest): void {
    this.mgr.createBackendSession = fn;
  }

  setPerformSendForTest(fn: () => Promise<void>): void {
    this.mgr.performSend = fn;
  }

  setDoSendAndCollectForTest(fn: () => Promise<SendAndCollectResult>): void {
    this.mgr.doSendAndCollect = fn;
  }

  withRelaySessionContextForTest(sessionId: string, prompt: string): string {
    return this.mgr.withRelaySessionContext(sessionId, prompt);
  }

  /**
   * Convenience accessor for the CopilotBackend's internal `activeSessions` map.
   * Tests use this to pre-populate or inspect SDK session state.
   */
  get activeSessions(): Map<string, unknown> {
    return this.mgr.backend?.activeSessions ?? new Map();
  }

  get sessionHandles(): Map<string, unknown> {
    return this.mgr.sessionHandles;
  }

  get sdkSessionIds(): Map<string, string> {
    return this.mgr.backendSessionIds;
  }

  get backendSessionIds(): Map<string, string> {
    return this.mgr.backendSessionIds;
  }

  get activeGoalAssignments(): Map<string, unknown> {
    return this.mgr.activeGoalAssignments;
  }

  get activeInternalControlTurns(): Map<string, SessionInternalControlMetadata> {
    return this.mgr.activeInternalControlTurns;
  }

  get workspaceMutationSessionLocks(): Set<string> {
    return this.mgr.workspaceMutationSessionLocks;
  }

  get busyTracker(): {
    setBusy(id: string): void;
    setIdle(id: string): void;
    isBusy(id: string): boolean;
    getBusySessionIds(): ReadonlySet<string>;
    resetActivityTimer(id: string): void;
  } {
    return this.mgr.busyTracker;
  }

  get viewEmission(): {
    emitEvent(sessionId: string, event: unknown): void;
    updateView(sessionId: string, event: unknown): void;
  } {
    return this.mgr.viewEmission;
  }

  get mcpServerStatuses(): Map<
    string,
    { serverName: string; status: "connected" | "failed" | "needs-auth"; error?: string }
  > {
    return this.mgr.mcpStatus.mcpServerStatuses;
  }

  get mcpStatusListeners(): Set<(event: unknown) => void> {
    return this.mgr.mcpStatus.mcpStatusListeners;
  }

  get pendingConnectionWaits(): Map<string, Promise<void>> {
    return this.mgr.mcpStatus.pendingConnectionWaits;
  }

  get mcpConnectionWaitAborters(): Map<string, () => void> {
    return this.mgr.mcpStatus.mcpConnectionWaitAborters;
  }

  /** The real BackgroundTaskManager instance — tests drive it directly via
   *  its own public API (handleBackendEvent / hasRunning / clear). */
  get backgroundTasks(): import("../background-task-manager").BackgroundTaskManager {
    return this.mgr.backgroundTasks;
  }

  /** Drives SessionManager's private background-task wake attempt directly,
   *  bypassing the backend event-subscription plumbing. */
  tryWakeSessionForBackgroundTask(sessionId: string): Promise<void> {
    return this.mgr.tryWakeSessionForBackgroundTask(sessionId);
  }

  /**
   * Synchronously dispatch an mcp-server-status (or other backend) event to
   * all subscribed listeners — mirrors what `subscribeToBackendEvents` does
   * after caching the status. Tests use this to drive `waitForMcpServerConnection`
   * deterministically without spinning up a real backend.
   *
   * Delegates to the real `handleBackendEvent` path on McpStatusManager so the
   * dispatch + cache-update logic stays in one place. A synthetic sessionId
   * and no-op logger are provided because tests bypass real session
   * subscription wiring.
   */
  emitMcpStatusEvent(event: {
    type: "mcp-server-status";
    serverName: string;
    status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured";
    error?: string;
  }): void {
    this.mgr.mcpStatus.handleBackendEvent(event, {
      sessionId: "test-session",
      log: { info: () => {}, warn: () => {} },
    });
  }

  get currentSessionId(): string | null {
    return this.mgr.currentSessionId;
  }
  set currentSessionId(v: string | null) {
    this.mgr.currentSessionId = v;
  }

  get authErrorCallback(): ((error: string) => void) | null {
    return this.mgr.authErrorCallback;
  }
  set authErrorCallback(v: ((error: string) => void) | null) {
    this.mgr.authErrorCallback = v;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic MCP server shape
  get customMcpServers(): any[] {
    return this.mgr.mcpStatus.customMcpServers;
  }
  set customMcpServers(v: unknown[]) {
    this.mgr.mcpStatus.customMcpServers = v;
  }

  get selfToolDeps(): unknown {
    return this.mgr.selfToolDeps;
  }
  set selfToolDeps(v: unknown) {
    this.mgr.selfToolDeps = v;
  }

  get sessions(): Map<string, unknown> {
    return this.mgr.sessions;
  }
  set sessions(v: Map<string, unknown>) {
    this.mgr.sessions = v;
  }

  get pendingSessionCreations(): Map<string, Promise<unknown>> {
    return this.mgr.pendingSessionCreations;
  }

  get sessionPauseTransitions(): Map<string, Promise<boolean>> {
    return this.mgr.sessionPauseTransitions;
  }

  get idleReapTimer(): ReturnType<typeof setInterval> | null {
    return this.mgr.idleReapTimer;
  }

  // -- Methods --

  getBackend(): IBackendProvider {
    return this.mgr.backend;
  }

  getSdkSessionId(id: string): string | undefined {
    return this.mgr.getSdkSessionId(id);
  }

  persistBackendId(sessionId: string, backendId: string): void {
    this.mgr.persistBackendId(sessionId, backendId);
  }

  createBackendSession(
    sessionId: string,
    isNew?: boolean,
    model?: string,
    soul?: string,
  ): Promise<unknown> {
    return this.mgr.createBackendSession(sessionId, isNew, model, soul);
  }

  subscribeToBackendEvents(sessionId: string): void {
    this.mgr.subscribeToBackendEvents(sessionId);
  }

  pauseSessionIfEligible(id: string, eligible: () => boolean): Promise<boolean> {
    return this.mgr.pauseSessionIfEligible(id, eligible);
  }

  startIdleSessionReaper(): void {
    this.mgr.startIdleSessionReaper();
  }

  stopIdleSessionReaper(): void {
    this.mgr.stopIdleSessionReaper();
  }

  restartBackendRuntime(): Promise<number> {
    return this.mgr.restartBackendRuntime();
  }

  notifyParentOfStuckSubagent(sessionId: string): Promise<void> {
    return this.mgr.notifyParentOfStuckSubagent(sessionId);
  }

  /** Test-only access to the private launch-pending marker used by the
   *  goal-loop subagent-yield predicate. */
  markSubagentLaunchPending(childSessionId: string, now?: number): void {
    this.mgr.markSubagentLaunchPending(childSessionId, now);
  }

  get subagentLaunchPending(): Map<string, number> {
    return this.mgr.subagentLaunchPending;
  }

  /** In-flight sends per session. The goal-loop subagent-yield predicate reads
   *  this as the synchronous stand-in for "a message is on its way to the
   *  child but its turn has not started", so a child can be neither busy nor
   *  launch-pending and still be real work in flight. */
  get pendingSendDrains(): Map<string, { count: number }> {
    return this.mgr.pendingSendDrains;
  }

  get pendingParentReadinessWakes(): Map<string, Map<string, unknown>> {
    return this.mgr.pendingParentReadinessWakes;
  }

  /** Last time any child of the given parent went idle. Drives the settle
   *  window that stops the goal loop from racing ahead between two subagent
   *  turns. */
  get lastSubagentIdleAt(): Map<string, number> {
    return this.mgr.lastSubagentIdleAt;
  }

  performBackendRuntimeRestart(): Promise<void> {
    return this.mgr.performBackendRuntimeRestart();
  }

  flushParentReadinessWake(parentSessionId: string): Promise<void> {
    return this.mgr.flushParentReadinessWake(parentSessionId);
  }

  interruptCollectionForTest(sessionId: string, reason: string): void {
    this.mgr.interruptCollection(sessionId, reason);
  }

  setSelfToolDepsForTest(deps: unknown): void {
    this.mgr.selfToolDeps = deps;
  }

  /** The underlying manager, narrowly typed for `vi.spyOn` in tests so call
   *  sites don't need their own `as any`. Spying here intercepts internal
   *  `this.sendMessageToParent(...)` calls since it's the same object. */
  get spyTarget(): {
    sendMessageToParent: (args: {
      sessionId: string;
      message: string;
      deliveryMode?: "queue" | "interrupt";
      waitForResponse?: boolean;
      timeoutMs?: number;
    }) => Promise<{ success: boolean; response?: string; status?: string; error?: string }>;
  } {
    return this.mgr;
  }

  getCopilotBackendSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void> {
    const getSessionSubscribers = this.mgr.backend?.getSessionSubscribers;
    if (typeof getSessionSubscribers !== "function") {
      throw new Error("Test backend does not expose CopilotBackend session subscribers");
    }

    const subscribers = getSessionSubscribers.call(this.mgr.backend, sessionId);
    if (!subscribers) {
      throw new Error(`No backend session subscribers registered for ${sessionId}`);
    }
    return subscribers;
  }

  /** @deprecated Use createBackendSession(). Alias kept for test compatibility. */
  async createSDKSession(
    sessionId: string,
    isNew?: boolean,
    model?: string,
    soul?: string,
  ): Promise<unknown> {
    return this.createBackendSession(sessionId, isNew, model, soul);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic config shape from SDK
  getMcpConfig(overrideWorkspaceDir?: string): Record<string, any> {
    return this.mgr.backend?.getMcpConfig?.(overrideWorkspaceDir) ?? {};
  }

  async refreshExpiredTokens(): Promise<void> {
    return this.mgr.refreshExpiredTokens();
  }

  get store(): ISessionStore {
    return this.mgr.store;
  }

  loadSessionData(id: string): PersistedSession | null {
    return this.store.loadSessionData(id);
  }

  saveSessionData(session: PersistedSession): void {
    this.store.saveSessionData(session);
  }

  replaceCreateBackendSession(fn: CreateBackendSessionForTest): void {
    this.mgr.createBackendSession = fn;
  }

  replaceRefreshExpiredTokens(fn: () => Promise<void>): void {
    this.mgr.refreshExpiredTokens = fn;
  }

  emitSessionStatus(sessionId: string, status: string | null): void {
    this.mgr.emitSessionStatus(sessionId, status);
  }

  get turnAccumulators(): Map<string, unknown> {
    return this.mgr.turnAccumulators;
  }

  buildConversationContext(
    sessionId: string,
    messages: PersistedSession["messages"],
  ): Promise<string | null> {
    return this.mgr.buildConversationContext(sessionId, messages);
  }

  get lastAuthEmitBySession(): Map<string, number> {
    return this.mgr.lastAuthEmitBySession;
  }

  /** Invoke the private GITHUB_TOKEN_FAILED dedup helper. */
  emitAuthErrorTelemetry(sessionId: string, cause?: unknown): void {
    this.mgr.emitAuthErrorTelemetry(sessionId, cause);
  }

  get sendAndCollectQueues(): Map<string, unknown> {
    return this.mgr.sendAndCollectQueues;
  }

  get runningTools(): Map<
    string,
    {
      sessionId: string;
      toolCallId: string;
      toolName: string;
      serverName?: string;
      startedAtMs: number;
      status: "running" | "completed" | "failed" | "cancelled";
      backgrounded: boolean;
      completedAtMs?: number;
      result?: unknown;
      outputPreview?: string;
      resultTruncated?: boolean;
      error?: string;
      cancel?: () => Promise<void> | void;
      cancellationScope: "tool" | "turn" | "none";
      process?: {
        rootPid: number;
        identitySource: "spawned-child";
        cancellationScope: "process-tree" | "process-group";
      };
      heartbeatTimer?: ReturnType<typeof setTimeout>;
    }
  > {
    return this.mgr.runningTools;
  }

  clearAllRunningTools(): Promise<void> {
    return this.mgr.clearAllRunningTools();
  }

  /** Test-only access to the private `selectRepositoryAgent` helper. */
  selectRepositoryAgent(
    workspacePath: string | undefined,
    requestedAgentName: string | undefined,
  ): {
    selectedAgent?: { name: string; path: string; description?: string };
    availableAgents: { name: string; path: string; description?: string }[];
  } {
    return this.mgr.selectRepositoryAgent(workspacePath, requestedAgentName);
  }

  replaceGit(fn: (cwd: string, args: string[]) => Promise<string>): void {
    this.mgr.git = fn;
  }

  replaceGetWorktreeRoot(fn: () => string): void {
    this.mgr.getWorktreeRoot = fn;
  }

  resolveBackendWorkspaceRoot(sessionData: unknown): string | undefined {
    return this.mgr.resolveBackendWorkspaceRoot(sessionData);
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */
