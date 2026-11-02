// electron/workflows/spawn-adapter.ts
//
// Bridge from `ctx.spawn` / `ctx.run` to `SessionManager.createSubagentSession*`.
// Defined as an interface (port) so tests can plug in stubs without
// constructing a real `SessionManager`.
//
// Workflow agent wiring:
//   `ctx.spawn(opts)` → `createSubagentSessionDeferred` (no launch prompt)
//   `ctx.run(opts, prompt)` → deferred session + atomic sendAndCollect
//   `ctx.send(handle, text)` → `sendMessageToSubagent`
//   `ctx.cancel(handle)` → `cancelTurn`
//
// The default implementation here is intentionally thin — most logic
// already lives on `SessionManager`. The adapter's job is to translate
// our `SpawnOptions` shape into the per-method arg objects.

import type { SpawnOptions } from "@marshal/workflow-sdk";

import type { SessionManager } from "../sessions";

export interface SpawnedHandle {
  readonly handleId: string;
  readonly sessionId: string;
  /**
   * Resolved spawn forensics, captured at creation so they survive the
   * subagent session being disposed at run end. `model`/`reasoningEffort` are
   * the per-session OVERRIDE (undefined = the host/tier default resolved by
   * ModelManager); `repositoryAgentName` is the repo persona that actually
   * loaded (e.g. the CliDri `investigator`). Surfaced into the spawn
   * diagnostics so a run's model/reasoning/persona is verifiable after the fact.
   */
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly repositoryAgentName?: string;
}

export interface SpawnAdapter {
  /** Create a subagent session without sending a prompt. */
  spawn(opts: ResolvedSpawnOpts): Promise<SpawnedHandle>;
  /** Create a subagent session and send the initial prompt. */
  spawnAndRun(opts: ResolvedSpawnOpts, prompt: string): Promise<SpawnedHandle>;
  /** Send a follow-up message; resolves once delivered (does not wait for reply). */
  send(handle: SpawnedHandle, text: string, opts?: { deliveryMode?: DeliveryMode }): Promise<void>;
  /**
   * Wait for the next assistant reply on the handle's session. Pure
   * passive listener — sends NO user message. Returns the assistant's
   * final text from the current/next `turn:idle`.
   *
   * NOTE: Earlier versions of this method delivered a sentinel empty
   * user message via `sendMessageToSubagent({ message: "" })` — that
   * created a SECOND turn after the first prompt had already completed,
   * causing the engine to capture the wrong reply (often empty) and
   * stalling workflow steps. The fix is to listen passively.
   */
  waitForReply(handle: SpawnedHandle, opts?: { timeoutMs?: number }): Promise<string>;
  /**
   * Atomic send + collect on an existing handle's session. Subscribes to
   * turn events BEFORE dispatching the user message, eliminating the
   * subscribe-after-send race. Used by `ctx.run` for race-free capture
   * of the first turn's assistant reply.
   */
  sendAndCollect(
    handle: SpawnedHandle,
    message: string,
    opts?: { timeoutMs?: number },
  ): Promise<string>;
  /** Cooperatively cancel any in-flight turn on the handle's session. */
  cancel(handle: SpawnedHandle): Promise<void>;
  /** Release the runtime resources for a workflow-owned subagent session. */
  dispose?(handle: SpawnedHandle): Promise<void>;
  /**
   * Optional: subscribe to `messageParent` calls originating from
   * `subagentSessionId`. Returns an unsubscribe function. The engine uses
   * this to record parent handoffs and, when no assistant reply is
   * captured, treat the latest parent message as the ctx.run reply.
   *
   * Implementations should scope the listener to the given session id
   * (the global listener is fanned out by the SessionManager); tests may
   * omit this method entirely.
   */
  onSubagentParentMessage?(
    subagentSessionId: string,
    cb: (info: { subagentSessionId: string; parentSessionId: string; message: string }) => void,
  ): () => void;
}

export type DeliveryMode = "wait-if-idle" | "queue" | "interrupt";

export interface ResolvedSpawnOpts extends SpawnOptions {
  readonly hostSessionId: string;
}

// ─── Default SessionManager-backed implementation ──────────────────────

/** Shape shared by `createSubagentSession*` returns (subset we read). */
interface CreatedSubagentResult {
  readonly session: {
    readonly id: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  };
  readonly repositoryAgent?: { readonly name: string };
}

/** Build a `SpawnedHandle`, snapshotting the resolved model/reasoning/persona
 *  so they survive the session being disposed at run end. */
function toSpawnedHandle(result: CreatedSubagentResult): SpawnedHandle {
  return {
    handleId: result.session.id,
    sessionId: result.session.id,
    model: result.session.model,
    reasoningEffort: result.session.reasoningEffort,
    repositoryAgentName: result.repositoryAgent?.name,
  };
}

/**
 * Default `SpawnAdapter` backed by the live `SessionManager`. Used in
 * production wiring; tests substitute a stub.
 */
export class SessionManagerSpawnAdapter implements SpawnAdapter {
  constructor(private readonly sessionManager: SessionManager) {}

  async spawn(opts: ResolvedSpawnOpts): Promise<SpawnedHandle> {
    const result = await this.sessionManager.createSubagentSessionDeferred({
      name: opts.displayName,
      agentName: opts.agentName,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      soul: opts.personality,
      permissionMode: opts.permissionMode,
      workspaceName: opts.workspaceName,
      repoPath: opts.repoPath,
      createWorktree: opts.createWorktree,
      worktreeName: opts.worktreeName,
      branchName: opts.branchName,
      baseRef: opts.baseRef,
      parentSessionId: opts.hostSessionId,
      skills: opts.skills ? Array.from(opts.skills) : undefined,
      mcp: opts.mcp ? Array.from(opts.mcp) : undefined,
    });
    return toSpawnedHandle(result);
  }

  async spawnAndRun(opts: ResolvedSpawnOpts, prompt: string): Promise<SpawnedHandle> {
    const result = await this.sessionManager.createSubagentSession({
      task: prompt,
      name: opts.displayName,
      agentName: opts.agentName,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      soul: opts.personality,
      permissionMode: opts.permissionMode,
      workspaceName: opts.workspaceName,
      repoPath: opts.repoPath,
      createWorktree: opts.createWorktree,
      worktreeName: opts.worktreeName,
      branchName: opts.branchName,
      baseRef: opts.baseRef,
      parentSessionId: opts.hostSessionId,
      skills: opts.skills ? Array.from(opts.skills) : undefined,
      mcp: opts.mcp ? Array.from(opts.mcp) : undefined,
    });
    return toSpawnedHandle(result);
  }

  async send(
    handle: SpawnedHandle,
    text: string,
    opts?: { deliveryMode?: DeliveryMode },
  ): Promise<void> {
    const result = await this.sessionManager.sendMessageToSubagent({
      sessionId: handle.sessionId,
      message: text,
      deliveryMode: opts?.deliveryMode ?? "queue",
    });
    if (!result.success) throw new Error(result.error ?? "send failed");
  }

  async waitForReply(handle: SpawnedHandle, opts?: { timeoutMs?: number }): Promise<string> {
    // Passive listener — does NOT send a user message. Older versions of
    // this method delivered an empty `sendMessageToSubagent({ message: "" })`
    // which created a stray second user turn after the prompt that
    // `ctx.run` had already dispatched, corrupting workflow step capture.
    const result = await this.sessionManager.collectNextAssistantReply(
      handle.sessionId,
      opts?.timeoutMs,
    );
    if (result.kind === "ok") return result.text;
    if (result.kind === "timeout")
      throw new Error("Timed out waiting for the subagent's next assistant reply.");
    throw new Error("Subagent turn completed without an assistant reply.");
  }

  async sendAndCollect(
    handle: SpawnedHandle,
    message: string,
    opts?: { timeoutMs?: number },
  ): Promise<string> {
    // Atomic — `sendAndCollect` subscribes to turn events BEFORE
    // dispatching the message, so the engine never misses the first
    // assistant tokens (no subscribe-after-send race).
    const result = await this.sessionManager.sendAndCollect(
      message,
      opts?.timeoutMs,
      undefined,
      handle.sessionId,
    );
    if (result.kind === "ok") return result.text;
    if (result.kind === "timeout") throw new Error("Timed out waiting for the subagent's reply.");
    throw new Error("Subagent turn completed without an assistant reply.");
  }

  async cancel(handle: SpawnedHandle): Promise<void> {
    try {
      await this.sessionManager.cancelTurn(handle.sessionId);
    } catch {
      // best-effort
    }
  }

  async dispose(handle: SpawnedHandle): Promise<void> {
    await this.sessionManager.pauseSession(handle.sessionId);
  }

  onSubagentParentMessage(
    subagentSessionId: string,
    cb: (info: { subagentSessionId: string; parentSessionId: string; message: string }) => void,
  ): () => void {
    // SessionManager's listener is global; scope by sessionId here so the
    // engine sees only events from the specific in-flight subagent.
    return this.sessionManager.addSubagentParentMessageListener((info) => {
      if (info.subagentSessionId !== subagentSessionId) return;
      cb(info);
    });
  }
}
