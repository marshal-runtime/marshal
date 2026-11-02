import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import { readEventLines } from "../event-log";
import { resolveSlot } from "../slot-resolver";
import type { ResolvedSpawnOpts, SpawnAdapter, SpawnedHandle } from "../spawn-adapter";
import { WorkflowLoader } from "../workflow-loader";
import { WorkflowRunManager } from "../workflow-run-manager";

let tmpRoot: string;
let repoRoot: string;
let runsRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-repo-local-"));
  repoRoot = path.join(tmpRoot, "repo");
  runsRoot = path.join(tmpRoot, "marshal-workflow-runs");
  fs.mkdirSync(path.join(repoRoot, ".github", "marshal-workflows", "repo-demo", "dist"), {
    recursive: true,
  });
  fs.mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRepoWorkflow(runBody: string): void {
  const dir = path.join(repoRoot, ".github", "marshal-workflows", "repo-demo");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "repo-demo",
      version: "1.0.0",
      title: "Repo Demo",
      permissions: { mode: "ask" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "dist", "workflow.js"),
    `
module.exports = { default: {
  id: "repo-demo",
  displayName: "Repo Demo",
  schemaVersion: 1,
  notifyOnComplete: "none",
  run: async function (ctx) {
    ${runBody}
  },
}};
`,
  );
  fs.writeFileSync(path.join(dir, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
}

function writeSourceOnlyRepoWorkflow(args: {
  folderName: string;
  manifestId: string;
  runBody: string;
}): void {
  const dir = path.join(repoRoot, ".github", "marshal-workflows", args.folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: args.manifestId,
      version: "1.0.0",
      title: "Source Only Demo",
      permissions: { mode: "ask" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "workflow.ts"),
    `
export default {
  id: ${JSON.stringify(args.manifestId)},
  displayName: "Source Only Demo",
  schemaVersion: 1,
  notifyOnComplete: "none",
  run: async function (ctx) {
    ${args.runBody}
  },
};
`,
  );
}

function writePowerQueryOnCallWorkflow(): void {
  const dir = path.join(
    repoRoot,
    ".github",
    "marshal-workflows",
    "pq-incident-incident-investigation",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "pq-incident-incident-investigation",
      version: "1.0.0",
      title: "PowerQuery incident Incident Investigation",
      permissions: { mode: "ask" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "bindings.json"),
    JSON.stringify({
      version: 1,
      targetRepoPath: repoRoot,
      externalContextPath: null,
      bindings: {
        "incident-fetcher": { kind: "default-with-role" },
        "incident-investigator": { kind: "default-with-role" },
        collector: { kind: "default-with-role" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "workflow.ts"),
    `
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const RecentIncidents = z.object({
  incidents: z.array(z.object({ id: z.string(), title: z.string() })),
});
const Investigation = z.object({
  id: z.string(),
  classification: z.string(),
  evidence: z.array(z.string()),
});
const CollectorSummary = z.object({ ok: z.boolean() });

export default defineWorkflow({
  id: "pq-incident-incident-investigation",
  displayName: "PowerQuery incident Incident Investigation",
  schemaVersion: 1,
  agentRequirements: [
    { slot: "incident-fetcher", role: "Fetch recent PowerQuery Dataflows incidents from incident." },
    { slot: "incident-investigator", role: "Investigate one incident with incident and query evidence." },
    { slot: "collector", role: "Collect final workflow artifacts." },
  ],
  run: async (ctx) => {
    const input = ctx.input || {};
    const shiftCursorKey = "shift-cursor/dataflows/current";
    const previousCursor = await ctx.store.get(shiftCursorKey);
    const recent = await ctx.step("fetch-recent-incidents", () =>
      ctx.run(
        { slot: "incident-fetcher", displayName: "fetch-recent-incidents", mcp: ["incident-query"] },
        "Fetch recent incidents for PowerQuery Dataflows on-call.",
        { schema: RecentIncidents },
      ),
    );
    await ctx.saveArtifact("recent-incidents.json", JSON.stringify(recent), {
      mime: "application/json",
    });
    const investigations = await ctx.fanOut(
      recent.incidents,
      (incident) =>
        ctx.run(
          {
            slot: "incident-investigator",
            displayName: "investigate-" + incident.id,
            mcp: ["query-mcp", "incident-query"],
          },
          "Investigate incident " + incident.id,
          { schema: Investigation },
        ),
      {
        maxConcurrency: Number(input.maxConcurrency || 1),
        keyFor: (incident) => incident.id,
        onUnitFailure: "abort",
      },
    );
    await ctx.saveArtifact("incident-investigations.json", JSON.stringify(investigations), {
      mime: "application/json",
    });
    const cursor = {
      previousShiftEnd:
        previousCursor && typeof previousCursor === "object" && "latestShiftEnd" in previousCursor
          ? previousCursor.latestShiftEnd
          : null,
      latestShiftEnd: input.shiftEnd || "2026-06-13T00:00:00Z",
      lookbackHours: Number(input.lookbackHours || 24),
    };
    await ctx.store.put(shiftCursorKey, cursor);
    const summary = await ctx.run(
      { slot: "collector", displayName: "collector-summary", mcp: [] },
      "Collect final PowerQuery on-call artifact summary.",
      { schema: CollectorSummary },
    );
    return { incidents: recent.incidents.length, investigations: investigations.length, cursor, summary };
  },
});
`,
  );
}

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

function powerQueryAdapter(): {
  adapter: SpawnAdapter;
  spawns: ResolvedSpawnOpts[];
  prompts: string[];
} {
  const spawns: ResolvedSpawnOpts[] = [];
  const prompts: string[] = [];
  const sessions = new Map<string, ResolvedSpawnOpts>();
  let n = 0;
  const adapter: SpawnAdapter = {
    async spawn(opts) {
      n++;
      spawns.push(opts);
      const handle = { handleId: `pq-h-${n}`, sessionId: `pq-s-${n}` };
      sessions.set(handle.sessionId, opts);
      return handle;
    },
    async spawnAndRun(opts) {
      n++;
      spawns.push(opts);
      const handle = { handleId: `pq-h-${n}`, sessionId: `pq-s-${n}` };
      sessions.set(handle.sessionId, opts);
      return handle;
    },
    async send() {
      /* no-op */
    },
    async waitForReply(handle) {
      return replyForPowerQueryDisplay(sessions.get(handle.sessionId)?.displayName ?? "");
    },
    async sendAndCollect(handle, prompt) {
      prompts.push(prompt);
      return replyForPowerQueryDisplay(sessions.get(handle.sessionId)?.displayName ?? "");
    },
    async cancel() {
      /* no-op */
    },
  };
  return { adapter, spawns, prompts };
}

function replyForPowerQueryDisplay(displayName: string): string {
  if (displayName === "fetch-recent-incidents") {
    return JSON.stringify({
      incidents: [{ id: "incident-1001", title: "Synthetic Dataflows incident" }],
    });
  }
  if (displayName === "investigate-incident-1001") {
    return JSON.stringify({
      id: "incident-1001",
      classification: "real",
      evidence: ["query://synthetic-query"],
    });
  }
  if (displayName === "collector-summary") {
    return JSON.stringify({ ok: true });
  }
  throw new Error(`No PowerQuery fixture reply for ${displayName}`);
}

function makeManager(
  adapter: SpawnAdapter,
  opts: {
    workspaceName?: string;
    workspaceEntries?: ReadonlyArray<{
      name: string;
      path: string;
    }>;
  } = {},
): WorkflowRunManager {
  const workspaceName = opts.workspaceName;
  const workspaceEntries =
    opts.workspaceEntries ??
    (workspaceName ? [{ name: workspaceName, path: repoRoot }] : undefined);
  return new WorkflowRunManager({
    spawnAdapter: adapter,
    hostSessionFactory: async ({ runId }) => `host-${runId}`,
    repoOverrides: { rootDir: runsRoot },
    loaderOverrides: {
      userRoot: path.join(tmpRoot, "marshal-workflows"),
    },
    backendOrigin: () => "copilot",
    ...(workspaceEntries
      ? {
          workspaceResolver: (candidate) =>
            workspaceEntries.find((entry) => entry.name.toLowerCase() === candidate.toLowerCase())
              ?.path,
          workspaceLister: () => workspaceEntries,
        }
      : {}),
  });
}

describe("repo-local workflows", () => {
  it("discovers workflows from the pre-rebrand .github/m-workflows root", () => {
    writeRepoWorkflow("return { ok: true };");
    fs.renameSync(
      path.join(repoRoot, ".github", "marshal-workflows"),
      path.join(repoRoot, ".github", "m-workflows"),
    );
    const loader = new WorkflowLoader({
      userRoot: path.join(tmpRoot, "user-workflows"),
    });

    expect(loader.listRepoWorkflows(repoRoot).map((entry) => entry.id)).toEqual(["repo-demo"]);
  });

  it("lists and runs workflows from .github/marshal-workflows with repo context", async () => {
    writeRepoWorkflow(`
      await ctx.step("ask", () =>
        ctx.run({ agentName: "reviewer", displayName: "Reviewer" }, "review"));
      return { ok: true };
    `);
    const { adapter, spawns } = recordingAdapter();
    const manager = makeManager(adapter);

    const workflows = await manager.listWorkflows({ repoPath: repoRoot });
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      id: "repo-demo",
      source: "repo-local",
      repoPath: repoRoot,
      projectName: "repo",
    });

    const { runId } = await manager.runWorkflow({ workflowId: "repo-demo", repoPath: repoRoot });
    const record = await manager._waitForRunTermination(runId, 10_000);
    expect(record.status).toBe("succeeded");
    expect(record.workflowRepoPath).toBe(repoRoot);
    expect(spawns[0]?.repoPath).toBe(repoRoot);
    expect(spawns[0]?.agentName).toBe("reviewer");
  });

  it("uses external .github folders as default subagent repo and skill context", async () => {
    const externalRepo = path.join(tmpRoot, "external-repo");
    const externalGithub = path.join(externalRepo, ".github");
    fs.mkdirSync(path.join(externalGithub, "agents"), { recursive: true });
    fs.mkdirSync(path.join(externalGithub, "skills", "external-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(externalGithub, "agents", "external-agent.agent.md"),
      "---\nname: external-agent\ndescription: External agent\n---\nExternal instructions",
    );
    fs.writeFileSync(
      path.join(externalGithub, "skills", "external-skill", "SKILL.md"),
      "---\nname: external-skill\ndescription: External skill\n---\nExternal skill instructions",
    );
    writeRepoWorkflow(`
      await ctx.run({ agentName: "external-agent", skills: ["*"] }, "use external context");
      return { external: ctx.externalContext?.githubFolderPath };
    `);
    const dir = path.join(
      repoRoot,
      ".github",
      "marshal-workflows",
      "repo-demo",
      "dist",
      "workflow.js",
    );
    const workflowJs = fs.readFileSync(dir, "utf-8").replace(
      'notifyOnComplete: "none",',
      `notifyOnComplete: "none",
  externalContext: { githubFolderPath: ${JSON.stringify(externalGithub)}, applyAsDefault: true },`,
    );
    fs.writeFileSync(dir, workflowJs);
    const { adapter, spawns } = recordingAdapter();
    const manager = makeManager(adapter);

    const { runId } = await manager.runWorkflow({ workflowId: "repo-demo", repoPath: repoRoot });
    const record = await manager._waitForRunTermination(runId, 10_000);

    expect(record.status).toBe("succeeded");
    expect(spawns[0]?.repoPath).toBe(externalRepo);
    expect(spawns[0]?.agentName).toBe("external-agent");
    expect(spawns[0]?.skills).toEqual(["external-skill"]);
    const snapshot = await manager.getRun({ runId });
    expect(snapshot?.result).toEqual({ external: externalGithub });
  });

  it("retry resolves the original repo-local workflow", async () => {
    writeRepoWorkflow(`
      await ctx.step("one", async () => "ok");
      return { ok: true };
    `);
    const manager = makeManager(recordingAdapter().adapter);
    const first = await manager.runWorkflow({ workflowId: "repo-demo", repoPath: repoRoot });
    await manager._waitForRunTermination(first.runId, 10_000);

    const retry = await manager.retryFromStep({ runId: first.runId, stepId: "/0:one" });
    const record = await manager._waitForRunTermination(retry.newRunId, 10_000);
    expect(record.workflowRepoPath).toBe(repoRoot);
    expect(record.runFamilyId).toBe(first.runFamilyId);
  });

  it("compiles a source-only repo-local workflow even when folder and manifest id differ", async () => {
    writeSourceOnlyRepoWorkflow({
      folderName: "folder-name",
      manifestId: "manifest-name",
      runBody: `
        await ctx.step("one", async () => "ok");
        return { ok: true };
      `,
    });
    const manager = makeManager(recordingAdapter().adapter);

    const { runId } = await manager.runWorkflow({
      workflowId: "manifest-name",
      repoPath: repoRoot,
    });
    const record = await manager._waitForRunTermination(runId, 10_000);

    expect(record.status).toBe("succeeded");
    expect(record.workflowRepoPath).toBe(repoRoot);
    expect(fs.existsSync(path.join(runsRoot, runId, "workflow.compiled.js"))).toBe(true);
  });

  it("prefers workflow.ts over stale dist for repo-local workflows", async () => {
    writeSourceOnlyRepoWorkflow({
      folderName: "source-wins",
      manifestId: "source-wins",
      runBody: `return { from: "source" };`,
    });
    const dir = path.join(repoRoot, ".github", "marshal-workflows", "source-wins");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dist", "workflow.js"),
      `
module.exports = { default: {
  id: "source-wins",
  displayName: "Source Wins",
  schemaVersion: 1,
  notifyOnComplete: "none",
  run: async function () { return { from: "stale-dist" }; }
}};
`,
    );

    const manager = makeManager(recordingAdapter().adapter);
    const { runId } = await manager.runWorkflow({
      workflowId: "source-wins",
      repoPath: repoRoot,
    });
    await manager._waitForRunTermination(runId, 10_000);

    const snapshot = await manager.getRun({ runId });
    expect(snapshot?.result).toEqual({ from: "source" });
  });

  it("lists workspace repo-local workflows and runs them by workspaceName without installation", async () => {
    writeRepoWorkflow(`
      await ctx.step("one", async () => "ok");
      return { ok: true };
    `);
    const manager = makeManager(recordingAdapter().adapter, { workspaceName: "Repo Workspace" });

    const workflows = await manager.listWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      id: "repo-demo",
      source: "repo-local",
      repoPath: repoRoot,
      workspaceName: "Repo Workspace",
    });

    const { runId } = await manager.runWorkflow({
      workflowId: "repo-demo",
      workspaceName: "Repo Workspace",
    });
    const record = await manager._waitForRunTermination(runId, 10_000);
    expect(record.status).toBe("succeeded");
    expect(record.workflowRepoPath).toBe(repoRoot);
    expect(record.workflowWorkspaceName).toBe("Repo Workspace");
  });

  it("does not discover repo-local workflows from internal worktrees absent from the registry", async () => {
    writeRepoWorkflow(`
      await ctx.step("one", async () => "ok");
      return { ok: true };
    `);
    const staleWorktreeRoot = path.join(tmpRoot, "stale-subagent-worktree");
    const staleWorkflowDir = path.join(
      staleWorktreeRoot,
      ".github",
      "marshal-workflows",
      "repo-demo",
    );
    fs.mkdirSync(staleWorkflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(staleWorkflowDir, "manifest.json"),
      JSON.stringify({
        id: "repo-demo",
        version: "1.0.0",
        title: "Stale Duplicate Repo Demo",
        permissions: { mode: "ask" },
      }),
    );
    const manager = makeManager(recordingAdapter().adapter, {
      workspaceEntries: [{ name: "Repo Workspace", path: repoRoot }],
    });

    const workflows = await manager.listWorkflows();

    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      id: "repo-demo",
      displayName: "Repo Demo",
      repoPath: repoRoot,
      workspaceName: "Repo Workspace",
    });
  });

  it("describes a source-only repo-local workflow by id and repoPath without installation", async () => {
    writeSourceOnlyRepoWorkflow({
      folderName: "folder-name",
      manifestId: "manifest-name",
      runBody: `return { ok: true };`,
    });
    const manager = makeManager(recordingAdapter().adapter);

    const description = await manager.describeWorkflow({
      workflowId: "manifest-name",
      repoPath: repoRoot,
    });

    expect(description).toMatchObject({
      id: "manifest-name",
      source: "repo-local",
      dir: path.join(repoRoot, ".github", "marshal-workflows", "folder-name"),
      agentRequirements: [],
    });
  });

  it("marks pre-start compile failures as failed instead of leaving a pending run", async () => {
    writeSourceOnlyRepoWorkflow({
      folderName: "broken-source",
      manifestId: "broken-source",
      runBody: `return import("./missing-module");`,
    });
    const manager = makeManager(recordingAdapter().adapter);

    await expect(
      manager.runWorkflow({ workflowId: "broken-source", repoPath: repoRoot }),
    ).rejects.toThrow(/missing-module|Could not resolve/);

    const run = manager.listRuns().find((entry) => entry.workflowId === "broken-source");
    expect(run?.status).toBe("failed");
  });

  it("runs a source-only PowerQuery on-call workflow fixture with cursor, artifacts, and MCP stubs", async () => {
    writePowerQueryOnCallWorkflow();
    const { adapter, spawns, prompts } = powerQueryAdapter();
    const manager = makeManager(adapter);

    const first = await manager.runWorkflow({
      workflowId: "pq-incident-incident-investigation",
      repoPath: repoRoot,
      input: {
        lookbackHours: 24,
        maxConcurrency: 1,
        shiftEnd: "2026-06-13T00:00:00Z",
      },
      initiatorSessionId: "powerquery-oncall-smoke",
    });
    await manager._waitForRunTermination(first.runId, 10_000);

    const second = await manager.runWorkflow({
      workflowId: "pq-incident-incident-investigation",
      repoPath: repoRoot,
      input: {
        lookbackHours: 24,
        maxConcurrency: 1,
        shiftEnd: "2026-06-20T00:00:00Z",
      },
      initiatorSessionId: "powerquery-oncall-smoke",
    });
    const secondRecord = await manager._waitForRunTermination(second.runId, 10_000);
    expect(secondRecord.status).toBe("succeeded");
    expect(secondRecord.workflowRepoPath).toBe(repoRoot);

    const firstSnapshot = await manager.getRun({ runId: first.runId });
    const secondSnapshot = await manager.getRun({ runId: second.runId });
    expect(firstSnapshot?.artifacts.map((a) => a.key)).toEqual([
      "recent-incidents.json",
      "incident-investigations.json",
    ]);
    expect(secondSnapshot?.result).toMatchObject({
      incidents: 1,
      investigations: 1,
      cursor: {
        previousShiftEnd: "2026-06-13T00:00:00Z",
        latestShiftEnd: "2026-06-20T00:00:00Z",
      },
      summary: { ok: true },
    });

    const recentArtifact = firstSnapshot?.artifacts.find((a) => a.key === "recent-incidents.json");
    expect(recentArtifact).toBeDefined();
    const recent = manager.readArtifact({
      runId: first.runId,
      storageKey: recentArtifact?.storageKey ?? "",
    });
    expect(recent?.mime).toBe("application/json");
    expect(JSON.parse(recent?.content ?? "{}")).toEqual({
      incidents: [{ id: "incident-1001", title: "Synthetic Dataflows incident" }],
    });

    expect(spawns.find((s) => s.displayName === "fetch-recent-incidents")?.mcp).toEqual([
      "incident-query",
    ]);
    expect(spawns.find((s) => s.displayName === "investigate-incident-1001")?.mcp).toEqual([
      "query-mcp",
      "incident-query",
    ]);
    expect(spawns.find((s) => s.displayName === "collector-summary")?.mcp).toEqual([]);
    expect(prompts.some((prompt) => prompt.includes("Workflow slot binding"))).toBe(true);

    const events = Array.from(readEventLines(path.join(runsRoot, second.runId, "events.ndjson")));
    const slots = events
      .filter((e) => e.type === "agent.spawn-requested")
      .map((e) =>
        "slot" in e.payload && typeof e.payload.slot === "string" ? e.payload.slot : undefined,
      );
    expect(slots).toEqual(["incident-fetcher", "incident-investigator", "collector"]);
    expect(events.some((e) => e.type === "state.written")).toBe(true);
  });

  it("throws a clear error when a required repo-local binding agent is missing", () => {
    expect(() =>
      resolveSlot(
        { slot: "reviewer" },
        {
          workflowDir: repoRoot,
          requirements: [{ slot: "reviewer", role: "Review code" }],
          bindings: {
            version: 1,
            targetRepoPath: repoRoot,
            bindings: {
              reviewer: {
                kind: "repo-agent",
                agentName: "missing-reviewer",
                requireRepoLocal: true,
              },
            },
          },
        },
      ),
    ).toThrow(/requires repo-local agent 'missing-reviewer'/);
  });
});
