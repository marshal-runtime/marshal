import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
}));

import type { AutomationData } from "../../../../common/marshal-ipc-contract";
import { GatewayAutomationBackend } from "./backend";
import { WATCHER_PLACEHOLDER_ID } from "./condition";
import { ConditionSupervisor } from "./condition-supervisor";
import { computeStepsHash, encodeMultiStepDescription } from "./map";

interface RecordedCall {
  method: string;
  params: unknown;
}

interface CronUpdateCall extends RecordedCall {
  method: "cron.update";
  params: { id: string; patch: Record<string, unknown> };
}

function isCronUpdateCall(call: RecordedCall): call is CronUpdateCall {
  if (call.method !== "cron.update") return false;
  const p = call.params;
  return (
    !!p &&
    typeof p === "object" &&
    "patch" in p &&
    typeof (p as { patch?: unknown }).patch === "object" &&
    (p as { patch?: unknown }).patch !== null
  );
}

interface CronRunsCall extends RecordedCall {
  method: "cron.runs";
  params: { id: string; sortDir?: string };
}

function isCronRunsCall(call: RecordedCall): call is CronRunsCall {
  if (call.method !== "cron.runs") return false;
  const p = call.params;
  return (
    !!p && typeof p === "object" && "id" in p && typeof (p as { id?: unknown }).id === "string"
  );
}

function makeFakeClient() {
  const calls: RecordedCall[] = [];
  const replies = new Map<string, unknown>();
  return {
    calls,
    setReply: (method: string, reply: unknown) => replies.set(method, reply),
    client: {
      request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(
        async (method, params) => {
          calls.push({ method, params });
          if (replies.has(method)) return replies.get(method);
          throw new Error(`fake client: no reply configured for ${method}`);
        },
      ),
    },
  };
}

const AUTO: AutomationData = {
  id: "auto-1",
  name: "Test",
  steps: [{ id: "s1", label: "t", prompt: "hi" }],
  schedule: { naturalLanguage: "weekdays at 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  createdAt: "2026-04-22T10:00:00Z",
  updatedAt: "2026-04-22T10:00:00Z",
  triggerType: "schedule",
};

describe("GatewayAutomationBackend", () => {
  it("createAutomation calls cron.add then patches sessionTarget with the server-assigned id", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "server-id-42",
      name: "Test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "session:auto-server-id-42",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    };
    f.setReply("cron.add", { ...canonicalJob, sessionTarget: "isolated" });
    f.setReply("cron.update", canonicalJob);
    // createAutomation now does cron.add → cron.update → cron.list to return
    // the canonical AutomationData. The list RPC returns a page with the new job.
    f.setReply("cron.list", { jobs: [canonicalJob] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const created = await be.createAutomation(AUTO);
    expect(created.id).toBe("server-id-42");
    expect(created.name).toBe("Test");
    expect(f.calls[0].method).toBe("cron.add");
    expect(f.calls[0].params).toMatchObject({ sessionTarget: "isolated" });
    expect(f.calls[1].method).toBe("cron.update");
    expect(f.calls[1].params).toMatchObject({
      id: "server-id-42",
      patch: { sessionTarget: "session:auto-server-id-42" },
    });
    expect(f.calls[2].method).toBe("cron.list");
  });

  it("createAutomation with targetSessionId uses the existing session target without auto-session patch", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "server-id-target",
      name: "Test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "session:user-session-123",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    };
    f.setReply("cron.add", canonicalJob);
    f.setReply("cron.list", { jobs: [canonicalJob] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const created = await be.createAutomation({ ...AUTO, targetSessionId: "user-session-123" });

    expect(created.targetSessionId).toBe("user-session-123");
    expect(f.calls.map((c) => c.method)).toEqual(["cron.add", "cron.list"]);
    expect(f.calls[0].params).toMatchObject({ sessionTarget: "session:user-session-123" });
  });

  it("createAutomation rolls back via cron.remove when the follow-up cron.update fails", async () => {
    const f = makeFakeClient();
    f.setReply("cron.add", {
      id: "server-id-99",
      name: "Test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    });
    // cron.update fails — we should roll back by calling cron.remove and
    // re-throw the original update error to the caller.
    f.client.request.mockImplementationOnce(async (method, params) => {
      // first call is cron.add — use the configured reply
      f.calls.push({ method, params });
      return {
        id: "server-id-99",
        name: "Test",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hi" },
        state: {},
      };
    });
    f.client.request.mockImplementationOnce(async (method, params) => {
      // second call: cron.update — throw
      f.calls.push({ method, params });
      throw new Error("simulated network drop");
    });
    f.client.request.mockImplementationOnce(async (method, params) => {
      // third call: cron.remove — succeed (rollback)
      f.calls.push({ method, params });
      return { removed: true };
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.createAutomation(AUTO)).rejects.toThrow(/simulated network drop/);
    expect(f.calls.map((c) => c.method)).toEqual(["cron.add", "cron.update", "cron.remove"]);
    expect(f.calls[2].params).toEqual({ id: "server-id-99" });
  });

  it("createAutomation surfaces a composed error when both cron.update AND the rollback cron.remove fail", async () => {
    // Worst-case path: orphan job left on the server. The thrown error must
    // mention both errors so operators can diagnose; rule-out a silent
    // swallow if either branch is later refactored.
    const f = makeFakeClient();
    f.client.request.mockImplementationOnce(async (method, params) => {
      f.calls.push({ method, params });
      return {
        id: "orphan-id",
        name: "Test",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hi" },
        state: {},
      };
    });
    f.client.request.mockImplementationOnce(async (method, params) => {
      f.calls.push({ method, params });
      throw new Error("update kaboom");
    });
    f.client.request.mockImplementationOnce(async (method, params) => {
      f.calls.push({ method, params });
      throw new Error("rollback also kaboom");
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.createAutomation(AUTO)).rejects.toThrow(
      /cron\.update failed and rollback cron\.remove also failed.*orphan-id.*update kaboom.*rollback also kaboom/s,
    );
  });

  it("createAutomation surfaces a clear error when cron.add response is missing an id", async () => {
    // parseCronJobId guard: the server's response shape is owned by marshal
    // and could change. A response without `id` would otherwise leak `undefined`
    // into the sessionTarget patch and create a stuck "session:auto-undefined"
    // server-side; we want a hard failure at the boundary instead.
    const f = makeFakeClient();
    f.setReply("cron.add", {
      // intentionally no `id` field
      name: "Test",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.createAutomation(AUTO)).rejects.toThrow(/expected.*\bid\b.*string/i);
    // The cron.update never fires — we caught the bad response before
    // making any further server-mutating calls.
    expect(f.calls.map((c) => c.method)).toEqual(["cron.add"]);
  });

  it("listAutomations and getAllAutomationRuns hide tail crons", async () => {
    // Regression: tails are scheduled with payload.kind === "agentTurn" and
    // deleteAfterRun: false (intentional — multi-device catch-up safety). The
    // payload.kind filter alone leaked every tail (`auto-<parentId>-r<runInstance>-s<stepIndex>`)
    // into the user-visible automations list and double-counted runs in the
    // activities panel. Both surfaces must additionally exclude tail-named crons.
    const f = makeFakeClient();
    const parent = {
      id: "parent-1",
      name: "Daily summary",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:auto-parent-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    };
    const tail = {
      id: "tail-A",
      name: "auto-parent-1-r1700000000-s1",
      enabled: true,
      createdAtMs: 2,
      updatedAtMs: 2,
      schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
      sessionTarget: "session:auto-parent-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "step 2 prompt" },
      state: {},
    };
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") return { jobs: [parent, tail] };
      if (method === "cron.runs") return { entries: [] };
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const list = await be.listAutomations();
    expect(list.map((a) => a.id)).toEqual(["parent-1"]);

    const allRuns = await be.getAllAutomationRuns();
    // No tail entries should appear as automations in the all-history fan-out;
    // since cron.runs returns [] for the parent, the result is also [].
    expect(allRuns).toEqual([]);
    // The tail's cron.runs must NOT have been queried — that would have meant
    // it was treated as an automation in its own right.
    const tailRunsCalls = f.calls.filter(
      (c): c is CronRunsCall => isCronRunsCall(c) && c.params.id === "tail-A",
    );
    expect(tailRunsCalls).toHaveLength(0);
  });

  it("listAutomations unwraps { jobs } and filters non-agentTurn payloads", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        {
          id: "a",
          name: "agentTurn",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "session:auto-a",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
          state: {},
        },
        {
          id: "b",
          name: "system event",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "fire" },
          state: {},
        },
      ],
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const list = await be.listAutomations();
    expect(list.map((a) => a.id)).toEqual(["a"]);
  });

  it("listAutomations surfaces a watcher cron as triggerType: condition with condition + interval populated", async () => {
    // Round-trip guard: cron.list responses for condition-trigger automations
    // must rehydrate as triggerType: "condition" so recordKnownConditionAutomation
    // registers them with the supervisor and reconcileConditionAutomations
    // can detect missing watchers after a reconnect. Hardcoding triggerType:
    // "schedule" in cronJobToAutomationData (the bug this test guards) would
    // silently break Tasks 5/7/8 across reconnects.
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        {
          id: "cron-watch-42",
          name: "Watch the merge",
          description: "",
          enabled: true,
          deleteAfterRun: false,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          schedule: { kind: "every", everyMs: 900_000 },
          sessionTarget: "session:auto-cron-watch-42",
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
              '  2. Call cron.remove({id: "cron-watch-42"}) to stop polling',
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
        },
      ],
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const list = await be.listAutomations();
    expect(list).toHaveLength(1);
    const watcher = list[0];
    expect(watcher.id).toBe("cron-watch-42");
    expect(watcher.triggerType).toBe("condition");
    expect(watcher.condition).toBe("PR 1878 is merged");
    expect(watcher.conditionCheckInterval).toBe(15);
    expect(watcher.steps).toHaveLength(1);
    expect(watcher.steps[0].prompt).toBe("Notify me about the merge");
  });

  it("updateAutomation forwards a patch to cron.update", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", {
      id: "job-1",
      name: "new name",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:auto-job-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.updateAutomation("job-1", { name: "new name" });
    expect(f.calls[0].method).toBe("cron.update");
    expect(f.calls[0].params).toMatchObject({ id: "job-1", patch: { name: "new name" } });
  });

  it("updateAutomation clears targetSessionId back to the automation-owned session key", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    await be.updateAutomation("job-1", { targetSessionId: undefined });

    expect(f.calls[0].params).toMatchObject({
      id: "job-1",
      patch: { sessionTarget: "session:auto-job-1" },
    });
  });

  it("preserves schedule prompt when patching only the model", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "job-1",
      name: "Existing schedule",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:auto-job-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Keep this prompt" },
      state: {},
    };
    f.setReply("cron.list", { jobs: [canonicalJob] });
    f.setReply("cron.update", { ok: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    await be.listAutomations();
    await be.updateAutomation("job-1", { model: "claude-haiku-4.5" });

    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    const payload = updateCall!.params.patch.payload;
    expect(payload).toEqual({
      kind: "agentTurn",
      model: "claude-haiku-4.5",
      message: "Keep this prompt",
    });
  });

  it("drops stale schedule prompt state when list no longer returns an automation", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "job-1",
      name: "Existing schedule",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:auto-job-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Stale prompt" },
      state: {},
    };
    f.setReply("cron.list", { jobs: [canonicalJob] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.listAutomations();

    f.setReply("cron.list", { jobs: [] });
    await be.listAutomations();

    await expect(be.updateAutomation("job-1", { model: "claude-haiku-4.5" })).rejects.toThrow(
      /cannot patch model without steps/,
    );
    expect(f.calls.filter(isCronUpdateCall)).toHaveLength(0);
  });

  it("toggleAutomation forwards enabled via cron.update", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", {
      id: "job-1",
      name: "x",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "session:auto-job-1",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.toggleAutomation("job-1", false);
    expect(f.calls[0].params).toMatchObject({ id: "job-1", patch: { enabled: false } });
  });

  it("deleteAutomation treats `removed: false` as success (idempotent)", async () => {
    const f = makeFakeClient();
    // No tail crons in the list — single-step automation, just remove parent.
    f.setReply("cron.list", { jobs: [] });
    f.setReply("cron.remove", { removed: false });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.deleteAutomation("job-1")).resolves.toBeUndefined();
  });

  it("deleteAutomation calls cron.remove once for a single-step automation (no tails)", async () => {
    // Phase 2b: deleteAutomation now lists crons first to find tail crons
    // owned by this parent. With no tails in the list, the result should be
    // a single cron.remove call against the parent.
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        // The parent itself, plus an unrelated foreign job — neither is a tail.
        {
          id: "job-1",
          name: "parent",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
          state: {},
        },
        {
          id: "other",
          name: "auto-other-r1-s1",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "session:auto-other",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
          state: {},
        },
      ],
    });
    f.setReply("cron.remove", { removed: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.deleteAutomation("job-1");
    const removes = f.calls.filter((c) => c.method === "cron.remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].params).toEqual({ id: "job-1" });
  });

  it("deleteAutomation cancels tail crons before removing the parent", async () => {
    // Phase 2b multi-step: a parent owns N-1 tail crons named
    // auto-<parentId>-r<runInstanceId>-s<stepIndex>. deleteAutomation must
    // cancel those tails before removing the parent so the orphan-tail
    // pattern doesn't leak.
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        {
          id: "tail-A",
          name: "auto-job-1-r1700000000-s1",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "tail step 1" },
          state: {},
        },
        {
          id: "tail-B",
          name: "auto-job-1-r1700000000-s2",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "tail step 2" },
          state: {},
        },
      ],
    });
    f.setReply("cron.remove", { removed: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.deleteAutomation("job-1");
    const removes = f.calls.filter((c) => c.method === "cron.remove");
    expect(removes).toHaveLength(3);
    // Tails removed first, parent last.
    expect(removes[0].params).toEqual({ id: "tail-A" });
    expect(removes[1].params).toEqual({ id: "tail-B" });
    expect(removes[2].params).toEqual({ id: "job-1" });
  });

  it("deleteAutomation still removes the parent when a tail cron.remove fails", async () => {
    // Best-effort tail removal: a transient failure cancelling a tail must
    // not block the parent removal. The user is fixing a broken state by
    // deleting; partial failure is better than refusing the operation.
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        {
          id: "tail-A",
          name: "auto-job-1-r1700000000-s1",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "tail step 1" },
          state: {},
        },
      ],
    });
    // First cron.remove (tail-A) throws; the second (parent) should still run.
    let removeCalls = 0;
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "tail-A",
              name: "auto-job-1-r1700000000-s1",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
              sessionTarget: "session:auto-job-1",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "tail step 1" },
              state: {},
            },
          ],
        };
      }
      if (method === "cron.remove") {
        removeCalls += 1;
        if (removeCalls === 1) throw new Error("transient tail-remove failure");
        return { removed: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.deleteAutomation("job-1")).resolves.toBeUndefined();
    const removes = f.calls.filter((c) => c.method === "cron.remove");
    expect(removes).toHaveLength(2);
    expect(removes[1].params).toEqual({ id: "job-1" });
  });

  it("triggerAutomationNow sends cron.run with mode=force", async () => {
    const f = makeFakeClient();
    f.setReply("cron.run", { ok: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.triggerAutomationNow("job-1");
    expect(f.calls[0].method).toBe("cron.run");
    expect(f.calls[0].params).toEqual({ id: "job-1", mode: "force" });
  });

  it("getAutomationRuns unwraps { entries } and maps via the pure mapper", async () => {
    const f = makeFakeClient();
    // Phase 2b: getAutomationRuns now reads cron.list first to detect whether
    // the parent is multi-step. With no sentinel in description, falls back
    // to the 2a single-step run-log mapper.
    f.setReply("cron.list", {
      jobs: [
        {
          id: "job-1",
          name: "single",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
          state: {},
        },
      ],
    });
    f.setReply("cron.runs", {
      entries: [
        { ts: 1, runAtMs: 1, status: "ok", summary: "done", durationMs: 10 },
        { ts: 2, runAtMs: 2, status: "skipped" },
      ],
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const runs = await be.getAutomationRuns("job-1");
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("completed");
    expect(runs[1].status).toBe("skipped");
    // Single-step path uses the existing 2a mapper, so each run-log entry
    // produces one AutomationRunData with one step-0 result.
    expect(runs[0].stepResults).toHaveLength(1);
    expect(runs[0].stepResults[0].stepId).toBe("step-0");
  });

  it("getAutomationRuns aggregates multi-step runs via the history aggregator", async () => {
    // Phase 2b multi-step: when the parent's description carries the multi-
    // step sentinel, getAutomationRuns must fan out to per-tail cron.runs
    // and synthesize per-step AutomationRunData via aggregateMultiStepRuns.
    const f = makeFakeClient();
    const sentinelDescription = encodeMultiStepDescription("user desc", {
      v: 1,
      stepCount: 3,
      steps: [
        { id: "s2", label: "two", prompt: "p2" },
        { id: "s3", label: "three", prompt: "p3" },
      ],
      stepsHash: computeStepsHash([
        { id: "s1", label: "one", prompt: "p1" },
        { id: "s2", label: "two", prompt: "p2" },
        { id: "s3", label: "three", prompt: "p3" },
      ]),
    });
    f.setReply("cron.list", {
      jobs: [
        {
          id: "job-1",
          name: "multi",
          description: sentinelDescription,
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "p1" },
          state: {},
        },
        {
          id: "tail-A",
          name: "auto-job-1-r100-s1",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "p2" },
          state: {},
        },
        {
          id: "tail-B",
          name: "auto-job-1-r100-s2",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
          sessionTarget: "session:auto-job-1",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "p3" },
          state: {},
        },
      ],
    });
    // The aggregator reads parent runs + per-tail runs. We dispatch by
    // params.id to give each invocation a distinct reply.
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "job-1",
              name: "multi",
              description: sentinelDescription,
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
              sessionTarget: "session:auto-job-1",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "p1" },
              state: {},
            },
            {
              id: "tail-A",
              name: "auto-job-1-r100-s1",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
              sessionTarget: "session:auto-job-1",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "p2" },
              state: {},
            },
            {
              id: "tail-B",
              name: "auto-job-1-r100-s2",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "at", at: "2026-04-22T10:00:00Z" },
              sessionTarget: "session:auto-job-1",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "p3" },
              state: {},
            },
          ],
        };
      }
      if (method === "cron.runs") {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mockImplementation params is `unknown`; cron.runs always carries { id }
        const id = (params as { id: string }).id;
        if (id === "job-1") {
          return {
            entries: [{ ts: 100, runAtMs: 100, status: "ok", summary: "step 1 ok", durationMs: 5 }],
          };
        }
        if (id === "tail-A") {
          return {
            entries: [{ ts: 110, runAtMs: 110, status: "ok", summary: "step 2 ok", durationMs: 5 }],
          };
        }
        if (id === "tail-B") {
          return {
            entries: [{ ts: 120, runAtMs: 120, status: "ok", summary: "step 3 ok", durationMs: 5 }],
          };
        }
        return { entries: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const runs = await be.getAutomationRuns("job-1");
    expect(runs).toHaveLength(1);
    expect(runs[0].automationId).toBe("job-1");
    expect(runs[0].stepResults).toHaveLength(3);
    expect(runs[0].stepResults[0]).toMatchObject({
      stepId: "step-0",
      status: "completed",
      output: "step 1 ok",
    });
    expect(runs[0].stepResults[1]).toMatchObject({
      stepId: "step-1",
      status: "completed",
      output: "step 2 ok",
    });
    expect(runs[0].stepResults[2]).toMatchObject({
      stepId: "step-2",
      status: "completed",
      output: "step 3 ok",
    });
    expect(runs[0].status).toBe("completed");
    // Both tail crons should have been queried.
    const tailRunsCalls = f.calls.filter(
      (c): c is CronRunsCall => isCronRunsCall(c) && c.params.id !== "job-1",
    );
    expect(tailRunsCalls.map((c) => c.params.id).sort()).toEqual(["tail-A", "tail-B"]);
  });

  it("getAutomationRuns returns [] when the parent isn't found in cron.list", async () => {
    // Defensive: if the parent was deleted between the caller's automations
    // list snapshot and this call, treat as "no runs" rather than crashing.
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const runs = await be.getAutomationRuns("missing-job");
    expect(runs).toEqual([]);
  });

  it("getAllAutomationRuns issues exactly one cron.list across N automations", async () => {
    // Regression: previously each per-automation getAutomationRuns call did
    // its own cron.list (N+1 RPCs). The cached-jobs path threads the top-
    // level cron.list snapshot to each per-automation aggregator, so we
    // expect exactly one cron.list regardless of how many automations exist.
    const f = makeFakeClient();
    const jobs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 5; i += 1) {
      const id = `job-${i}`;
      const sentinelDescription = encodeMultiStepDescription(`desc ${i}`, {
        v: 1,
        stepCount: 2,
        steps: [{ id: `${id}-s2`, label: "two", prompt: "p2" }],
        stepsHash: computeStepsHash([
          { id: `${id}-s1`, label: "one", prompt: "p1" },
          { id: `${id}-s2`, label: "two", prompt: "p2" },
        ]),
      });
      jobs.push({
        id,
        name: `multi-${i}`,
        description: sentinelDescription,
        enabled: true,
        createdAtMs: i,
        updatedAtMs: i,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: `session:auto-${id}`,
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "p1" },
        state: {},
      });
    }
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") return { jobs };
      if (method === "cron.runs") return { entries: [] };
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.getAllAutomationRuns();
    const listCalls = f.calls.filter((c) => c.method === "cron.list");
    expect(listCalls).toHaveLength(1);
  });

  it("throws a clear error when methods are called without an attached client", async () => {
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    await expect(be.listAutomations()).rejects.toThrow(/client/i);
  });
});

describe("GatewayAutomationBackend.createAutomation — condition trigger", () => {
  const CONDITION_AUTO: AutomationData = {
    id: "auto-cond",
    name: "Watch",
    steps: [{ id: "s1", label: "L", prompt: "Notify" }],
    schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
    enabled: true,
    createdAt: "2026-05-07T00:00:00Z",
    updatedAt: "2026-05-07T00:00:00Z",
    triggerType: "condition",
    condition: "PR 1878 merged",
    conditionCheckInterval: 15,
  };

  it("substitutes the watcher placeholder id with the real cron id in payload.message", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "cron-cond-1",
      name: "Watch",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "session:auto-cron-cond-1",
      wakeMode: "now",
      // Canonical job after sessionTarget + payload patches: message no longer
      // contains the placeholder id; instead it has the real cron id.
      payload: {
        kind: "agentTurn",
        message: 'Check ... cron.remove({id: "cron-cond-1"})...',
        toolsAllow: ["cron", "sessions_spawn", "web_fetch", "web_search", "group:plugins"],
      },
      state: {},
    };
    f.setReply("cron.add", { ...canonicalJob, sessionTarget: "isolated" });
    f.setReply("cron.update", canonicalJob);
    f.setReply("cron.list", { jobs: [canonicalJob] });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.createAutomation(CONDITION_AUTO);

    // Verify the cron.update call (phase 2) carries BOTH the sessionTarget
    // patch AND a new payload that has the placeholder substituted with the
    // real cron id.
    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    const updatePatch = updateCall!.params.patch;
    expect(updatePatch.sessionTarget).toBe("session:auto-cron-cond-1");
    // Payload patch must NOT contain the placeholder anymore
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- updatePatch.payload is unknown; tests narrow to the agentTurn payload shape
    const payload = updatePatch.payload as {
      kind: string;
      message: string;
      toolsAllow: readonly string[];
    };
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain('cron.remove({id: "cron-cond-1"})');
    expect(payload.message).not.toContain(WATCHER_PLACEHOLDER_ID);
    expect(payload.toolsAllow).toEqual([
      "cron",
      "sessions_spawn",
      "web_fetch",
      "web_search",
      "group:plugins",
    ]);
  });

  it("rolls back via cron.remove if the placeholder-substitution cron.update fails", async () => {
    const f = makeFakeClient();
    f.setReply("cron.add", {
      id: "cron-cond-2",
      name: "Watch",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 900_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "<placeholder>" },
      state: {},
    });
    // cron.update intentionally errors via the fake client default
    f.setReply("cron.remove", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await expect(be.createAutomation(CONDITION_AUTO)).rejects.toThrow(
      /no reply configured for cron\.update/,
    );

    // Rollback verified: cron.remove was called with the orphan cron's id
    const removeCall = f.calls.find((c) => c.method === "cron.remove");
    expect(removeCall).toBeDefined();
    expect(removeCall!.params).toMatchObject({ id: "cron-cond-2" });
  });

  it("does NOT substitute placeholder for schedule-trigger automations (only sessionTarget patches)", async () => {
    const f = makeFakeClient();
    const canonicalJob = {
      id: "cron-sched-7",
      name: "Sched",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "UTC" },
      sessionTarget: "session:auto-cron-sched-7",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    };
    f.setReply("cron.add", { ...canonicalJob, sessionTarget: "isolated" });
    f.setReply("cron.update", canonicalJob);
    f.setReply("cron.list", { jobs: [canonicalJob] });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    await be.createAutomation({
      ...AUTO,
      // schedule trigger — no condition / steps differ
    });

    const updateCall = f.calls.find(isCronUpdateCall);
    const updatePatch = updateCall!.params.patch;
    expect(updatePatch.sessionTarget).toBe("session:auto-cron-sched-7");
    // Schedule-trigger create should NOT include a payload patch
    expect(updatePatch.payload).toBeUndefined();
  });
});

describe("GatewayAutomationBackend.updateAutomation — condition trigger", () => {
  it("substitutes the watcher placeholder id with the real cron id when condition+steps are patched", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    await be.updateAutomation("cron-cond-99", {
      triggerType: "condition",
      condition: "Updated condition",
      conditionCheckInterval: 30,
      steps: [{ id: "s1", label: "L", prompt: "Updated action" }],
    });

    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    const patch = updateCall!.params.patch;
    expect(patch.payload).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- patch.payload is unknown; tests narrow to the agentTurn payload shape
    const payload = patch.payload as { kind: string; message: string };
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain('cron.remove({id: "cron-cond-99"})');
    expect(payload.message).not.toContain(WATCHER_PLACEHOLDER_ID);
    expect(payload.message).toContain("Updated condition");
    expect(payload.message).toContain("Updated action");
  });

  it("forwards interval-only patches without rebuilding the payload", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    await be.updateAutomation("cron-cond-100", {
      triggerType: "condition",
      conditionCheckInterval: 60,
    });

    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    const patch = updateCall!.params.patch;
    expect(patch.payload).toBeUndefined();
    expect(patch.schedule).toEqual({ kind: "every", everyMs: 3_600_000 });
  });

  it("preserves watcher prompt when patching only the model", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    be.recordKnownConditionAutomation({
      id: "cron-cond-model",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "Original condition",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "Original action" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.updateAutomation("cron-cond-model", {
      triggerType: "condition",
      model: "claude-haiku-4.5",
    });

    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    expect(updateCall!.params.patch.payload).toEqual(
      expect.objectContaining({
        kind: "agentTurn",
        model: "claude-haiku-4.5",
        toolsAllow: expect.arrayContaining(["cron"]),
        message: expect.stringContaining("Original condition"),
      }),
    );
    expect(updateCall!.params.patch.payload).toEqual(
      expect.objectContaining({ message: expect.stringContaining("Original action") }),
    );
    expect(updateCall!.params.patch.payload).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('cron.remove({id: "cron-cond-model"})'),
      }),
    );
  });

  it("substitutes the watcher placeholder when ONLY steps is patched (fetches existing condition from in-memory map)", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    // Seed the in-memory map (mimics what happens after listAutomations / createAutomation).
    be.recordKnownConditionAutomation({
      id: "cron-cond-101",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "Original condition",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "Old action" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.updateAutomation("cron-cond-101", {
      triggerType: "condition",
      steps: [{ id: "s1", label: "L", prompt: "New action" }],
    });

    const updateCall = f.calls.find(isCronUpdateCall);
    expect(updateCall).toBeDefined();
    const patch = updateCall!.params.patch;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- patch.payload is unknown; tests narrow to the agentTurn payload shape
    const payload = patch.payload as { kind: string; message: string };
    expect(payload.message).toContain('cron.remove({id: "cron-cond-101"})');
    expect(payload.message).not.toContain(WATCHER_PLACEHOLDER_ID);
    expect(payload.message).toContain("Original condition"); // preserved from in-memory state
    expect(payload.message).toContain("New action"); // from patch
  });

  it("two back-to-back edits use the merged in-memory state (refresh after cron.update)", async () => {
    const f = makeFakeClient();
    f.setReply("cron.update", { ok: true });

    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    be.recordKnownConditionAutomation({
      id: "cron-cond-merge",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "First condition",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "First action" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.updateAutomation("cron-cond-merge", {
      triggerType: "condition",
      condition: "Second condition",
    });
    await be.updateAutomation("cron-cond-merge", {
      triggerType: "condition",
      steps: [{ id: "s1", label: "L", prompt: "Second action" }],
    });

    const updateCalls = f.calls.filter((c) => c.method === "cron.update");
    expect(updateCalls).toHaveLength(2);
    const secondCall = updateCalls[1];
    if (!isCronUpdateCall(secondCall)) throw new Error("expected cron.update");
    const secondPatch = secondCall.params.patch;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- patch.payload is unknown; narrow to agentTurn shape
    const payload = secondPatch.payload as { kind: string; message: string };
    expect(payload.message).toContain("Second condition");
    expect(payload.message).toContain("Second action");
    expect(payload.message).not.toContain("First condition");
  });
});

describe("GatewayAutomationBackend.getHeartbeatStatus", () => {
  it("calls last-heartbeat RPC and returns supported envelope with derived running", async () => {
    const tsRecent = Date.now() - 5000;
    const f = makeFakeClient();
    f.setReply("last-heartbeat", { ts: tsRecent, status: "sent" });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.getHeartbeatStatus();

    expect(f.calls[0].method).toBe("last-heartbeat");
    expect(f.calls[0].params).toEqual({});
    if (!result.supported) throw new Error("expected supported: true");
    expect(result.supported).toBe(true);
    expect(result.running).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.lastRun).toBe(new Date(tsRecent).toISOString());
  });

  it("returns supported:true with running:false when no heartbeat has fired", async () => {
    const f = makeFakeClient();
    f.setReply("last-heartbeat", null);
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.getHeartbeatStatus();

    expect(result).toEqual({
      supported: true,
      enabled: false,
      lastRun: null,
      nextRun: null,
      running: false,
    });
  });
});

describe("GatewayAutomationBackend.getHeartbeatConfig", () => {
  it("calls config.get, extracts agents.defaults.heartbeat, returns supported envelope with controllable map", async () => {
    const f = makeFakeClient();
    f.setReply("config.get", {
      config: {
        agents: {
          defaults: {
            heartbeat: {
              every: "30m",
              activeHours: { start: "09:00", end: "17:00" },
              prompt: "Test prompt",
            },
          },
        },
      },
      hash: "abc123",
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.getHeartbeatConfig();

    expect(f.calls[0].method).toBe("config.get");
    expect(f.calls[0].params).toEqual({});
    if (!result.supported) throw new Error("expected supported: true");
    expect(result).toMatchObject({
      supported: true,
      enabled: true,
      intervalMinutes: 30,
      schedule: "work-hours",
      prompt: "Test prompt",
      workStartHour: 9,
      workEndHour: 17,
      controllable: {
        enabled: true,
        intervalMinutes: true,
        schedule: true,
        prompt: true,
        permissions: false,
        workDays: false,
        workStartHour: true,
        workEndHour: true,
      },
    });
  });

  it("returns supported:true with default settings if heartbeat subtree missing", async () => {
    const f = makeFakeClient();
    f.setReply("config.get", { config: {}, hash: "x" });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.getHeartbeatConfig();
    if (!result.supported) throw new Error("expected supported: true");
    expect(result.intervalMinutes).toBe(60);
    expect(result.schedule).toBe("always");
  });
});

describe("GatewayAutomationBackend.updateHeartbeatConfig", () => {
  it("enabled-only patch uses set-heartbeats fast path; no config.get / config.patch", async () => {
    const f = makeFakeClient();
    f.setReply("set-heartbeats", { ok: true, enabled: true });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ enabled: true });

    expect(result).toEqual({ ok: true });
    expect(f.calls.map((c) => c.method)).toEqual(["set-heartbeats"]);
    expect(f.calls[0].params).toEqual({ enabled: true });
  });

  it("non-enabled patch goes through config.get → config.patch with base hash", async () => {
    const f = makeFakeClient();
    f.setReply("config.get", { config: {}, hash: "abc123" });
    f.setReply("config.patch", { ok: true, hash: "new-hash" });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({
      intervalMinutes: 30,
      prompt: "New prompt",
    });

    expect(result).toEqual({ ok: true });
    expect(f.calls[0].method).toBe("config.get");
    expect(f.calls[0].params).toEqual({});
    expect(f.calls[1].method).toBe("config.patch");
    expect(f.calls[1].params).toEqual({
      baseHash: "abc123",
      // marshal's `config.patch` schema requires `raw` as a JSON5 string
      // of the merge-patch (parsed and applied server-side).
      raw: JSON.stringify({
        agents: {
          defaults: {
            heartbeat: {
              every: "30m",
              prompt: "New prompt",
            },
          },
        },
      }),
    });
  });

  it("hash conflict (CONFIG_HASH_MISMATCH) returns config-conflict reason", async () => {
    const f = makeFakeClient();
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "config.get") return { config: {}, hash: "abc123" };
      if (method === "config.patch") {
        const err = new Error("base hash mismatch") as Error & { code?: string };
        err.code = "CONFIG_HASH_MISMATCH";
        throw err;
      }
      return null;
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ prompt: "x" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("config-conflict");
    expect(result.message).toMatch(/changed externally/i);
  });

  it("combined enabled+other patch runs config.patch BEFORE set-heartbeats (no half-applied toggle on hash conflict)", async () => {
    const f = makeFakeClient();
    f.setReply("set-heartbeats", { ok: true, enabled: true });
    f.setReply("config.get", { config: {}, hash: "h" });
    f.setReply("config.patch", { ok: true, hash: "h2" });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ enabled: true, prompt: "x" });

    expect(result).toEqual({ ok: true });
    // Order is load-bearing: config.patch first so a hash conflict doesn't
    // strand a half-applied set-heartbeats toggle on the server.
    expect(f.calls.map((c) => c.method)).toEqual(["config.get", "config.patch", "set-heartbeats"]);
  });

  it("combined enabled+other: config.patch failure aborts before set-heartbeats fires", async () => {
    const f = makeFakeClient();
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "config.get") return { config: {}, hash: "abc" };
      if (method === "config.patch") {
        const err = new Error("base hash mismatch") as Error & { code?: string };
        err.code = "CONFIG_HASH_MISMATCH";
        throw err;
      }
      return null;
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ enabled: true, prompt: "x" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("config-conflict");
    // set-heartbeats MUST NOT have fired — otherwise the user would see
    // "settings changed externally" while their toggle silently committed.
    expect(f.calls.map((c) => c.method)).not.toContain("set-heartbeats");
  });

  it("config.get without a usable hash returns unknown-error envelope (no config.patch fired)", async () => {
    // Defends against an marshal protocol skew where config.get returns a
    // shape without `hash` (or with non-string `hash`). Without this guard,
    // the bug would either silently send config.patch with `baseHash:
    // undefined` (rejected by marshal) or, worse, crash the process.
    const f = makeFakeClient();
    f.setReply("config.get", { config: {} }); // no `hash` field
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ prompt: "x" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown-error");
    expect(result.message).toMatch(/usable hash/i);
    // config.patch must NOT have been attempted with a bogus hash.
    expect(f.calls.map((c) => c.method)).not.toContain("config.patch");
  });

  it("set-heartbeats failure surfaces structured envelope (no exception escape)", async () => {
    // Pre-fix: a network/marshal error on set-heartbeats threw out of
    // updateHeartbeatConfig and was caught only by the IPC's outer
    // String(error) catch — losing the structured `reason`/`message`.
    const f = makeFakeClient();
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "set-heartbeats") {
        throw new Error("connection refused");
      }
      return null;
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({ enabled: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown-error");
    expect(result.message).toMatch(/connection refused/);
  });

  it("empty patch returns ok with no RPC calls", async () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const result = await be.updateHeartbeatConfig({});

    expect(result).toEqual({ ok: true });
    expect(f.calls).toHaveLength(0);
    expect(f.client.request).not.toHaveBeenCalled();
  });
});

describe("GatewayAutomationBackend.triggerHeartbeatNow", () => {
  it("returns not-supported sentinel with a helpful message", async () => {
    const be = new GatewayAutomationBackend({ tz: "UTC" });

    const result = await be.triggerHeartbeatNow();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-supported");
    expect(result.message).toMatch(/marshal|lobster/i);
  });
});

describe("GatewayAutomationBackend — cron removed event for condition watcher", () => {
  it("updates the local automation row to enabled:false + firedAt when the watcher is removed", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));

    be.recordKnownConditionAutomation({
      id: "cron-789",
      name: "Watcher",
      condition: "X",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      enabled: true,
      triggerType: "condition",
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    be.handleCronEvent({ action: "removed", jobId: "cron-789" });

    expect(events.length).toBe(1);
    expect(events[0].id).toBe("cron-789");
    expect(events[0].enabled).toBe(false);
    expect(events[0].firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores cron removed events for unknown ids", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));

    be.handleCronEvent({ action: "removed", jobId: "unknown-id" });

    expect(events.length).toBe(0);
  });

  it("does NOT set firedAt for schedule-trigger automations (they use enabled:false alone)", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));

    be.recordKnownConditionAutomation({
      id: "cron-sched-1",
      name: "Scheduled",
      enabled: true,
      triggerType: "schedule",
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "9am", days: [1], hour: 9, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    be.handleCronEvent({ action: "removed", jobId: "cron-sched-1" });

    // Schedule-trigger row receives no `firedAt` mutation. Implementation
    // detail: schedule-trigger registrations may be ignored entirely (no
    // listener fires) OR may fire with firedAt undefined. Either is acceptable —
    // the contract is "schedule-trigger automations don't get firedAt set".
    const firedAtValues = events.map((e) => e.firedAt);
    expect(firedAtValues.every((v) => v === undefined)).toBe(true);
  });

  it("ignores non-removed cron events (started/finished/added/updated)", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));

    be.recordKnownConditionAutomation({
      id: "cron-other-1",
      name: "Watcher",
      condition: "X",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      enabled: true,
      triggerType: "condition",
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    for (const action of ["started", "finished", "added", "updated"]) {
      be.handleCronEvent({ action, jobId: "cron-other-1" });
    }

    expect(events.length).toBe(0);
  });
});

describe("GatewayAutomationBackend — supervisor integration", () => {
  it("recordKnownConditionAutomation registers the watcher with the attached supervisor", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    const registerSpy = vi.spyOn(supervisor, "registerWatcher");
    be.attachConditionSupervisor(supervisor);

    be.recordKnownConditionAutomation({
      id: "cron-cond-9",
      name: "Watcher",
      condition: "X",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      enabled: true,
      triggerType: "condition",
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(registerSpy).toHaveBeenCalledWith({ cronId: "cron-cond-9" });
  });

  it("handleCronEvent unregisters the watcher when a condition automation transitions to fired", () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    const unregisterSpy = vi.spyOn(supervisor, "unregisterWatcher");
    be.attachConditionSupervisor(supervisor);

    be.recordKnownConditionAutomation({
      id: "cron-fire-1",
      name: "Watcher",
      condition: "X",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      enabled: true,
      triggerType: "condition",
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    be.handleCronEvent({ action: "removed", jobId: "cron-fire-1" });

    expect(unregisterSpy).toHaveBeenCalledWith("cron-fire-1");
  });

  it("listAutomations unregisters stale condition watchers that disappeared remotely", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    const cronRemove = vi
      .fn<(params: { id: string }) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    const supervisor = new ConditionSupervisor({ cronRemove });
    const unregisterSpy = vi.spyOn(supervisor, "unregisterWatcher");
    be.attachConditionSupervisor(supervisor);

    be.recordKnownConditionAutomation({
      id: "cron-remote-delete",
      name: "Watcher",
      condition: "X",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      enabled: true,
      triggerType: "condition",
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.listAutomations();

    expect(unregisterSpy).toHaveBeenCalledWith("cron-remote-delete");
  });
});

describe("GatewayAutomationBackend.reconcileConditionAutomations", () => {
  it("marks an active condition automation as fired when its watcher is missing AND a spawned action session is observed", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] }); // watcher gone
    f.setReply("sessions.list", {
      sessions: [
        {
          key: "agent:m:cron:cron-cond-1:run:abc",
          parentSessionKey: "agent:m:cron:cron-cond-1",
        },
        {
          key: "agent:m:spawned-action-x",
          parentSessionKey: "agent:m:cron:cron-cond-1:run:abc",
        },
      ],
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-cond-1",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.reconcileConditionAutomations();

    expect(events.length).toBe(1);
    expect(events[0].id).toBe("cron-cond-1");
    expect(events[0].enabled).toBe(false);
    expect(events[0].firedAt).toBeDefined();
  });

  it("marks an active condition automation as enabled:false (without firedAt) when watcher is missing AND no spawned session is observed", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] });
    f.setReply("sessions.list", { sessions: [] }); // no spawned action observed
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-cond-2",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.reconcileConditionAutomations();

    expect(events.length).toBe(1);
    expect(events[0].enabled).toBe(false);
    expect(events[0].firedAt).toBeUndefined();
  });

  it("does not change automations whose watcher is still present in cron.list", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", {
      jobs: [
        {
          id: "cron-cond-3",
          name: "Watcher",
          schedule: { kind: "every", everyMs: 900_000 },
          enabled: true,
          payload: { kind: "agentTurn", message: "..." },
          sessionTarget: "session:auto-cron-cond-3",
          wakeMode: "now",
          createdAtMs: 0,
          updatedAtMs: 0,
          state: {},
        },
      ],
    });
    f.setReply("sessions.list", { sessions: [] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-cond-3",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.reconcileConditionAutomations();

    expect(events.length).toBe(0);
  });

  it("ignores schedule-trigger automations during reconcile (only condition triggers are tracked)", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] });
    f.setReply("sessions.list", { sessions: [] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    // The known map only takes condition-trigger entries; calling
    // recordKnownConditionAutomation with a schedule trigger is unusual but
    // tests the guard.
    be.recordKnownConditionAutomation({
      id: "cron-sched-7",
      name: "Sched",
      triggerType: "schedule",
      enabled: true,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "9am", days: [1], hour: 9, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.reconcileConditionAutomations();

    expect(events.length).toBe(0);
  });

  it("ignores already-disabled rows (no further notification)", async () => {
    const f = makeFakeClient();
    f.setReply("cron.list", { jobs: [] });
    f.setReply("sessions.list", { sessions: [] });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-cond-already-off",
      name: "Watcher",
      triggerType: "condition",
      enabled: false, // already disabled — reconcile should skip
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await be.reconcileConditionAutomations();

    expect(events.length).toBe(0);
  });

  it("does not clobber a firedAt set by handleCronEvent during an in-flight reconcile (race)", async () => {
    // Race: reconcile snapshots `missing` from the map, then awaits sessions.list.
    // While that await is pending, a `cron removed` WS event fires and
    // handleCronEvent sets firedAt on the same row. When sessions.list
    // resolves with no spawned-action observed, the reconcile loop must NOT
    // overwrite the firedAt that handleCronEvent just wrote.
    const f = makeFakeClient();
    let resolveSessionsList!: (value: unknown) => void;
    const sessionsListPromise = new Promise<unknown>((resolve) => {
      resolveSessionsList = resolve;
    });
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") return { jobs: [] };
      if (method === "sessions.list") return sessionsListPromise;
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-race",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    const reconcilePromise = be.reconcileConditionAutomations();
    // Yield to let reconcile reach the sessions.list await.
    await Promise.resolve();
    await Promise.resolve();
    be.handleCronEvent({ action: "removed", jobId: "cron-race" });
    resolveSessionsList({ sessions: [] });
    await reconcilePromise;

    const fired = events.filter((e) => e.firedAt !== undefined);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.id).toBe("cron-race");
    expect(last.firedAt).toBeDefined();
    expect(last.enabled).toBe(false);
  });

  it("propagates sessions.list rejection without leaving the map in a partial state", async () => {
    const f = makeFakeClient();
    f.client.request.mockImplementation(async (method, params) => {
      f.calls.push({ method, params });
      if (method === "cron.list") return { jobs: [] };
      if (method === "sessions.list") throw new Error("network blip");
      throw new Error(`unexpected method ${method}`);
    });
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);
    const events: AutomationData[] = [];
    be.onAutomationsChanged((data) => events.push(data));
    be.recordKnownConditionAutomation({
      id: "cron-net-err",
      name: "Watcher",
      triggerType: "condition",
      enabled: true,
      condition: "x",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    await expect(be.reconcileConditionAutomations()).rejects.toThrow(/network blip/);
    expect(events.length).toBe(0);
  });
});

describe("GatewayAutomationBackend.updateAutomation cold-map guard", () => {
  it("throws when rebuilding a watcher prompt with a steps-only patch and no in-memory condition", async () => {
    const f = makeFakeClient();
    const be = new GatewayAutomationBackend({ tz: "UTC" });
    be.attachClient(f.client);

    await expect(
      be.updateAutomation("cron-x", {
        triggerType: "condition",
        steps: [{ id: "s1", label: "L", prompt: "new action" }],
      }),
    ).rejects.toThrow(/condition is missing|hydrate|cold/i);
    expect(f.calls.filter((c) => c.method === "cron.update")).toHaveLength(0);
  });
});
