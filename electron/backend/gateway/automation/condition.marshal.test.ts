// Marshal-owned test
import { describe, it, expect } from "vitest";

import {
  WATCHER_TOOLS_ALLOW,
  WATCHER_PLACEHOLDER_ID,
  buildConditionWatcherPrompt,
  buildActionPrompt,
  conditionIntervalToCronSchedule,
} from "./condition";
import { cronJobToAutomationData } from "./map";

describe("WATCHER_TOOLS_ALLOW", () => {
  it("includes cron (for self-remove scope), sessions_spawn (for action firing), and eval tools", () => {
    expect(WATCHER_TOOLS_ALLOW).toEqual([
      "cron",
      "sessions_spawn",
      "web_fetch",
      "web_search",
      "group:plugins",
    ]);
  });
});

describe("WATCHER_PLACEHOLDER_ID", () => {
  it("is a recognizable placeholder string", () => {
    expect(WATCHER_PLACEHOLDER_ID).toBe("__M_WATCHER_PLACEHOLDER_ID__");
  });
});

describe("buildConditionWatcherPrompt", () => {
  it("builds a prompt that names the condition, instructs sessions_spawn + cron.remove, and inlines the action", () => {
    const prompt = buildConditionWatcherPrompt({
      condition: "PR 1878 is merged",
      steps: [
        { id: "s1", label: "Notify", prompt: "Send me a chat message about PR 1878" },
        { id: "s2", label: "File", prompt: "Create an issue in repo xy titled 'follow-up'" },
      ],
      watcherCronId: "cron-abc",
    });

    expect(prompt).toContain("PR 1878 is merged");
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain('cron.remove({id: "cron-abc"})');
    expect(prompt).toContain("Send me a chat message about PR 1878");
    expect(prompt).toContain("Create an issue in repo xy titled 'follow-up'");
  });

  it("includes an idempotency hint to mitigate duplicate firing", () => {
    const prompt = buildConditionWatcherPrompt({
      condition: "x",
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      watcherCronId: "cron-1",
    });
    expect(prompt).toMatch(/already.*completed.*recently|no-op/i);
  });

  it("uses the placeholder id when watcherCronId is the placeholder constant", () => {
    const prompt = buildConditionWatcherPrompt({
      condition: "x",
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      watcherCronId: WATCHER_PLACEHOLDER_ID,
    });
    expect(prompt).toContain(`cron.remove({id: "${WATCHER_PLACEHOLDER_ID}"})`);
  });
});

describe("buildActionPrompt", () => {
  it("joins single-step actions with no separator", () => {
    const action = buildActionPrompt([{ id: "s1", label: "L", prompt: "Send a message" }]);
    expect(action).toBe("Send a message");
  });

  it("joins multi-step actions with double-newline separators", () => {
    const action = buildActionPrompt([
      { id: "s1", label: "L1", prompt: "Step one" },
      { id: "s2", label: "L2", prompt: "Step two" },
    ]);
    expect(action).toBe("Step one\n\nStep two");
  });
});

describe("conditionIntervalToCronSchedule", () => {
  it("maps 5 to a 5-minute cron schedule", () => {
    expect(conditionIntervalToCronSchedule(5)).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it("maps 15 (the default) to a 15-minute cron schedule", () => {
    expect(conditionIntervalToCronSchedule(15)).toEqual({ kind: "every", everyMs: 900_000 });
  });

  it("maps 30 and 60", () => {
    expect(conditionIntervalToCronSchedule(30)).toEqual({ kind: "every", everyMs: 1_800_000 });
    expect(conditionIntervalToCronSchedule(60)).toEqual({ kind: "every", everyMs: 3_600_000 });
  });

  it("rejects intervals outside the canonical set", () => {
    expect(() => conditionIntervalToCronSchedule(7)).toThrow(/canonical|valid|5\/15\/30\/60/i);
  });

  it("falls back to 15 when the interval is undefined", () => {
    expect(conditionIntervalToCronSchedule(undefined)).toEqual({ kind: "every", everyMs: 900_000 });
  });
});

describe("buildConditionWatcherPrompt <-> tryParseWatcher contract", () => {
  it("produces output that round-trips through cronJobToAutomationData", () => {
    const message = buildConditionWatcherPrompt({
      condition: "PR 1878 is merged",
      steps: [
        { id: "s1", label: "Notify", prompt: "Send chat message about merge" },
        { id: "s2", label: "File", prompt: "Open GitHub issue in xy" },
      ],
      watcherCronId: "cron-test-1",
    });

    const job = {
      id: "cron-test-1",
      name: "Watch PR",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 900_000 },
      sessionTarget: "session:auto-cron-test-1" as const,
      wakeMode: "now" as const,
      payload: {
        kind: "agentTurn" as const,
        message,
        toolsAllow: [...WATCHER_TOOLS_ALLOW],
      },
      state: {},
    };

    const result = cronJobToAutomationData(job);
    expect(result.triggerType).toBe("condition");
    expect(result.condition).toBe("PR 1878 is merged");
    expect(result.conditionCheckInterval).toBe(15);
    // The action body round-trips as a single concatenated step (the action body
    // is joined with double-newlines on emit and stored as one prompt on
    // round-trip — multi-step + condition is documented out-of-scope).
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].prompt).toContain("Send chat message about merge");
    expect(result.steps[0].prompt).toContain("Open GitHub issue in xy");
  });
});
