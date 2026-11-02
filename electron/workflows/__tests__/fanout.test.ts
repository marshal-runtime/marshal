// electron/workflows/__tests__/fanout.test.ts
//
// FanOut behaviour: per-unit step keys, failFraction policy, drift
// detection on retry. Uses the same stub-spawn-adapter as hello-world.

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wffanout-"));
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

function installWorkflow(id: string, body: string): void {
  const dir = path.join(userRoot, id);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, version: "1.0.0", title: id, permissions: { mode: "ask" } }),
  );
  fs.writeFileSync(
    path.join(dir, "dist", "workflow.js"),
    `module.exports = { default: {
      id: ${JSON.stringify(id)},
      displayName: ${JSON.stringify(id)},
      schemaVersion: 1,
      notifyOnComplete: "none",
      run: async function (ctx) { ${body} }
    }};`,
  );
  writeInstalledSource(dir, {
    source: "user-local",
    installedAt: Date.now(),
    distHash: "h",
    version: "1.0.0",
  });
}

const stubAdapter: SpawnAdapter = {
  async spawn() {
    return { handleId: "h", sessionId: "s" };
  },
  async spawnAndRun() {
    return { handleId: "h", sessionId: "s" };
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

function makeManager(): WorkflowRunManager {
  return new WorkflowRunManager({
    spawnAdapter: stubAdapter,
    hostSessionFactory: async ({ runId }) => `host-${runId}`,
    repoOverrides: { rootDir: runsRoot },
    loaderOverrides: { userRoot },
    backendOrigin: () => "copilot",
  });
}

describe("ctx.fanOut", () => {
  it("runs all units with per-unit step keys", async () => {
    installWorkflow(
      "fanout-basic",
      `
        const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
        const out = await ctx.fanOut(items, async (b) => "processed-" + b.name, {
          keyFor: (b) => b.name,
        });
        return { count: out.length };
      `,
    );
    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "fanout-basic" });
    const rec = await mgr._waitForRunTermination(runId, 10_000);
    expect(rec.status).toBe("succeeded");

    const events = Array.from(readEventLines(path.join(runsRoot, runId, "events.ndjson")));
    const started = events.find((e) => e.type === "fanOut.started");
    expect(started?.payload).toMatchObject({ count: 3, itemKeys: ["a", "b", "c"] });

    const stepLabels = events
      .filter((e) => e.type === "step.completed")
      .map((e) => (e.payload as { label: string }).label);
    // Expect the parent __fanOut step + three per-unit step labels.
    expect(stepLabels).toContain("__fanOut");
    expect(stepLabels).toContain("[a]");
    expect(stepLabels).toContain("[b]");
    expect(stepLabels).toContain("[c]");
  });

  it("gives concurrent units sibling step keys and correctly attributes spawned agents", async () => {
    // Each unit spawns an agent, forcing the units' bodies to interleave across
    // awaits. Regression guard for the shared-stack race that nested every
    // unit's step key inside the previous one (e.g.
    // `…/__fanOut/0:[a]/0:[b]/0:[c]`) and mis-attributed each spawned agent's
    // stepKey/fanOutUnitKey — which broke the run-exec UI's agent↔unit mapping.
    installWorkflow(
      "fanout-parallel-attribution",
      `
        await ctx.fanOut(["a", "b", "c"], async (name) => {
          await ctx.spawn({ displayName: "agent-" + name });
          return name;
        }, { keyFor: (n) => n });
        return { ok: true };
      `,
    );
    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "fanout-parallel-attribution" });
    const rec = await mgr._waitForRunTermination(runId, 10_000);
    expect(rec.status).toBe("succeeded");

    const events = Array.from(readEventLines(path.join(runsRoot, runId, "events.ndjson")));

    // The single __fanOut parent step.
    const fanStarted = events.find(
      (event) => event.type === "step.started" && payloadString(event, "label") === "__fanOut",
    );
    const fanKey = fanStarted ? payloadString(fanStarted, "stepKey") : undefined;
    expect(fanKey).toBeTruthy();
    if (!fanKey) throw new Error("Expected the fan-out parent step key");

    // The three unit steps are DIRECT children of __fanOut (siblings) — not
    // nested inside one another.
    const unitStarts = events.filter(
      (event) => event.type === "step.started" && /^\[/.test(payloadString(event, "label") ?? ""),
    );
    expect(unitStarts).toHaveLength(3);
    const unitKeys = new Set<string>();
    for (const unitStarted of unitStarts) {
      const stepKey = payloadString(unitStarted, "stepKey");
      const parentStepKey = payloadString(unitStarted, "parentStepKey");
      if (!stepKey) throw new Error("Expected a fan-out unit step key");
      expect(parentStepKey).toBe(fanKey); // sibling of the others
      expect(stepKey.startsWith(`${fanKey}/`)).toBe(true);
      // exactly one segment below __fanOut (no further "/" → not nested)
      expect(stepKey.slice(fanKey.length + 1).includes("/")).toBe(false);
      unitKeys.add(stepKey);
    }
    expect(unitKeys.size).toBe(3); // all distinct

    // Each spawned agent is attributed to its OWN unit: distinct fanOutUnitKey
    // in {a,b,c}, fanOutStepKey === the __fanOut step, and stepKey === its unit.
    const spawned = events.filter((e) => e.type === "agent.spawned");
    expect(spawned).toHaveLength(3);
    const seenUnitKeys = spawned
      .map((event) => payloadString(event, "fanOutUnitKey"))
      .sort((left, right) => (left ?? "").localeCompare(right ?? ""));
    expect(seenUnitKeys).toEqual(["a", "b", "c"]);
    for (const spawnedEvent of spawned) {
      const stepKey = payloadString(spawnedEvent, "stepKey");
      expect(payloadString(spawnedEvent, "fanOutStepKey")).toBe(fanKey);
      expect(stepKey !== undefined && unitKeys.has(stepKey)).toBe(true);
    }
  });

  it("aborts via failFraction when too many units fail", async () => {
    installWorkflow(
      "fanout-fail",
      `
        try {
          await ctx.fanOut([0, 1, 2, 3], async (n) => {
            if (n >= 2) throw new Error("bad " + n);
            return n;
          }, { onUnitFailure: { failFraction: 0.4 } });
        } catch (e) {
          return { aborted: true, msg: String(e.message) };
        }
        return { aborted: false };
      `,
    );
    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "fanout-fail" });
    const rec = await mgr._waitForRunTermination(runId, 10_000);
    expect(rec.status).toBe("succeeded");
    const events = Array.from(readEventLines(path.join(runsRoot, runId, "events.ndjson")));
    const completed = events.find((e) => e.type === "fanOut.completed");
    expect(completed?.payload).toMatchObject({ aborted: true });
  });

  it("returns ok/err tagged values under 'continue' policy", async () => {
    installWorkflow(
      "fanout-continue",
      `
        const results = await ctx.fanOut([1, 2, 3], async (n) => {
          if (n === 2) throw new Error("two");
          return n * 10;
        }, { onUnitFailure: "continue" });
        const okCount = results.filter(r => r && r.ok).length;
        const errCount = results.filter(r => r && r.ok === false).length;
        return { okCount, errCount };
      `,
    );
    const mgr = makeManager();
    const { runId } = await mgr.runWorkflow({ workflowId: "fanout-continue" });
    const rec = await mgr._waitForRunTermination(runId, 10_000);
    expect(rec.status).toBe("succeeded");
  });
});

function payloadString(event: { readonly payload: unknown }, key: string): string | undefined {
  if (event.payload === null || typeof event.payload !== "object") return undefined;
  const value: unknown = Reflect.get(event.payload, key);
  return typeof value === "string" ? value : undefined;
}
