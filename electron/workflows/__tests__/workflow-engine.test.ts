// electron/workflows/__tests__/test-workflow.test.ts
//
// End-to-end happy-path test for the workflow engine. Uses a real fs
// tmpdir; mocks electron's safeStorage as unavailable so per-line
// encryption falls back to base64 plaintext (the documented degraded
// mode). The SpawnAdapter is stubbed because we are testing the engine,
// not SessionManager.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { requireSchedule } from "../../automations/schedule";
import { setWorkflowDiagnosticSinkForTests, type WorkflowDiagnosticEntry } from "../diagnostics";
import { readEventLines } from "../event-log";
import { writeInstalledSource } from "../installed-source-store";
import type { ResolvedSpawnOpts, SpawnAdapter, SpawnedHandle } from "../spawn-adapter";
import { WorkflowRunManager, type WorkflowRunManagerDeps } from "../workflow-run-manager";
import type { WorkflowScheduleRecord } from "../workflow-scheduler";

let tmpRoot: string;
let userRoot: string;
let runsRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wfengine-"));
  userRoot = path.join(tmpRoot, "marshal-workflows");
  runsRoot = path.join(tmpRoot, "marshal-workflow-runs");
  fs.mkdirSync(userRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  setWorkflowDiagnosticSinkForTests(undefined);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function installTestWorkflow(
  workflowJs: string,
  permissionsMode: "ask" | "allow-all" = "ask",
): void {
  const dir = path.join(userRoot, "test-workflow");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "test-workflow",
      version: "1.0.0",
      title: "Test Workflow",
      permissions: { mode: permissionsMode },
    }),
  );
  fs.writeFileSync(path.join(dir, "dist", "workflow.js"), workflowJs);
  writeInstalledSource(dir, {
    source: "user-local",
    installedAt: Date.now(),
    distHash: "test-hash",
    version: "1.0.0",
  });
}

function stubSpawnAdapter(replies: Record<string, string> = {}): SpawnAdapter {
  let n = 0;
  return {
    async spawn() {
      n++;
      const h: SpawnedHandle = { handleId: `h-${n}`, sessionId: `sess-${n}` };
      return h;
    },
    async spawnAndRun() {
      n++;
      return { handleId: `h-${n}`, sessionId: `sess-${n}` };
    },
    async send() {
      /* no-op */
    },
    async waitForReply(handle) {
      return replies[handle.sessionId] ?? "ok";
    },
    async sendAndCollect(handle) {
      // Test stub: behave like waitForReply (ignore the message; return canned reply).
      return replies[handle.sessionId] ?? "ok";
    },
    async cancel() {
      /* no-op */
    },
  };
}

function makeManager(
  spawnAdapter: SpawnAdapter = stubSpawnAdapter(),
  overrides: Partial<WorkflowRunManagerDeps> = {},
): WorkflowRunManager {
  return new WorkflowRunManager({
    spawnAdapter,
    hostSessionFactory: async ({ runId }) => `host-${runId}`,
    repoOverrides: { rootDir: runsRoot },
    loaderOverrides: { userRoot },
    backendOrigin: () => "copilot",
    ...overrides,
  });
}

// Helper that produces a CJS workflow module string by reading the
// authoring SDK as an external require — the loader's default resolution
// (`createRequire(runDestPath)`) cannot resolve `@marshal/workflow-sdk`
// because the run dir is a tmpdir. We side-step this by providing the
// definition as a literal object (skipping `defineWorkflow`'s call); the
// engine only needs `{ id, run }`-shaped defaults.
function workflowModule(spec: { id: string; runBody: string }): string {
  return `
module.exports = { default: {
  id: ${JSON.stringify(spec.id)},
  displayName: ${JSON.stringify(spec.id)},
  schemaVersion: 1,
  notifyOnComplete: "none",
  run: async function (ctx) {
    ${spec.runBody}
  }
}};
`;
}

describe("WorkflowEngine — test workflow", () => {
  it("runs a single-step workflow end-to-end", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const greeting = await ctx.step("greet", async () => "hello, " + (ctx.input.name || "world"));
          await ctx.saveArtifact("summary.md", "# " + greeting);
          return { greeting };
        `,
      }),
    );

    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({
      workflowId: "test-workflow",
      input: { name: "engine" },
    });
    const record = await mgr._waitForRunTermination(runId, 10_000);
    expect(record.status).toBe("succeeded");

    const snapshot = await mgr.getRun({ runId });
    expect(snapshot?.status).toBe("succeeded");
    expect(snapshot?.steps).toHaveLength(1);
    expect(snapshot?.steps[0].label).toBe("greet");
    expect(snapshot?.steps[0].result).toBe("hello, engine");
    expect(snapshot?.artifacts.find((a) => a.key === "summary.md")).toBeDefined();

    // workflow.compiled.js was pinned into the run dir
    const compiled = path.join(runsRoot, runId, "workflow.compiled.js");
    expect(fs.existsSync(compiled)).toBe(true);

    // event log contains run.started and run.completed
    const eventsPath = path.join(runsRoot, runId, "events.ndjson");
    const events = Array.from(readEventLines(eventsPath));
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("step.completed");
    expect(types).toContain("artifact.saved");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("fails the run with run.failed when the workflow body throws", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `throw new Error("nope");`,
      }),
    );
    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("failed");
    expect(record.errorSummary?.message).toContain("nope");
  });

  it("rejects when backend is not copilot", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "gateway",
    });
    await expect(mgr.runWorkflow({ workflowId: "test-workflow" })).rejects.toThrow(/gateway/i);
  });

  it("passes manifest allow-all permission mode to the workflow host session", async () => {
    installTestWorkflow(
      workflowModule({ id: "test-workflow", runBody: "return {};" }),
      "allow-all",
    );
    const hostSessionFactory = vi.fn<WorkflowRunManagerDeps["hostSessionFactory"]>(
      async ({ runId }) => `host-${runId}`,
    );
    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });

    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    await mgr._waitForRunTermination(runId, 5_000);

    expect(hostSessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "allow-all" }),
    );
  });

  it("passes explicit allow-all permission mode to the workflow host session", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const hostSessionFactory = vi.fn<WorkflowRunManagerDeps["hostSessionFactory"]>(
      async ({ runId }) => `host-${runId}`,
    );
    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });

    const { runId } = await mgr.runWorkflow({
      workflowId: "test-workflow",
      permissionMode: "allow-all",
    });
    await mgr._waitForRunTermination(runId, 5_000);

    expect(hostSessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "allow-all" }),
    );
  });

  it("preserves runFamilyId on retry-from-step", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          await ctx.step("greet", async () => "hi");
          return {};
        `,
      }),
    );
    const mgr = makeManager();
    const first = await mgr.runWorkflow({ workflowId: "test-workflow" });
    await mgr._waitForRunTermination(first.runId, 5_000);

    // Retry from the first step
    const retry = await mgr.retryFromStep({ runId: first.runId, stepId: "/0:greet" });
    expect(retry.runFamilyId).toBe(first.runFamilyId);
    expect(retry.newRunId).not.toBe(first.runId);
    await mgr._waitForRunTermination(retry.newRunId, 5_000);
  });

  it("persists ctx.store values across workflow runs", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const previous = (await ctx.store.get("counter")) || 0;
          await ctx.store.put("counter", previous + 1);
          return { previous, next: previous + 1 };
        `,
      }),
    );

    const mgr = makeManager();
    const first = await mgr.runWorkflow({ workflowId: "test-workflow" });
    await mgr._waitForRunTermination(first.runId, 5_000);
    const second = await mgr.runWorkflow({ workflowId: "test-workflow" });
    await mgr._waitForRunTermination(second.runId, 5_000);

    const firstSnapshot = await mgr.getRun({ runId: first.runId });
    const secondSnapshot = await mgr.getRun({ runId: second.runId });
    expect(firstSnapshot?.result).toEqual({ previous: 0, next: 1 });
    expect(secondSnapshot?.result).toEqual({ previous: 1, next: 2 });
  });

  it("surfaces durable state and artifacts through control-plane helpers", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          await ctx.store.put("shards/2026-06/oncall", { primary: "Ada" });
          await ctx.saveArtifact("oncall-summary.json", JSON.stringify({ primary: "Ada" }), {
            mime: "application/json",
          });
          return { ok: true };
        `,
      }),
    );

    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    await mgr._waitForRunTermination(runId, 5_000);

    expect(mgr.listState({ workflowId: "test-workflow", prefix: "shards/" })).toEqual([
      expect.objectContaining({
        workflowId: "test-workflow",
        key: "shards/2026-06/oncall",
        runId,
      }),
    ]);
    expect(
      mgr.readState({
        workflowId: "test-workflow",
        key: "shards/2026-06/oncall",
      }),
    ).toEqual(
      expect.objectContaining({
        workflowId: "test-workflow",
        key: "shards/2026-06/oncall",
        value: { primary: "Ada" },
      }),
    );
    expect(mgr.listArtifacts({ workflowId: "test-workflow", prefix: "oncall-" })).toEqual([
      expect.objectContaining({
        runId,
        workflowId: "test-workflow",
        key: "oncall-summary.json",
        mime: "application/json",
      }),
    ]);
  });

  it("clears operational workflow state while preserving config by default", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const mgr = makeManager();
    await mgr.putWorkflowConfigValue({
      workflowId: "test-workflow",
      key: "routing/defaults",
      value: { destination: "email" },
    });
    await mgr._putStateForTests("test-workflow", "command-center-state", { tab: "overview" });
    await mgr._putStateForTests("test-workflow", "incident-incident-investigation/latest", {
      id: "1",
    });
    await mgr._putStateForTests("test-workflow", "system/action-center/action-1", { id: "a1" });
    await mgr._putStateForTests("test-workflow", "system/notification-outbox/old-1", { id: "n1" });

    const result = await mgr.clearWorkflowState({ workflowId: "test-workflow" });
    const second = await mgr.clearWorkflowState({ workflowId: "test-workflow" });

    expect(result).toMatchObject({
      workflowId: "test-workflow",
      scanned: 5,
      deleted: 4,
      errors: [],
    });
    expect(new Set(result.deletedKeys)).toEqual(
      new Set([
        "command-center-state",
        "incident-incident-investigation/latest",
        "system/action-center/action-1",
        "system/notification-outbox/old-1",
      ]),
    );
    expect(second).toMatchObject({ scanned: 1, deleted: 0, errors: [] });
    expect(
      mgr.getWorkflowStateValue({ workflowId: "test-workflow", key: "config/routing/defaults" }),
    ).toEqual({
      key: "config/routing/defaults",
      found: true,
      value: { destination: "email" },
    });
  });

  it("rejects config clear selectors unless explicitly requested", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const mgr = makeManager();

    await expect(
      mgr.clearWorkflowState({ workflowId: "test-workflow", prefixes: ["config/"] }),
    ).rejects.toThrow(/includeConfig/);
  });

  it("persists, deduplicates, retries, and reconciles action-center sessions", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const launches: Array<{ title: string; prompt: string }> = [];
    const cancelled: string[] = [];
    const sessionStates = new Map<string, "busy" | "idle" | "missing">();
    const mgr = makeManager(stubSpawnAdapter(), {
      launchActionSession: async ({ title, prompt }) => {
        launches.push({ title, prompt });
        const sessionId = `action-${String(launches.length)}`;
        sessionStates.set(sessionId, "busy");
        return { sessionId, title };
      },
      getActionSessionState: (sessionId) => sessionStates.get(sessionId) ?? "missing",
      cancelActionSession: async (sessionId) => {
        cancelled.push(sessionId);
        sessionStates.set(sessionId, "idle");
      },
    });
    const request = {
      workflowId: "test-workflow",
      itemId: "investigate-1",
      title: "Investigate incident",
      prompt: "Inspect the failure",
    };

    const started = await mgr.dispatchWorkflowAction(request);
    const duplicate = await mgr.dispatchWorkflowAction(request);
    const retried = await mgr.dispatchWorkflowAction({ ...request, retry: true });
    sessionStates.set("action-2", "idle");
    const completed = await mgr.getWorkflowActionItem({
      workflowId: "test-workflow",
      itemId: request.itemId,
    });

    expect(started).toMatchObject({
      status: "started",
      item: { dispatch: { status: "active", linkedSessionId: "action-1", attempt: 1 } },
    });
    expect(duplicate).toMatchObject({ status: "already-active" });
    expect(retried).toMatchObject({
      status: "started",
      item: { dispatch: { linkedSessionId: "action-2", attempt: 2 } },
    });
    expect(cancelled).toEqual(["action-1"]);
    expect(launches).toHaveLength(2);
    expect(completed).toMatchObject({ dispatch: { status: "completed", attempt: 2 } });
  });

  it("records notification approval before dispatching its worker", async () => {
    installTestWorkflow(workflowModule({ id: "test-workflow", runBody: "return {};" }));
    const mgr = makeManager(stubSpawnAdapter(), {
      launchActionSession: async ({ title }) => ({ sessionId: "notification-worker", title }),
    });

    const result = await mgr.approveWorkflowNotification({
      workflowId: "test-workflow",
      approvedBy: "operator@example.com",
      item: {
        id: "notification-1",
        title: "Notify owner",
        destination: "email",
        target: "owner@example.com",
        preparedBy: "steward",
        detailLevel: "summary",
        content: { summary: "Incident summary", body: "Send the incident summary." },
        approval: { status: "pending" },
      },
    });

    expect(result).toMatchObject({
      status: "started",
      item: {
        id: "notification:notification-1",
        itemApproval: { status: "approved", decidedBy: "operator@example.com" },
      },
    });
  });

  it("exposes schedule occurrence metadata to scheduled workflow runs", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          return ctx.schedule;
        `,
      }),
    );

    const mgr = makeManager();
    const occurrenceAt = new Date(2026, 5, 9, 9, 0).getTime();
    const checkedAt = new Date(2026, 5, 9, 9, 1).getTime();
    const record: WorkflowScheduleRecord = {
      schemaVersion: 1,
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
      schedule: requireSchedule("every day at 9am"),
      enabled: true,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    };

    const { runId } = await mgr._runScheduledWorkflowForTests(record, { occurrenceAt, checkedAt });
    await mgr._waitForRunTermination(runId, 5_000);
    const snapshot = await mgr.getRun({ runId });

    expect(snapshot?.schedule).toEqual({
      key: "user-local:test-workflow",
      naturalLanguage: "every day at 9am",
      normalized: "every day at 9am",
      parser: "electron/automations/parseSchedule",
      kind: "single",
      occurrenceAt,
      checkedAt,
      incremental: {
        windowStartAt: occurrenceAt,
        windowEndAt: checkedAt,
      },
    });
    expect(snapshot?.result).toEqual(snapshot?.schedule);
  });

  it("ctx.notifyParent no-ops gracefully when there is no initiating session", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          return await ctx.notifyParent("manual run update");
        `,
      }),
    );

    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    const snapshot = await mgr.getRun({ runId });

    expect(record.status).toBe("succeeded");
    expect(snapshot?.result).toEqual({ delivered: false, status: "unavailable" });
  });

  it("ctx.notifyParent uses the manager notification port", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const parent = await ctx.notifyParent("workflow milestone", {
            waitForResponse: true,
            timeoutMs: 1234,
          });
          return parent;
        `,
      }),
    );
    const parentCalls: Array<{
      sessionId: string;
      message: string;
      waitForResponse?: boolean;
      timeoutMs?: number;
    }> = [];
    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
      sendWorkflowParentMessage: async (args) => {
        parentCalls.push(args);
        return { delivered: true, status: "responded", response: "ack" };
      },
    });

    const { runId } = await mgr.runWorkflow({
      workflowId: "test-workflow",
      initiatorSessionId: "parent-session",
    });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    const snapshot = await mgr.getRun({ runId });

    expect(record.status).toBe("succeeded");
    expect(parentCalls).toEqual([
      {
        sessionId: "parent-session",
        message: expect.stringContaining("workflow milestone"),
        waitForResponse: true,
        timeoutMs: 1234,
      },
    ]);
    expect(snapshot?.result).toEqual({ delivered: true, status: "responded", response: "ack" });
  });

  // Regression: prior `ctx.run` shape was `spawnAndRun(opts, prompt) +
  // waitForReply(...)`. That dispatched the prompt as part of session
  // creation, and the engine only began listening for `turn:idle` AFTER
  // the spawn promise resolved — a subscribe-after-send race. A
  // synchronously-replying subagent (or any subagent whose first turn
  // completed inside the same microtask as the send) had its first
  // reply lost, and the engine then injected a stray empty user turn
  // via the old `waitForReply` → `sendMessageToSubagent({ message: "" })`
  // shim.  The fix is **deferred spawn + sendAndCollect**: subscribe
  // first, then send the prompt atomically.
  it("ctx.run uses deferred-spawn + sendAndCollect (race-safe first-turn capture)", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const reply = await ctx.run(
            { agentName: "echo", displayName: "echo" },
            "say hi",
          );
          await ctx.saveArtifact("reply.txt", String(reply));
          return { reply };
        `,
      }),
    );

    type Call = {
      kind: "spawn" | "spawnAndRun" | "send" | "sendAndCollect" | "waitForReply";
      arg?: string;
    };
    const calls: Call[] = [];
    let n = 0;
    const adapter: SpawnAdapter = {
      async spawn() {
        n++;
        calls.push({ kind: "spawn" });
        return { handleId: `h-${n}`, sessionId: `sess-${n}` };
      },
      async spawnAndRun() {
        n++;
        calls.push({ kind: "spawnAndRun" });
        return { handleId: `h-${n}`, sessionId: `sess-${n}` };
      },
      async send(_h, text) {
        calls.push({ kind: "send", arg: text });
      },
      async sendAndCollect(_h, message) {
        // Synchronous reply: simulates a subagent that completed its turn
        // in the same microtask as the send. The pre-fix shape lost this.
        calls.push({ kind: "sendAndCollect", arg: message });
        return "echo: " + message;
      },
      async waitForReply() {
        calls.push({ kind: "waitForReply" });
        return "should-not-be-used";
      },
      async cancel() {
        /* no-op */
      },
    };

    const mgr = new WorkflowRunManager({
      spawnAdapter: adapter,
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("succeeded");

    // ctx.run must go through deferred spawn + sendAndCollect — NOT
    // spawnAndRun + waitForReply.
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("spawn");
    expect(kinds).toContain("sendAndCollect");
    expect(kinds).not.toContain("spawnAndRun");
    expect(kinds).not.toContain("waitForReply");
    // No stray empty user turn:
    expect(calls.find((c) => c.kind === "send" && c.arg === "")).toBeUndefined();
    expect(calls.find((c) => c.kind === "sendAndCollect" && c.arg === "")).toBeUndefined();

    // The first reply was captured and made it into the artifact store.
    const snapshot = await mgr.getRun({ runId });
    expect(snapshot?.artifacts.find((a) => a.key === "reply.txt")).toBeDefined();
  });

  it("disposes workflow-owned host and ctx.run subagent sessions after success", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const reply = await ctx.run(
            { agentName: "echo", displayName: "echo" },
            "say hi",
          );
          return { reply };
        `,
      }),
    );

    const disposedSubagents: string[] = [];
    const disposedHosts: string[] = [];
    let spawnCount = 0;
    const adapter: SpawnAdapter = {
      async spawn() {
        spawnCount++;
        return { handleId: `h-${spawnCount}`, sessionId: `sess-${spawnCount}` };
      },
      async spawnAndRun() {
        throw new Error("ctx.run should use deferred spawn");
      },
      async send() {
        /* no-op */
      },
      async sendAndCollect() {
        return "ok";
      },
      async waitForReply() {
        return "unused";
      },
      async cancel() {
        /* no-op */
      },
      async dispose(handle) {
        disposedSubagents.push(handle.sessionId);
      },
    };
    const mgr = new WorkflowRunManager({
      spawnAdapter: adapter,
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      hostSessionDisposer: async (sessionId) => {
        disposedHosts.push(sessionId);
      },
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });

    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("succeeded");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(disposedSubagents).toEqual(["sess-1"]);
    expect(disposedHosts).toEqual([`host-${runId}`]);
  });

  it("cleans run broadcast subscriptions and session indexes after terminal runs", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const reply = await ctx.run(
            { agentName: "echo", displayName: "echo" },
            "say hi",
          );
          return { reply };
        `,
      }),
    );

    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const mgr = makeManager();
    mgr.attachBroadcaster((channel, payload) => broadcasts.push({ channel, payload }));

    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("succeeded");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mgr.getRunIdForSession(`host-${runId}`)).toBeUndefined();
    expect(mgr.getRunIdForSession("sess-1")).toBeUndefined();
    expect(mgr.listRuns().find((run) => run.runId === runId)?.hostSessionId).toBe(`host-${runId}`);
    expect(mgr.getRunIdForHostSession(`host-${runId}`)).toBe(runId);
    expect(mgr._getRuntimeDebugState()).toMatchObject({
      runEventSubscriptionCount: 0,
      sessionRunIndexSize: 0,
    });
    expect(broadcasts.some((item) => item.channel === `workflows:run-status:${runId}`)).toBe(true);
  });

  it("writes workflow diagnostics around ctx.run subagent execution", async () => {
    const diagnostics: WorkflowDiagnosticEntry[] = [];
    setWorkflowDiagnosticSinkForTests((entry) => diagnostics.push(entry));
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          await ctx.run(
            { agentName: "echo", displayName: "echo" },
            "say hi",
          );
          return { ok: true };
        `,
      }),
    );

    const adapter: SpawnAdapter = {
      async spawn() {
        return { handleId: "h-1", sessionId: "sess-1" };
      },
      async spawnAndRun() {
        throw new Error("ctx.run should use deferred spawn");
      },
      async send() {
        /* no-op */
      },
      async sendAndCollect() {
        return "ok";
      },
      async waitForReply() {
        return "unused";
      },
      async cancel() {
        /* no-op */
      },
    };
    const mgr = makeManager(adapter);

    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(record.status).toBe("succeeded");
    expect(diagnostics.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining([
        "manager.create-run.start",
        "workflow.active.begin",
        "engine.run.start",
        "agent.run.start",
        "agent.spawn.requested",
        "agent.send-and-collect.start",
        "agent.send-and-collect.succeeded",
        "workflow.active.end",
      ]),
    );
    expect(
      diagnostics.find((entry) => entry.operation === "agent.spawn.adapter-succeeded")?.details,
    ).toMatchObject({ sessionId: "sess-1" });
    expect(JSON.stringify(diagnostics)).not.toContain("say hi");
  });

  it("disposes leftover ctx.spawn handles when a workflow fails", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          await ctx.spawn({ agentName: "worker", displayName: "worker" });
          throw new Error("boom");
        `,
      }),
    );

    const cancelled: string[] = [];
    const disposed: string[] = [];
    const adapter: SpawnAdapter = {
      async spawn() {
        return { handleId: "h-1", sessionId: "sess-1" };
      },
      async spawnAndRun() {
        throw new Error("not used");
      },
      async send() {
        /* no-op */
      },
      async sendAndCollect() {
        return "unused";
      },
      async waitForReply() {
        return "unused";
      },
      async cancel(handle) {
        cancelled.push(handle.sessionId);
      },
      async dispose(handle) {
        disposed.push(handle.sessionId);
      },
    };
    const mgr = makeManager(adapter);

    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("failed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toEqual(["sess-1"]);
    expect(disposed).toEqual(["sess-1"]);
  });

  // Regression: workflow-spawned subagents may use messageParent for
  // final handoff. If no assistant reply is captured, ctx.run should use
  // the parent message as its reply and still deregister the listener.
  it("uses messageParent as the ctx.run reply when no assistant reply is captured", async () => {
    installTestWorkflow(
      workflowModule({
        id: "test-workflow",
        runBody: `
          const reply = await ctx.run(
            { agentName: "worker", displayName: "worker" },
            "go",
          );
          await ctx.saveArtifact("reply.json", String(reply));
          return JSON.parse(String(reply));
        `,
      }),
    );

    type Listener = (info: {
      subagentSessionId: string;
      parentSessionId: string;
      message: string;
    }) => void;
    const listeners = new Map<string, Listener>();
    const adapter: SpawnAdapter = {
      async spawn() {
        return { handleId: "h-1", sessionId: "sess-1" };
      },
      async spawnAndRun() {
        return { handleId: "h-1", sessionId: "sess-1" };
      },
      async send() {
        /* no-op */
      },
      async sendAndCollect(handle, _message) {
        // Simulate the subagent sending messageParent during its turn
        // instead of producing an assistant reply.
        const cb = listeners.get(handle.sessionId);
        cb?.({
          subagentSessionId: handle.sessionId,
          parentSessionId: "host",
          message: JSON.stringify({ ok: true, source: "parent-message" }),
        });
        throw new Error("Timed out waiting for the subagent's reply.");
      },
      async waitForReply() {
        return "x";
      },
      async cancel() {
        /* no-op */
      },
      onSubagentParentMessage(subagentSessionId, cb) {
        listeners.set(subagentSessionId, cb);
        return () => {
          listeners.delete(subagentSessionId);
        };
      },
    };

    const mgr = new WorkflowRunManager({
      spawnAdapter: adapter,
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("succeeded");

    const snapshot = await mgr.getRun({ runId });
    expect(snapshot?.artifacts.find((artifact) => artifact.key === "reply.json")).toBeDefined();

    const eventsPath = path.join(runsRoot, runId, "events.ndjson");
    const events = Array.from(readEventLines(eventsPath));
    expect(
      events.some(
        (event) => event.type === "ctx.emit" && event.payload.name === "agent.parent-message",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "agent.message" &&
          event.payload.content === JSON.stringify({ ok: true, source: "parent-message" }),
      ),
    ).toBe(true);

    // After the step ends the listener must have been removed (deregister
    // on step end — scoped per-step, not run-wide).
    expect(listeners.has("sess-1")).toBe(false);
  });
});

describe("WorkflowEngine — model + reasoning defaults", () => {
  function recordingAdapter(): { adapter: SpawnAdapter; spawns: ResolvedSpawnOpts[] } {
    const spawns: ResolvedSpawnOpts[] = [];
    let n = 0;
    const adapter: SpawnAdapter = {
      async spawn(opts) {
        n++;
        spawns.push(opts);
        return { handleId: `h-${n}`, sessionId: `s-${n}` };
      },
      async spawnAndRun(opts) {
        n++;
        spawns.push(opts);
        return { handleId: `h-${n}`, sessionId: `s-${n}` };
      },
      async send() {
        /* no-op */
      },
      async waitForReply(_handle: SpawnedHandle) {
        return "{}";
      },
      async sendAndCollect(_handle: SpawnedHandle) {
        return "{}";
      },
      async cancel() {
        /* no-op */
      },
    };
    return { adapter, spawns };
  }

  it("applies workflow-level model/reasoning defaults and lets a spawn override them", async () => {
    const dir = path.join(userRoot, "test-workflow");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "test-workflow",
        version: "1.0.0",
        title: "Test Workflow",
        permissions: { mode: "ask" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "dist", "workflow.js"),
      `
module.exports = { default: {
  id: "test-workflow",
  displayName: "Test Workflow",
  schemaVersion: 1,
  notifyOnComplete: "none",
  defaultModel: "wf-default-model",
  defaultReasoningEffort: "xhigh",
  run: async function (ctx) {
    await ctx.run({ displayName: "inherits" }, "prompt-a");
    await ctx.run({ displayName: "overrides", model: "step-model", reasoningEffort: "low" }, "prompt-b");
    return {};
  }
}};
`,
    );
    writeInstalledSource(dir, {
      source: "user-local",
      installedAt: Date.now(),
      distHash: "test-hash",
      version: "1.0.0",
    });

    const { adapter, spawns } = recordingAdapter();
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({ workflowId: "test-workflow", input: {} });
    const record = await mgr._waitForRunTermination(runId, 10_000);
    expect(record.status).toBe("succeeded");

    expect(spawns).toHaveLength(2);
    // No per-spawn model/reasoning → inherit the workflow-level defaults.
    expect(spawns[0]?.model).toBe("wf-default-model");
    expect(spawns[0]?.reasoningEffort).toBe("xhigh");
    // Per-spawn override wins over the workflow-level default.
    expect(spawns[1]?.model).toBe("step-model");
    expect(spawns[1]?.reasoningEffort).toBe("low");
  });
});
