import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeServiceContainer,
} from "@marshal/runtime";
import {
  DelegationManager,
  createRuntimeDelegationProvider,
  type DelegationAdapterPort,
} from "@marshal/runtime/delegation";
import { FileDelegationStore } from "@marshal/runtime/effects";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProductionMarshalRuntimeApi } from "./api";
import { resolveFirstPartyExtensionCatalog } from "./first-party-extension-catalog";
import { MarshalRuntimeHost } from "./host";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("installed Swarm protocol through runtime TypeScript", () => {
  let root: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let hostOptions: ConstructorParameters<typeof MarshalRuntimeHost>[0];
  let sequence = 0;
  const owner = "swarm-root-session";
  const sessions = new Map<string, string>();
  const controllers = new Map<string, string>();
  const pending = new Map<string, () => void>();
  const launches: string[] = [];
  const adapter: DelegationAdapterPort = {
    async spawn({ delegationId, request }, context) {
      const sessionId = request.backend ?? `agent-${delegationId}`;
      sessions.set(sessionId, delegationId);
      const controller = context.invocation?.metadata?.runtimeExtensionIdentity;
      if (typeof controller === "string") controllers.set(sessionId, controller);
      launches.push(delegationId);
      return {
        state: "running",
        adapterHandle: sessionId,
        sessionId,
        model: "test-model",
        reasoningEffort: "high",
        transcriptRef: path.join(root, "transcript.jsonl"),
      };
    },
    async wait(handle) {
      await new Promise<void>((resolve) => pending.set(handle, resolve));
      return {
        state: "done",
        sessionId: handle,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
      };
    },
    async continue() {
      return { state: "running" };
    },
    async complete(handle) {
      pending.get(handle)?.();
      return { state: "done", sessionId: handle };
    },
    async pause(handle) {
      pending.get(handle)?.();
    },
    async cancel(handle) {
      pending.get(handle)?.();
      return { state: "failed", error: "Cancelled by test cleanup" };
    },
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(await realpath(tmpdir()), "marshal-swarm-protocol-"));
    await Promise.all(
      ["workspace", "results", "worktrees", "extensions", "runs"].map((name) =>
        mkdir(path.join(root, name)),
      ),
    );
    await writeFile(
      path.join(root, "transcript.jsonl"),
      '{"type":"message","text":"ordinary conversation"}\n',
    );
    const manager = new DelegationManager({
      store: new FileDelegationStore({ rootDirectory: path.join(root, "delegations") }),
      adapter,
    });
    const location = { isPackaged: false, appPath: process.cwd(), resourcesPath: process.cwd() };
    hostOptions = {
      location,
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot: path.join(root, "extensions"),
      nodeExecutable: process.execPath,
      resolveDelegationIdentity: async (sessionId) => {
        const delegationId = sessions.get(sessionId);
        return delegationId
          ? { delegationId, taskController: controllers.get(sessionId) }
          : undefined;
      },
      serviceContainer: createRuntimeServiceContainer(),
      authority: {
        async resolveScope(scope) {
          return { ...scope, workspacePath: path.join(root, "workspace") };
        },
        async authorize() {
          return { decision: "allow" };
        },
      },
      catalog: {
        listTools: () => [],
        listSkills: () => [],
        getSkill: () => null,
        listWorkspaces: () => [{ name: "workspace", path: path.join(root, "workspace") }],
        async getSessionContext(sessionId) {
          return {
            id: sessionId,
            name: "Protocol fixture",
            workspaceName: "workspace",
            runtimeDelegationId: sessions.get(sessionId),
          };
        },
      },
      packageLoader: {
        load: async () => ({ createAgentRuntime, createRuntimeBuiltinsSource }),
        metadata: () => ({
          name: "@marshal/runtime",
          version: "0.1.0",
          entrypoint: "dist/host.js",
          entrySha256: "0".repeat(64),
        }),
      },
      additionalProviderSources: [() => createRuntimeDelegationProvider({ manager })],
      firstPartyExtensions: resolveFirstPartyExtensionCatalog({
        location,
        runsDirectory: path.join(root, "runs"),
      }).filter((entry) => entry.identity === "@marshal/swarm"),
    };
    host = new MarshalRuntimeHost(hostOptions);
    api = new ProductionMarshalRuntimeApi(host);
    await host.start();
  }, 30_000);

  afterAll(async () => {
    for (const resolve of pending.values()) resolve();
    api?.dispose();
    await host?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function invoke(
    capability: string,
    input: Record<string, unknown>,
    sessionId = owner,
  ): Promise<Record<string, unknown>> {
    const response = await api.executeTypeScript({
      sessionId,
      workspaceName: "workspace",
      idempotencyKey: `protocol-${sequence++}`,
      input: { capability, args: input },
      source:
        "export default async (input, context) => context.runtime.invoke(input.capability, input.args);",
    });
    if (!response.ok) throw new Error(response.error.message);
    const output = response.value.output;
    if (!isRecord(output) || output.status !== "succeeded" || !isRecord(output.value))
      throw new Error(JSON.stringify(output));
    return output.value;
  }

  it(
    "launches registered nodes, permits same-principal reads, and rejects outsider mutations",
    { retry: 0, timeout: 60_000 },
    async () => {
      await invoke("swarm.runs.create", {
        runId: "protocol-run",
        objective: "Inspect explicit tasks",
        scope: "workspace",
        targetRef: "refs/heads/main",
        targetHead: "a".repeat(40),
      });
      await expect
        .poll(async () => {
          const result = await invoke("swarm.nodes.get", { runId: "protocol-run", taskId: "root" });
          return isRecord(result.node) ? result.node.state : undefined;
        })
        .toBe("running");
      const child = {
        runId: "protocol-run",
        parentTaskId: "root",
        taskId: "worker",
        role: "worker",
        objective: "Do assigned work",
        scope: "workspace",
        idempotencyKey: "one-worker",
      };
      await invoke("swarm.nodes.launch", child);
      await invoke("swarm.nodes.launch", child);
      await expect.poll(() => launches.length).toBe(2);
      const tree = await invoke("swarm.nodes.list", { runId: "protocol-run" });
      expect(tree.node).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: "root/worker", parentTaskId: "root" }),
        ]),
      );
      await expect(
        invoke("swarm.nodes.get", { runId: "protocol-run", taskId: "root" }, "unrelated-session"),
      ).resolves.toMatchObject({ node: { taskId: "root" } });
      await expect(
        invoke("swarm.runs.drive", { runId: "protocol-run" }, "unrelated-session"),
      ).rejects.toThrow(/own|authorized|denied/i);
      const workerNode = Array.isArray(tree.node)
        ? tree.node.find((node) => isRecord(node) && node.taskId === "root/worker")
        : undefined;
      const workerSession = isRecord(workerNode)
        ? [...sessions.entries()].find(([, id]) => id === workerNode.delegationId)?.[0]
        : undefined;
      expect(workerSession).toBeDefined();
      await expect(
        invoke("runtime.delegation.spawn", { prompt: "Unregistered child" }, workerSession),
      ).rejects.toThrow(/extension task operations/);
      await expect(
        invoke(
          "swarm.nodes.launch",
          { ...child, parentTaskId: "root/worker", taskId: "unauthorized" },
          workerSession,
        ),
      ).rejects.toThrow(/planner|role|children/i);
      await invoke(
        "swarm.nodes.block",
        { runId: "protocol-run", taskId: "root/worker", reason: "Waiting for user clarification" },
        workerSession,
      );
      const blocked = await invoke("swarm.nodes.get", {
        runId: "protocol-run",
        taskId: "root/worker",
      });
      expect(blocked.node).toMatchObject({
        state: "blocked",
        reason: "Waiting for user clarification",
      });
      const evidence = await invoke("swarm.runs.evidence-list", {});
      expect(evidence.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "protocol-run" })]),
      );
      await invoke("swarm.nodes.resume", {
        runId: "protocol-run",
        taskId: "root/worker",
        reason: "Clarification supplied",
      });
      await expect
        .poll(async () => {
          const result = await invoke("swarm.nodes.get", {
            runId: "protocol-run",
            taskId: "root/worker",
          });
          return isRecord(result.node) ? result.node.state : undefined;
        })
        .toBe("running");
      expect(launches).toHaveLength(2);
      await invoke(
        "swarm.nodes.complete",
        { runId: "protocol-run", taskId: "root/worker", commits: [] },
        workerSession,
      );
      await expect(
        invoke("swarm.nodes.complete", { runId: "protocol-run", taskId: "root" }),
      ).rejects.toThrow(/artifact/i);
      const artifactPath = path.join(root, "plan.md");
      await writeFile(artifactPath, "# Decisions\nThe assigned work is complete.\n");
      await invoke("swarm.nodes.publishArtifact", {
        runId: "protocol-run",
        taskId: "root",
        artifact: { uri: artifactPath, summary: "Plan and outcome", kind: "plan" },
      });
      await invoke("swarm.nodes.complete", { runId: "protocol-run", taskId: "root" });
      api.dispose();
      await host.dispose();
      host = new MarshalRuntimeHost(hostOptions);
      api = new ProductionMarshalRuntimeApi(host);
      await host.start();
      expect(await host.listExtensions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ identity: "@marshal/swarm", status: "enabled" }),
        ]),
      );
      const recovered = await invoke("swarm.runs.evidence-list", {});
      expect(recovered.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "protocol-run", status: "completed" }),
        ]),
      );
      const file = await invoke("swarm.runs.read-file", {
        runId: "protocol-run",
        taskId: "root",
        uri: artifactPath,
        offset: 0,
      });
      expect(file.text).toContain("assigned work is complete");
    },
  );
});
