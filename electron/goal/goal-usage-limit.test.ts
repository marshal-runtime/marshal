import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RuntimeAuthError } from "../../common/foundation/auth/auth-errors";
import type { GoalRecord } from "../../common/goal-contract";
import { RuntimeUsageLimitError } from "../../common/runtime-usage-limit";
import type { PersistedSession } from "../session-store";
import { GoalEngine } from "./goal-engine";
import {
  AUTH_FAILURE_RETRY_WAIT_MS,
  USAGE_LIMIT_FALLBACK_WAIT_MS,
  USAGE_LIMIT_RESUME_GRACE_MS,
  type GoalEngineDeps,
} from "./goal-engine-support";
import { GoalManager, type IGoalSessionStore } from "./goal-manager";

const SESSION_ID = "overnight-goal";

class MemoryGoalStore implements IGoalSessionStore {
  private session: PersistedSession = {
    id: SESSION_ID,
    name: "Overnight goal",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    hasUnread: false,
    isActive: false,
    messages: [],
  };

  loadSessionData(id: string): PersistedSession | null {
    return id === SESSION_ID ? structuredClone(this.session) : null;
  }

  saveSessionData(session: PersistedSession): void {
    this.session = structuredClone(session);
  }
}

function makeEngine(sendContinuation: GoalEngineDeps["sendContinuation"]) {
  const manager = new GoalManager({
    store: new MemoryGoalStore(),
    emit: vi.fn<(sessionId: string, goal: GoalRecord | null) => void>(),
  });
  manager.createGoal(SESSION_ID, "Finish the migration overnight");
  const engine = new GoalEngine({
    goalManager: manager,
    isBusy: () => false,
    getConversationContext: () => "context",
    composeContinuation: async () => "Continue the migration",
    reviewTransition: async () => ({ decision: "approve" }),
    sendContinuation,
    deliverCompletion: async () => {},
  });
  return { manager, engine };
}

describe("GoalEngine with a runtime usage limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T23:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("parks the goal until the reported reset, then resumes without spending the error budget", async () => {
    const retryAt = Date.now() + 2 * 60 * 60_000;
    let engineRef: GoalEngine | null = null;
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      if (sendContinuation.mock.calls.length === 1) {
        throw new RuntimeUsageLimitError("Codex usage limit reached.", retryAt);
      }
      engineRef?.pause(SESSION_ID);
      return { kind: "ok", text: "continued" };
    });
    const { manager, engine } = makeEngine(sendContinuation);
    engineRef = engine;

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendContinuation).toHaveBeenCalledTimes(1);
    expect(engine.isRunning(SESSION_ID)).toBe(false);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBe(retryAt + USAGE_LIMIT_RESUME_GRACE_MS);
    expect(manager.getGoal(SESSION_ID)).toMatchObject({ status: "pursuing" });
    expect(manager.getGoal(SESSION_ID)?.blockedReason).toBeUndefined();

    // An idle wake before the reset must not spend another refused turn.
    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now());
    expect(sendContinuation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_RESUME_GRACE_MS);
    expect(sendContinuation).toHaveBeenCalledTimes(2);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBeUndefined();
    expect(manager.getGoal(SESSION_ID)).toMatchObject({ status: "pursuing" });
  });

  test("keeps waiting through repeated refusals without a reset time instead of blocking", async () => {
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      throw new RuntimeUsageLimitError("Codex usage limit reached.");
    });
    const { manager, engine } = makeEngine(sendContinuation);

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    for (let refusal = 1; refusal < 5; refusal += 1) {
      expect(engine.usageLimitResumeAt(SESSION_ID)).toBe(Date.now() + USAGE_LIMIT_FALLBACK_WAIT_MS);
      // oxlint-disable-next-line no-await-in-loop -- each wait must observe the park the previous refusal set
      await vi.advanceTimersByTimeAsync(USAGE_LIMIT_FALLBACK_WAIT_MS);
    }

    expect(sendContinuation).toHaveBeenCalledTimes(5);
    expect(manager.getGoal(SESSION_ID)).toMatchObject({ status: "pursuing" });
    expect(manager.getGoal(SESSION_ID)?.blockedReason).toBeUndefined();
    engine.pause(SESSION_ID);
  });

  test("pausing a parked goal cancels the scheduled resume", async () => {
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      throw new RuntimeUsageLimitError("Codex usage limit reached.", Date.now() + 60_000);
    });
    const { engine } = makeEngine(sendContinuation);

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    engine.pause(SESSION_ID);
    await vi.advanceTimersByTimeAsync(60_000 + USAGE_LIMIT_RESUME_GRACE_MS + 1_000);

    expect(sendContinuation).toHaveBeenCalledTimes(1);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBeUndefined();
  });

  test("a resume trigger does not cut a usage-limit wait short", async () => {
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      throw new RuntimeUsageLimitError("Codex usage limit reached.", Date.now() + 60 * 60_000);
    });
    const { engine } = makeEngine(sendContinuation);

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    engine.signalResumeTrigger(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendContinuation).toHaveBeenCalledTimes(1);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBeDefined();
    engine.pause(SESSION_ID);
  });

  test("still counts ordinary dispatch failures toward the blocked limit", async () => {
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      throw new Error("model call failed");
    });
    const { manager, engine } = makeEngine(sendContinuation);

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendContinuation).toHaveBeenCalledTimes(3);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBeUndefined();
    await vi.waitFor(() =>
      expect(manager.getGoal(SESSION_ID)?.blockedReason).toContain("Repeated errors"),
    );
  });
});

describe("GoalEngine with a failed runtime sign-in", () => {
  const SIGN_IN = "Codex isn't signed in or its sign-in expired.";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T23:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("parks instead of spending the error budget, and retries on the next resume trigger", async () => {
    let engineRef: GoalEngine | null = null;
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      if (sendContinuation.mock.calls.length === 1) throw new RuntimeAuthError(SIGN_IN);
      engineRef?.pause(SESSION_ID);
      return { kind: "ok", text: "continued" };
    });
    const { manager, engine } = makeEngine(sendContinuation);
    engineRef = engine;

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.authRetryAt(SESSION_ID)).toBe(Date.now() + AUTH_FAILURE_RETRY_WAIT_MS);
    expect(engine.usageLimitResumeAt(SESSION_ID)).toBeUndefined();
    expect(manager.getGoal(SESSION_ID)).toMatchObject({ status: "pursuing" });

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendContinuation).toHaveBeenCalledTimes(1);

    // Signing in again (or opening the session) fires the resume trigger.
    engine.signalResumeTrigger(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendContinuation).toHaveBeenCalledTimes(2);
    expect(engine.authRetryAt(SESSION_ID)).toBeUndefined();
  });

  test("keeps retrying on its own while nobody signs in, without blocking the goal", async () => {
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      throw new RuntimeAuthError(SIGN_IN);
    });
    const { manager, engine } = makeEngine(sendContinuation);

    engine.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4 * AUTH_FAILURE_RETRY_WAIT_MS);

    expect(sendContinuation).toHaveBeenCalledTimes(5);
    expect(manager.getGoal(SESSION_ID)).toMatchObject({ status: "pursuing" });
    expect(manager.getGoal(SESSION_ID)?.blockedReason).toBeUndefined();
    engine.pause(SESSION_ID);
    expect(engine.authRetryAt(SESSION_ID)).toBeUndefined();
  });
});
