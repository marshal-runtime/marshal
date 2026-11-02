import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createRuntimeServiceContainer } from "@marshal/runtime";
import { DelegationManager } from "@marshal/runtime/delegation";
import type {
  DelegationAdapterSpawnRequest,
  DelegationContext,
  DelegationRecord,
  DelegationStore,
} from "@marshal/runtime/delegation";
import { FileDelegationStore } from "@marshal/runtime/effects";
import {
  InMemorySwarmRunEventStore,
  type SwarmRoleModelService,
  type SwarmRun,
  type SwarmRunEventStore,
} from "@marshal/swarm";
import { describe, expect, it, vi } from "vitest";

import type { MSettings } from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";
import { testDouble } from "../testing/harness";
import {
  SessionManagerRuntimeAgentAdapter,
  type MarshalRuntimeAgentPort,
  type MarshalRuntimeAgentSessionPort,
  type MarshalRuntimeAgentSummary,
} from "./agent-orchestration";
import { createSwarmRunId } from "./swarm-driver";
import {
  captureMissingRunTargets,
  collectDescendantChangeRefs,
  createMarshalSwarmProduction,
  MarshalDelegationAdapter,
  recoverPersistedRuns,
} from "./swarm-production";
import {
  SWARM_EVENT_STORE_SERVICE,
  SWARM_ROLE_MODEL_SERVICE,
  SWARM_TRANSCRIPT_READER_SERVICE,
} from "./swarm-services";
import type { MarshalSwarmWorktreeLifecycle } from "./swarm-worktree-lifecycle";

const execFileAsync = promisify(execFile);
const scope = testDouble<DelegationContext>({
  scope: { sessionId: "owner-1" },
});
const owner = { workspaceName: "marshal-program" };
const workspace = { name: "marshal-program", path: "Q:\\repos\\marshal" };
const runtimeWorkspace = { name: "runtime-program", path: "Q:\\repos\\runtime" };
type SwarmRole = "planner" | "worker" | "reviewer" | "reconciler";

describe("MarshalDelegationAdapter", () => {
  it("hands oversized prompts to native launch through a bounded snapshot reference", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "swarm-instructions-"));
    try {
      const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
      const adapter = createAdapter({ launch }, undefined, undefined, directory);
      const request = spawnRequest(undefined, "worker");
      const prompt = "Complete task constraints\n".repeat(3000);
      await expect(
        adapter.spawn({ ...request, request: { ...request.request, prompt } }, scope),
      ).resolves.toMatchObject({ state: "running" });
      const nativeTask = launch.mock.calls[0]?.[0].task;
      expect(nativeTask?.length).toBeLessThanOrEqual(32768);
      expect(nativeTask).toContain(directory);
      expect(nativeTask).toContain("read this entire file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unavailable explicit models before creating an agent and preserves available models", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch }, undefined, (model) => model === "claude-opus-5[1m]");
    const request = spawnRequest(undefined, "reconciler");
    await expect(
      adapter.spawn({ ...request, request: { ...request.request, model: "missing-opus" } }, scope),
    ).resolves.toEqual({
      state: "failed",
      error: {
        message:
          'Configured delegation model "missing-opus" is unavailable; no fallback was selected.',
      },
    });
    expect(launch).not.toHaveBeenCalled();
    await expect(
      adapter.spawn(
        { ...request, request: { ...request.request, model: "claude-opus-5[1m]" } },
        scope,
      ),
    ).resolves.toMatchObject({ state: "running" });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5[1m]", runtimeAgentRole: "reconciler" }),
    );
  });

  it.each([
    ["planner", false, "swarm"],
    ["worker", true, "worker"],
    ["reviewer", false, "reviewer"],
    ["reconciler", true, "reconciler"],
  ] satisfies Array<[SwarmRole, boolean, MarshalRuntimeAgentSummary["runtimeAgentRole"]]>)(
    "routes the %s role with createWorktree=%s",
    async (role, createWorktree, runtimeAgentRole) => {
      const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
      const adapter = createAdapter({ launch });

      await expect(
        adapter.spawn(spawnRequest(runtimeWorkspace.name, role), scope),
      ).resolves.toEqual({
        adapterHandle: "agent-1",
        sessionId: "agent-1",
        state: "running",
      });
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { sessionId: "owner-1", workspaceName: "marshal-program" },
          task: "Implement the requested change",
          idempotencyKey: "delegation-1",
          workspaceName: runtimeWorkspace.name,
          repoPath: runtimeWorkspace.path,
          runtimeAgentRole,
          createWorktree,
        }),
      );
    },
  );

  it("bounds native launch keys without changing the trusted delegation identity", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch });
    const delegationId = "swarm:" + "deep-child/".repeat(60);
    await adapter.spawn(spawnRequest(undefined, "worker", delegationId), scope);
    expect(launch.mock.calls[0]?.[0].idempotencyKey).toHaveLength(64);
    expect(launch.mock.calls[0]?.[0].runtimeDelegationId).toBe(delegationId);
  });

  it("uses the owner workspace when no delegation scope is provided", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch });

    await adapter.spawn(spawnRequest(undefined, "planner"), scope);

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { sessionId: "owner-1", workspaceName: "marshal-program" },
        workspaceName: workspace.name,
        repoPath: workspace.path,
      }),
    );
  });

  it("adopts the owner session when spawn backend matches the caller", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("owner-1"));
    const adapter = createAdapter({ launch });

    await expect(
      adapter.spawn(spawnRequest(undefined, "planner", "delegation-1", "owner-1"), scope),
    ).resolves.toEqual({
      adapterHandle: "owner-1",
      sessionId: "owner-1",
      state: "running",
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "owner-1",
        runtimeAgentRole: "swarm",
        createWorktree: false,
      }),
    );
  });

  it("does not attach a foreign backend session id", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch });

    await adapter.spawn(spawnRequest(undefined, "planner", "delegation-1", "other-session"), scope);

    expect(launch.mock.calls[0]?.[0].sessionId).toBeUndefined();
  });

  it("returns the real launch failure", async () => {
    const launch = vi
      .fn<MarshalRuntimeAgentPort["launch"]>()
      .mockRejectedValue(new Error("backend rejected session creation"));
    const adapter = createAdapter({ launch });

    await expect(adapter.spawn(spawnRequest(undefined, "worker"), scope)).resolves.toEqual({
      state: "failed",
      error: { message: "backend rejected session creation" },
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("returns only execution references on idle and propagates a plain child error", async () => {
    const longOutput = "x".repeat(20_000);
    const wait = vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
      state: "completed",
      agent: agent("agent-1"),
      result: JSON.stringify({ output: longOutput }),
    });
    const adapter = createAdapter({ wait });

    await expect(adapter.wait("agent-1", scope)).resolves.toEqual({
      adapterHandle: "agent-1",
      state: "done",
      sessionId: "agent-1",
    });

    wait.mockRejectedValueOnce(new Error("Child failed plainly"));
    await expect(adapter.wait("agent-1", scope)).resolves.toEqual({
      adapterHandle: "agent-1",
      state: "failed",
      error: "Child failed plainly",
    });
  });

  it.each([
    ["planner", "swarm", undefined],
    ["reviewer", "reviewer", "Q:\\missing-read-only-checkout"],
  ] satisfies Array<
    [SwarmRole, MarshalRuntimeAgentSummary["runtimeAgentRole"], string | undefined]
  >)(
    "does not capture an own change reference for a %s",
    async (_role, runtimeAgentRole, repoPath) => {
      const wait = vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
        state: "completed",
        agent: agent("agent-1", runtimeAgentRole, repoPath),
        result: "Done",
      });
      const adapter = createAdapter({ wait });

      await expect(adapter.wait("agent-1", scope)).resolves.toEqual({
        adapterHandle: "agent-1",
        state: "done",
        sessionId: "agent-1",
      });
    },
  );

  it("preserves a user turn that races the internal adopted-owner continuation bridge", async () => {
    const get = vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockResolvedValueOnce(agent("owner-1"))
      .mockResolvedValueOnce(agent("owner-1", "swarm", undefined, "running"));
    const sendRuntimeContinuation = vi
      .fn<
        NonNullable<
          ConstructorParameters<typeof MarshalDelegationAdapter>[1]["sendRuntimeContinuation"]
        >
      >()
      .mockRejectedValue(new Error("Another message or turn is already active for this session"));
    const adapter = createAdapter({ get }, undefined, undefined, undefined, {
      sendRuntimeContinuation,
    });
    await expect(adapter.continue("owner-1", "automatic", scope)).resolves.toMatchObject({
      state: "running",
      sessionId: "owner-1",
    });
    expect(sendRuntimeContinuation).toHaveBeenCalledOnce();
  });

  it.each(["held", "accepted"] as const)(
    "preserves the internal bridge %s receipt",
    async (delivery) => {
      const get = vi.fn<MarshalRuntimeAgentPort["get"]>().mockResolvedValue(agent("agent-1"));
      const sendRuntimeContinuation = vi
        .fn<
          NonNullable<
            ConstructorParameters<typeof MarshalDelegationAdapter>[1]["sendRuntimeContinuation"]
          >
        >()
        .mockResolvedValue({ delivery });
      const adapter = createAdapter({ get }, undefined, undefined, undefined, {
        sendRuntimeContinuation,
      });
      await expect(adapter.continue("agent-1", "exact resolution", scope)).resolves.toMatchObject({
        state: "running",
        continuationDelivery: delivery,
      });
      expect(sendRuntimeContinuation).toHaveBeenCalledExactlyOnceWith(
        "owner-1",
        "agent-1",
        "exact resolution",
        0,
      );
    },
  );

  it("holds a continuation superseded before backend delivery and retries the same prompt", async () => {
    const sendRuntimeContinuation = vi
      .fn<
        NonNullable<
          ConstructorParameters<typeof MarshalDelegationAdapter>[1]["sendRuntimeContinuation"]
        >
      >()
      .mockRejectedValueOnce(new Error("Session send was superseded before it started"))
      .mockResolvedValueOnce({ delivery: "accepted" });
    const adapter = createAdapter(
      { get: async (_scope, id) => agent(id) },
      undefined,
      undefined,
      undefined,
      { sendRuntimeContinuation },
    );
    await expect(adapter.continue("owner-1", "blocked child reason", scope)).resolves.toMatchObject(
      { state: "running", continuationDelivery: "held" },
    );
    await expect(adapter.continue("owner-1", "blocked child reason", scope)).resolves.toMatchObject(
      { state: "running", continuationDelivery: "accepted" },
    );
    expect(sendRuntimeContinuation).toHaveBeenCalledTimes(2);
  });

  it("does not enqueue an automatic continuation for a busy child", async () => {
    const send = vi.fn<MarshalRuntimeAgentPort["send"]>();
    const get = vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockResolvedValue(agent("child", "worker", undefined, "running"));
    await expect(
      createAdapter({ get, send }).continue("child", "automatic", scope),
    ).resolves.toMatchObject({ state: "running", continuationDelivery: "held" });
    expect(send).not.toHaveBeenCalled();
  });

  it("continues the same child session when Runtime requests a follow-up", async () => {
    const send = vi.fn<MarshalRuntimeAgentPort["send"]>().mockResolvedValue({
      agent: agent("agent-1"),
      accepted: true,
      messageId: "message-1",
    });
    const adapter = createAdapter({ send, get: async (_scope, id) => agent(id) });

    await expect(
      adapter.continue("agent-1", "Continue after children settle", scope),
    ).resolves.toEqual({
      adapterHandle: "agent-1",
      sessionId: "agent-1",
      state: "running",
      continuationDelivery: "accepted",
    });
    expect(send).toHaveBeenCalledWith(
      { sessionId: "owner-1", workspaceName: "marshal-program" },
      "agent-1",
      "Continue after children settle",
      "queue",
      undefined,
    );
  });

  it("continues an adopted owner through native delivery without a subagent message ID", async () => {
    const sendMessage = vi.fn<MarshalRuntimeAgentSessionPort["sendMessage"]>().mockResolvedValue();
    const native = new SessionManagerRuntimeAgentAdapter(
      testDouble<MarshalRuntimeAgentSessionPort>({
        getSessionAsync: async () =>
          testDouble<PersistedSession>({
            ...agent("owner-1", "swarm"),
            workspaceName: workspace.name,
            messages: [],
          }),
        isSessionBusy: () => false,
        sendMessage,
      }),
    );
    const adapter = createAdapter(native);

    await expect(
      adapter.continue("owner-1", "Continue after children settle", scope),
    ).resolves.toEqual({
      adapterHandle: "owner-1",
      sessionId: "owner-1",
      state: "running",
      continuationDelivery: "accepted",
    });
    expect(sendMessage).toHaveBeenCalledWith("owner-1", "Continue after children settle");

    sendMessage.mockRejectedValueOnce(new Error("backend rejected continuation"));
    await expect(adapter.continue("owner-1", "Retry", scope)).resolves.toEqual({
      adapterHandle: "owner-1",
      state: "failed",
      error: "backend rejected continuation",
    });
  });

  it("reuses the current adopted owner turn when the owner resumes its own run", async () => {
    const sendMessage = vi
      .fn<MarshalRuntimeAgentSessionPort["sendMessage"]>()
      .mockRejectedValue(new Error("Another message or turn is already active for this session"));
    const sendMessageToSubagent = vi.fn<MarshalRuntimeAgentSessionPort["sendMessageToSubagent"]>();
    const native = new SessionManagerRuntimeAgentAdapter(
      testDouble<MarshalRuntimeAgentSessionPort>({
        getSessionAsync: async () =>
          testDouble<PersistedSession>({
            ...agent("owner-1", "swarm"),
            workspaceName: workspace.name,
            messages: [],
          }),
        isSessionBusy: () => true,
        getRuntimeExecutionEvidence: () => ({
          sessionId: "owner-1",
          executionId: "active-owner-turn",
        }),
        sendMessage,
        sendMessageToSubagent,
      }),
    );
    await expect(
      createAdapter(native).continue("owner-1", "Resume the run", scope),
    ).resolves.toEqual({
      adapterHandle: "owner-1",
      sessionId: "owner-1",
      state: "running",
      continuationDelivery: "held",
      executionId: "active-owner-turn",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageToSubagent).not.toHaveBeenCalled();
  });

  it("reuses an owner turn that starts while its continuation is being sent", async () => {
    const get = vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockResolvedValueOnce(agent("owner-1"))
      .mockResolvedValueOnce(agent("owner-1", "swarm", undefined, "running"));
    const send = vi
      .fn<MarshalRuntimeAgentPort["send"]>()
      .mockRejectedValue(new Error("Another message or turn is already active for this session"));
    await expect(
      createAdapter({ get, send }).continue("owner-1", "Resume", scope),
    ).resolves.toEqual({
      adapterHandle: "owner-1",
      sessionId: "owner-1",
      state: "running",
      continuationDelivery: "held",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not reinterpret a child continuation rejection as an active owner turn", async () => {
    const send = vi
      .fn<MarshalRuntimeAgentPort["send"]>()
      .mockRejectedValue(new Error("Another message or turn is already active for this session"));
    const get = vi.fn<MarshalRuntimeAgentPort["get"]>().mockResolvedValue(agent("agent-1"));
    await expect(
      createAdapter({ get, send }).continue("agent-1", "Continue", scope),
    ).resolves.toEqual({
      adapterHandle: "agent-1",
      state: "failed",
      error: "Another message or turn is already active for this session",
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it.each(["running", "idle"] as const)(
    "recovers an existing %s owner without delivering or spawning work",
    async (state) => {
      const get = vi
        .fn<MarshalRuntimeAgentPort["get"]>()
        .mockResolvedValue(agent("owner-1", "swarm", undefined, state));
      const send = vi.fn<MarshalRuntimeAgentPort["send"]>();
      const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>();
      await expect(createAdapter({ get, send, launch }).recover("owner-1", scope)).resolves.toEqual(
        {
          adapterHandle: "owner-1",
          sessionId: "owner-1",
          state: state === "running" ? "running" : "done",
        },
      );
      expect(send).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("refuses recovery of a missing owner or a different session", async () => {
    const get = vi.fn<MarshalRuntimeAgentPort["get"]>().mockResolvedValue(null);
    const adapter = createAdapter({ get });
    await expect(adapter.recover("agent-1", scope)).rejects.toThrow("existing adopted owner");
    expect(get).not.toHaveBeenCalled();
    await expect(adapter.recover("owner-1", scope)).rejects.toThrow("existing owner session");
  });

  it("recovers a persisted failed root through the native owner while preserving child delegation links", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "marshal-delegation-recovery-"));
    try {
      const store = new FileDelegationStore({ rootDirectory: directory });
      const failure = "Another message or turn is already active for this session";
      await store.create({
        delegationId: "root-delegation",
        adapterHandle: "owner-1",
        sessionId: "owner-1",
        ownerSessionId: "owner-1",
        state: "failed",
        error: failure,
      });
      await store.create({
        delegationId: "child-delegation",
        parentDelegationId: "root-delegation",
        adapterHandle: "child-1",
        state: "running",
      });
      const sendMessage = vi.fn<MarshalRuntimeAgentSessionPort["sendMessage"]>();
      const createSubagentSession =
        vi.fn<MarshalRuntimeAgentSessionPort["createSubagentSession"]>();
      const native = new SessionManagerRuntimeAgentAdapter(
        testDouble<MarshalRuntimeAgentSessionPort>({
          getSessionAsync: async () =>
            testDouble<PersistedSession>({
              ...agent("owner-1", "swarm"),
              workspaceName: workspace.name,
              messages: [],
            }),
          isSessionBusy: () => true,
          sendMessage,
          createSubagentSession,
        }),
      );
      const manager = new DelegationManager({ store, adapter: createAdapter(native) });
      const continuation = { delegationId: "root-delegation", prompt: "Resume the existing run" };
      expect((await manager.continue(continuation, scope)).state).toBe("failed");
      const recovery = {
        delegationId: "root-delegation",
        expectedError: failure,
        reason: "Verified owner execution remains live",
        idempotencyKey: "recover-root",
      };
      expect(await manager.recover(recovery, scope)).toMatchObject({
        delegationId: "root-delegation",
        adapterHandle: "owner-1",
        sessionId: "owner-1",
        state: "running",
      });
      const resumed = await manager.continue(continuation, scope);
      expect(resumed).toMatchObject({
        delegationId: "root-delegation",
        adapterHandle: "owner-1",
        state: "running",
      });
      const reopenedStore = new FileDelegationStore({ rootDirectory: directory });
      const restarted = new DelegationManager({
        store: reopenedStore,
        adapter: createAdapter(native),
      });
      const { continuationDelivery, ...persistedExecution } = resumed;
      expect(continuationDelivery).toBe("held");
      const recovered = await restarted.recover(recovery, scope);
      expect(recovered).toEqual(persistedExecution);
      expect(recovered).not.toHaveProperty("continuationDelivery");
      expect(await reopenedStore.get("child-delegation")).toMatchObject({
        parentDelegationId: "root-delegation",
        adapterHandle: "child-1",
        state: "running",
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(createSubagentSession).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still rejects a child continuation without a durable message ID", async () => {
    const send = vi.fn<MarshalRuntimeAgentPort["send"]>().mockResolvedValue({
      agent: agent("agent-1"),
      accepted: true,
    });

    await expect(
      createAdapter({ send, get: async (_scope, id) => agent(id) }).continue(
        "agent-1",
        "Continue",
        scope,
      ),
    ).resolves.toEqual({
      adapterHandle: "agent-1",
      state: "failed",
      error: 'Native agent "agent-1" returned no continuation message ID.',
    });
  });

  it("returns failed when Runtime cancels a native agent", async () => {
    const cancel = vi.fn<MarshalRuntimeAgentPort["cancel"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ cancel });

    await expect(adapter.cancel("agent-1", scope)).resolves.toEqual({
      adapterHandle: "agent-1",
      state: "failed",
      error: 'Native agent "agent-1" was cancelled.',
    });
  });

  it("resolves a repeated pause harmlessly when the agent is gone or already idle", async () => {
    const send = vi.fn<MarshalRuntimeAgentPort["send"]>();
    const get = vi.fn<MarshalRuntimeAgentPort["get"]>().mockResolvedValue(null);
    const adapter = createAdapter({ get, send });

    await expect(adapter.pause("agent-1", "run paused", scope)).resolves.toBeUndefined();
    await expect(adapter.pause("agent-1", "run paused", scope)).resolves.toBeUndefined();

    get.mockResolvedValue(agent("agent-1"));
    await expect(adapter.pause("agent-1", "run paused", scope)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves a pause whose interrupt lands on a session being deleted", async () => {
    const get = vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockResolvedValue(agent("agent-1", undefined, undefined, "running"));
    const send = vi
      .fn<MarshalRuntimeAgentPort["send"]>()
      .mockRejectedValue(new Error("This chat is being deleted"));
    const adapter = createAdapter({ get, send });

    await expect(adapter.pause("agent-1", "run paused", scope)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a real pause failure", async () => {
    const get = vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockResolvedValue(agent("agent-1", undefined, undefined, "running"));
    const send = vi
      .fn<MarshalRuntimeAgentPort["send"]>()
      .mockRejectedValue(new Error("interrupt delivery rejected"));
    const adapter = createAdapter({ get, send });

    await expect(adapter.pause("agent-1", "run paused", scope)).rejects.toThrow(
      "interrupt delivery rejected",
    );
  });

  it("routes a formal swarm spawn through the admission gate", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const admitLaunch = vi
      .fn<MarshalSwarmWorktreeLifecycle["admitLaunch"]>()
      .mockImplementation(async (_scope, _createsWorktree, _signal, inner) => inner());
    const adapter = new MarshalDelegationAdapter(
      testDouble<DelegationStore>({
        get: vi.fn<DelegationStore["get"]>(async () => delegation("delegation-1", "agent-1")),
        list: vi.fn<DelegationStore["list"]>(async () => []),
      }),
      {
        listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
        getSessionAsync: async (sessionId) => (sessionId === "owner-1" ? owner : null),
      },
      testDouble<MarshalRuntimeAgentPort>({ launch }),
      testDouble<MarshalSwarmWorktreeLifecycle>({
        admitLaunch,
        environmentalError: vi
          .fn<MarshalSwarmWorktreeLifecycle["environmentalError"]>()
          .mockReturnValue(undefined),
        resolveIntegrationRefForDelegation: vi
          .fn<MarshalSwarmWorktreeLifecycle["resolveIntegrationRefForDelegation"]>()
          .mockResolvedValue(undefined),
      }),
    );

    await expect(adapter.spawn(spawnRequest(undefined, "worker"), scope)).resolves.toEqual({
      adapterHandle: "agent-1",
      sessionId: "agent-1",
      state: "running",
    });
    expect(admitLaunch).toHaveBeenCalledWith(
      { sessionId: "owner-1", workspaceName: "marshal-program" },
      true,
      undefined,
      expect.any(Function),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("forks an isolated child from the baseline the executor resolved", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch });

    await adapter.spawn(
      {
        delegationId: "delegation-1",
        request: {
          prompt: "Implement the requested change",
          role: "worker",
          baseRef: "refs/swarm/run/integration/marshal-program",
        },
      },
      scope,
    );

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        createWorktree: true,
        baseRef: "refs/swarm/run/integration/marshal-program",
      }),
    );
  });

  it("omits baseRef when the executor resolved no baseline", async () => {
    const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent("agent-1"));
    const adapter = createAdapter({ launch });

    await adapter.spawn(spawnRequest(undefined, "worker"), scope);

    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty("baseRef");
  });

  it("finalizes the requested root when multiple runs share the owner session", async () => {
    const records = [
      delegation("old-root", "owner-1"),
      { ...delegation("current-root", "owner-1"), ownerSessionId: "owner-1" },
      delegation("old-child", "old-agent", "old-root", ["old-commit"]),
      delegation("current-child", "current-agent", "current-root", ["current-commit"]),
    ];
    const integrateRoot = vi.fn<MarshalSwarmWorktreeLifecycle["integrateRoot"]>();
    const adapter = new MarshalDelegationAdapter(
      testDouble<DelegationStore>({ list: async () => records }),
      {
        listWorkspacesForSelfTools: () => [workspace],
        getSessionAsync: async () => owner,
      },
      testDouble<MarshalRuntimeAgentPort>({ get: async () => agent("owner-1") }),
      testDouble<MarshalSwarmWorktreeLifecycle>({ integrateRoot }),
    );
    const result = await adapter.complete("owner-1", scope, "current-root");
    expect(result).toMatchObject({ state: "done", changeRefs: ["current-commit"] });
    expect(integrateRoot).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({
      integrationWarning: expect.stringContaining("owner checkout was not changed"),
    });
    await expect(adapter.complete("owner-1", scope, "missing-root")).rejects.toThrow(
      "does not match",
    );
    await expect(adapter.complete("owner-1", scope, "old-child")).rejects.toThrow("does not match");
    await expect(adapter.complete("owner-1", scope)).rejects.toThrow("portable delegation ID");
    expect(integrateRoot).not.toHaveBeenCalled();
    // Separately launched roots retain their existing integration behavior.
    await adapter.complete("owner-1", scope, "old-root");
    expect(integrateRoot).toHaveBeenCalledExactlyOnceWith({
      rootDelegationId: "old-root",
      records,
      ownerScope: { sessionId: "owner-1", workspaceName: "marshal-program" },
    });
  });

  it("promotes a worktree only on explicit completion without waiting for idle", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "swarm-production-branch-"));
    try {
      await git(repository, ["init", "--initial-branch", "main"]);
      await git(repository, ["config", "user.email", "swarm@example.test"]);
      await git(repository, ["config", "user.name", "Swarm"]);
      await writeFile(path.join(repository, "change.txt"), "change\n", "utf8");
      await git(repository, ["add", "change.txt"]);
      await git(repository, ["commit", "-q", "-m", "change"]);
      const wait = vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
        state: "completed",
        agent: agent("agent-1", "worker", repository),
        result: "Done",
      });
      const promoteCompletedDelegation = vi
        .fn<MarshalSwarmWorktreeLifecycle["promoteCompletedDelegation"]>()
        .mockResolvedValue(undefined);
      const reclaimCapturedWorktrees = vi
        .fn<MarshalSwarmWorktreeLifecycle["reclaimCapturedWorktrees"]>()
        .mockResolvedValue(undefined);
      const records = [
        delegation("root-delegation", "root-agent"),
        delegation("delegation-1", "agent-1", "root-delegation"),
      ];
      const adapter = new MarshalDelegationAdapter(
        testDouble<DelegationStore>({
          list: vi.fn<DelegationStore["list"]>(async () => records),
        }),
        {
          listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
          getSessionAsync: async (sessionId) => (sessionId === "owner-1" ? owner : null),
        },
        testDouble<MarshalRuntimeAgentPort>({
          wait,
          get: async () => agent("agent-1", "worker", repository),
        }),
        testDouble<MarshalSwarmWorktreeLifecycle>({
          promoteCompletedDelegation,
          reclaimCapturedWorktrees,
        }),
      );

      await adapter.wait("agent-1", scope);
      expect(promoteCompletedDelegation).not.toHaveBeenCalled();
      const settled = await adapter.complete("agent-1", scope);

      expect(settled).toMatchObject({
        adapterHandle: "agent-1",
        state: "done",
        sessionId: "agent-1",
      });
      expect(settled.changeRefs).toEqual(["refs/heads/main"]);
      expect(promoteCompletedDelegation).toHaveBeenCalledWith({
        delegationId: "delegation-1",
        worktreePath: repository,
      });
      expect(reclaimCapturedWorktrees).toHaveBeenCalledWith({
        delegationId: "delegation-1",
        records,
        ownerScope: { sessionId: "owner-1", workspaceName: "marshal-program" },
      });
    } finally {
      await rm(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("captures the exact commit when a completed child is detached", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "swarm-production-"));
    try {
      await git(repository, ["init", "--initial-branch", "main"]);
      await git(repository, ["config", "user.email", "swarm@example.test"]);
      await git(repository, ["config", "user.name", "Swarm"]);
      await writeFile(path.join(repository, "change.txt"), "change\n", "utf8");
      await git(repository, ["add", "change.txt"]);
      await git(repository, ["commit", "-q", "-m", "change"]);
      const commit = await gitText(repository, ["rev-parse", "HEAD"]);
      await git(repository, ["checkout", "-q", "--detach", "HEAD"]);

      const wait = vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
        state: "completed",
        agent: agent("agent-1", "worker", repository),
        result: "Done",
      });
      const adapter = new MarshalDelegationAdapter(
        testDouble<DelegationStore>({
          list: vi.fn<DelegationStore["list"]>(async () => [
            delegation("delegation-1", "agent-1", "root-delegation"),
          ]),
        }),
        {
          listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
          getSessionAsync: async (sessionId) => (sessionId === "owner-1" ? owner : null),
        },
        testDouble<MarshalRuntimeAgentPort>({
          wait,
          get: async () => agent("agent-1", "worker", repository),
        }),
        testDouble<MarshalSwarmWorktreeLifecycle>({
          promoteCompletedDelegation: vi
            .fn<MarshalSwarmWorktreeLifecycle["promoteCompletedDelegation"]>()
            .mockResolvedValue(undefined),
          reclaimCapturedWorktrees: vi
            .fn<MarshalSwarmWorktreeLifecycle["reclaimCapturedWorktrees"]>()
            .mockResolvedValue(undefined),
        }),
      );

      const settled = await adapter.complete("agent-1", scope);
      expect(settled, JSON.stringify(settled)).toMatchObject({
        adapterHandle: "agent-1",
        state: "done",
        sessionId: "agent-1",
        changeRefs: [commit],
      });
    } finally {
      await rm(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("never promotes or reclaims for a child that has no worktree", async () => {
    const wait = vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
      state: "completed",
      agent: agent("agent-1", "reviewer", "Q:\\missing-read-only-checkout"),
      result: "Done",
    });
    const promoteCompletedDelegation = vi
      .fn<MarshalSwarmWorktreeLifecycle["promoteCompletedDelegation"]>()
      .mockResolvedValue(undefined);
    const reclaimCapturedWorktrees = vi
      .fn<MarshalSwarmWorktreeLifecycle["reclaimCapturedWorktrees"]>()
      .mockResolvedValue(undefined);
    const adapter = new MarshalDelegationAdapter(
      testDouble<DelegationStore>({
        list: vi.fn<DelegationStore["list"]>(async () => [delegation("delegation-1", "agent-1")]),
      }),
      {
        listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
        getSessionAsync: async (sessionId) => (sessionId === "owner-1" ? owner : null),
      },
      testDouble<MarshalRuntimeAgentPort>({ wait }),
      testDouble<MarshalSwarmWorktreeLifecycle>({
        promoteCompletedDelegation,
        reclaimCapturedWorktrees,
      }),
    );

    await adapter.wait("agent-1", scope);

    expect(promoteCompletedDelegation).not.toHaveBeenCalled();
    expect(reclaimCapturedWorktrees).not.toHaveBeenCalled();
  });
});

describe("Marshal Swarm production composition", () => {
  it("passes the exact shared Runtime container through the pinned Swarm boundary", async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), "swarm-production-container-"));
    const serviceContainer = createRuntimeServiceContainer();
    const releaseRuntimeTaskController = vi.fn<
      (sessionId: string, delegationId: string) => Promise<void>
    >(async () => undefined);
    const transcriptPage = { uri: "/session.json", text: "readable transcript", truncated: false };
    const readRuntimeTranscript = vi.fn<
      Parameters<typeof createMarshalSwarmProduction>[0]["sessions"]["readRuntimeTranscript"]
    >(async () => transcriptPage);
    try {
      const production = createMarshalSwarmProduction({
        rootDirectory,
        serviceContainer,
        sessions: testDouble<Parameters<typeof createMarshalSwarmProduction>[0]["sessions"]>({
          listWorkspacesForSelfTools: () => [],
          getDefaultModel: () => "sonnet",
          isModelAvailable: (model: string) => model === "sonnet",
          getSessionAsync: async () => null,
          releaseRuntimeTaskController,
          readRuntimeTranscript,
        }),
        getSettings: () =>
          testDouble<MSettings>({
            swarmWorkerModel: "gpt-5.6-luna",
            swarmWorkerReasoningEffort: "medium",
          }),
        deliverCleanupAdvice: async () => undefined,
      });

      expect(production.swarmOptions.serviceContainer).toBe(serviceContainer);
      const handles = await production.serviceBindingHandles;
      const transcriptReader = serviceContainer.get(SWARM_TRANSCRIPT_READER_SERVICE);
      const transcriptRequest = { sessionId: "child-1", uri: "/session.json", offset: 64 };
      await expect(transcriptReader.read(transcriptRequest)).resolves.toEqual(transcriptPage);
      expect(readRuntimeTranscript).toHaveBeenCalledExactlyOnceWith(transcriptRequest);
      expect(serviceContainer.tryGet(SWARM_EVENT_STORE_SERVICE)).toBe(
        production.swarmOptions.eventStore,
      );
      const roles = serviceContainer.get<SwarmRoleModelService>(SWARM_ROLE_MODEL_SERVICE);
      expect(roles.resolve("planner")).toEqual({ model: "sonnet", reasoningEffort: "max" });
      expect(() => roles.resolve("worker")).toThrow(
        'Configured Swarm model "gpt-5.6-luna" is unavailable; no fallback was selected.',
      );
      vi.spyOn(production.worktreeLifecycle, "retireCompletedRun").mockRejectedValue(
        new Error("cleanup unavailable"),
      );
      const completedRun = testDouble<SwarmRun>({
        runId: "run-1",
        state: "completed",
        tasks: [{ taskId: "root", delegationId: "root-delegation" }],
      });
      await production.onRunSettled(
        { sessionId: "owner-1", workspaceName: workspace.name },
        { ...completedRun, state: "failed" },
      );
      expect(releaseRuntimeTaskController).not.toHaveBeenCalled();
      await production.onRunSettled(
        { sessionId: "owner-1", workspaceName: workspace.name },
        completedRun,
      );
      expect(releaseRuntimeTaskController).toHaveBeenCalledExactlyOnceWith(
        "owner-1",
        "root-delegation",
      );
      await Promise.all(handles.map((handle) => handle.dispose()));
    } finally {
      await rm(rootDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
});

describe("swarm terminal settlement and recovery", () => {
  type ProductionOptions = Parameters<typeof createMarshalSwarmProduction>[0];

  async function makeProduction(onRunTerminalFailure?: ProductionOptions["onRunTerminalFailure"]) {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), "swarm-production-terminal-"));
    const releaseRuntimeTaskController = vi.fn<
      (sessionId: string, delegationId: string) => Promise<void>
    >(async () => undefined);
    const production = createMarshalSwarmProduction({
      rootDirectory,
      serviceContainer: createRuntimeServiceContainer(),
      sessions: testDouble<ProductionOptions["sessions"]>({
        listWorkspacesForSelfTools: () => [],
        getDefaultModel: () => "sonnet",
        isModelAvailable: (model: string) => model === "sonnet",
        getSessionAsync: async () => null,
        releaseRuntimeTaskController,
        readRuntimeTranscript: async () => ({ uri: "/t.json", text: "", truncated: false }),
      }),
      getSettings: () => testDouble<MSettings>({}),
      deliverCleanupAdvice: async () => undefined,
      ...(onRunTerminalFailure ? { onRunTerminalFailure } : {}),
    });
    const retire = vi
      .spyOn(production.worktreeLifecycle, "retireCompletedRun")
      .mockResolvedValue(undefined);
    return { production, releaseRuntimeTaskController, retire, rootDirectory };
  }

  function failedRun(runId: string, delegationId?: string): SwarmRun {
    return testDouble<SwarmRun>({
      runId,
      state: "failed",
      error: "root worker crashed",
      tasks: delegationId ? [{ taskId: "root", delegationId }] : [],
    });
  }

  it("ordinary failed settlement hands off with the root delegation and retains the controller", async () => {
    const onRunTerminalFailure = vi.fn<NonNullable<ProductionOptions["onRunTerminalFailure"]>>(
      async () => undefined,
    );
    const { production, releaseRuntimeTaskController, retire, rootDirectory } =
      await makeProduction(onRunTerminalFailure);
    try {
      const runId = createSwarmRunId("owner-1", "failed");
      await production.onRunSettled(
        { sessionId: "owner-1", workspaceName: workspace.name },
        failedRun(runId, "root-delegation"),
      );
      expect(onRunTerminalFailure).toHaveBeenCalledExactlyOnceWith({
        sessionId: "owner-1",
        runId,
        delegationId: "root-delegation",
        reason: "root worker crashed",
        abandoned: false,
      });
      expect(releaseRuntimeTaskController).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("failed settlement without a root delegation is an evidence gap: no handoff, no release", async () => {
    const onRunTerminalFailure = vi.fn<NonNullable<ProductionOptions["onRunTerminalFailure"]>>(
      async () => undefined,
    );
    const { production, releaseRuntimeTaskController, rootDirectory } =
      await makeProduction(onRunTerminalFailure);
    try {
      await production.onRunSettled(
        { sessionId: "owner-1", workspaceName: workspace.name },
        failedRun(createSwarmRunId("owner-1", "no-delegation")),
      );
      expect(onRunTerminalFailure).not.toHaveBeenCalled();
      expect(releaseRuntimeTaskController).not.toHaveBeenCalled();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("abandoned settlement hands off first, then releases only the matching controller", async () => {
    const onRunTerminalFailure = vi.fn<NonNullable<ProductionOptions["onRunTerminalFailure"]>>(
      async () => undefined,
    );
    const { production, releaseRuntimeTaskController, rootDirectory } =
      await makeProduction(onRunTerminalFailure);
    try {
      const runId = createSwarmRunId("owner-1", "abandoned");
      await production.onRunAbandoned(
        { sessionId: "owner-1", workspaceName: workspace.name },
        failedRun(runId, "root-delegation"),
      );
      expect(onRunTerminalFailure).toHaveBeenCalledExactlyOnceWith({
        sessionId: "owner-1",
        runId,
        delegationId: "root-delegation",
        reason: "root worker crashed",
        abandoned: true,
      });
      expect(releaseRuntimeTaskController).toHaveBeenCalledExactlyOnceWith(
        "owner-1",
        "root-delegation",
      );
      expect(onRunTerminalFailure.mock.invocationCallOrder[0]).toBeLessThan(
        releaseRuntimeTaskController.mock.invocationCallOrder[0] ?? Number.NaN,
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("abandoned settlement without a root delegation releases nothing", async () => {
    const { production, releaseRuntimeTaskController, rootDirectory } = await makeProduction();
    try {
      await production.onRunAbandoned(
        { sessionId: "owner-1", workspaceName: workspace.name },
        failedRun(createSwarmRunId("owner-1", "abandoned-unproven")),
      );
      expect(releaseRuntimeTaskController).not.toHaveBeenCalled();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("recovery settles persisted terminal runs and logs unrecoverable ones without guessing", async () => {
    const inner = new InMemorySwarmRunEventStore();
    const failedRunId = createSwarmRunId("owner-1", "persisted-failed");
    await inner.create(failedRunId, "objective", workspace.name);
    await inner.append(failedRunId, {
      type: "task.added",
      task: { taskId: "root", role: "worker", objective: "objective", scope: workspace.name },
    });
    await inner.append(failedRunId, {
      type: "task.started",
      taskId: "root",
      delegationId: "root-delegation",
    });
    await inner.append(failedRunId, { type: "run.failed", error: "root worker crashed" });
    const completedRunId = createSwarmRunId("owner-2", "persisted-completed");
    await inner.create(completedRunId, "objective", workspace.name);
    await inner.append(completedRunId, {
      type: "task.added",
      task: { taskId: "root", role: "worker", objective: "objective", scope: workspace.name },
    });
    await inner.append(completedRunId, {
      type: "task.started",
      taskId: "root",
      delegationId: "done-delegation",
    });
    await inner.append(completedRunId, { type: "task.completed", taskId: "root", result: "done" });
    await inner.append(completedRunId, { type: "run.completed", result: "done" });
    const legacyRunId = "legacy-run-without-owner-prefix";
    await inner.create(legacyRunId, "objective", workspace.name);
    const brokenRunId = createSwarmRunId("owner-3", "broken");
    const eventStore: SwarmRunEventStore = {
      create: (...args) => inner.create(...args),
      append: (...args) => inner.append(...args),
      list: async () => [...(await inner.list()), brokenRunId],
      read: (runId) =>
        runId === brokenRunId ? Promise.reject(new Error("corrupt event log")) : inner.read(runId),
    };
    const onRunSettled = vi.fn<(scope: unknown, run: SwarmRun) => Promise<void>>(
      async () => undefined,
    );
    const drive = vi.fn<(scope: unknown, runId: string) => Promise<SwarmRun>>(async () =>
      failedRun(failedRunId),
    );

    await recoverPersistedRuns(eventStore, { drive }, onRunSettled);

    const settledRunIds = onRunSettled.mock.calls.map(([, run]) => run.runId).sort();
    expect(settledRunIds).toEqual([completedRunId, failedRunId].sort());
    const failedCall = onRunSettled.mock.calls.find(([, run]) => run.runId === failedRunId);
    expect(failedCall?.[0]).toEqual({ sessionId: "owner-1", workspaceName: workspace.name });
    expect(failedCall?.[1]).toMatchObject({ state: "failed", error: "root worker crashed" });
    // The legacy id (no owner prefix) and the corrupt log are logged evidence
    // gaps: recovery neither settles them nor throws.
    expect(drive).not.toHaveBeenCalled();
  });
});

describe("collectDescendantChangeRefs", () => {
  it("collects native refs through portable planner delegations", () => {
    const records = [
      delegation("root", "root-agent"),
      delegation("middle", "middle-agent", "root"),
      delegation("implementation", "implementation-agent", "middle", [
        "refs/heads/marshal/subagent/implementation",
      ]),
    ];

    expect(collectDescendantChangeRefs(records, "root")).toEqual([
      "refs/heads/marshal/subagent/implementation",
    ]);
  });
});

function createAdapter(
  agents: Partial<MarshalRuntimeAgentPort>,
  records: readonly DelegationRecord[] = [delegation("delegation-1", "agent-1")],
  isModelAvailable?: (model: string) => boolean,
  instructionDirectory?: string,
  continuationBridge?: Partial<ConstructorParameters<typeof MarshalDelegationAdapter>[1]>,
): MarshalDelegationAdapter {
  return new MarshalDelegationAdapter(
    testDouble<DelegationStore>({
      list: vi.fn<DelegationStore["list"]>(async () => records),
    }),
    {
      listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
      getSessionAsync: async (sessionId) => (sessionId === "owner-1" ? owner : null),
      ...continuationBridge,
    },
    testDouble<MarshalRuntimeAgentPort>(agents),
    undefined,
    isModelAvailable,
    instructionDirectory,
  );
}

function spawnRequest(
  workspaceScope?: string,
  role?: SwarmRole,
  delegationId = "delegation-1",
  backend?: string,
): DelegationAdapterSpawnRequest {
  return {
    delegationId,
    request: {
      prompt: "Implement the requested change",
      ...(workspaceScope ? { scope: workspaceScope } : {}),
      ...(role ? { role } : {}),
      ...(backend ? { backend } : {}),
    },
  };
}

function agent(
  id: string,
  runtimeAgentRole?: MarshalRuntimeAgentSummary["runtimeAgentRole"],
  repoPath?: string,
  state: MarshalRuntimeAgentSummary["state"] = "idle",
): MarshalRuntimeAgentSummary {
  return {
    id,
    name: id,
    state,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:01.000Z",
    ...(runtimeAgentRole ? { runtimeAgentRole } : {}),
    ...(repoPath ? { repoPath } : {}),
  };
}

function delegation(
  delegationId: string,
  adapterHandle: string,
  parentDelegationId?: string,
  changeRefs?: readonly string[],
): DelegationRecord {
  return {
    delegationId,
    adapterHandle,
    state: "done",
    ...(parentDelegationId ? { parentDelegationId } : {}),
    ...(changeRefs ? { changeRefs } : {}),
  };
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  await gitText(repository, args);
}

async function gitText(repository: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd: repository, windowsHide: true });
  return result.stdout.trim();
}

describe("captureMissingRunTargets", () => {
  const OWNER_SESSION_ID = "owner-1";
  const UNPARSED_RUN_ID = "recursion-run";

  it("captures the owner workspace when the run id encodes the session", async () => {
    const target = { scope: workspace.name, ref: "refs/heads/main", head: "abc" };
    const captureTarget = vi
      .fn<MarshalSwarmWorktreeLifecycle["captureTarget"]>()
      .mockResolvedValue(target);
    const initializeIntegration = vi
      .fn<MarshalSwarmWorktreeLifecycle["initializeIntegration"]>()
      .mockResolvedValue([]);
    const lifecycle = testDouble<MarshalSwarmWorktreeLifecycle>({
      captureTarget,
      initializeIntegration,
    });
    const sessions = {
      listWorkspacesForSelfTools: () => [workspace, runtimeWorkspace],
      getSessionAsync: async () => owner,
    };
    const runId = createSwarmRunId(OWNER_SESSION_ID, "suffix");

    await expect(
      captureMissingRunTargets(lifecycle, sessions, runId, workspace.name),
    ).resolves.toEqual([target]);
    expect(captureTarget).toHaveBeenCalledWith(workspace.name, workspace.path);
    expect(initializeIntegration).toHaveBeenCalledWith(runId, [target]);
  });

  it("skips capture when the run id has no owner prefix", async () => {
    const lifecycle = testDouble<MarshalSwarmWorktreeLifecycle>({
      captureTarget: vi.fn<MarshalSwarmWorktreeLifecycle["captureTarget"]>(),
      initializeIntegration: vi.fn<MarshalSwarmWorktreeLifecycle["initializeIntegration"]>(),
    });
    const sessions = {
      listWorkspacesForSelfTools: () => [workspace],
      getSessionAsync: async () => owner,
    };

    await expect(
      captureMissingRunTargets(lifecycle, sessions, UNPARSED_RUN_ID, workspace.name),
    ).resolves.toBeUndefined();
    expect(lifecycle.captureTarget).not.toHaveBeenCalled();
  });

  it("skips capture when the owner workspace is not registered", async () => {
    const lifecycle = testDouble<MarshalSwarmWorktreeLifecycle>({
      captureTarget: vi.fn<MarshalSwarmWorktreeLifecycle["captureTarget"]>(),
      initializeIntegration: vi.fn<MarshalSwarmWorktreeLifecycle["initializeIntegration"]>(),
    });
    const sessions = {
      listWorkspacesForSelfTools: () => [],
      getSessionAsync: async () => owner,
    };
    const runId = createSwarmRunId(OWNER_SESSION_ID, "suffix");

    await expect(
      captureMissingRunTargets(lifecycle, sessions, runId, workspace.name),
    ).resolves.toBeUndefined();
    expect(lifecycle.captureTarget).not.toHaveBeenCalled();
  });
});
