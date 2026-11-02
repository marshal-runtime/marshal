import { describe, expect, test, vi } from "vitest";

import type { GoalFence, GoalRecord } from "../../common/goal-contract";
import {
  AgentMessageOutbox,
  type AgentMessageOutboxPersistence,
  buildGoalMessageIdempotencyKey,
  type GoalMessageIdentity,
} from "../agent-message-outbox";
import {
  GoalDocumentSchema,
  createInitialGoalDocument,
  migrateGoalDocumentForPersistence,
} from "../schemas/goal-schema";
import type { PersistedSession } from "../session-store";
import {
  buildContinuationContext,
  buildGoalConversationContext,
  type GoalContinuationContext,
} from "./goal-context";
import { GoalEngine } from "./goal-engine";
import type { GoalEngineDeps } from "./goal-engine-support";
import { GoalManager, type IGoalSessionStore } from "./goal-manager";
import { buildTransitionReviewPrompt, createTransitionReviewer } from "./transition-reviewer";

class MemoryGoalStore implements IGoalSessionStore {
  private readonly sessions = new Map<string, PersistedSession>();

  constructor(session = makeSession("session-1")) {
    this.sessions.set(session.id, structuredClone(session));
  }

  loadSessionData(id: string): PersistedSession | null {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  saveSessionData(session: PersistedSession): void {
    this.sessions.set(session.id, structuredClone(session));
  }
}

class MemoryOutboxPersistence implements AgentMessageOutboxPersistence {
  content: string | null = null;

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    this.content = content;
  }
}

function makeSession(id: string): PersistedSession {
  return {
    id,
    name: "Goal session",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    hasUnread: false,
    isActive: false,
    messages: [],
  };
}

function makeManager(store = new MemoryGoalStore()): GoalManager {
  return new GoalManager({
    store,
    emit: vi.fn<(sessionId: string, goal: GoalRecord | null) => void>(),
  });
}

function goalIdentity(fence: GoalFence): GoalMessageIdentity {
  return {
    goalFence: fence,
    goalId: fence.goalId,
    goalDeliveryKind: "terminal",
    goalTerminalKind: "completed",
    goalDeliverySequence: fence.epoch,
  };
}

describe("simplified goal core contract", () => {
  test("keeps one embedded record, preserves context authority, and rejects stale epochs", () => {
    const store = new MemoryGoalStore();
    const manager = makeManager(store);
    const created = manager.createGoal("session-1", "Ship the repair", {
      criteria: ["Focused tests pass"],
    });
    const initialFence = manager.captureFence("session-1");
    expect(initialFence).toEqual({ goalId: created.id, epoch: 1 });
    expect(() => manager.createGoal("session-1", "Second goal")).toThrow(
      "This conversation already has a goal",
    );

    const contextual = manager.updateContext(
      "session-1",
      {
        progress: ["Core contract written"],
        openQuestions: ["Will persistence preserve state?"],
        assumptions: ["The session store is durable"],
        decisions: ["Keep a single record"],
        state: { set: { checkpoint: { passed: true } } },
      },
      initialFence!,
    );
    expect(contextual?.epoch).toBe(1);
    expect(manager.isFenceCurrent("session-1", initialFence!)).toBe(true);

    const replacedContext = manager.updateContext(
      "session-1",
      {
        progress: ["Replacement progress"],
        openQuestions: [],
        assumptions: ["Replacement assumption"],
        decisions: ["Replacement decision"],
      },
      initialFence!,
    );
    expect(replacedContext).toMatchObject({
      progress: ["Replacement progress"],
      openQuestions: [],
      assumptions: ["Replacement assumption"],
      decisions: ["Replacement decision"],
    });

    const revised = manager.updateDefinition(
      "session-1",
      { criteria: ["Focused tests pass", "Typecheck is classified"] },
      initialFence!,
    );
    expect(revised?.epoch).toBe(2);
    expect(manager.updateContext("session-1", { progress: ["stale"] }, initialFence!)).toBeNull();

    const paused = manager.pause("session-1", { goalId: created.id, epoch: 2 });
    expect(paused?.status).toBe("paused");
    const resumed = manager.resume("session-1", { goalId: created.id, epoch: 3 });
    expect(resumed?.status).toBe("pursuing");
    expect(manager.stop("session-1", { goalId: created.id, epoch: 4 })?.status).toBe("stopped");

    const restarted = makeManager(store).getGoal("session-1");
    expect(restarted?.status).toBe("stopped");
    expect(restarted?.state).toEqual({ checkpoint: { passed: true } });
    expect(restarted?.openQuestions).toEqual([]);
    expect(restarted?.assumptions).toEqual(["Replacement assumption"]);
    expect(restarted?.decisions).toEqual(["Replacement decision"]);
    expect(restarted).not.toHaveProperty("pendingReview");
    expect(restarted).not.toHaveProperty("reviewerFeedback");
    expect(restarted).not.toHaveProperty("finalDelivery");
    expect(restarted).not.toHaveProperty("memory");
    expect(GoalDocumentSchema.parse(restarted)).toEqual(restarted);
  });

  test("migrates legacy records into bounded string-list state without reviving old fields", () => {
    const migrated = migrateGoalDocumentForPersistence({
      schemaVersion: 2,
      id: "legacy-goal",
      lifecycleEpoch: 7,
      objective: "Finish the migration",
      acceptanceCriteria: ["Preserve terminal state"],
      status: "completed",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
      completedAt: "2026-08-20T01:00:00.000Z",
      progress: ["Done"],
      openQuestions: [{ question: "Anything left?", assumption: "No" }],
      decisions: [{ decision: "Use one record" }],
      scratchpad: { nested: { value: 1 } },
      pendingReview: { state: "approved" },
      reviewerFeedback: "legacy",
      finalDelivery: { state: "sent" },
      memory: ["legacy"],
      continuationCount: 3,
      activeMs: 500,
      tokensUsed: 900,
    });

    expect(migrated.kind).toBe("migrated");
    if (migrated.kind !== "migrated") throw new Error("Expected migrated goal");
    expect(migrated.document).toMatchObject({
      epoch: 7,
      status: "completed",
      criteria: ["Preserve terminal state"],
      openQuestions: ["Anything left?"],
      assumptions: ["No"],
      decisions: ["Use one record"],
      state: { nested: { value: 1 } },
    });
    expect(Object.keys(migrated.document)).not.toEqual(
      expect.arrayContaining(["pendingReview", "reviewerFeedback", "finalDelivery", "memory"]),
    );
  });

  test("captures the user's actual instruction by provenance, not stored role", () => {
    const session = makeSession("session-1");
    session.messages = [
      {
        id: "m-user-1",
        role: "user",
        content: "Build the exporter with CSV and PDF output",
        timestamp: "2026-09-09T10:00:00.000Z",
      },
      {
        id: "m-forwarded",
        role: "user",
        content: "Worker report: exporter scaffolding complete",
        timestamp: "2026-09-09T10:05:00.000Z",
        agentMessage: {
          source: "subagent:worker-1",
          kind: "subagent",
          deliveryMode: "queue",
          sequence: 1,
        },
      },
      {
        id: "m-continuation",
        role: "user",
        content: "[GOAL CONTINUATION] keep going",
        timestamp: "2026-09-09T10:06:00.000Z",
        goalContinuation: true,
      },
      {
        id: "m-internal",
        role: "user",
        content: "internal control request",
        timestamp: "2026-09-09T10:07:00.000Z",
        internalControl: { kind: "goal-continuation", exchangeId: "x", side: "request" },
      },
    ];
    const store = new MemoryGoalStore(session);
    const manager = makeManager(store);
    const goal = manager.createGoal("session-1", "Ship the exporter");
    // The latest role-"user" rows are a forwarded worker report, a goal
    // continuation, and an internal control exchange — none are the user's
    // words. The pointer must land on the real instruction.
    expect(goal.sourceInstruction).toEqual({
      messageId: "m-user-1",
      excerpt: "Build the exporter with CSV and PDF output",
    });
    expect(GoalDocumentSchema.parse(goal)).toEqual(goal);

    // Survives persistence and is carried into the continuation context
    // (authority set — untrimmable in fitGoalPayload).
    const restarted = makeManager(store).getGoal("session-1");
    expect(restarted?.sourceInstruction?.messageId).toBe("m-user-1");
    const context = buildContinuationContext(restarted!, "conversation");
    expect(context.goal.sourceInstruction?.messageId).toBe("m-user-1");
  });

  test("goals in sessions with no genuine user message carry no source instruction", () => {
    const session = makeSession("session-1");
    session.messages = [
      {
        id: "m-forwarded",
        role: "user",
        content: "Swarm task prompt: do the thing",
        timestamp: "2026-09-09T10:00:00.000Z",
        agentMessage: {
          source: "parent",
          kind: "parent",
          deliveryMode: "queue",
          sequence: 1,
        },
      },
    ];
    const manager = makeManager(new MemoryGoalStore(session));
    const goal = manager.createGoal("session-1", "Programmatic worker goal");
    expect(goal.sourceInstruction).toBeUndefined();
    expect(GoalDocumentSchema.parse(goal)).toEqual(goal);
  });

  test("the review prompt demands disproof and preserves the source instruction over budget", () => {
    const goal = createInitialGoalDocument({
      objective: "Ship the exporter",
      sourceInstruction: {
        messageId: "m-user-1",
        excerpt: "Build the exporter with CSV and PDF output",
      },
    });
    const oversized = {
      ...goal,
      progress: Array.from({ length: 100 }, (_, i) => `progress entry ${i} ${"x".repeat(700)}`),
    };
    const prompt = buildTransitionReviewPrompt(
      {
        goal: oversized,
        proposal: { target: "completed", reason: "All criteria satisfied" },
        conversationContext: "c".repeat(40_000),
      },
      "goal-session-1",
    );
    expect(prompt).toContain("DISPROVE");
    expect(prompt).toContain("goal-session-1");
    expect(prompt).toContain("getSessionTranscript");
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
    // The pointer to the user's words survives the over-budget payload whole,
    // alongside the untrimmed objective and proposal; trimming is visible.
    expect(payload.goal.sourceInstruction).toEqual(goal.sourceInstruction);
    expect(payload.goal.objective).toBe("Ship the exporter");
    expect(payload.proposal).toEqual({ target: "completed", reason: "All criteria satisfied" });
    expect(payload.truncated).toBeDefined();
  });

  test("recovers a verdict embedded in reviewer narration", async () => {
    const { parseTransitionReviewVerdict } = await import("./transition-reviewer");
    expect(
      parseTransitionReviewVerdict(
        'I inspected src/pipeline.mjs directly.\n{"decision":"approve"}',
      ),
    ).toEqual({ decision: "approve" });
    expect(
      parseTransitionReviewVerdict(
        'The entrypoint never calls dispatchFixAgent — "7/7 green" proves nothing here. ' +
          '{"decision":"reject","feedback":"runTriage never dispatches a fix agent; add {entrypoint} coverage."}',
      ),
    ).toEqual({
      decision: "reject",
      feedback: "runTriage never dispatches a fix agent; add {entrypoint} coverage.",
    });
    expect(() => parseTransitionReviewVerdict("no verdict here at all")).toThrow("malformed JSON");
  });

  test("uses a fresh ephemeral reviewer for each proposal", async () => {
    let sequence = 0;
    const disposed: string[] = [];
    const reviewer = createTransitionReviewer({
      createReviewerSession: async () => `reviewer-${++sequence}`,
      runPrompt: async () => ({ kind: "ok", text: '{"decision":"approve"}' }),
      disposeSession: async (sessionId) => {
        disposed.push(sessionId);
      },
    });
    const goal = createInitialGoalDocument({ objective: "Review transitions" });
    const input = {
      goal,
      proposal: { target: "paused" as const, reason: "User dependency" },
      conversationContext: "",
    };

    await expect(reviewer(input, "session-1")).resolves.toEqual({ decision: "approve" });
    await expect(reviewer(input, "session-1")).resolves.toEqual({ decision: "approve" });
    expect(disposed).toEqual(["reviewer-1", "reviewer-2"]);
  });

  test("controller ownership suppresses idle polling and release restores continuation", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Wait for controlled work");
    let owned = true;
    const composeContinuation = vi.fn<() => Promise<string>>().mockResolvedValue("Continue");
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(
      async (_id, _prompt, onEvent) => {
        // A controller can adopt the session during a goal turn. Its usage still counts.
        owned = true;
        onEvent({ type: "turn:usage", inputTokens: 10, outputTokens: 5 });
        return { kind: "ok", text: "Controller is waiting for a dependency" };
      },
    );
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => owned,
      getConversationContext: () => "Idle children, blocked dependency",
      composeContinuation,
      sendContinuation,
      reviewTransition: async () => ({ decision: "approve" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    engine.signalResumeTrigger("session-1");
    expect(engine.isRunning("session-1")).toBe(false);
    expect(composeContinuation).not.toHaveBeenCalled();
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
    owned = false;
    engine.signalResumeTrigger("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false));
    expect(manager.getGoal("session-1")?.continuationCount).toBe(1);
    expect(manager.getGoal("session-1")?.tokensUsed).toBe(15);
    engine.signalResumeTrigger("session-1");
    expect(sendContinuation).toHaveBeenCalledOnce();
  });

  test("ownership acquired during composition prevents automatic dispatch", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Continue safely");
    let owned = false;
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>();
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => owned,
      getConversationContext: () => "Context",
      composeContinuation: async () => {
        owned = true;
        return "Now managed by the controller";
      },
      sendContinuation,
      reviewTransition: async () => ({ decision: "approve" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false));
    expect(sendContinuation).not.toHaveBeenCalled();
    expect(manager.getGoal("session-1")?.continuationCount).toBe(0);
  });

  test("persists rejected review feedback and resumes through a fresh composer", async () => {
    const store = new MemoryGoalStore();
    const manager = makeManager(store);
    const goal = manager.createGoal("session-1", "Complete safely");
    const composeContinuation = vi.fn<
      (context: GoalContinuationContext, sourceSessionId: string) => Promise<string>
    >(async () => "Continue after review feedback");
    let pauseEngine = (_sessionId: string): void => {};
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => {
        const session = store.loadSessionData("session-1");
        return session ? buildGoalConversationContext(session) : "";
      },
      composeContinuation,
      reviewTransition: async () => ({
        decision: "reject",
        feedback: "Run the missing migration check.",
      }),
      sendContinuation: async () => {
        pauseEngine("session-1");
        return { kind: "ok", text: "continued" };
      },
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);

    expect(
      engine.proposeTransition(
        "session-1",
        { target: "completed", reason: "Implementation is done" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(composeContinuation).toHaveBeenCalledOnce(), { timeout: 2_000 });

    const restarted = makeManager(store);
    expect(restarted.getGoal("session-1")?.status).toBe("pursuing");
    const session = store.loadSessionData("session-1");
    expect(session?.messages.at(-1)?.internalControl).toMatchObject({
      kind: "goal-transition-review",
      side: "response",
    });
    expect(buildGoalConversationContext(session!)).toContain(
      "reviewer: Transition review rejected the proposal: Run the missing migration check.",
    );
  });

  test("keeps the same goal session after context-usage events", async () => {
    const manager = makeManager();
    const goal = manager.createGoal("session-1", "Keep pursuing in the original session");
    let sends = 0;
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => sends >= 2,
      getConversationContext: () => "conversation",
      composeContinuation: async () => "Take the next step",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation: async (_sessionId, _prompt, onEvent) => {
        sends += 1;
        onEvent({ type: "turn:token-usage", currentTokens: 500_000, tokenLimit: 500_000 });
        return { kind: "ok", text: "step complete" };
      },
      deliverCompletion: async () => {},
    });

    engine.start("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.continuationCount).toBe(2), {
      timeout: 2_000,
    });
    engine.pause("session-1");

    expect(manager.captureFence("session-1")).toEqual({ goalId: goal.id, epoch: goal.epoch });
    expect(manager.getGoal("session-1")?.continuationCount).toBe(2);
  });

  test("a rejected hard-limit transition grants one real continuation", async () => {
    const store = new MemoryGoalStore();
    const manager = makeManager(store);
    const goal = manager.createGoal("session-1", "Continue after second eyes");
    const session = store.loadSessionData("session-1")!;
    session.goal = { ...goal, continuationCount: 100 };
    store.saveSessionData(session);
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      pauseEngine("session-1");
      return { kind: "ok" as const, text: "continued" };
    });
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => "context",
      composeContinuation: async () => "Perform the reviewer-requested continuation",
      reviewTransition: async () => ({
        decision: "reject",
        feedback: "One more concrete check remains.",
      }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);

    engine.start("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce(), { timeout: 3_000 });
  });

  test("a persisted pursuing goal resumes after restart and a duplicate start dispatches one driver", async () => {
    const store = new MemoryGoalStore();
    makeManager(store).createGoal("session-1", "Survive restart");
    // Restart: a fresh manager + engine over the same persisted store.
    const manager = makeManager(store);
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      pauseEngine("session-1");
      return { kind: "ok", text: "resumed" };
    });
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => "",
      composeContinuation: async () => "Continue the persisted goal",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);

    engine.start("session-1");
    engine.start("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce(), { timeout: 3_000 });
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false));
    expect(sendContinuation).toHaveBeenCalledOnce();
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
  });

  test("opening a controller-owned pursuing goal keeps it pursuing and release resumes it", async () => {
    const store = new MemoryGoalStore();
    const manager = makeManager(store);
    manager.createGoal("session-1", "Controller-owned work");
    let owned = true;
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      pauseEngine("session-1");
      return { kind: "ok", text: "continued after release" };
    });
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => owned,
      getConversationContext: () => "",
      composeContinuation: async () => "Continue",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);

    // switchSession reconciliation is signalResumeTrigger: viewing the session
    // must never pause a healthy controller-owned goal.
    engine.signalResumeTrigger("session-1");
    expect(engine.isRunning("session-1")).toBe(false);
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
    expect(manager.getGoal("session-1")?.progress).toEqual([]);

    // A legitimate controller release resumes pursuit on the same trigger.
    owned = false;
    engine.signalResumeTrigger("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
  });

  test("startup start leaves paused and blocked goals untouched", () => {
    const pausedStore = new MemoryGoalStore();
    const pausedManager = makeManager(pausedStore);
    pausedManager.createGoal("session-1", "Paused work");
    pausedManager.pause("session-1");
    const blockedStore = new MemoryGoalStore();
    const blockedManager = makeManager(blockedStore);
    const blockedGoal = blockedManager.createGoal("session-1", "Blocked work");
    blockedManager.applyReviewedTransition(
      "session-1",
      { target: "blocked", reason: "Waiting on user access decision" },
      { goalId: blockedGoal.id, epoch: blockedGoal.epoch },
    );
    const composeContinuation = vi.fn<GoalEngineDeps["composeContinuation"]>(async () => "unused");
    for (const manager of [pausedManager, blockedManager]) {
      const engine = new GoalEngine({
        goalManager: manager,
        isBusy: () => false,
        getConversationContext: () => "",
        composeContinuation,
        reviewTransition: async () => ({ decision: "approve" }),
        sendContinuation: async () => ({ kind: "ok", text: "unused" }),
        deliverCompletion: async () => {},
      });
      engine.start("session-1");
      expect(engine.isRunning("session-1")).toBe(false);
    }
    expect(composeContinuation).not.toHaveBeenCalled();
    expect(pausedManager.getGoal("session-1")?.status).toBe("paused");
    expect(blockedManager.getGoal("session-1")).toMatchObject({
      status: "blocked",
      blockedReason: "Waiting on user access decision",
    });
  });

  test("persistent context-preparation failure ends blocked with the underlying reason", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Prepare safely");
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => Promise.reject(new Error("context store offline")),
      composeContinuation: async () => "unused",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 10_000,
    });
    expect(manager.getGoal("session-1")?.blockedReason).toContain("context store offline");
    expect(manager.getGoal("session-1")?.blockedReason).toContain("3 consecutive times");
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false));
  }, 15_000);

  test("preparation errors reset after a successful dispatch and pursuit continues", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Tolerate transient failures");
    const outcomes = ["fail", "fail", "ok", "fail", "fail", "ok"];
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      if (sendContinuation.mock.calls.length >= 2) pauseEngine("session-1");
      return { kind: "ok", text: "continued" };
    });
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () =>
        outcomes.shift() === "fail" ? Promise.reject(new Error("flaky context")) : "context",
      composeContinuation: async () => "Continue",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);
    engine.start("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledTimes(2), {
      timeout: 10_000,
    });
    // Four total failures, but never three consecutive: the goal stays pursuing.
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
    // The pause lands mid-second-turn, so only the first turn recorded its counter.
    expect(manager.getGoal("session-1")?.continuationCount).toBe(1);
  }, 15_000);

  test("controller takeover during failed preparation does not count toward blocked", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Handoff mid-preparation");
    let owned = false;
    let prepCalls = 0;
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => owned,
      getConversationContext: () => {
        prepCalls += 1;
        owned = true;
        return Promise.reject(new Error("interrupted by controller takeover"));
      },
      composeContinuation: async () => "unused",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false), { timeout: 3_000 });
    expect(prepCalls).toBe(1);
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
    expect(manager.getGoal("session-1")?.blockedReason).toBeUndefined();
  });

  test("a dispatch-not-ready goal parks without touching state and resumes when ready", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Wait for the runtime");
    let ready = false;
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      pauseEngine("session-1");
      return { kind: "ok", text: "continued" };
    });
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isDispatchReady: () => ready,
      getConversationContext: () => "",
      composeContinuation: async () => "Continue",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);

    // Inactive runtime / auth transition: the engine parks — no dispatch, no
    // error budget, no durable mutation.
    engine.start("session-1");
    expect(engine.isRunning("session-1")).toBe(false);
    expect(sendContinuation).not.toHaveBeenCalled();
    expect(manager.getGoal("session-1")).toMatchObject({ status: "pursuing" });
    expect(manager.getGoal("session-1")?.blockedReason).toBeUndefined();

    // The post-auth / runtime-switch wake resumes it.
    ready = true;
    engine.signalResumeTrigger("session-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
  });

  test("a reviewer that keeps rejecting a system failure report cannot buy an endless paid retry loop", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Fail persistently");
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(async () => ({
      decision: "reject",
      feedback: "Looks transient; keep trying.",
    }));
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => Promise.reject(new Error("context store offline")),
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 25_000,
    });
    const blocked = manager.getGoal("session-1");
    expect(blocked?.blockedReason).toContain("context store offline");
    expect(blocked?.blockedReason).toContain(
      "review rejected 3 consecutive system failure reports",
    );
    // Exactly bounded: one review per system proposal, three rejections.
    expect(reviewTransition).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(engine.isRunning("session-1")).toBe(false));
  }, 30_000);

  test("a pending review parks during an auth transition instead of burning attempts", async () => {
    const manager = makeManager();
    const goal = manager.createGoal("session-1", "Review parks");
    let ready = false;
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(async () => ({
      decision: "approve",
    }));
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isDispatchReady: () => ready,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    expect(
      engine.proposeTransition(
        "session-1",
        { target: "blocked", reason: "Waiting on an external dependency" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reviewTransition).not.toHaveBeenCalled();
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");

    ready = true;
    engine.signalResumeTrigger("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 3_000,
    });
    expect(reviewTransition).toHaveBeenCalledOnce();
  });

  test("a review failure during sign-out parks rather than consuming bounded attempts", async () => {
    const manager = makeManager();
    const goal = manager.createGoal("session-1", "Survive sign-out mid-review");
    let ready = true;
    const reviewTransition = vi
      .fn<GoalEngineDeps["reviewTransition"]>(async () => ({ decision: "approve" }))
      .mockImplementationOnce(async () => {
        ready = false;
        throw new Error("backend torn down by sign-out");
      });
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isDispatchReady: () => ready,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    expect(
      engine.proposeTransition(
        "session-1",
        { target: "blocked", reason: "Waiting on an external dependency" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    // The in-flight review fails against the torn-down backend; the review
    // parks without consuming an attempt or scheduling a retry timer.
    await vi.waitFor(() => expect(reviewTransition).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
    expect(manager.getGoal("session-1")?.blockedReason).toBeUndefined();

    // Sign-in completes: the wake re-runs the parked review and it applies.
    ready = true;
    engine.signalResumeTrigger("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 3_000,
    });
    expect(reviewTransition).toHaveBeenCalledTimes(2);
  });

  test("an unexpected driver crash records a durable blocked reason", async () => {
    const manager = makeManager();
    manager.createGoal("session-1", "Crash visibly");
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => {
        throw new Error("busy tracker exploded");
      },
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    engine.start("session-1");
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 5_000,
    });
    expect(manager.getGoal("session-1")?.blockedReason).toContain("internal error");
    expect(manager.getGoal("session-1")?.blockedReason).toContain("busy tracker exploded");
  });

  test("an unavailable transition reviewer degrades to a terminal blocked state instead of retrying forever", async () => {
    const manager = makeManager();
    const goal = manager.createGoal("session-1", "Complete under review outage");
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(() =>
      Promise.reject(new Error("reviewer transport down")),
    );
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      // Wired deliberately: the same-run exhaustion fallback must still block
      // WITH the run-identity guard active — this test must never pass merely
      // because getRunIdentity was omitted from its deps.
      getRunIdentity: () => "delegation-stable",
      getConversationContext: () => Promise.reject(new Error("context store offline")),
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    expect(
      engine.proposeTransition(
        "session-1",
        { target: "completed", reason: "All criteria satisfied" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 15_000,
    });
    const blocked = manager.getGoal("session-1");
    // A completion claim is never applied unreviewed; it degrades to a
    // visible blocked state carrying the system failure.
    expect(blocked?.blockedReason).toContain("Completion was claimed but not reviewed");
    expect(blocked?.blockedReason).toContain("reviewer transport down");
    expect(blocked?.completedAt).toBeUndefined();
    expect(reviewTransition.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("review proceeds on goal authority when conversation context collection fails", async () => {
    const manager = makeManager();
    const goal = manager.createGoal("session-1", "Block with degraded context");
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(async (input) => {
      expect(input.conversationContext).toContain("conversation context unavailable");
      return { decision: "approve" };
    });
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => Promise.reject(new Error("context store offline")),
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    expect(
      engine.proposeTransition(
        "session-1",
        { target: "blocked", reason: "Waiting on an external dependency" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 5_000,
    });
    expect(manager.getGoal("session-1")?.blockedReason).toBe("Waiting on an external dependency");
    expect(reviewTransition).toHaveBeenCalledOnce();
  });

  test("retries completion enqueue without persisting delivery state in the goal", async () => {
    const manager = makeManager();
    const created = manager.createGoal("session-1", "Deliver exactly once");
    const completed = manager.applyReviewedTransition(
      "session-1",
      { target: "completed", reason: "Done" },
      { goalId: created.id, epoch: created.epoch },
    );
    expect(completed?.status).toBe("completed");
    const deliverCompletion = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("outbox unavailable"))
      .mockResolvedValue(undefined);
    const engine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion,
    });

    engine.start("session-1");
    await vi.waitFor(() => expect(deliverCompletion).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(manager.getGoal("session-1")).not.toHaveProperty("finalDelivery");
  });

  test("deduplicates completion delivery across restart and separates later epochs", async () => {
    const persistence = new MemoryOutboxPersistence();
    const fence = { goalId: "goal-1", epoch: 2 };
    const first = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await first.start({ pauseDispatch: true });
    const accepted = await first.enqueue({
      source: "goal:goal-1",
      target: "session-1",
      kind: "goal-terminal",
      content: "Complete",
      ...goalIdentity(fence),
    });
    await first.shutdown();

    const restarted = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await restarted.start({ pauseDispatch: true });
    const duplicate = await restarted.enqueue({
      source: "goal:goal-1",
      target: "session-1",
      kind: "goal-terminal",
      content: "Complete again",
      ...goalIdentity(fence),
    });

    expect(duplicate.messageId).toBe(accepted.messageId);
    expect(buildGoalMessageIdempotencyKey(goalIdentity({ ...fence, epoch: 3 }))).not.toBe(
      buildGoalMessageIdempotencyKey(goalIdentity(fence)),
    );
    await restarted.shutdown();
  });
});
