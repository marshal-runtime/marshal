import { describe, it, expect } from "vitest";

import type { AutomationData } from "../../../../common/marshal-ipc-contract";
import { WATCHER_TOOLS_ALLOW, WATCHER_PLACEHOLDER_ID } from "./condition";
import {
  automationDataToCronJobCreate,
  automationPatchToCronJobPatch,
  buildTailCronName,
  computeStepsHash,
  cronJobToAutomationData,
  cronRunLogEntryToAutomationRunData,
  encodeMultiStepDescription,
  decodeMultiStepDescription,
  matchesParentTailPattern,
  parseTailCronName,
  substitutePreviousOutput,
  type CronJob,
  type CronRunLogEntry,
  type MultiStepState,
} from "./map";

const BASE_AUTOMATION: AutomationData = {
  id: "auto-1",
  name: "Daily summary",
  description: "Run weekday mornings",
  steps: [{ id: "s1", label: "Summarize", prompt: "Summarize my inbox" }],
  schedule: { naturalLanguage: "weekdays at 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  createdAt: "2026-04-22T10:00:00.000Z",
  updatedAt: "2026-04-22T10:00:00.000Z",
  triggerType: "schedule",
};

describe("automationDataToCronJobCreate", () => {
  it("maps a basic scheduled automation", () => {
    const result = automationDataToCronJobCreate(BASE_AUTOMATION, { tz: "UTC" });
    expect(result.name).toBe("Daily summary");
    expect(result.enabled).toBe(true);
    expect(result.deleteAfterRun).toBe(false);
    expect(result.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" });
    expect(result.payload).toEqual({ kind: "agentTurn", message: "Summarize my inbox" });
    // Placeholder target; GatewayAutomationBackend.createAutomation patches
    // this with the server-assigned id via a follow-up cron.update.
    expect(result.sessionTarget).toBe("isolated");
    expect(result.wakeMode).toBe("now");
    expect(result.delivery).toEqual({ mode: "none" });
  });

  it("emits '*' for days when all days are selected", () => {
    // Empty naturalLanguage forces the structured-fields fallback path so this
    // test exercises scheduleExprFromParts directly. With NL set, the parser
    // takes precedence (see "resolves schedule.naturalLanguage..." patch test).
    const result = automationDataToCronJobCreate(
      {
        ...BASE_AUTOMATION,
        schedule: { naturalLanguage: "", days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 },
      },
      { tz: "UTC" },
    );
    expect(result.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  });

  it("emits '*' for days when the day list is empty", () => {
    const result = automationDataToCronJobCreate(
      {
        ...BASE_AUTOMATION,
        schedule: { naturalLanguage: "", days: [], hour: 9, minute: 0 },
      },
      { tz: "UTC" },
    );
    if (result.schedule.kind !== "cron")
      throw new Error(`expected cron, got ${result.schedule.kind}`);
    expect(result.schedule.expr).toBe("0 9 * * *");
  });

  it("forwards oneShot as explicit deleteAfterRun", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, oneShot: true },
      { tz: "UTC" },
    );
    expect(result.deleteAfterRun).toBe(true);
  });

  it("never leaks pinnedSessionId into the session target (always placeholder on add)", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, pinnedSessionId: "sdk-session-xyz" },
      { tz: "UTC" },
    );
    // The real session:auto-<id> target is set by a follow-up cron.update
    // in GatewayAutomationBackend.createAutomation once the server assigns
    // the id. The create-time target must never reference the Marshal-side
    // pinnedSessionId (SDK session id) — spec §8 "Session semantics".
    expect(result.sessionTarget).toBe("isolated");
    expect(result.sessionTarget).not.toContain("sdk-session-xyz");
  });

  it("uses targetSessionId as the cron session target", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, targetSessionId: "user-session-123" },
      { tz: "UTC" },
    );
    expect(result.sessionTarget).toBe("session:user-session-123");
  });

  it("rejects project-scoped automations on gateway", () => {
    expect(() =>
      automationDataToCronJobCreate(
        { ...BASE_AUTOMATION, repoPath: "C:\\src\\repo" },
        { tz: "UTC" },
      ),
    ).toThrow(/only supported by the local automation backend/);
  });

  it("throws on unparseable naturalLanguage (matches patch path)", () => {
    // Symmetric pin with the patch-path test. A future inlining of
    // scheduleExprFromParts that bypasses scheduleToCronExpr would restore
    // the `0 0 * * *` silent-corruption regression — this test catches it.
    expect(() =>
      automationDataToCronJobCreate(
        {
          ...BASE_AUTOMATION,
          schedule: { naturalLanguage: "not a schedule", days: [], hour: 0, minute: 0 },
        },
        { tz: "UTC" },
      ),
    ).toThrow(/Could not parse schedule/i);
  });

  it("throws on empty name", () => {
    expect(() =>
      automationDataToCronJobCreate({ ...BASE_AUTOMATION, name: "" }, { tz: "UTC" }),
    ).toThrow(/name/i);
  });

  it("forwards browserHeadless=true into cron job state['m.browserHeadless']", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, browserHeadless: true },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.browserHeadless": true });
  });

  it("forwards model override into the agentTurn payload", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, model: "claude-haiku-4.5" },
      { tz: "UTC" },
    );
    expect(result.payload).toEqual({
      kind: "agentTurn",
      message: "Summarize my inbox",
      model: "claude-haiku-4.5",
    });
  });

  it("forwards model override into condition watcher payload", () => {
    const result = automationDataToCronJobCreate(
      {
        ...BASE_AUTOMATION,
        triggerType: "condition",
        condition: "PR 1878 is merged",
        conditionCheckInterval: 15,
        model: "claude-haiku-4.5",
      },
      { tz: "UTC" },
    );
    expect(result.payload.kind).toBe("agentTurn");
    if (result.payload.kind !== "agentTurn") throw new Error("expected agentTurn payload");
    expect(result.payload.model).toBe("claude-haiku-4.5");
    expect(result.payload.toolsAllow).toEqual([...WATCHER_TOOLS_ALLOW]);
  });

  it("omits state entry when browserHeadless is absent", () => {
    const result = automationDataToCronJobCreate(BASE_AUTOMATION, { tz: "UTC" });
    expect(result.state).toBeUndefined();
  });

  it("omits state entry when browserHeadless is explicitly false", () => {
    // Conditional spread on the truthy value: `false` and absent are
    // semantically equivalent here (gateway never injects a default).
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, browserHeadless: false },
      { tz: "UTC" },
    );
    expect(result.state).toBeUndefined();
  });

  // teamsNotify: mode round-trips via cron state so
  // the user's choice survives gateway sync. Default ("always") and unset
  // both omit the state entry — same observable behavior on the inverse.
  it("forwards teamsNotify='auto' into cron job state['m.teamsNotify']", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, teamsNotify: "auto" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.teamsNotify": "auto" });
  });

  it("forwards teamsNotify='never' into cron job state['m.teamsNotify']", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.teamsNotify": "never" });
  });

  it("omits state entry when teamsNotify is the default ('always')", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, teamsNotify: "always" },
      { tz: "UTC" },
    );
    expect(result.state).toBeUndefined();
  });

  it("merges browserHeadless and teamsNotify in the same state bag", () => {
    const result = automationDataToCronJobCreate(
      { ...BASE_AUTOMATION, browserHeadless: true, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({
      "m.browserHeadless": true,
      "m.teamsNotify": "never",
    });
  });
});

describe("automationDataToCronJobCreate — condition trigger", () => {
  const CONDITION_AUTOMATION: AutomationData = {
    ...BASE_AUTOMATION,
    triggerType: "condition",
    condition: "PR 1878 is merged",
    conditionCheckInterval: 15,
  };

  it("produces a watcher cron with the expected payload", () => {
    const result = automationDataToCronJobCreate(CONDITION_AUTOMATION, { tz: "UTC" });

    expect(result.name).toBe("Daily summary"); // inherited from BASE_AUTOMATION
    expect(result.enabled).toBe(true);
    expect(result.deleteAfterRun).toBe(false); // watcher self-removes via cron.remove
    expect(result.schedule).toEqual({ kind: "every", everyMs: 900_000 });
    expect(result.payload.kind).toBe("agentTurn");
    if (result.payload.kind !== "agentTurn") throw new Error("expected agentTurn payload");
    expect(result.payload.message).toContain("PR 1878 is merged");
    expect(result.payload.message).toContain("sessions_spawn");
    expect(result.payload.message).toContain(WATCHER_PLACEHOLDER_ID);
    expect(result.payload.toolsAllow).toEqual([...WATCHER_TOOLS_ALLOW]);
    expect(result.sessionTarget).toBe("isolated");
    expect(result.wakeMode).toBe("now");
    expect(result.delivery).toEqual({ mode: "none" });
  });

  it("uses the action steps' prompts in the watcher's ACTION block", () => {
    const result = automationDataToCronJobCreate(
      {
        ...CONDITION_AUTOMATION,
        steps: [
          { id: "s1", label: "L1", prompt: "Send chat message about merge" },
          { id: "s2", label: "L2", prompt: "Open follow-up issue in repo xy" },
        ],
      },
      { tz: "UTC" },
    );
    if (result.payload.kind !== "agentTurn") throw new Error("expected agentTurn payload");
    expect(result.payload.message).toContain("Send chat message about merge");
    expect(result.payload.message).toContain("Open follow-up issue in repo xy");
  });

  it("defaults conditionCheckInterval to 15 minutes when undefined", () => {
    const result = automationDataToCronJobCreate(
      {
        ...CONDITION_AUTOMATION,
        conditionCheckInterval: undefined,
      },
      { tz: "UTC" },
    );
    expect(result.schedule).toEqual({ kind: "every", everyMs: 900_000 });
  });

  it("supports all canonical intervals: 5, 15, 30, 60", () => {
    const expectedMs: Record<5 | 15 | 30 | 60, number> = {
      5: 300_000,
      15: 900_000,
      30: 1_800_000,
      60: 3_600_000,
    };
    for (const interval of [5, 15, 30, 60] as const) {
      const result = automationDataToCronJobCreate(
        { ...CONDITION_AUTOMATION, conditionCheckInterval: interval },
        { tz: "UTC" },
      );
      expect(result.schedule).toEqual({ kind: "every", everyMs: expectedMs[interval] });
    }
  });

  it("rejects non-canonical intervals", () => {
    expect(() =>
      automationDataToCronJobCreate(
        { ...CONDITION_AUTOMATION, conditionCheckInterval: 7 },
        { tz: "UTC" },
      ),
    ).toThrow(/canonical|valid|5\/15\/30\/60/i);
  });

  it("rejects empty condition string", () => {
    expect(() =>
      automationDataToCronJobCreate({ ...CONDITION_AUTOMATION, condition: "" }, { tz: "UTC" }),
    ).toThrow(/condition.*non-empty|condition is required/i);
  });

  it("rejects missing condition field on a condition-triggered automation", () => {
    const broken = { ...CONDITION_AUTOMATION };
    delete broken.condition;
    expect(() => automationDataToCronJobCreate(broken, { tz: "UTC" })).toThrow(
      /condition.*non-empty|condition is required/i,
    );
  });

  it("forces deleteAfterRun: false even when oneShot is passed (watcher self-removes)", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, oneShot: false },
      { tz: "UTC" },
    );
    expect(result.deleteAfterRun).toBe(false);
  });

  // Sibling pin to the time-trigger CREATE state-bag forwarding (76d71622).
  // Without this, condition automations created via gateway dropped teamsNotify
  // on disk and were silently re-grandfathered to "always" on the next read.
  it("forwards teamsNotify via state['m.teamsNotify'] (mirrors time-trigger CREATE)", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, teamsNotify: "auto" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.teamsNotify": "auto" });
  });

  it("omits state when teamsNotify is 'always' (default — round-trips as unset)", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, teamsNotify: "always" },
      { tz: "UTC" },
    );
    expect(result.state).toBeUndefined();
  });

  it("forwards teamsNotify: 'never' via state", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.teamsNotify": "never" });
  });

  // browserHeadless was a sibling miss to the teamsNotify forwarding above.
  it("forwards browserHeadless=true via state['m.browserHeadless']", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, browserHeadless: true },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({ "m.browserHeadless": true });
  });

  it("omits state when browserHeadless is false (default — round-trips as unset)", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, browserHeadless: false },
      { tz: "UTC" },
    );
    expect(result.state).toBeUndefined();
  });

  it("merges browserHeadless and teamsNotify in the same state bag", () => {
    const result = automationDataToCronJobCreate(
      { ...CONDITION_AUTOMATION, browserHeadless: true, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(result.state).toEqual({
      "m.browserHeadless": true,
      "m.teamsNotify": "never",
    });
  });
});

describe("cronJobToAutomationData", () => {
  const MAKE_JOB = (over: Partial<CronJob> = {}): CronJob => ({
    id: "job-1",
    name: "Daily summary",
    description: "x",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
    sessionTarget: "session:auto-job-1",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi" },
    state: {},
    ...over,
  });

  it("round-trips a scheduled cron job we emitted", () => {
    const job = MAKE_JOB();
    const data = cronJobToAutomationData(job);
    expect(data.id).toBe("job-1");
    expect(data.name).toBe("Daily summary");
    expect(data.enabled).toBe(true);
    expect(data.oneShot).toBe(false);
    expect(data.triggerType).toBe("schedule");
    expect(data.schedule.days).toEqual([1, 2, 3, 4, 5]);
    expect(data.schedule.hour).toBe(9);
    expect(data.schedule.minute).toBe(0);
    expect(data.schedule.readOnly).toBeFalsy();
    expect(data.steps).toEqual([{ id: "step-0", label: "Daily summary", prompt: "hi" }]);
    expect(data.pinnedSessionId).toBeUndefined();
  });

  it("recovers model override from a scheduled cron job payload", () => {
    const job = MAKE_JOB({
      payload: { kind: "agentTurn", message: "hi", model: "claude-haiku-4.5" },
    });
    const data = cronJobToAutomationData(job);
    expect(data.model).toBe("claude-haiku-4.5");
  });

  it("recovers model override from a condition watcher cron job payload", () => {
    const job = MAKE_JOB({
      schedule: { kind: "every", everyMs: 900_000 },
      payload: {
        kind: "agentTurn",
        message:
          "CONDITION:\nPR 1878 is merged\n\nUse available tools to determine whether the condition is met.\n\nACTION (only run when condition is met, via sessions_spawn):\nNotify\n\nIf similar work already ran, do not duplicate it.",
        model: "claude-haiku-4.5",
        toolsAllow: [...WATCHER_TOOLS_ALLOW],
      },
    });
    const data = cronJobToAutomationData(job);
    expect(data.triggerType).toBe("condition");
    expect(data.model).toBe("claude-haiku-4.5");
  });

  it("humanizes naturalLanguage for clean cron emits so the edit form doesn't surface raw cron", () => {
    // Without humanization, opening an edit form for a saved automation
    // surfaces the raw cron expression as the user-editable schedule, and the
    // next save round-trip produces a parse failure → "0 0 * * *" regression.
    expect(cronJobToAutomationData(MAKE_JOB()).schedule.naturalLanguage).toBe("weekdays at 9am");
    expect(
      cronJobToAutomationData(
        MAKE_JOB({ schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" } }),
      ).schedule.naturalLanguage,
    ).toBe("every day at 8am");
  });

  it("recovers browserHeadless=true from cron job state", () => {
    const job = MAKE_JOB({ state: { "m.browserHeadless": true } });
    const data = cronJobToAutomationData(job);
    expect(data.browserHeadless).toBe(true);
  });

  it("yields undefined browserHeadless when state has no flag", () => {
    const job = MAKE_JOB({ state: {} });
    const data = cronJobToAutomationData(job);
    expect(data.browserHeadless).toBeUndefined();
  });

  it("yields undefined browserHeadless when state[m.browserHeadless] === false", () => {
    // Inverse map uses `=== true ? true : undefined`, so explicit `false`
    // collapses to undefined locally. Same observable behavior as absent.
    const job = MAKE_JOB({ state: { "m.browserHeadless": false } });
    const data = cronJobToAutomationData(job);
    expect(data.browserHeadless).toBeUndefined();
  });

  it("recovers teamsNotify='auto' from cron job state", () => {
    const job = MAKE_JOB({ state: { "m.teamsNotify": "auto" } });
    const data = cronJobToAutomationData(job);
    expect(data.teamsNotify).toBe("auto");
  });

  it("recovers teamsNotify='never' from cron job state", () => {
    const job = MAKE_JOB({ state: { "m.teamsNotify": "never" } });
    const data = cronJobToAutomationData(job);
    expect(data.teamsNotify).toBe("never");
  });

  it("yields undefined teamsNotify when state has no flag (manager treats unset as 'always')", () => {
    const job = MAKE_JOB({ state: {} });
    const data = cronJobToAutomationData(job);
    expect(data.teamsNotify).toBeUndefined();
  });

  it("yields undefined teamsNotify when state value is the default 'always'", () => {
    // Default round-trips as unset locally — the forward map omits it on
    // create, so seeing it on the inverse means a foreign writer set it
    // explicitly. Either way, surface as undefined.
    const job = MAKE_JOB({ state: { "m.teamsNotify": "always" } });
    const data = cronJobToAutomationData(job);
    expect(data.teamsNotify).toBeUndefined();
  });

  it("yields undefined teamsNotify when state value is unrecognized", () => {
    const job = MAKE_JOB({ state: { "m.teamsNotify": "loud" } });
    const data = cronJobToAutomationData(job);
    expect(data.teamsNotify).toBeUndefined();
  });

  it("marks non-emitted cron expressions as readOnly", () => {
    const job = MAKE_JOB({ schedule: { kind: "cron", expr: "*/15 * * * *", tz: "UTC" } });
    const data = cronJobToAutomationData(job);
    expect(data.schedule.readOnly).toBe(true);
    expect(data.schedule.naturalLanguage).toBe("*/15 * * * *");
  });

  it("marks `at` schedules as readOnly with humanized string", () => {
    const job = MAKE_JOB({ schedule: { kind: "at", at: "2026-05-01T12:00:00Z" } });
    const data = cronJobToAutomationData(job);
    expect(data.schedule.readOnly).toBe(true);
    expect(data.schedule.naturalLanguage).toMatch(/one-shot/i);
  });

  it("marks `every` schedules as readOnly with humanized string", () => {
    const job = MAKE_JOB({ schedule: { kind: "every", everyMs: 900_000 } });
    const data = cronJobToAutomationData(job);
    expect(data.schedule.readOnly).toBe(true);
    expect(data.schedule.naturalLanguage).toMatch(/every/i);
  });

  it("round-trips explicit target session IDs without making emitted schedules read-only", () => {
    const job = MAKE_JOB({ sessionTarget: "session:some-other-id" });
    const data = cronJobToAutomationData(job);
    expect(data.schedule.readOnly).toBeFalsy();
    expect(data.targetSessionId).toBe("some-other-id");
    expect(data.pinnedSessionId).toBeUndefined();
  });

  it("treats missing deleteAfterRun as oneShot: false", () => {
    const job = MAKE_JOB({ deleteAfterRun: undefined });
    const data = cronJobToAutomationData(job);
    expect(data.oneShot).toBe(false);
  });
});

describe("cronJobToAutomationData — condition trigger round-trip", () => {
  it("detects a watcher cron via toolsAllow and returns triggerType: condition", () => {
    const watcherJob: CronJob = {
      id: "cron-watch-1",
      name: "Watch PR",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "session:auto-cron-watch-1",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: [
          "Check whether this condition is currently true:",
          "",
          "CONDITION:",
          "PR 1878 is merged",
          "",
          "Use available tools (web_fetch, web_search, plugin tools, etc.) to inspect the current state of the world.",
          "",
          "If the condition is satisfied:",
          "  1. Call sessions_spawn with task = the ACTION below",
          '  2. Call cron.remove({id: "cron-watch-1"}) to stop polling',
          '  3. Reply briefly: "Fired."',
          "",
          "If NOT satisfied: reply briefly with what you checked (one short sentence is fine), and stop. Do NOT take action.",
          "",
          "ACTION (only run when condition is met, via sessions_spawn):",
          "Notify me about the merge",
          "",
          "If similar work has already been completed recently, the action should report no-op rather than duplicate the work.",
        ].join("\n"),
        toolsAllow: ["cron", "sessions_spawn", "web_fetch", "web_search", "group:plugins"],
      },
      state: {},
    };
    const result = cronJobToAutomationData(watcherJob);
    expect(result.triggerType).toBe("condition");
    expect(result.condition).toBe("PR 1878 is merged");
    expect(result.conditionCheckInterval).toBe(15);
    expect(result.steps).toEqual([
      { id: "step-0", label: "Watch PR", prompt: "Notify me about the merge" },
    ]);
  });

  it("does NOT detect a schedule-trigger automation as a watcher (no toolsAllow)", () => {
    const scheduleJob: CronJob = {
      id: "cron-sched-1",
      name: "Daily summary",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "session:auto-cron-sched-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Summarize my inbox" },
      state: {},
    };
    const result = cronJobToAutomationData(scheduleJob);
    expect(result.triggerType).toBe("schedule");
  });

  it("derives conditionCheckInterval from everyMs", () => {
    for (const [everyMs, expected] of [
      [300_000, 5],
      [900_000, 15],
      [1_800_000, 30],
      [3_600_000, 60],
    ] as const) {
      const watcherJob: CronJob = {
        id: "cron-w",
        name: "W",
        description: undefined,
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "every", everyMs },
        sessionTarget: "session:auto-cron-w",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message:
            "Check whether this condition is currently true:\n\nCONDITION:\nx\n\nUse available tools rest...",
          toolsAllow: ["cron", "sessions_spawn", "web_fetch", "web_search", "group:plugins"],
        },
        state: {},
      };
      expect(cronJobToAutomationData(watcherJob).conditionCheckInterval).toBe(expected);
    }
  });

  it("snaps non-canonical everyMs to the nearest canonical interval", () => {
    const watcherJob: CronJob = {
      id: "cron-w",
      name: "W",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      // 7 minutes — non-canonical (closest canonical: 5)
      schedule: { kind: "every", everyMs: 7 * 60_000 },
      sessionTarget: "session:auto-cron-w",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Check whether this condition is currently true:\n\nCONDITION:\nx\n\nUse available tools rest...",
        toolsAllow: ["cron", "sessions_spawn", "web_fetch", "web_search", "group:plugins"],
      },
      state: {},
    };
    expect(cronJobToAutomationData(watcherJob).conditionCheckInterval).toBe(5);
  });

  it("snaps an out-of-range everyMs to the nearest canonical (e.g., 100min → 60)", () => {
    const watcherJob: CronJob = {
      id: "cron-w",
      name: "W",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 100 * 60_000 },
      sessionTarget: "session:auto-cron-w",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          "Check whether this condition is currently true:\n\nCONDITION:\nx\n\nUse available tools rest...",
        toolsAllow: ["cron", "sessions_spawn", "web_fetch", "web_search", "group:plugins"],
      },
      state: {},
    };
    expect(cronJobToAutomationData(watcherJob).conditionCheckInterval).toBe(60);
  });

  it("toolsAllow contains sessions_spawn but the message has no CONDITION block — surfaces as triggerType: condition with empty condition (manually-edited payload fallback)", () => {
    // tryParseWatcher's documented behavior: a job whose toolsAllow signals
    // "watcher" but whose message body doesn't match the canonical template
    // (manual server-side edit, foreign client, malformed migration) falls
    // through with condition: "" rather than being misclassified as
    // schedule-trigger. Pin the current behavior — if we ever flip the
    // fallback to "return null and treat as schedule" this test must update
    // in tandem.
    const watcherJob: CronJob = {
      id: "cron-edited",
      name: "Edited",
      description: undefined,
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "session:auto-cron-edited",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "manually edited body without the CONDITION marker",
        toolsAllow: ["cron", "sessions_spawn"],
      },
      state: {},
    };
    const result = cronJobToAutomationData(watcherJob);
    expect(result.triggerType).toBe("condition");
    expect(result.condition).toBe("");
    expect(result.steps).toEqual([{ id: "step-0", label: "Edited", prompt: "" }]);
  });
});

describe("cronRunLogEntryToAutomationRunData", () => {
  const MAKE_ENTRY = (over: Partial<CronRunLogEntry> = {}): CronRunLogEntry => ({
    ts: 1_700_000_000_000,
    runAtMs: 1_700_000_000_000,
    status: "ok",
    sessionId: "sess-1",
    summary: "done",
    durationMs: 1234,
    ...over,
  });

  it("maps ok → completed with composite id", () => {
    const run = cronRunLogEntryToAutomationRunData(MAKE_ENTRY(), "auto-1", 0);
    expect(run.status).toBe("completed");
    expect(run.id).toMatch(/^auto-1:/);
    expect(run.finalOutput).toBe("done");
    expect(run.stepResults[0].status).toBe("completed");
  });

  it("preserves skipped as skipped", () => {
    const run = cronRunLogEntryToAutomationRunData(
      MAKE_ENTRY({ status: "skipped", summary: "empty event" }),
      "auto-1",
      0,
    );
    expect(run.status).toBe("skipped");
  });

  it("maps error → failed and carries the error string", () => {
    const run = cronRunLogEntryToAutomationRunData(
      MAKE_ENTRY({ status: "error", error: "boom", summary: undefined }),
      "auto-1",
      0,
    );
    expect(run.status).toBe("failed");
    expect(run.stepResults[0].error).toBe("boom");
  });

  it("falls back to ts when runAtMs is absent", () => {
    const run = cronRunLogEntryToAutomationRunData(MAKE_ENTRY({ runAtMs: undefined }), "auto-1", 0);
    expect(run.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("omits completedAt when durationMs is absent", () => {
    const run = cronRunLogEntryToAutomationRunData(
      MAKE_ENTRY({ durationMs: undefined }),
      "auto-1",
      0,
    );
    expect(run.completedAt).toBeUndefined();
  });

  it("disambiguates entries sharing a timestamp via the index parameter", () => {
    const run1 = cronRunLogEntryToAutomationRunData(MAKE_ENTRY(), "auto-1", 0);
    const run2 = cronRunLogEntryToAutomationRunData(MAKE_ENTRY(), "auto-1", 1);
    expect(run1.id).not.toBe(run2.id);
  });
});

describe("multi-step description sentinel", () => {
  const userDesc = "summarize my emails daily";
  const baseState: MultiStepState = {
    v: 1,
    stepCount: 3,
    steps: [
      { id: "step-1", label: "translate", prompt: "Translate {{previousOutput}} to Spanish" },
      { id: "step-2", label: "send", prompt: "Send {{previousOutput}} to my team" },
    ],
    stepsHash: "abc123",
  };

  it("round-trips state through description", () => {
    const encoded = encodeMultiStepDescription(userDesc, baseState);
    const decoded = decodeMultiStepDescription(encoded);
    expect(decoded.userDescription).toBe(userDesc);
    expect(decoded.state).toEqual(baseState);
  });

  it("returns null state when sentinel is absent", () => {
    const decoded = decodeMultiStepDescription("just a plain description");
    expect(decoded.userDescription).toBe("just a plain description");
    expect(decoded.state).toBeNull();
  });

  it("returns null state when sentinel is malformed (invalid base64)", () => {
    const decoded = decodeMultiStepDescription("desc\n\n[__m_multistep_v1__:not-valid-base64!@#$]");
    expect(decoded.state).toBeNull();
    expect(decoded.userDescription).toContain("not-valid-base64");
  });

  it("returns null state when sentinel decodes to wrong shape", () => {
    const badJson = Buffer.from(JSON.stringify({ wrongShape: true })).toString("base64");
    const decoded = decodeMultiStepDescription(`desc\n\n[__m_multistep_v1__:${badJson}]`);
    expect(decoded.state).toBeNull();
  });

  it("preserves the [schedule: ...] prefix", () => {
    const withPrefix = "[schedule: every weekday at 9am] " + userDesc;
    const encoded = encodeMultiStepDescription(withPrefix, baseState);
    const decoded = decodeMultiStepDescription(encoded);
    expect(decoded.userDescription).toBe(withPrefix);
    expect(decoded.state).toEqual(baseState);
  });

  it("encodes with newline separator before sentinel", () => {
    const encoded = encodeMultiStepDescription(userDesc, baseState);
    expect(encoded).toMatch(/\n\n\[__m_multistep_v1__:[A-Za-z0-9+/=]+\]\s*$/);
  });

  it("rejects sentinel where stepCount disagrees with steps.length + 1", () => {
    // Hand-craft a payload where stepCount lies about steps.length
    const lyingState = {
      v: 1,
      stepCount: 99,
      steps: [{ id: "step-1", label: "x", prompt: "p" }],
      stepsHash: "h",
    };
    const b64 = Buffer.from(JSON.stringify(lyingState)).toString("base64");
    const decoded = decodeMultiStepDescription(`desc\n\n[__m_multistep_v1__:${b64}]`);
    expect(decoded.state).toBeNull();
  });

  it("rejects sentinel with stepCount < 2 (single-step has no sentinel)", () => {
    const tooFew = {
      v: 1,
      stepCount: 1,
      steps: [],
      stepsHash: "h",
    };
    const b64 = Buffer.from(JSON.stringify(tooFew)).toString("base64");
    const decoded = decodeMultiStepDescription(`desc\n\n[__m_multistep_v1__:${b64}]`);
    expect(decoded.state).toBeNull();
  });
});

describe("computeStepsHash", () => {
  it("returns same hash for same steps", () => {
    const steps = [
      { id: "a", label: "L1", prompt: "p1" },
      { id: "b", label: "L2", prompt: "p2" },
    ];
    expect(computeStepsHash(steps)).toBe(computeStepsHash(steps));
  });

  it("returns different hash when prompt changes", () => {
    const a = [{ id: "a", label: "L", prompt: "p1" }];
    const b = [{ id: "a", label: "L", prompt: "p2" }];
    expect(computeStepsHash(a)).not.toBe(computeStepsHash(b));
  });

  it("treats label change as a hash difference", () => {
    const a = [{ id: "a", label: "L1", prompt: "p" }];
    const b = [{ id: "a", label: "L2", prompt: "p" }];
    expect(computeStepsHash(a)).not.toBe(computeStepsHash(b));
  });

  it("returns sha256 hex (64 chars)", () => {
    const hash = computeStepsHash([{ id: "a", label: "L", prompt: "p" }]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tail-cron name encoding", () => {
  it("builds and parses round-trip", () => {
    const name = buildTailCronName("auto-abc", "1714312800000", 2);
    expect(name).toBe("auto-auto-abc-r1714312800000-s2");
    const parsed = parseTailCronName(name);
    expect(parsed).toEqual({
      parentId: "auto-abc",
      runInstanceId: "1714312800000",
      stepIndex: 2,
    });
  });

  it("returns null on non-tail names", () => {
    expect(parseTailCronName("user-cron-foo")).toBeNull();
    expect(parseTailCronName("auto-abc")).toBeNull();
    expect(parseTailCronName("auto-x-r123")).toBeNull();
  });

  it("matchesParentTailPattern matches all tail crons for a parent", () => {
    const pattern = matchesParentTailPattern("auto-abc");
    expect(pattern.test("auto-auto-abc-r1234-s1")).toBe(true);
    expect(pattern.test("auto-auto-abc-r5678-s9")).toBe(true);
    expect(pattern.test("auto-auto-xyz-r1234-s1")).toBe(false);
    expect(pattern.test("auto-abc")).toBe(false);
  });
});

describe("substitutePreviousOutput", () => {
  it("replaces single occurrence", () => {
    expect(substitutePreviousOutput("Translate {{previousOutput}} to Spanish", "Hello world")).toBe(
      "Translate Hello world to Spanish",
    );
  });

  it("replaces multiple occurrences", () => {
    expect(substitutePreviousOutput("X={{previousOutput}}, Y={{previousOutput}}", "5")).toBe(
      "X=5, Y=5",
    );
  });

  it("leaves prompt unchanged when token absent", () => {
    expect(substitutePreviousOutput("hi", "ignored")).toBe("hi");
  });

  it("handles whitespace inside braces", () => {
    expect(substitutePreviousOutput("Use {{ previousOutput }} now", "X")).toBe("Use X now");
  });

  it("does not match different tokens", () => {
    expect(substitutePreviousOutput("{{otherToken}}", "X")).toBe("{{otherToken}}");
  });

  it("substitutes multi-line output verbatim", () => {
    const out = "line1\nline2\nline3";
    expect(substitutePreviousOutput("Translate: {{previousOutput}}", out)).toBe(
      `Translate: ${out}`,
    );
  });

  it("is case-sensitive: does not match {{PreviousOutput}}", () => {
    // Pin the case-sensitive contract — copilot mode is case-sensitive too.
    // A future regex broadening would silently change semantics in shared
    // prompts, so this test exists to make that change explicit.
    expect(substitutePreviousOutput("{{PreviousOutput}}", "X")).toBe("{{PreviousOutput}}");
    expect(substitutePreviousOutput("{{previousoutput}}", "X")).toBe("{{previousoutput}}");
  });
});

describe("automationDataToCronJobCreate (multi-step)", () => {
  const baseInput = {
    name: "summarize",
    description: "daily summary",
    enabled: true,
    oneShot: false,
    schedule: {
      naturalLanguage: "every day at 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 9,
      minute: 0,
    },
    triggerType: "schedule" as const,
  };

  it("encodes multi-step plan into description", () => {
    const input = {
      ...baseInput,
      steps: [
        { id: "step-1", label: "fetch", prompt: "Get unread emails" },
        { id: "step-2", label: "translate", prompt: "Translate {{previousOutput}} to Spanish" },
        { id: "step-3", label: "send", prompt: "Send {{previousOutput}} to team" },
      ],
    };
    const result = automationDataToCronJobCreate(input, { tz: "America/Los_Angeles" });

    expect(result.payload).toEqual({
      kind: "agentTurn",
      message: "Get unread emails",
    });

    const decoded = decodeMultiStepDescription(result.description ?? "");
    expect(decoded.state).not.toBeNull();
    expect(decoded.state?.stepCount).toBe(3);
    expect(decoded.state?.steps.length).toBe(2); // steps 2..N (slice(1))
    expect(decoded.state?.steps[0].prompt).toContain("{{previousOutput}}");
  });

  it("does NOT encode sentinel for single-step automations (parity with 2a)", () => {
    const input = {
      ...baseInput,
      steps: [{ id: "step-1", label: "x", prompt: "do it" }],
    };
    const result = automationDataToCronJobCreate(input, { tz: "UTC" });
    expect(result.description ?? "").not.toContain("__m_multistep_v1__");
  });

  it("does NOT double-encode when create-path description already contains a sentinel", () => {
    // Symmetric with the patch path: if a caller passes a server-side
    // description (which already wraps the user description in a sentinel
    // from a prior encode), strip that outer sentinel before re-encoding so
    // the inner user description doesn't get nested. Future "duplicate
    // automation" or "import → save" flows would otherwise produce nested
    // sentinels that decode unpredictably.
    const innerDesc = "real user description";
    const rawWithSentinel = encodeMultiStepDescription(innerDesc, {
      v: 1,
      stepCount: 2,
      steps: [{ id: "old-s2", label: "old", prompt: "old prompt" }],
      stepsHash: "old",
    });
    const result = automationDataToCronJobCreate(
      {
        ...baseInput,
        description: rawWithSentinel,
        steps: [
          { id: "step-1", label: "a", prompt: "p1" },
          { id: "step-2", label: "b", prompt: "p2" },
          { id: "step-3", label: "c", prompt: "p3" },
        ],
      },
      { tz: "UTC" },
    );
    const decoded = decodeMultiStepDescription(result.description ?? "");
    // The user description must be the inner (single-encoded) value, NOT the
    // doubly-wrapped form (which would still contain the inner sentinel).
    expect(decoded.userDescription).toBe(innerDesc);
    expect(decoded.userDescription).not.toContain("__m_multistep_v1__");
    expect(decoded.state?.stepCount).toBe(3);
    // Decoding once more on the userDescription yields no further sentinel —
    // confirming there's no nested wrapping left to peel.
    const reDecoded = decodeMultiStepDescription(decoded.userDescription);
    expect(reDecoded.state).toBeNull();
  });

  it("strips stale sentinel from description on a single-step create (multi→single duplicate)", () => {
    // If a caller round-trips a server-side multi-step description into a
    // single-step create (e.g. duplicating a 3-step automation as 1-step),
    // the sentinel must be stripped — otherwise the new single-step automation
    // would silently rehydrate the old steps[1..N] via cronJobToAutomationData.
    const sentinelLadenDesc = encodeMultiStepDescription("user desc", {
      v: 1,
      stepCount: 2,
      steps: [{ id: "s2", label: "B", prompt: "two" }],
      stepsHash: "h",
    });
    const result = automationDataToCronJobCreate(
      {
        ...baseInput,
        description: sentinelLadenDesc,
        steps: [{ id: "step-1", label: "a", prompt: "p1" }],
      },
      { tz: "UTC" },
    );
    expect(result.description).toBe("user desc");
    expect(result.description ?? "").not.toContain("__m_multistep_v1__");
  });

  it("preserves the [schedule: ...] prefix from 2a (alongside sentinel)", () => {
    const input = {
      ...baseInput,
      description: "[schedule: every day at 9am] daily summary",
      steps: [
        { id: "step-1", label: "a", prompt: "p1" },
        { id: "step-2", label: "b", prompt: "p2" },
      ],
    };
    const result = automationDataToCronJobCreate(input, { tz: "UTC" });
    expect(result.description).toMatch(/^\[schedule: /);
    expect(result.description).toMatch(/\[__m_multistep_v1__:/);
  });
});

describe("cronJobToAutomationData (multi-step round-trip)", () => {
  const buildJob = (over: Partial<CronJob> = {}): CronJob => ({
    id: "auto-test-multi",
    name: "test-multi",
    description: "user description here",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "session:auto-test-multi",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi" },
    state: {},
    ...over,
  });

  const multiStepCreate = automationDataToCronJobCreate(
    {
      name: "test-multi",
      description: "user description here",
      enabled: true,
      oneShot: false,
      schedule: {
        naturalLanguage: "daily at 9am",
        days: [0, 1, 2, 3, 4, 5, 6],
        hour: 9,
        minute: 0,
      },
      triggerType: "schedule",
      steps: [
        { id: "step-1", label: "first", prompt: "step 1 prompt" },
        { id: "step-2", label: "second", prompt: "step 2 prompt with {{previousOutput}}" },
        { id: "step-3", label: "third", prompt: "step 3 prompt" },
      ],
    },
    { tz: "UTC" },
  );

  it("reconstructs steps 2..N from sentinel", () => {
    const cronJob = buildJob({
      ...multiStepCreate,
    });
    const data = cronJobToAutomationData(cronJob);
    expect(data.steps.length).toBe(3);
    expect(data.steps[0].prompt).toBe("step 1 prompt");
    expect(data.steps[1].prompt).toBe("step 2 prompt with {{previousOutput}}");
    expect(data.steps[2].prompt).toBe("step 3 prompt");
  });

  it("falls back to single-step when sentinel is absent", () => {
    const cronJob = buildJob({ description: "just plain" });
    const data = cronJobToAutomationData(cronJob);
    expect(data.steps.length).toBe(1);
    expect(data.steps[0].prompt).toBe("hi");
  });

  it("falls back to single-step when sentinel is corrupted (user removed it externally)", () => {
    const cronJob = buildJob({
      description: "user desc\n\n[__m_multistep_v1__:not-valid-base64!@#$]",
    });
    const data = cronJobToAutomationData(cronJob);
    expect(data.steps.length).toBe(1);
    expect(data.steps[0].prompt).toBe("hi");
  });

  it("strips sentinel from returned description", () => {
    const cronJob = buildJob({
      ...multiStepCreate,
    });
    const data = cronJobToAutomationData(cronJob);
    expect(data.description ?? "").not.toContain("__m_multistep_v1__");
    expect(data.description).toBe("user description here");
  });
});

describe("automationPatchToCronJobPatch", () => {
  it("forwards single-step patches inline (no sentinel)", () => {
    // Mirrors the create-path single-step parity — a 1-step patch writes
    // payload.message directly and emits a sentinel-free description (empty
    // when no description is provided). The empty string is required (not
    // undefined) so a multi→single downgrade overwrites any stale sentinel
    // on the server.
    const patch = automationPatchToCronJobPatch(
      { steps: [{ id: "s1", label: "only", prompt: "do the thing" }] },
      { tz: "UTC" },
    );
    expect(patch.payload).toEqual({ kind: "agentTurn", message: "do the thing" });
    expect(patch.description).toBe("");
    expect(patch.description).not.toContain("__m_multistep_v1__");
  });

  it("forwards model override in patch payload", () => {
    const patch = automationPatchToCronJobPatch({ model: "claude-haiku-4.5" }, { tz: "UTC" });
    expect(patch.payload).toEqual({ kind: "agentTurn", model: "claude-haiku-4.5" });
  });

  it("maps targetSessionId patches to sessionTarget", () => {
    const patch = automationPatchToCronJobPatch(
      { targetSessionId: "user-session-123" },
      { tz: "UTC" },
    );
    expect(patch.sessionTarget).toBe("session:user-session-123");
  });

  it("uses isolated as a clear-target placeholder for backend substitution", () => {
    const patch = automationPatchToCronJobPatch({ targetSessionId: undefined }, { tz: "UTC" });
    expect(patch.sessionTarget).toBe("isolated");
  });

  it("rejects repoPath patches on gateway", () => {
    expect(() =>
      automationPatchToCronJobPatch({ repoPath: "C:\\src\\repo" }, { tz: "UTC" }),
    ).toThrow(/only supported by the local automation backend/);
  });

  it("emits a payload replacement when clearing model override in a patch", () => {
    const patch = automationPatchToCronJobPatch({ model: undefined }, { tz: "UTC" });
    expect(patch.payload).toEqual({ kind: "agentTurn", model: undefined });
  });

  it("encodes steps[1..N] into the description sentinel for multi-step patches", () => {
    // Phase 2b multi-step relaxation: steps[2..N] live in the parent cron's
    // description sentinel; payload.message carries step 1's prompt.
    const patch = automationPatchToCronJobPatch(
      {
        steps: [
          { id: "s1", label: "first", prompt: "step 1 prompt" },
          { id: "s2", label: "second", prompt: "step 2 prompt" },
          { id: "s3", label: "third", prompt: "step 3 prompt" },
        ],
      },
      { tz: "UTC" },
    );
    // payload.message is step 1's prompt (same as create-path).
    expect(patch.payload).toEqual({ kind: "agentTurn", message: "step 1 prompt" });
    // Description carries the sentinel; decoded state has step 2 + step 3.
    expect(patch.description).toBeDefined();
    const decoded = decodeMultiStepDescription(patch.description!);
    expect(decoded.state).not.toBeNull();
    expect(decoded.state!.stepCount).toBe(3);
    expect(decoded.state!.steps).toHaveLength(2);
    expect(decoded.state!.steps[0].prompt).toBe("step 2 prompt");
    expect(decoded.state!.steps[1].prompt).toBe("step 3 prompt");
  });

  it("preserves the patch's user description when encoding multi-step sentinel", () => {
    // If the patch carries both `description` and multi-step `steps`, the
    // user description goes into the sentinel-prefixed portion (decoded
    // back via decodeMultiStepDescription.userDescription).
    const patch = automationPatchToCronJobPatch(
      {
        description: "kept user description",
        steps: [
          { id: "s1", label: "a", prompt: "p1" },
          { id: "s2", label: "b", prompt: "p2" },
        ],
      },
      { tz: "UTC" },
    );
    expect(patch.description).toBeDefined();
    const decoded = decodeMultiStepDescription(patch.description!);
    expect(decoded.userDescription).toBe("kept user description");
    expect(decoded.state!.stepCount).toBe(2);
  });

  it("does NOT double-encode when patch.description already contains a sentinel", () => {
    // Defensive: if a caller passes the raw server-side description (which
    // already wraps the user description in a sentinel from a prior encode),
    // we strip that outer sentinel before re-encoding so the inner user
    // description doesn't get nested.
    const innerDesc = "real user description";
    const outerStateInput: MultiStepState = {
      v: 1,
      stepCount: 2,
      steps: [{ id: "s2", label: "B", prompt: "two" }],
      stepsHash: "old",
    };
    const rawWithSentinel = encodeMultiStepDescription(innerDesc, outerStateInput);

    const patch: Partial<AutomationData> = {
      description: rawWithSentinel,
      steps: [
        { id: "s1", label: "A", prompt: "one" },
        { id: "s2", label: "B", prompt: "two" },
        { id: "s3", label: "C", prompt: "three" },
      ],
    };
    const result = automationPatchToCronJobPatch(patch, { tz: "UTC" });
    const decoded = decodeMultiStepDescription(result.description ?? "");
    expect(decoded.userDescription).toBe(innerDesc); // not the doubly-wrapped version
    expect(decoded.userDescription).not.toContain("__m_multistep_v1__");
    expect(decoded.state?.stepCount).toBe(3);
  });

  it("strips stale sentinel when downgrading from multi-step to single-step (no description)", () => {
    // Today's UI form sends `description: formDescription.trim() || undefined`,
    // so the natural "remove steps 2..N from a multi-step automation that had
    // no user description" case sends { steps: [one], description: undefined }.
    // The patch path MUST emit out.description = "" (not skip the field) so
    // cron.update overwrites the stale multi-step sentinel on the server. If
    // we left the sentinel intact, the next cronJobToAutomationData would
    // rehydrate the deleted steps.
    const oldState: MultiStepState = {
      v: 1,
      stepCount: 3,
      steps: [
        { id: "s2", label: "B", prompt: "two" },
        { id: "s3", label: "C", prompt: "three" },
      ],
      stepsHash: "old",
    };
    // Sanity: confirm the encoded form really does carry the sentinel marker.
    expect(encodeMultiStepDescription("user desc", oldState)).toContain("__m_multistep_v1__");

    const patch: Partial<AutomationData> = {
      steps: [{ id: "s1", label: "A", prompt: "one" }],
      description: undefined,
    };
    const result = automationPatchToCronJobPatch(patch, { tz: "UTC" });
    expect(result.description).toBeDefined();
    expect(result.description).not.toContain("__m_multistep_v1__");
    expect(result.description).toBe("");
  });

  it("rejects description-only patches (protects multi-step state)", () => {
    // Footgun: a `{ description: "..." }` patch (no steps) for a multi-step
    // parent would forward the bare description to the server, wiping the
    // multi-step sentinel and losing steps[1..N] on the next run. The mapper
    // is pure (no server state) so it can't tell from the patch alone whether
    // the live cron is multi-step. Reject at the boundary; the fix forces
    // callers to resubmit `steps` so the encoded sentinel is preserved.
    expect(() =>
      automationPatchToCronJobPatch({ description: "new description text" }, { tz: "UTC" }),
    ).toThrow(/description-only patches are not supported/i);
    // The error message must mention `steps` so a confused caller knows what
    // to add. Also: error spelling matters — searchable from logs.
    expect(() => automationPatchToCronJobPatch({ description: "x" }, { tz: "UTC" })).toThrow(
      /resubmit.*steps/i,
    );
  });

  it("still accepts a bare-description patch when paired with steps", () => {
    // Sanity: the rejection is description-ONLY. Pairing description with
    // steps is the supported shape and must continue to work.
    const patch = automationPatchToCronJobPatch(
      {
        description: "user description",
        steps: [
          { id: "s1", label: "a", prompt: "p1" },
          { id: "s2", label: "b", prompt: "p2" },
        ],
      },
      { tz: "UTC" },
    );
    expect(patch.description).toBeDefined();
    const decoded = decodeMultiStepDescription(patch.description!);
    expect(decoded.userDescription).toBe("user description");
  });

  it("strips stale sentinel when downgrading multi-step to single-step (with sentinel-laden description)", () => {
    // Caller passed the raw server-side description (sentinel-wrapped). On
    // single-step downgrade, we must extract just the user portion and emit
    // it bare — no re-encoded sentinel.
    const sentinelLadenDesc = encodeMultiStepDescription("old user desc", {
      v: 1,
      stepCount: 2,
      steps: [{ id: "s2", label: "B", prompt: "two" }],
      stepsHash: "h",
    });
    const patch: Partial<AutomationData> = {
      steps: [{ id: "s1", label: "A", prompt: "one" }],
      description: sentinelLadenDesc,
    };
    const result = automationPatchToCronJobPatch(patch, { tz: "UTC" });
    expect(result.description).toBe("old user desc");
    expect(result.description).not.toContain("__m_multistep_v1__");
  });

  it("throws on unparseable naturalLanguage instead of silently saving placeholder zeros", () => {
    // Match copilot's `AutomationManager.create` behavior. Without the throw,
    // user-typed text that didn't match `parseSchedule` would fall through to
    // the structured-fields path — and with the renderer's placeholder zeros
    // that means silent `0 0 * * *` corruption, the same class of bug this PR
    // is fixing on the create + update mainline.
    expect(() =>
      automationPatchToCronJobPatch(
        {
          schedule: { naturalLanguage: "totally not a schedule", days: [], hour: 0, minute: 0 },
        },
        { tz: "UTC" },
      ),
    ).toThrow(/Could not parse schedule/i);
  });

  it("resolves schedule.naturalLanguage when structured fields are placeholders", () => {
    // The renderer (AutomationsPanel.tsx) sends only `naturalLanguage` with
    // placeholder zeros for `days`/`hour`/`minute` (TODO). Without
    // parsing NL in the mapper, every save round-trips to "0 0 * * *" — the
    // gateway equivalent of the bug copilot's manager.ts avoids via parseSchedule.
    const out = automationPatchToCronJobPatch(
      {
        schedule: { naturalLanguage: "every day at 8am", days: [], hour: 0, minute: 0 },
      },
      { tz: "UTC" },
    );
    expect(out.schedule).toEqual({ kind: "cron", expr: "0 8 * * *", tz: "UTC" });
  });

  it("forwards browserHeadless=true via state['m.browserHeadless']", () => {
    const out = automationPatchToCronJobPatch({ browserHeadless: true }, { tz: "UTC" });
    expect(out.state).toEqual({ "m.browserHeadless": true });
  });

  it("forwards browserHeadless=false explicitly via state (so an off-toggle is communicated)", () => {
    // Cron state patches merge server-side. We need to write `false` rather
    // than omit the key, otherwise toggling off would leave the previous
    // `true` value in place after a list refresh — silent-revert bug.
    const out = automationPatchToCronJobPatch({ browserHeadless: false }, { tz: "UTC" });
    expect(out.state).toEqual({ "m.browserHeadless": false });
  });

  it("omits state entirely when browserHeadless is undefined (no-op patch)", () => {
    const out = automationPatchToCronJobPatch({ name: "rename only" }, { tz: "UTC" });
    expect(out.state).toBeUndefined();
    expect(out.name).toBe("rename only");
  });

  it("forwards teamsNotify changes via state['m.teamsNotify']", () => {
    const out = automationPatchToCronJobPatch({ teamsNotify: "auto" }, { tz: "UTC" });
    expect(out.state).toEqual({ "m.teamsNotify": "auto" });
  });

  it("writes teamsNotify='always' explicitly so a revert-to-default is communicated", () => {
    // Cron state patches merge server-side. To revert from "auto" back to
    // the default "always", we must write it rather than omit, otherwise
    // the previous "auto" value would persist after a list refresh.
    const out = automationPatchToCronJobPatch({ teamsNotify: "always" }, { tz: "UTC" });
    expect(out.state).toEqual({ "m.teamsNotify": "always" });
  });

  it("merges browserHeadless and teamsNotify into one state patch", () => {
    const out = automationPatchToCronJobPatch(
      { browserHeadless: true, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(out.state).toEqual({
      "m.browserHeadless": true,
      "m.teamsNotify": "never",
    });
  });
});

describe("automationPatchToCronJobPatch — condition trigger", () => {
  it("rebuilds payload.message when condition is patched and includes toolsAllow inside payload", () => {
    const patch: Partial<AutomationData> = {
      triggerType: "condition",
      condition: "PR 1878 is merged",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "Notify" }],
    };
    const result = automationPatchToCronJobPatch(patch, { tz: "UTC" });
    expect(result.payload?.kind).toBe("agentTurn");
    if (result.payload?.kind !== "agentTurn") throw new Error("expected agentTurn payload");
    expect(result.payload.message).toContain("PR 1878 is merged");
    expect(result.payload.message).toContain("Notify");
    expect(result.payload.toolsAllow).toEqual([...WATCHER_TOOLS_ALLOW]);
    expect(result.schedule).toEqual({ kind: "every", everyMs: 900_000 });
  });

  it("rejects forbidden fields (workingDir, skillNames, permissions, pinnedSessionId) for condition trigger", () => {
    expect(() =>
      automationPatchToCronJobPatch(
        {
          triggerType: "condition",
          condition: "x",
          conditionCheckInterval: 15,
          steps: [{ id: "s1", label: "L", prompt: "p" }],
          workingDir: "/tmp",
        },
        { tz: "UTC" },
      ),
    ).toThrow(/workingDir.*not supported/i);
  });

  it("supports patching just the interval (no other fields) — schedule changes, payload untouched", () => {
    const result = automationPatchToCronJobPatch(
      { triggerType: "condition", conditionCheckInterval: 30 },
      { tz: "UTC" },
    );
    expect(result.schedule).toEqual({ kind: "every", everyMs: 1_800_000 });
    expect(result.payload).toBeUndefined();
  });

  it("preserves watcher toolsAllow when patching only the model", () => {
    const result = automationPatchToCronJobPatch(
      { triggerType: "condition", model: "claude-haiku-4.5" },
      { tz: "UTC" },
    );
    expect(result.payload).toEqual({
      kind: "agentTurn",
      model: "claude-haiku-4.5",
      toolsAllow: [...WATCHER_TOOLS_ALLOW],
    });
  });

  it("preserves watcher toolsAllow when clearing only the model", () => {
    const result = automationPatchToCronJobPatch(
      { triggerType: "condition", model: undefined },
      { tz: "UTC" },
    );
    expect(result.payload).toEqual({
      kind: "agentTurn",
      model: undefined,
      toolsAllow: [...WATCHER_TOOLS_ALLOW],
    });
  });

  it("rejects empty condition string when condition is being patched", () => {
    expect(() =>
      automationPatchToCronJobPatch({ triggerType: "condition", condition: "" }, { tz: "UTC" }),
    ).toThrow(/condition must be non-empty|condition is required/i);
  });

  it("supports patching just the steps (rebuilds prompt with the new steps)", () => {
    const result = automationPatchToCronJobPatch(
      {
        triggerType: "condition",
        condition: "X is true",
        steps: [{ id: "s2", label: "Replacement", prompt: "Different action prompt" }],
      },
      { tz: "UTC" },
    );
    expect(result.payload?.kind).toBe("agentTurn");
    if (result.payload?.kind !== "agentTurn") throw new Error("expected agentTurn payload");
    expect(result.payload.message).toContain("Different action prompt");
  });

  it("forwards teamsNotify changes via state['m.teamsNotify'] (mirrors schedule patch path)", () => {
    const out = automationPatchToCronJobPatch(
      { triggerType: "condition", teamsNotify: "auto" },
      { tz: "UTC" },
    );
    expect(out.state).toEqual({ "m.teamsNotify": "auto" });
  });

  it("merges browserHeadless and teamsNotify into one state patch on condition trigger", () => {
    const out = automationPatchToCronJobPatch(
      { triggerType: "condition", browserHeadless: true, teamsNotify: "never" },
      { tz: "UTC" },
    );
    expect(out.state).toEqual({
      "m.browserHeadless": true,
      "m.teamsNotify": "never",
    });
  });
});
