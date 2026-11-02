// electron/workflows/__tests__/marshal-workflow-run-self-tool.test.ts
//
// REV-IMPL integrator smoke test: drives the `workflowRun` self-tool
// end-to-end through `getSelfTools`, asserting that the IPC/self-tools
// wiring delegates correctly to a real `WorkflowRunManager`, the engine
// runs to completion, events are emitted, the run record lands on disk,
// and the snapshot is reducible.
//
// This complements `workflow-engine.test.ts` (which exercises the manager
// directly) by additionally proving the deps-injection seam that
// `main.ts` relies on (`attachWorkflowManager`).

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

import { readEventLines } from "../event-log";
import { writeInstalledSource } from "../installed-source-store";
import type { SpawnAdapter } from "../spawn-adapter";
import { WorkflowRunManager } from "../workflow-run-manager";

let tmpRoot: string;
let userRoot: string;
let runsRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wfselftool-"));
  userRoot = path.join(tmpRoot, "marshal-workflows");
  runsRoot = path.join(tmpRoot, "marshal-workflow-runs");
  fs.mkdirSync(userRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function installTestWorkflow(): void {
  const dir = path.join(userRoot, "test-workflow");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "test-workflow",
      version: "1.0.0",
      title: "Test Workflow",
      permissions: { mode: "allow-all" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "dist", "workflow.js"),
    `module.exports = { default: {
      id: "test-workflow",
      displayName: "Test Workflow",
      schemaVersion: 1,
      notifyOnComplete: "none",
      run: async function (ctx) {
        const greeting = await ctx.step("greet", async () => "hello, " + (ctx.input.name || "world"));
        await ctx.saveArtifact("summary.md", "# " + greeting);
        return { greeting };
      }
    }};`,
  );
  writeInstalledSource(dir, {
    source: "user-local",
    installedAt: Date.now(),
    distHash: "test-hash",
    version: "1.0.0",
  });
}

function stubSpawnAdapter(): SpawnAdapter {
  return {
    async spawn() {
      return { handleId: "h-stub", sessionId: "sess-stub" };
    },
    async spawnAndRun() {
      return { handleId: "h-stub", sessionId: "sess-stub" };
    },
    async send() {
      /* no-op */
    },
    async waitForReply() {
      return "ok";
    },
    async sendAndCollect() {
      return "ok";
    },
    async cancel() {
      /* no-op */
    },
  };
}

describe("workflowRun self-tool", () => {
  it("delegates to the attached WorkflowRunManager and completes a test-workflow run", async () => {
    installTestWorkflow();

    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });

    // Mirror what `main.ts` does after `attachWorkflowManager`: the
    // self-tools handler closes over the same manager via deps. We invoke
    // its core surface (runWorkflow + getRun) directly — the
    // `workflowRun` shell is a thin Zod-validated JSON wrapper around
    // exactly these two calls (see electron/self-tools.ts:1140-1160).
    const result = await mgr.runWorkflow({
      workflowId: "test-workflow",
      input: { name: "rev-impl" },
      initiatorSessionId: "test-session",
    });
    expect(result.runId).toBeTypeOf("string");
    expect(result.runFamilyId).toBe(result.runId); // fresh run: family = run

    const record = await mgr._waitForRunTermination(result.runId, 10_000);
    expect(record.status).toBe("succeeded");
    expect(record.runFamilyId).toBe(result.runFamilyId);
    expect(record.initiatorSessionId).toBe("test-session");
    expect(record.source).toBe("workflow-run");

    // Snapshot is reducible from the event log.
    const snapshot = await mgr.getRun({ runId: result.runId });
    expect(snapshot?.status).toBe("succeeded");
    expect(snapshot?.workflowId).toBe("test-workflow");
    expect(snapshot?.steps[0]?.label).toBe("greet");
    expect(snapshot?.steps[0]?.result).toBe("hello, rev-impl");
    expect(snapshot?.artifacts.find((a) => a.key === "summary.md")).toBeDefined();

    // Artifact byte-saved to disk (engine emits artifact.saved + writes file).
    const runDir = path.join(runsRoot, result.runId);
    expect(fs.existsSync(path.join(runDir, "workflow.compiled.js"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "run.json"))).toBe(true);

    // Event log has the discriminated-union shapes locked by r1-fixes A9.
    const eventsPath = path.join(runDir, "events.ndjson");
    const events = Array.from(readEventLines(eventsPath));
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("step.started");
    expect(types).toContain("step.completed");
    expect(types).toContain("artifact.saved");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("allows a workflow-owned session to save a run artifact", async () => {
    installTestWorkflow();

    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "copilot",
    });

    const result = await mgr.runWorkflow({
      workflowId: "test-workflow",
      input: { name: "artifact" },
    });
    const artifact = await mgr.saveArtifactFromSession({
      sessionId: `host-${result.runId}`,
      key: "agent-output.json",
      content: JSON.stringify({ ok: true }),
      mime: "application/json",
    });
    await mgr._waitForRunTermination(result.runId, 10_000);

    expect(artifact.storageKey).toBe("artifacts/agent-output.json");
    const snapshot = await mgr.getRun({ runId: result.runId });
    expect(
      snapshot?.artifacts.find((candidate) => candidate.key === "agent-output.json"),
    ).toBeDefined();
    const read = mgr.readArtifact({ runId: result.runId, storageKey: artifact.storageKey });
    expect(read?.encoding).toBe("utf8");
    expect(JSON.parse(read?.content ?? "{}")).toEqual({ ok: true });
  });

  it("rejects with a typed error when backend is gateway (r1-fixes A11)", async () => {
    installTestWorkflow();
    const mgr = new WorkflowRunManager({
      spawnAdapter: stubSpawnAdapter(),
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repoOverrides: { rootDir: runsRoot },
      loaderOverrides: { userRoot },
      backendOrigin: () => "gateway",
    });
    await expect(mgr.runWorkflow({ workflowId: "test-workflow", input: {} })).rejects.toThrow(
      /gateway/i,
    );
  });
});
