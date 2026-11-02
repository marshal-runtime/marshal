// electron/workflows/__tests__/slot-resolution.test.ts
//
// FEAT-SLOTS end-to-end test. Exercises the engine's REAL spawnAndTrack
// / runSubagent code paths — only the SessionManager-shim layer of the
// SpawnAdapter is stubbed (a "recording adapter" that captures every
// call into the underlying spawn function). The slot resolver, preamble
// composition, in-flight tracking, and ctx.send preamble consumption
// all run unmodified.
//
// The IMPL-ENGINE smoke test (`workflow-engine.test.ts`) used a stub adapter
// that ignored its `opts` and `prompt` arguments entirely — that's how
// a bug in slot translation could slip through. This test asserts on
// every observable side-effect of the resolution path.

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

import { install } from "../install-local";
import { writeInstalledSource } from "../installed-source-store";
import { resolveSlot, SlotResolutionError } from "../slot-resolver";
import type {
  SpawnAdapter,
  SpawnedHandle,
  ResolvedSpawnOpts,
  DeliveryMode,
} from "../spawn-adapter";
import { WorkflowRunManager } from "../workflow-run-manager";

let tmpRoot: string;
let userRoot: string;
let runsRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-slot-"));
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

// ── Recording SpawnAdapter ──────────────────────────────────────────────
//
// Captures every arg passed to spawn/spawnAndRun/send/waitForReply so the
// test can assert on the resolved opts and prompt content. Returns
// canned replies indexed by sessionId.

interface RecordedSpawn {
  readonly kind: "spawn" | "spawnAndRun";
  readonly opts: ResolvedSpawnOpts;
  readonly prompt?: string;
  readonly handleId: string;
  readonly sessionId: string;
}
interface RecordedSend {
  readonly handle: SpawnedHandle;
  readonly text: string;
  readonly opts?: { deliveryMode?: DeliveryMode };
}
interface RecordedSendAndCollect {
  readonly handle: SpawnedHandle;
  readonly message: string;
}

function recordingAdapter(replies: (sessionId: string) => string): {
  adapter: SpawnAdapter;
  spawns: RecordedSpawn[];
  sends: RecordedSend[];
  sendAndCollects: RecordedSendAndCollect[];
} {
  let n = 0;
  const spawns: RecordedSpawn[] = [];
  const sends: RecordedSend[] = [];
  const sendAndCollects: RecordedSendAndCollect[] = [];
  const adapter: SpawnAdapter = {
    async spawn(opts) {
      n++;
      const h: SpawnedHandle = { handleId: `h-${n}`, sessionId: `s-${n}` };
      spawns.push({ kind: "spawn", opts, handleId: h.handleId, sessionId: h.sessionId });
      return h;
    },
    async spawnAndRun(opts, prompt) {
      n++;
      const h: SpawnedHandle = { handleId: `h-${n}`, sessionId: `s-${n}` };
      spawns.push({
        kind: "spawnAndRun",
        opts,
        prompt,
        handleId: h.handleId,
        sessionId: h.sessionId,
      });
      return h;
    },
    async send(handle, text, opts) {
      sends.push({ handle, text, opts });
    },
    async waitForReply(handle) {
      return replies(handle.sessionId);
    },
    async sendAndCollect(handle, message) {
      sendAndCollects.push({ handle, message });
      return replies(handle.sessionId);
    },
    async cancel() {
      /* no-op */
    },
  };
  return { adapter, spawns, sends, sendAndCollects };
}

// ── Install a tiny workflow that declares two slots ────────────────────

function installSlotWorkflow(args: {
  agents: Record<string, string>; // agentMdPath → body
  bindings: Record<string, unknown>;
  permissionsMode?: "ask" | "allow-all";
}): { workflowDir: string } {
  const dir = path.join(userRoot, "slot-demo");
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [rel, body] of Object.entries(args.agents)) {
    fs.writeFileSync(path.join(dir, rel), body, "utf-8");
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "slot-demo",
      version: "1.0.0",
      title: "Slot Demo",
      permissions: { mode: args.permissionsMode ?? "ask" },
    }),
  );
  // Hand-rolled CJS module so we control agentRequirements precisely.
  fs.writeFileSync(
    path.join(dir, "dist", "workflow.js"),
    `
module.exports = { default: {
  id: "slot-demo",
  displayName: "Slot Demo",
  schemaVersion: 1,
  notifyOnComplete: "none",
  agentRequirements: [
    { slot: "investigator", role: "Forensic analyst",
      defaultPersonality: "Cite evidence.",
      defaultAgent: { agentMdPath: "agents/investigator.agent.md" } },
    { slot: "generalist", role: "General helper for ad-hoc tasks",
      defaultPersonality: "Be concise." },
    { slot: "repoExpert", role: "Repo-local agent" },
  ],
  run: async function (ctx) {
    // ctx.run with slot=investigator (shipped-agent)
    await ctx.step("investigate", () =>
      ctx.run({ slot: "investigator", displayName: "Inv" }, "investigate the issue"));
    // ctx.run with slot=generalist (default-with-role)
    await ctx.step("summarize", () =>
      ctx.run({ slot: "generalist", displayName: "Sum" }, "summarize"));
    // ctx.spawn + ctx.send with slot=investigator (deferred preamble)
    const h = await ctx.spawn({ slot: "investigator", displayName: "InvDeferred" });
    await ctx.send(h, "deferred-message-1");
    await ctx.send(h, "deferred-message-2"); // second send should NOT include preamble
    // ctx.run with slot=repoExpert (repo-agent, agentName="dp-engineer")
    await ctx.step("expertise", () =>
      ctx.run({ slot: "repoExpert", displayName: "Repo" }, "review my code"));
    return { ok: true };
  },
}};
`,
  );
  fs.writeFileSync(path.join(dir, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
  fs.writeFileSync(
    path.join(dir, "bindings.json"),
    JSON.stringify({ version: 1, bindings: args.bindings, targetRepoPath: tmpRoot }),
  );
  writeInstalledSource(dir, {
    source: "user-local",
    installedAt: Date.now(),
    distHash: "x",
    version: "1.0.0",
  });
  return { workflowDir: dir };
}

function installRepoLocalSlotWorkflow(): { repoPath: string; workflowDir: string } {
  const repoPath = path.join(tmpRoot, "repo-local-target");
  const dir = path.join(repoPath, ".github", "marshal-workflows", "slot-demo");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "investigator.agent.md"), "# Investigator");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "slot-demo",
      version: "1.0.0",
      title: "Slot Demo",
      permissions: { mode: "ask" },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "dist", "workflow.js"),
    `
module.exports = { default: {
  id: "slot-demo",
  displayName: "Slot Demo",
  schemaVersion: 1,
  notifyOnComplete: "none",
  agentRequirements: [
    { slot: "investigator", role: "Forensic analyst",
      defaultAgent: { agentMdPath: "agents/investigator.agent.md" } },
    { slot: "generalist", role: "General helper for ad-hoc tasks" },
  ],
  run: async function (ctx) {
    await ctx.run({ slot: "investigator", displayName: "Inv" }, "investigate");
    await ctx.run({ slot: "generalist", displayName: "Sum" }, "summarize");
    return { ok: true };
  },
}};
`,
  );
  fs.writeFileSync(path.join(dir, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
  return { repoPath, workflowDir: dir };
}

function makeManager(adapter: SpawnAdapter): WorkflowRunManager {
  return new WorkflowRunManager({
    spawnAdapter: adapter,
    hostSessionFactory: async ({ runId }) => `host-${runId}`,
    repoOverrides: { rootDir: runsRoot },
    loaderOverrides: { userRoot },
    backendOrigin: () => "copilot",
  });
}

// ───────────────────────────────────────────────────────────────────────

describe("slot-resolver (pure)", () => {
  it("throws on both slot and agentName", () => {
    expect(() =>
      resolveSlot(
        { slot: "x", agentName: "y" },
        {
          workflowDir: "/tmp",
          requirements: [],
          bindings: { version: 1, bindings: {}, targetRepoPath: null },
        },
      ),
    ).toThrow(/cannot specify both/i);
  });
  it("throws on unknown slot", () => {
    expect(() =>
      resolveSlot(
        { slot: "unknown" },
        {
          workflowDir: "/tmp",
          requirements: [{ slot: "known", role: "r" }],
          bindings: { version: 1, bindings: {}, targetRepoPath: null },
        },
      ),
    ).toThrow(SlotResolutionError);
  });
  it("throws when binding missing", () => {
    expect(() =>
      resolveSlot(
        { slot: "known" },
        {
          workflowDir: "/tmp",
          requirements: [{ slot: "known", role: "r" }],
          bindings: { version: 1, bindings: {}, targetRepoPath: null },
        },
      ),
    ).toThrow(/no entry for slot/i);
  });
  it("passes through when no slot (legacy)", () => {
    const out = resolveSlot(
      { agentName: "explicit" },
      {
        workflowDir: "/tmp",
        requirements: [],
        bindings: { version: 1, bindings: {}, targetRepoPath: null },
      },
    );
    expect(out.resolvedOpts.agentName).toBe("explicit");
    expect(out.promptPreamble).toBeUndefined();
  });
  it("default-with-role: drops slot, emits preamble containing role + personality", () => {
    const out = resolveSlot(
      { slot: "s", displayName: "d" },
      {
        workflowDir: "/tmp",
        requirements: [{ slot: "s", role: "Friendly greeter", defaultPersonality: "Brief." }],
        bindings: {
          version: 1,
          bindings: { s: { kind: "default-with-role" } },
          targetRepoPath: null,
        },
      },
    );
    expect(out.resolvedOpts.slot).toBeUndefined();
    expect(out.resolvedOpts.agentName).toBeUndefined();
    expect(out.resolvedOpts.displayName).toBe("d");
    expect(out.promptPreamble).toMatch(/Role: Friendly greeter/);
    expect(out.promptPreamble).toMatch(/Personality: Brief\./);
  });
  it("repo-agent: maps to agentName + workspaceName/repoPath", () => {
    const out = resolveSlot(
      { slot: "s" },
      {
        workflowDir: "/tmp",
        requirements: [{ slot: "s", role: "r" }],
        bindings: {
          version: 1,
          bindings: { s: { kind: "repo-agent", agentName: "dp", workspaceName: "ws" } },
          targetRepoPath: "/repo",
        },
      },
    );
    expect(out.resolvedOpts.agentName).toBe("dp");
    expect(out.resolvedOpts.workspaceName).toBe("ws");
    expect(out.resolvedOpts.repoPath).toBe("/repo");
    expect(out.promptPreamble).toBeUndefined();
  });
});

describe("engine slot resolution end-to-end", () => {
  it("translates slots into resolved spawn opts + preambles across ctx.run and ctx.spawn", async () => {
    const investigatorBody = "# Investigator\nYou are a forensic analyst. Always cite evidence.";
    installSlotWorkflow({
      agents: { "agents/investigator.agent.md": investigatorBody },
      bindings: {
        investigator: { kind: "shipped-agent" },
        generalist: { kind: "default-with-role" },
        repoExpert: { kind: "repo-agent", agentName: "dp-engineer", workspaceName: "ws" },
      },
    });

    const { adapter, spawns, sends, sendAndCollects } = recordingAdapter(() => "{}");
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({ workflowId: "slot-demo" });
    const record = await mgr._waitForRunTermination(runId, 10_000);
    expect(record.status).toBe("succeeded");

    // 4 spawns: investigate (ctx.run, shipped), summarize (ctx.run, default),
    // deferred (ctx.spawn, shipped), expertise (ctx.run, repo-agent)
    expect(spawns.length).toBe(4);

    const [investigate, summarize, deferred, expertise] = spawns;

    const collectFor = (spawn: RecordedSpawn): string | undefined =>
      sendAndCollects.find((call) => call.handle.sessionId === spawn.sessionId)?.message;

    // 1) shipped-agent via ctx.run: preamble inlined into sendAndCollect prompt, no agentName
    expect(investigate.kind).toBe("spawn");
    expect(investigate.opts.agentName).toBeUndefined();
    expect(investigate.opts.slot).toBeUndefined();
    expect(collectFor(investigate)).toContain("kind: shipped-agent");
    expect(collectFor(investigate)).toContain("Source: agents/investigator.agent.md");
    expect(collectFor(investigate)).toContain("forensic analyst");
    expect(collectFor(investigate)).toContain("investigate the issue");

    // 2) default-with-role via ctx.run: preamble inlined into sendAndCollect
    expect(summarize.kind).toBe("spawn");
    expect(summarize.opts.agentName).toBeUndefined();
    expect(collectFor(summarize)).toContain("kind: default-with-role");
    expect(collectFor(summarize)).toContain("Role: General helper for ad-hoc tasks");
    expect(collectFor(summarize)).toContain("Personality: Be concise.");
    expect(collectFor(summarize)).toContain("summarize");

    // 3) ctx.spawn (deferred): no prompt to spawn; first ctx.send carries preamble
    expect(deferred.kind).toBe("spawn");
    expect(deferred.opts.agentName).toBeUndefined();
    const sendsForDeferred = sends.filter((s) => s.handle.sessionId === deferred.sessionId);
    expect(sendsForDeferred.length).toBe(2);
    expect(sendsForDeferred[0].text).toContain("kind: shipped-agent");
    expect(sendsForDeferred[0].text).toContain("deferred-message-1");
    // Second send: preamble already consumed, plain text only.
    expect(sendsForDeferred[1].text).toBe("deferred-message-2");
    expect(sendsForDeferred[1].text).not.toContain("kind: shipped-agent");

    // 4) repo-agent via ctx.run: maps to agentName, workspaceName, repoPath; no preamble
    expect(expertise.kind).toBe("spawn");
    expect(expertise.opts.agentName).toBe("dp-engineer");
    expect(expertise.opts.workspaceName).toBe("ws");
    expect(expertise.opts.repoPath).toBe(tmpRoot);
    expect(collectFor(expertise)).toBe("review my code");
  });

  it("surfaces missing-binding as a failed run, not a silent default", async () => {
    installSlotWorkflow({
      agents: { "agents/investigator.agent.md": "x" },
      bindings: {
        // Intentionally missing the `investigator` slot binding.
        generalist: { kind: "default-with-role" },
        repoExpert: { kind: "repo-agent", agentName: "x" },
      },
    });
    const { adapter } = recordingAdapter(() => "{}");
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({ workflowId: "slot-demo" });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("failed");
    expect(record.errorSummary?.message).toMatch(/binding map has no entry for slot/i);
  });

  it("auto-derives bindings for repo-local workflows without bindings.json", async () => {
    const { repoPath } = installRepoLocalSlotWorkflow();
    const { adapter, spawns, sendAndCollects } = recordingAdapter(() => "{}");
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({ workflowId: "slot-demo", repoPath });
    const record = await mgr._waitForRunTermination(runId, 5_000);
    expect(record.status).toBe("succeeded");
    expect(spawns.length).toBe(2);
    expect(spawns[0].opts.slot).toBeUndefined();
    expect(sendAndCollects[0].message).toContain("kind: shipped-agent");
    expect(spawns[1].opts.slot).toBeUndefined();
    expect(sendAndCollects[1].message).toContain("kind: default-with-role");
  });

  it("applies manifest allow-all permission mode to workflow-spawned agents by default", async () => {
    installSlotWorkflow({
      agents: { "agents/investigator.agent.md": "# Investigator" },
      bindings: {
        investigator: { kind: "shipped-agent" },
        generalist: { kind: "default-with-role" },
        repoExpert: { kind: "repo-agent", agentName: "dp-engineer", workspaceName: "ws" },
      },
      permissionsMode: "allow-all",
    });

    const { adapter, spawns } = recordingAdapter(() => "{}");
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({ workflowId: "slot-demo" });
    const record = await mgr._waitForRunTermination(runId, 10_000);

    expect(record.status).toBe("succeeded");
    expect(spawns).toHaveLength(4);
    expect(spawns.every((spawn) => spawn.opts.permissionMode === "allow-all")).toBe(true);
  });

  it("applies explicit allow-all permission mode to workflow-spawned agents when manifest asks", async () => {
    installSlotWorkflow({
      agents: { "agents/investigator.agent.md": "# Investigator" },
      bindings: {
        investigator: { kind: "shipped-agent" },
        generalist: { kind: "default-with-role" },
        repoExpert: { kind: "repo-agent", agentName: "dp-engineer", workspaceName: "ws" },
      },
    });

    const { adapter, spawns } = recordingAdapter(() => "{}");
    const mgr = makeManager(adapter);
    const { runId } = await mgr.runWorkflow({
      workflowId: "slot-demo",
      permissionMode: "allow-all",
    });
    const record = await mgr._waitForRunTermination(runId, 10_000);

    expect(record.status).toBe("succeeded");
    expect(spawns).toHaveLength(4);
    expect(spawns.every((spawn) => spawn.opts.permissionMode === "allow-all")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────

describe("install() — explicit bindings", () => {
  // Use the engine's introspect path via install() with a prebuilt CJS
  // module so we don't need esbuild in the test environment.

  function srcDir(): string {
    const d = path.join(tmpRoot, "src-install");
    const agentsDir = path.join(d, "agents");
    fs.mkdirSync(path.join(d, "dist"), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(d, "manifest.json"),
      JSON.stringify({
        id: "demo-install",
        version: "1.0.0",
        title: "Demo Install",
        permissions: { mode: "ask" },
      }),
    );
    fs.writeFileSync(path.join(agentsDir, "shipped.agent.md"), "# Shipped agent body");
    fs.writeFileSync(
      path.join(d, "dist", "workflow.js"),
      `
module.exports = { default: {
  id: "demo-install",
  displayName: "Demo Install",
  schemaVersion: 1,
  notifyOnComplete: "none",
  agentRequirements: [
    { slot: "needsShipped", role: "needs the shipped agent",
      defaultAgent: { agentMdPath: "agents/shipped.agent.md" } },
    { slot: "needsRole", role: "just role" },
  ],
  run: async () => ({}),
}};
`,
    );
    fs.writeFileSync(path.join(d, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
    return d;
  }

  it("auto-derives bindings when none provided (shipped + default-with-role)", async () => {
    const loader = makeManager(recordingAdapter(() => "{}").adapter)["loader"];
    const result = await install({ sourceDir: srcDir() }, { loader });
    expect(result.bindings.bindings.needsShipped.kind).toBe("shipped-agent");
    expect(result.bindings.bindings.needsRole.kind).toBe("default-with-role");
    expect(result.autoDerivedSlots).toEqual(["needsShipped", "needsRole"]);
    // Sibling agent file copied into the install dir.
    expect(fs.existsSync(path.join(userRoot, "demo-install", "agents", "shipped.agent.md"))).toBe(
      true,
    );
  });

  it("create-agent writes the .agent.md into the target repo and persists the binding", async () => {
    const targetRepo = path.join(tmpRoot, "target-repo");
    fs.mkdirSync(path.join(targetRepo, ".github", "agents"), { recursive: true });
    const loader = makeManager(recordingAdapter(() => "{}").adapter)["loader"];
    const result = await install(
      {
        sourceDir: srcDir(),
        targetRepoPath: targetRepo,
        bindings: {
          needsShipped: { kind: "shipped-agent" },
          needsRole: {
            kind: "create-agent",
            agentMdPath: ".github/agents/custom.agent.md",
            agentName: "custom",
          },
        },
        createAgentBodies: { needsRole: "# Custom agent\nDo the thing." },
      },
      { loader },
    );
    const created = path.join(targetRepo, ".github", "agents", "custom.agent.md");
    expect(fs.existsSync(created)).toBe(true);
    expect(fs.readFileSync(created, "utf-8")).toContain("Do the thing");
    expect(result.createdAgentPaths).toContain(created);
    expect(result.bindings.targetRepoPath).toBe(targetRepo);
    expect(result.bindings.bindings.needsRole.kind).toBe("create-agent");
  });

  it("rejects create-agent with no body", async () => {
    const targetRepo = path.join(tmpRoot, "target-repo-2");
    fs.mkdirSync(path.join(targetRepo, ".github", "agents"), { recursive: true });
    const loader = makeManager(recordingAdapter(() => "{}").adapter)["loader"];
    await expect(
      install(
        {
          sourceDir: srcDir(),
          targetRepoPath: targetRepo,
          bindings: {
            needsShipped: { kind: "shipped-agent" },
            needsRole: {
              kind: "create-agent",
              agentMdPath: ".github/agents/custom.agent.md",
              agentName: "custom",
            },
          },
          // intentionally omit createAgentBodies
        },
        { loader },
      ),
    ).rejects.toThrow(/createAgentBodies/);
  });

  it("rejects bindings with unknown slots", async () => {
    const loader = makeManager(recordingAdapter(() => "{}").adapter)["loader"];
    await expect(
      install(
        {
          sourceDir: srcDir(),
          bindings: {
            needsShipped: { kind: "shipped-agent" },
            needsRole: { kind: "default-with-role" },
            mysteryExtra: { kind: "default-with-role" },
          },
        },
        { loader },
      ),
    ).rejects.toThrow(/does not declare/i);
  });
});

describe("describeWorkflow", () => {
  it("returns agentRequirements from an installed workflow", async () => {
    installSlotWorkflow({
      agents: { "agents/investigator.agent.md": "x" },
      bindings: {
        investigator: { kind: "shipped-agent" },
        generalist: { kind: "default-with-role" },
        repoExpert: { kind: "repo-agent", agentName: "dp-engineer" },
      },
    });
    const mgr = makeManager(recordingAdapter(() => "{}").adapter);
    const desc = await mgr.describeWorkflow({ workflowId: "slot-demo" });
    expect(desc.id).toBe("slot-demo");
    expect(desc.agentRequirements.map((r) => r.slot)).toEqual([
      "investigator",
      "generalist",
      "repoExpert",
    ]);
    expect(desc.currentBindings?.bindings.investigator.kind).toBe("shipped-agent");
  });

  it("returns agentRequirements from a sourceDir workflow.ts", async () => {
    const dir = path.join(tmpRoot, "source-workflow");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "source-slot-demo",
        version: "1.0.0",
        title: "Source Slot Demo",
        permissions: { mode: "ask" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "workflow.ts"),
      `
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

export default defineWorkflow({
  id: "source-slot-demo",
  displayName: "Source Slot Demo",
  params: z.object({ incidentId: z.string() }),
  agentRequirements: [
    { slot: "investigator", role: "Investigate incidents" },
  ],
  run: async () => ({ ok: true }),
});
`,
    );

    const mgr = makeManager(recordingAdapter(() => "{}").adapter);
    const desc = await mgr.describeWorkflow({ sourceDir: dir });

    expect(desc.id).toBe("source-slot-demo");
    expect(desc.agentRequirements).toEqual([
      { slot: "investigator", role: "Investigate incidents" },
    ]);
  });
});
