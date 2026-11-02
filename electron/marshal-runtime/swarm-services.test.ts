import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRuntimeServiceContainer } from "@marshal/runtime";
import type { SwarmSharedContextService } from "@marshal/swarm";
import { afterEach, describe, expect, it } from "vitest";

import { bindMarshalSwarmServices, SWARM_SHARED_CONTEXT_SERVICE, SWARM_ROLE_MODEL_SERVICE } from "./swarm-services";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sharedContextService(): Promise<{
  service: SwarmSharedContextService;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "marshal-field-guide-test-"));
  tempDirectories.push(root);
  const container = createRuntimeServiceContainer();
  await bindMarshalSwarmServices(container, root);
  return {
    root,
    service: container.get<SwarmSharedContextService>(SWARM_SHARED_CONTEXT_SERVICE),
  };
}

describe("Marshal Swarm shared context", () => {
  it("uses the cross-module service token consumed by the extension bundle", () => {
    expect(SWARM_SHARED_CONTEXT_SERVICE).toBe(Symbol.for("@marshal/swarm:shared-context"));
  });

  it("creates field-guide/index.md and injects its complete content", async () => {
    const { service } = await sharedContextService();

    const initial = await service.read("run-1");

    expect(path.basename(path.dirname(initial.path))).toBe("field-guide");
    expect(path.basename(initial.path)).toBe("index.md");
    expect(initial.content).toBe("# Field Guide\n");
    expect(await readFile(initial.path, "utf8")).toBe(initial.content);

    const completeGuide = `${Array.from(
      { length: 250 },
      (_, index) => `- Durable repository surprise ${index + 1}`,
    ).join("\n")}\n`;
    await writeFile(initial.path, completeGuide, "utf8");

    const reread = await service.read("run-1");
    expect(reread.path).toBe(initial.path);
    expect(reread.content).toBe(completeGuide);
  });

  it("labels each topic file with its absolute ownership path", async () => {
    const { service } = await sharedContextService();
    const initial = await service.read("run-1");
    const guideDirectory = path.dirname(initial.path);

    await writeFile(
      path.join(guideDirectory, "topics", "session-boundary.md"),
      "Sessions own admission.\n",
      "utf8",
    );
    await writeFile(
      path.join(guideDirectory, "topics", "baseline-contract.md"),
      "One boundary worker lands SwarmBaselineService.\n",
      "utf8",
    );
    await writeFile(
      path.join(guideDirectory, "integration-refs.md"),
      "Integration state is git refs only.\n",
      "utf8",
    );

    const guide = await service.read("run-1");

    expect(guide.content).toContain("# Field Guide\n");
    expect(guide.content).toContain(
      `--- FIELD GUIDE TOPIC: ${path.join(guideDirectory, "integration-refs.md")} ---`,
    );
    expect(guide.content).toContain("Integration state is git refs only.\n");
    expect(guide.content).toContain("One boundary worker lands SwarmBaselineService.\n");
    expect(guide.content).toContain("Sessions own admission.\n");
  });

  it("creates a writable topics directory and leaves no probe or status file behind", async () => {
    const { service } = await sharedContextService();

    const guide = await service.read("run-1");
    await service.read("run-1");

    const guideDirectory = path.dirname(guide.path);
    expect(await readdir(guideDirectory)).toEqual(["index.md", "topics"]);
    expect(await readdir(path.join(guideDirectory, "topics"))).toEqual([]);
    expect(guide.content).toBe("# Field Guide\n");
  });

  it("never overwrites an index.md the root planner owns", async () => {
    const { service } = await sharedContextService();
    const initial = await service.read("run-1");
    await writeFile(initial.path, "# Field Guide\n\n- Curated by the root planner.\n", "utf8");

    await service.read("run-1");

    expect(await readFile(initial.path, "utf8")).toBe(
      "# Field Guide\n\n- Curated by the root planner.\n",
    );
  });

  it("ignores non-Markdown files and directories under the guide", async () => {
    const { service } = await sharedContextService();
    const initial = await service.read("run-1");
    const guideDirectory = path.dirname(initial.path);
    await writeFile(path.join(guideDirectory, "notes.txt"), "not a topic", "utf8");
    await mkdir(path.join(guideDirectory, "topics", "nested.md"), { recursive: true });

    const guide = await service.read("run-1");

    expect(guide.content).toBe("# Field Guide\n");
  });

  it("keeps each run's guide and topics separate", async () => {
    const { service } = await sharedContextService();
    const first = await service.read("run-1");
    const second = await service.read("run-2");
    await writeFile(
      path.join(path.dirname(first.path), "topics", "only-run-1.md"),
      "Run one decision.\n",
      "utf8",
    );

    expect(second.path).not.toBe(first.path);
    expect((await service.read("run-1")).content).toContain("Run one decision.\n");
    expect((await service.read("run-2")).content).toBe("# Field Guide\n");
  });
});


describe("Marshal Swarm role settings", () => {
  it("resolves all provider-neutral role settings ahead of generic and legacy worker defaults", async () => {
    const container = createRuntimeServiceContainer();
    const policy = {
      planner: { model: "provider/planner", reasoningEffort: "max" as const },
      reviewer: { model: "provider/reviewer", reasoningEffort: "high" as const },
      worker: { model: "provider/worker", reasoningEffort: "medium" as const },
      reconciler: { model: "provider/reconciler", reasoningEffort: "max" as const },
    };
    await bindMarshalSwarmServices(container, "/unused", () => ({ swarmRoleModels: policy, swarmWorkerModel: "invalid-legacy" }),
      (configured) => { if (!configured || configured === "invalid-legacy") throw new Error("invalid fallback"); return configured; });
    const roles = container.get(SWARM_ROLE_MODEL_SERVICE);
    for (const role of ["planner", "reviewer", "worker", "reconciler"] as const)
      expect(roles.resolve(role)).toEqual(policy[role]);
  });
});
