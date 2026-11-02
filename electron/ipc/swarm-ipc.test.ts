import type { SwarmRun, SwarmRunTarget } from "@marshal/swarm";
import type { SwarmRunCreateInput } from "@marshal/swarm";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import type { SwarmDriver } from "../marshal-runtime/swarm-driver";
import type { MarshalSwarmWorktreeLifecycle } from "../marshal-runtime/swarm-worktree-lifecycle";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import { callIpc, type TestIpcHandlers } from "../testing/harness/call-ipc";
import { testDouble } from "../testing/harness/test-double";
import { composeRunObjective, registerSwarmHandlers, SWARM_CONVERSATION_CONTEXT_HEADING } from "./swarm-ipc";

const owner = testDouble<PersistedSession>({
  id: "owner-1",
  name: "Owner",
  workspaceName: "marshal-program",
  messages: [],
});

describe("swarm IPC", () => {
  it("forwards explicit role policy and legacy worker options to the Runtime creation input", async () => {
    const harness = createHarness();
    const roleModels = { worker: { model: "approved-worker", reasoningEffort: "high" as const } };
    await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id, objective: "Build", roleModels, workerModel: "legacy", workerReasoningEffort: "medium",
    });
    expect(createInput(harness.start)).toMatchObject({ roleModels, workerModel: "legacy", workerReasoningEffort: "medium" });
  });

  it("captures every declared resource repository and initialises one integration ref each", async () => {
    const harness = createHarness();

    const result = await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id,
      objective: "Complete both programs",
      resourceIds: ["runtime-program", "marshal-program"],
    });

    expect(result).toEqual({ success: true, runId: "created-run", state: "running" });
    expect(harness.captureTarget.mock.calls).toEqual([
      ["marshal-program", "Q:\\registered\\marshal"],
      ["runtime-program", "Q:\\registered\\runtime"],
    ]);
    const input = createInput(harness.start);
    expect(input).toEqual({
      runId: expect.stringMatching(/^owner\./),
      objective: "Complete both programs",
      scope: "marshal-program",
      targetRef: "refs/heads/main",
      targetHead: "a".repeat(40),
    });
    const targets = [
      { scope: "marshal-program", ref: "refs/heads/main", head: "a".repeat(40) },
      { scope: "runtime-program", ref: "refs/heads/main", head: "a".repeat(40) },
    ];
    expect(harness.initializeIntegration).toHaveBeenCalledWith(input.runId, targets);
    expect(harness.stageRunCreation).toHaveBeenCalledWith(input.runId, {
      targets: [
        { scope: "marshal-program", ref: "refs/heads/main", head: "a".repeat(40) },
        { scope: "runtime-program", ref: "refs/heads/main", head: "a".repeat(40) },
      ],
      configuration: {
        workerModel: "gpt-5.6-luna",
        workerReasoningEffort: "medium",
      },
    });
  });

  it("includes prior conversation in the objective", async () => {
    const harness = createHarness({
      ...owner,
      messages: [
        { id: "m1", role: "user", content: "Let's plan a checkout", timestamp: "" },
        { id: "m2", role: "assistant", content: "Split cart and pay.", timestamp: "" },
      ],
    });

    await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id,
      objective: "Build it",
    });

    const input = createInput(harness.start);
    expect(input.objective).toContain("Build it");
    expect(input.objective).toContain(SWARM_CONVERSATION_CONTEXT_HEADING);
    expect(input.objective).toContain("Let's plan a checkout");
    expect(input.objective).toContain("Split cart and pay.");
  });

  it("omits prior conversation when fresh is set", async () => {
    const harness = createHarness({
      ...owner,
      messages: [{ id: "m1", role: "user", content: "Let's plan a checkout", timestamp: "" }],
    });

    await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id,
      objective: "Build it",
      fresh: true,
    });

    expect(createInput(harness.start).objective).toBe("Build it");
  });

  it("refuses a resource set that omits the owner repository", async () => {
    const harness = createHarness();

    const result = await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id,
      objective: "Complete the program",
      resourceIds: ["runtime-program"],
    });

    expect(result).toEqual({
      success: false,
      error: 'Swarm workspace resources must include the owner workspace "marshal-program".',
    });
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.initializeIntegration).not.toHaveBeenCalled();
  });

  it("returns no command, checkpoint, budget, or revision metadata", async () => {
    const harness = createHarness();

    const created = await callIpc(harness.handlers, "swarm:create", {
      sessionId: owner.id,
      objective: "Complete the program",
    });
    const fetched = await callIpc(harness.handlers, "swarm:get", owner.id, "created-run");

    expect(created).toEqual({ success: true, runId: "created-run", state: "running" });
    expect(fetched).toEqual({ success: true, runId: "created-run", state: "completed" });
    for (const response of [created, fetched]) {
      expect(response).not.toHaveProperty("command");
      expect(response).not.toHaveProperty("checkpoint");
      expect(response).not.toHaveProperty("budget");
      expect(response).not.toHaveProperty("revision");
    }
  });
});

describe("composeRunObjective", () => {
  describe("Sanity", () => {
    it("appends a trimmed conversation under the heading", () => {
      expect(composeRunObjective("Build it", "  user: hi  ")).toBe(
        `Build it\n\n${SWARM_CONVERSATION_CONTEXT_HEADING}\nuser: hi`,
      );
    });
  });

  describe("Error Handling", () => {
    it("returns the objective when conversation is missing", () => {
      expect(composeRunObjective("Build it", undefined)).toBe("Build it");
    });
  });

  describe("Edge Cases", () => {
    it("returns the objective when conversation is only whitespace", () => {
      expect(composeRunObjective("Build it", "  ")).toBe("Build it");
    });
  });
});

function createHarness(session: PersistedSession = owner) {
  const handlers: TestIpcHandlers = new Map();
  const start = vi.fn<SwarmDriver["start"]>().mockResolvedValue(run("created-run", "running"));
  const read = vi.fn<SwarmDriver["read"]>().mockResolvedValue(run("created-run", "completed"));
  const captureTarget = vi.fn<MarshalSwarmWorktreeLifecycle["captureTarget"]>().mockImplementation(
    async (scope: string): Promise<SwarmRunTarget> => ({
      scope,
      ref: "refs/heads/main",
      head: "a".repeat(40),
    }),
  );
  const initializeIntegration = vi
    .fn<MarshalSwarmWorktreeLifecycle["initializeIntegration"]>()
    .mockResolvedValue([]);
  const stageRunCreation = vi.fn<NonNullable<MarshalSwarmWorktreeLifecycle["stageRunCreation"]>>();
  const ipcHandle = (<C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
    handlers.set(channel, testDouble<(...args: unknown[]) => unknown>(handler));
  }) as <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  registerSwarmHandlers({
    ipcHandle,
    driver: testDouble<SwarmDriver>({ start, read }),
    worktreeLifecycle: testDouble<MarshalSwarmWorktreeLifecycle>({
      captureTarget,
      initializeIntegration,
      stageRunCreation,
    }),
    sessions: testDouble<SessionManager>({
      getSessionAsync: vi.fn<SessionManager["getSessionAsync"]>(async (sessionId: string) =>
        sessionId === session.id ? session : null,
      ),
      listWorkspacesForSelfTools: vi.fn<SessionManager["listWorkspacesForSelfTools"]>(() => [
        { name: "marshal-program", path: "Q:\\registered\\marshal" },
        { name: "runtime-program", path: "Q:\\registered\\runtime" },
      ]),
    }),
  });
  return { handlers, start, captureTarget, initializeIntegration, stageRunCreation };
}

function createInput(start: ReturnType<typeof createHarness>["start"]): SwarmRunCreateInput {
  const input = start.mock.calls[0]?.[1];
  if (!input) throw new Error("Swarm create was not invoked.");
  return input;
}

function run(runId: string, state: SwarmRun["state"]): SwarmRun {
  return {
    runId,
    state,
    scope: "marshal-program",
    objective: "Complete the program",
    tasks: [],
  };
}
