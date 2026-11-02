import { describe, it, expect, vi, beforeEach } from "vitest";

import { encodeMultiStepDescription, computeStepsHash } from "./map";
import { GatewayAutomationOrchestrator, type OrchestratorRpcClient } from "./orchestrator";

type EventListenerFn = (name: string, payload: Record<string, unknown>) => void;

function makeFakeClient() {
  const listeners = new Set<EventListenerFn>();
  return {
    onEvent: vi.fn<(cb: EventListenerFn) => () => void>((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
    emit(name: string, payload: Record<string, unknown>) {
      for (const l of listeners) l(name, payload);
    },
    listeners,
  };
}

/**
 * Build a parent cron job whose `description` carries a multi-step sentinel
 * for `stepCount` steps. step 0 lives in `payload.message`; the sentinel
 * carries steps[1..N-1] (1-indexed from the user's perspective).
 *
 * Tail step prompts use {{previousOutput}} so we can verify substitution.
 */
function makeParentCron(stepCount: number, parentId = "parent-1") {
  const tailSteps = Array.from({ length: stepCount - 1 }, (_, i) => ({
    id: `step-${i + 1}`,
    label: `step-${i + 1}`,
    prompt: i === 0 ? "Use {{previousOutput}}" : "Continue from {{previousOutput}}",
  }));
  const allSteps = [{ id: "step-0", label: "x", prompt: "p1" }, ...tailSteps];
  return {
    id: parentId,
    name: `parent-automation-${parentId}`,
    description: encodeMultiStepDescription("user desc", {
      v: 1,
      stepCount,
      steps: tailSteps,
      stepsHash: computeStepsHash(allSteps),
    }),
    enabled: true,
    payload: { kind: "agentTurn", message: "step 1 prompt" },
    sessionTarget: `session:auto-${parentId}`,
    sessionKey: `session:auto-${parentId}`,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    wakeMode: "now",
    delivery: { mode: "none" },
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    state: {},
  };
}

describe("GatewayAutomationOrchestrator (skeleton)", () => {
  let orch: GatewayAutomationOrchestrator;
  let client: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    orch = new GatewayAutomationOrchestrator();
    client = makeFakeClient();
  });

  it("subscribes to onEvent on attachClient", () => {
    orch.attachClient(client as OrchestratorRpcClient);
    expect(client.onEvent).toHaveBeenCalled();
  });

  it("unsubscribes on detachClient", () => {
    orch.attachClient(client as OrchestratorRpcClient);
    expect(client.listeners.size).toBe(1);
    orch.detachClient();
    expect(client.listeners.size).toBe(0);
  });

  it("ignores events when no client attached", () => {
    expect(() => client.emit("cron", {})).not.toThrow();
  });

  it("attachClient is idempotent (re-attaching detaches old listener first)", () => {
    orch.attachClient(client as OrchestratorRpcClient);
    orch.attachClient(client as OrchestratorRpcClient);
    expect(client.listeners.size).toBe(1);
  });
});

describe("GatewayAutomationOrchestrator chain advance", () => {
  let orch: GatewayAutomationOrchestrator;
  let client: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    orch = new GatewayAutomationOrchestrator();
    client = makeFakeClient();
    orch.attachClient(client as OrchestratorRpcClient);
  });

  it("advances from step 1 to step 2 when cron finished event arrives", async () => {
    const parent = makeParentCron(3);
    // Stub client.request:
    //   - cron.list returns [parent]
    //   - chat.history returns one assistant message we expect to substitute
    //   - cron.add succeeds
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m1",
              role: "user",
              content: [{ type: "text", text: "step 1 prompt" }],
              timestamp: new Date(Date.now() - 1000).toISOString(),
            },
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-1", ...params };
      return null;
    });

    const runAtMs = Date.now() - 500;
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 400,
      sessionId: "sess-1",
      sessionKey: "session:auto-parent-1",
      summary: "step 1 ok",
    });

    // Allow microtasks to flush
    await new Promise((r) => setImmediate(r));

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    const payload = addCall![1];
    expect(payload.name).toBe(`auto-parent-1-r${runAtMs}-s1`);
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload.payload typed as unknown; narrowing for test inspection
    const inner = payload.payload as Record<string, unknown>;
    expect(inner.kind).toBe("agentTurn");
    // Step 2's prompt has {{previousOutput}} substituted with "step 1 output"
    expect(inner.message).toBe("Use step 1 output");
    expect(payload.sessionTarget).toBe("session:auto-parent-1");
    // Tails MUST set deleteAfterRun: false so a disabled-but-present stub
    // remains in cron.list after the one-shot run; this prevents a second
    // desktop reconnecting within the TTL from re-adding completed steps.
    expect(payload.deleteAfterRun).toBe(false);
  });

  it("ignores non-cron events", async () => {
    client.emit("sessions.changed", { sessionId: "x" });
    await new Promise((r) => setImmediate(r));
    expect(client.request).not.toHaveBeenCalled();
  });

  it("ignores cron events without action='finished'", async () => {
    client.emit("cron", { jobId: "p", action: "added" });
    await new Promise((r) => setImmediate(r));
    expect(client.request).not.toHaveBeenCalled();
  });

  it("ignores cron events for jobs that aren't multi-step parents", async () => {
    const plainJob = {
      id: "single-1",
      name: "single",
      description: "no sentinel here",
      payload: { kind: "agentTurn", message: "do it" },
    };
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [plainJob] };
      return null;
    });

    client.emit("cron", { jobId: "single-1", action: "finished", status: "ok" });
    await new Promise((r) => setImmediate(r));

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("uses evt.job snapshot when present (skips parent cron.list lookup)", async () => {
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [] }; // no existing tail crons
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-1", ...params };
      return null;
    });

    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });

    await new Promise((r) => setImmediate(r));

    // Exactly one cron.list call: the dedup pre-flight. evt.job let us skip
    // a second one for parent lookup.
    const listCalls = client.request.mock.calls.filter(([m]) => m === "cron.list");
    expect(listCalls).toHaveLength(1);
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
  });

  it("schedules step 3 when a tail cron for step 2 finishes", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 500;
    const tailStep1Name = `auto-parent-1-r${runAtMs}-s1`;
    const tailStep1 = {
      id: "tail-1",
      name: tailStep1Name,
      description: `[step 2/3 of '${parent.name}']`,
      payload: { kind: "agentTurn", message: "Use step 1 output" },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent, tailStep1] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m3",
              role: "assistant",
              content: [{ type: "text", text: "step 2 output" }],
              timestamp: new Date(runAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-2", ...params };
      return null;
    });

    client.emit("cron", {
      jobId: "tail-1",
      action: "finished",
      status: "ok",
      runAtMs: runAtMs,
      durationMs: 500,
      sessionKey: "session:auto-parent-1",
      job: tailStep1,
    });

    await new Promise((r) => setImmediate(r));

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    const payload = addCall![1];
    expect(payload.name).toBe(`auto-parent-1-r${runAtMs}-s2`);
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload.payload typed as unknown; narrowing for test inspection
    const inner = payload.payload as Record<string, unknown>;
    expect(inner.message).toBe("Continue from step 2 output");
    // Description uses parent's display name, not ID
    expect(payload.description).toBe(`[step 3/3 of '${parent.name}']`);
  });

  it("does NOT schedule next step on status='error' (and skips chat.history)", async () => {
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [parent] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "error",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
    // Short-circuit happens before any RPC fetch
    const histCall = client.request.mock.calls.find(([m]) => m === "chat.history");
    expect(histCall).toBeUndefined();
  });

  it("does NOT schedule next step when assistant message is empty", async () => {
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("does NOT schedule next step when chat.history throws", async () => {
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") throw new Error("network down");
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("uses fallback window when assistant timestamp is past primary [start, start+duration+5s]", async () => {
    // Clock-skew path: the assistant message is past the primary window
    // (runAtMs + durationMs + 5s slack) but still >= runAtMs. The fallback
    // branch must accept it and substitute. Without this, mild clock skew
    // between server and client would prevent any tail from being scheduled.
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 60_000;
    const durationMs = 1000;
    // primary window end = runAtMs + 1000 + 5000 = runAtMs + 6000
    // assistant ts = runAtMs + 30_000 → outside primary, but >= runAtMs
    const assistantTs = runAtMs + 30_000;
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output (skewed)" }],
              timestamp: new Date(assistantTs).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded
    const payload = addCall![1];
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload.payload typed as unknown; narrowing for test inspection
    const inner = payload.payload as Record<string, unknown>;
    expect(inner.message).toBe("Use step 1 output (skewed)");
  });

  it("fallback window is capped at runAtMs + CATCH_UP_TTL_MS (1h)", async () => {
    // Shared session safety: a much later user-initiated assistant message
    // (e.g. 2h after the run finished) must NOT be picked up by the fallback
    // path. CATCH_UP_TTL_MS is 1h, matching the chain-abandonment policy.
    // Chain itself is fresh (runAtMs ~30min ago) so isStale doesn't trip
    // upstream — the only thing that should suppress the schedule is the
    // capped fallback dropping the too-late message.
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 30 * 60 * 1000; // 30min ago
    const durationMs = 1000;
    // assistant ts is 2h after runAtMs — > runAtMs, past primary slack
    // window AND past the 1h fallback cap. Expect: dropped.
    const assistantTs = runAtMs + 2 * 60 * 60 * 1000;
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "later",
              role: "assistant",
              content: [{ type: "text", text: "user-initiated reply much later" }],
              timestamp: new Date(assistantTs).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    // No assistant message in window or fallback → fetchPreviousOutput
    // returns null → scheduleNextStep aborts without cron.add.
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("does NOT schedule next step when no assistant message in history", async () => {
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "u1",
              role: "user",
              content: [{ type: "text", text: "request" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("schedules next step when finished < 1h ago", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 30 * 60 * 1000;
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 1000,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
  });

  it("does NOT schedule when finished > 1h ago (catch-up window elapsed)", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 2 * 60 * 60 * 1000;
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 1000,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("uses event time + duration as the finished timestamp (just past 1h not scheduled)", async () => {
    const parent = makeParentCron(3);
    // 65 min ago, durationMs = 0 → finishedAt is 65 min ago, beyond 60-min TTL
    const runAtMs = Date.now() - 65 * 60 * 1000;
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 0,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("does NOT schedule when a tail cron with the deterministic name already exists", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 500;
    const existingTailName = `auto-parent-1-r${runAtMs}-s1`;
    const existingTail = {
      id: "tail-existing",
      name: existingTailName,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [parent, existingTail] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 100,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("dedups duplicate tail crons, keeping earliest id, before scheduling next step", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 500;
    const tailName = `auto-parent-1-r${runAtMs}-s1`;
    const dup1 = {
      id: "aaa-tail",
      name: tailName,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    const dup2 = {
      id: "zzz-tail",
      name: tailName,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    const removed: string[] = [];
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent, dup1, dup2] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.remove") {
        const id = params.id;
        if (typeof id === "string") removed.push(id);
        return { ok: true };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 100,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    // Earliest id "aaa-tail" is kept; "zzz-tail" removed
    expect(removed).toEqual(["zzz-tail"]);
    // Pre-existing dup at the deterministic name means we still skip cron.add
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("handles cron.add failure during scheduleNextStep without crashing", async () => {
    // Network/server error on cron.add must surface as a logged warning via
    // advanceChain's .catch — never crash the orchestrator's event handler.
    const parent = makeParentCron(2);
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [parent] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") throw new Error("network");
      return null;
    });

    // Emit and let the .catch in onCronEvent absorb the rejection.
    expect(() =>
      client.emit("cron", {
        jobId: "parent-1",
        action: "finished",
        status: "ok",
        runAtMs: Date.now() - 100,
        durationMs: 50,
        sessionKey: "session:auto-parent-1",
        job: parent,
      }),
    ).not.toThrow();

    await new Promise((r) => setImmediate(r));

    // cron.add WAS attempted (the failure path); we just don't crash.
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
  });

  it("strips marshal cron headers/suffixes from substituted {{previousOutput}}", async () => {
    // Production assistant messages from cron-fired runs carry marshal
    // plumbing in the text: a leading [cron:<jobId> <jobName>] header and a
    // trailing "Current time: ..." suffix. fetchPreviousOutput must route the
    // raw chat.history payload through normalizeHistoryMessages so the cron
    // metadata never leaks into substituted {{previousOutput}}.
    const parent = makeParentCron(2);
    const runAtMs = Date.now() - 500;
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    "[cron:abc daily-summary] step 1 output\n\n" +
                    "Current time: 2026-04-29T10:00:00Z",
                },
              ],
              timestamp: new Date(runAtMs + 100).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-1", ...params };
      return null;
    });

    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 200,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });

    await new Promise((r) => setImmediate(r));

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    const payload = addCall![1];
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- payload.payload typed as unknown; narrowing for test inspection
    const inner = payload.payload as Record<string, unknown>;
    // {{previousOutput}} must contain ONLY the cleaned assistant text — no
    // [cron:...] header, no "Current time:" suffix.
    expect(inner.message).toBe("Use step 1 output");
    expect(inner.message).not.toContain("[cron:");
    expect(inner.message).not.toContain("Current time:");
  });

  it("does NOT abandon chain at exactly the TTL boundary (uses >, not >=)", async () => {
    // isStale is `Date.now() - finishedAtMs > CATCH_UP_TTL_MS` — at exactly
    // the boundary, the chain MUST advance. Pin time with fake timers so we
    // can construct the equality precisely.
    vi.useFakeTimers();
    try {
      const NOW = 1_700_000_000_000;
      vi.setSystemTime(NOW);
      const CATCH_UP_TTL_MS = 60 * 60 * 1000;
      const parent = makeParentCron(2);
      // finishedAtMs = runAtMs + durationMs = exactly NOW - CATCH_UP_TTL_MS
      const runAtMs = NOW - CATCH_UP_TTL_MS;
      const durationMs = 0;
      client.request.mockImplementation(async (method, params) => {
        if (method === "cron.list") return { jobs: [] };
        if (method === "chat.history") {
          return {
            messages: [
              {
                id: "m2",
                role: "assistant",
                content: [{ type: "text", text: "step 1 output" }],
                timestamp: new Date(runAtMs).toISOString(),
              },
            ],
          };
        }
        if (method === "cron.add") return { id: "tail-1", ...params };
        return null;
      });

      client.emit("cron", {
        jobId: "parent-1",
        action: "finished",
        status: "ok",
        runAtMs,
        durationMs,
        sessionKey: "session:auto-parent-1",
        job: parent,
      });

      await vi.advanceTimersByTimeAsync(0);

      const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
      expect(addCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats content with all-empty text blocks as empty output (failure short-circuit)", async () => {
    // Production assistant content is always Array<{type:"text", text:"..."}>.
    // If every block's text is empty/whitespace, normalizeHistoryMessages
    // drops the message entirely (clean text empty → skipped). The orchestrator
    // sees no assistant message in the window → fetchPreviousOutput returns
    // null → scheduleNextStep aborts before cron.add.
    const parent = makeParentCron(3);
    client.request.mockImplementation(async (method) => {
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [
                { type: "text", text: "" },
                { type: "text", text: "  " },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });
    client.emit("cron", {
      jobId: "parent-1",
      action: "finished",
      status: "ok",
      runAtMs: Date.now() - 100,
      durationMs: 50,
      sessionKey: "session:auto-parent-1",
      job: parent,
    });
    await new Promise((r) => setImmediate(r));
    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });
});

describe("GatewayAutomationOrchestrator reconcile", () => {
  let orch: GatewayAutomationOrchestrator;
  let client: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    orch = new GatewayAutomationOrchestrator();
    client = makeFakeClient();
    orch.attachClient(client as OrchestratorRpcClient);
  });

  it("scans for parents missing their next tail step and schedules within TTL", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 30 * 60 * 1000;
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent] };
      if (method === "cron.runs" && params.id === "parent-1") {
        return {
          entries: [{ runAtMs, ts: runAtMs, durationMs: 1000, status: "ok" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-1", ...params };
      return null;
    });

    await orch.reconcile();

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded
    const payload = addCall![1];
    expect(payload.name).toBe(`auto-parent-1-r${runAtMs}-s1`);
  });

  it("advances to next step when prior step is complete on reconcile", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 30 * 60 * 1000;
    const existingTail = {
      id: "tail-1",
      name: `auto-parent-1-r${runAtMs}-s1`,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent, existingTail] };
      if (method === "cron.runs" && params.id === "parent-1") {
        return {
          entries: [{ runAtMs, ts: runAtMs, durationMs: 1000, status: "ok" }],
        };
      }
      if (method === "cron.runs" && params.id === "tail-1") {
        return {
          entries: [{ runAtMs: runAtMs + 2000, ts: runAtMs + 2000, durationMs: 500, status: "ok" }],
        };
      }
      if (method === "chat.history") {
        // Assistant message timestamp is strictly INSIDE the tail run window
        // [tailRunAtMs, tailRunAtMs + tailDurationMs] = [runAtMs+2000, runAtMs+2500].
        // Picking the boundary (runAtMs + 2500 = finishedAtMs) would mask the
        // bug where reconcile synthesized evt with (runAtMs: finishedAtMs,
        // durationMs: 0) — that synthesis pushes the search window forward
        // and misses messages with ts < finishedAtMs. Use the midpoint so the
        // primary [runAtMs, runAtMs+durationMs+slack] window fails when the
        // synthesis is wrong.
        return {
          messages: [
            {
              id: "m4",
              role: "assistant",
              content: [{ type: "text", text: "step 2 output" }],
              timestamp: new Date(runAtMs + 2300).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-2", ...params };
      return null;
    });

    await orch.reconcile();

    const addCalls = client.request.mock.calls.filter(([m]) => m === "cron.add");
    // s1 is already present and must not be re-added.
    const dupAdd = addCalls.find(([, p]) => p.name === `auto-parent-1-r${runAtMs}-s1`);
    expect(dupAdd).toBeUndefined();
    // Chain must actually resume: s2 is the next step and should be added,
    // since tail-1's run-log shows it completed within the TTL.
    const s2Add = addCalls.find(([, p]) => p.name === `auto-parent-1-r${runAtMs}-s2`);
    expect(s2Add).toBeDefined();
  });

  it("does NOT schedule when stale (TTL elapsed)", async () => {
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent] };
      if (method === "cron.runs" && params.id === "parent-1") {
        return {
          entries: [{ runAtMs, ts: runAtMs, durationMs: 1000, status: "ok" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: [{ type: "text", text: "step 1 output" }],
              timestamp: new Date(runAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "x" };
      return null;
    });

    await orch.reconcile();

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });

  it("ignores single-step parents (no sentinel)", async () => {
    const plainJob = {
      id: "single-1",
      name: "single",
      description: "no sentinel here",
      payload: { kind: "agentTurn", message: "do it" },
    };
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [plainJob] };
      return null;
    });

    await orch.reconcile();

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
    const runsCall = client.request.mock.calls.find(([m]) => m === "cron.runs");
    expect(runsCall).toBeUndefined();
  });

  it("uses tail-cron run-log timing for TTL on later steps", async () => {
    // Parent run is 90 minutes ago (would be stale for parent-only TTL),
    // but tail s1 finished 10 minutes ago (within TTL). Reconcile should
    // schedule s2 because the latest step's finishedAt is recent.
    const parent = makeParentCron(3);
    const parentRunAtMs = Date.now() - 90 * 60 * 1000;
    const tailRunAtMs = Date.now() - 10 * 60 * 1000;
    const existingTail = {
      id: "tail-s1",
      name: `auto-parent-1-r${parentRunAtMs}-s1`,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent, existingTail] };
      if (method === "cron.runs" && params.id === "parent-1") {
        return {
          entries: [{ runAtMs: parentRunAtMs, ts: parentRunAtMs, durationMs: 1000, status: "ok" }],
        };
      }
      if (method === "cron.runs" && params.id === "tail-s1") {
        return {
          entries: [{ runAtMs: tailRunAtMs, ts: tailRunAtMs, durationMs: 500, status: "ok" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "m4",
              role: "assistant",
              content: [{ type: "text", text: "step 2 output" }],
              timestamp: new Date(tailRunAtMs + 500).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "tail-s2", ...params };
      return null;
    });

    await orch.reconcile();

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeDefined();
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded
    const payload = addCall![1];
    expect(payload.name).toBe(`auto-parent-1-r${parentRunAtMs}-s2`);
  });

  it("does NOT re-schedule completed tails on second-device reconcile (multi-device safety)", async () => {
    // Scenario: desktop A finished a 3-step chain. All tails ran OK and are
    // now disabled stubs (deleteAfterRun: false → enabled: false post-run).
    // Desktop B reconnects within the 1h TTL. Reconcile must NOT re-add s1
    // or s2: both already exist in cron.list and the chain is complete.
    const parent = makeParentCron(3);
    const runAtMs = Date.now() - 10 * 60 * 1000; // 10 min ago — within TTL
    const completedTailS1 = {
      id: "tail-s1-id",
      name: `auto-parent-1-r${runAtMs}-s1`,
      enabled: false, // disabled post-run
      description: `[step 2/3 of '${parent.name}']`,
      payload: { kind: "agentTurn", message: "step 2 prompt" },
    };
    const completedTailS2 = {
      id: "tail-s2-id",
      name: `auto-parent-1-r${runAtMs}-s2`,
      enabled: false,
      description: `[step 3/3 of '${parent.name}']`,
      payload: { kind: "agentTurn", message: "step 3 prompt" },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") {
        return { jobs: [parent, completedTailS1, completedTailS2] };
      }
      if (method === "cron.runs" && params.id === "parent-1") {
        return {
          entries: [{ runAtMs, ts: runAtMs, durationMs: 100, status: "ok", summary: "step 1 ok" }],
        };
      }
      if (method === "cron.runs" && params.id === "tail-s1-id") {
        return {
          entries: [
            {
              runAtMs: runAtMs + 1000,
              ts: runAtMs + 1000,
              durationMs: 100,
              status: "ok",
              summary: "step 2 ok",
            },
          ],
        };
      }
      if (method === "cron.runs" && params.id === "tail-s2-id") {
        return {
          entries: [
            {
              runAtMs: runAtMs + 2000,
              ts: runAtMs + 2000,
              durationMs: 100,
              status: "ok",
              summary: "step 3 ok",
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "should-not-add", ...params };
      return null;
    });

    await orch.reconcile();

    // No new cron.add calls — chain is already complete on the server.
    const addCalls = client.request.mock.calls.filter(([m]) => m === "cron.add");
    expect(addCalls).toHaveLength(0);
  });

  it("GCs stale tail crons during reconcile", async () => {
    // Tails are scheduled with deleteAfterRun: false (intentional — multi-
    // device catch-up safety, see scheduleNextStep). Without a sweep they
    // accumulate forever. The sweep runs on reconcile init: list tails whose
    // run-log shows status=ok AND finishedAt > catch-up TTL ago, AND whose
    // runInstanceId has no still-active sibling (run unfired or within TTL).
    //
    // Layout: parent + 3 stale completed tails (runInstance "old", finished
    // 2h ago) + 1 active tail (runInstance "new", finished 10min ago, within
    // TTL). After reconcile, only the 3 stale tails should be removed.
    const parent = makeParentCron(3);
    const oldRunAtMs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const newRunAtMs = Date.now() - 10 * 60 * 1000; // 10min ago — active
    const staleS1 = {
      id: "stale-s1",
      name: `auto-parent-1-r${oldRunAtMs}-s1`,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    const staleS2 = {
      id: "stale-s2",
      name: `auto-parent-1-r${oldRunAtMs}-s2`,
      description: "[step 3/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    // Third stale tail in the same old runInstance to assert all three get
    // GC'd, not just the one we happen to find first.
    const staleS3Other = {
      id: "stale-other-s1",
      name: `auto-other-parent-r${oldRunAtMs}-s1`,
      description: "[step 2/2]",
      payload: { kind: "agentTurn", message: "..." },
    };
    const activeS1 = {
      id: "active-s1",
      name: `auto-parent-1-r${newRunAtMs}-s1`,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") {
        return { jobs: [parent, staleS1, staleS2, staleS3Other, activeS1] };
      }
      if (method === "cron.runs") {
        const id = params.id;
        if (id === "parent-1") {
          // Parent has runs for both old and new chains; the chain advance pass
          // shouldn't re-schedule old (stale) but might examine new — we mock
          // both so the chain advance terminates cleanly without forging tails.
          return {
            entries: [
              { runAtMs: oldRunAtMs, ts: oldRunAtMs, durationMs: 100, status: "ok" },
              { runAtMs: newRunAtMs, ts: newRunAtMs, durationMs: 100, status: "ok" },
            ],
          };
        }
        if (id === "stale-s1") {
          return {
            entries: [
              {
                runAtMs: oldRunAtMs + 1000,
                ts: oldRunAtMs + 1000,
                durationMs: 100,
                status: "ok",
              },
            ],
          };
        }
        if (id === "stale-s2") {
          return {
            entries: [
              {
                runAtMs: oldRunAtMs + 2000,
                ts: oldRunAtMs + 2000,
                durationMs: 100,
                status: "ok",
              },
            ],
          };
        }
        if (id === "stale-other-s1") {
          return {
            entries: [
              {
                runAtMs: oldRunAtMs + 1000,
                ts: oldRunAtMs + 1000,
                durationMs: 100,
                status: "ok",
              },
            ],
          };
        }
        if (id === "active-s1") {
          return {
            entries: [
              {
                runAtMs: newRunAtMs + 1000,
                ts: newRunAtMs + 1000,
                durationMs: 100,
                status: "ok",
              },
            ],
          };
        }
        return { entries: [] };
      }
      if (method === "chat.history") {
        // Minimal stub; chain-advance for the active runInstance would consult
        // this when scheduling step 3 — return an in-window assistant message
        // so it succeeds and the test's assertion isolates only the GC sweep
        // rather than getting tangled with "did chain advance fire?".
        return {
          messages: [
            {
              id: "m",
              role: "assistant",
              content: [{ type: "text", text: "step 2 output" }],
              timestamp: new Date(newRunAtMs + 1000).toISOString(),
            },
          ],
        };
      }
      if (method === "cron.add") return { id: "newly-scheduled", ...params };
      if (method === "cron.remove") return { removed: true };
      return null;
    });

    await orch.reconcile();

    const removeCalls = client.request.mock.calls.filter(([m]) => m === "cron.remove");
    const removedIds = removeCalls
      .map(([, p]) => (typeof p.id === "string" ? p.id : ""))
      .filter(Boolean)
      .sort();
    // Exactly the 3 stale tails are removed; the active tail is kept.
    expect(removedIds).toEqual(["stale-other-s1", "stale-s1", "stale-s2"]);
  });

  it("does NOT GC errored tail crons (status !== 'ok' kept for inspection)", async () => {
    // A user investigating a failed run needs the tail to stick around as a
    // breadcrumb. The sweep deliberately gates on status === "ok" so errored
    // chains aren't pruned even when past TTL.
    const parent = makeParentCron(3);
    const oldRunAtMs = Date.now() - 2 * 60 * 60 * 1000;
    const erroredTail = {
      id: "errored-s1",
      name: `auto-parent-1-r${oldRunAtMs}-s1`,
      description: "[step 2/3]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method, params) => {
      if (method === "cron.list") return { jobs: [parent, erroredTail] };
      if (method === "cron.runs" && params.id === "errored-s1") {
        return {
          entries: [
            {
              runAtMs: oldRunAtMs + 1000,
              ts: oldRunAtMs + 1000,
              durationMs: 100,
              status: "error",
              error: "ouch",
            },
          ],
        };
      }
      return null;
    });
    await orch.reconcile();
    const removeCalls = client.request.mock.calls.filter(([m]) => m === "cron.remove");
    expect(removeCalls).toHaveLength(0);
  });

  it("terminates cleanly when cron.list returns empty jobs", async () => {
    // Defensive: an empty server (or a server with no automations matching
    // any sentinel) must not trigger any further RPCs and must not throw.
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [] };
      return null;
    });
    await orch.reconcile();
    const addCalls = client.request.mock.calls.filter(([m]) => m === "cron.add");
    expect(addCalls).toHaveLength(0);
    const runsCalls = client.request.mock.calls.filter(([m]) => m === "cron.runs");
    expect(runsCalls).toHaveLength(0);
  });
});

describe("GatewayAutomationOrchestrator chain advance — final-step guard", () => {
  let orch: GatewayAutomationOrchestrator;
  let client: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    orch = new GatewayAutomationOrchestrator();
    client = makeFakeClient();
    orch.attachClient(client as OrchestratorRpcClient);
  });

  it("does not schedule beyond final step", async () => {
    const parent = makeParentCron(2); // 2 steps total = step 0 (parent) + step 1 (tail)
    const runAtMs = Date.now() - 200;
    const finalTail = {
      id: "tail-final",
      name: `auto-parent-1-r${runAtMs}-s1`,
      description: "[step 2/2]",
      payload: { kind: "agentTurn", message: "..." },
    };
    client.request.mockImplementation(async (method) => {
      if (method === "cron.list") return { jobs: [parent, finalTail] };
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "x",
              role: "assistant",
              content: [{ type: "text", text: "final out" }],
              timestamp: new Date(runAtMs + 1).toISOString(),
            },
          ],
        };
      }
      return null;
    });

    client.emit("cron", {
      jobId: "tail-final",
      action: "finished",
      status: "ok",
      runAtMs,
      durationMs: 1,
      sessionKey: "session:auto-parent-1",
      job: finalTail,
    });

    await new Promise((r) => setImmediate(r));

    const addCall = client.request.mock.calls.find(([m]) => m === "cron.add");
    expect(addCall).toBeUndefined();
  });
});
