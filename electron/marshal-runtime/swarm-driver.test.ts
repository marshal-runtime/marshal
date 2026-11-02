import { InMemorySwarmRunEventStore, replaySwarmRun, type SwarmRun } from "@marshal/swarm";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import type {
  MarshalRuntimeApi,
  MarshalRuntimeApiResult,
  MarshalRuntimeInvocationValue,
  MarshalRuntimeInvokeRequest,
} from "./contracts";
import { SwarmDriver, createSwarmRunId, parseSwarmRunOwnerSessionId } from "./swarm-driver";

const scope = { sessionId: "owner-1", workspaceName: "marshal-program" };

describe("SwarmDriver", () => {
  it("starts one Runtime-owned recursive drive on create", async () => {
    const eventStore = new InMemorySwarmRunEventStore();
    const runId = createSwarmRunId(scope.sessionId, "created");
    let driveCount = 0;
    const api = fakeApi(async (request) => {
      if (request.capability === "swarm.runs.create") {
        await eventStore.create(runId, "Complete the program", scope.workspaceName);
        await eventStore.append(runId, { type: "task.added", task: rootTask() });
        return { run: { ...(await run(eventStore, runId)), state: "running" } };
      }
      if (request.capability !== "swarm.runs.drive") {
        throw new Error(`Unexpected capability ${request.capability}`);
      }
      driveCount += 1;
      await eventStore.append(runId, { type: "task.started", taskId: "root" });
      await eventStore.append(runId, {
        type: "task.completed",
        taskId: "root",
        result: "done",
      });
      await eventStore.append(runId, { type: "run.completed", result: "done" });
      return { run: { ...(await run(eventStore, runId)), state: "completed" } };
    });
    const driver = new SwarmDriver(api);

    const created = await driver.start(scope, {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      targetRef: "refs/heads/main",
      targetHead: "a".repeat(40),
      roleModels: { worker: { model: "approved-worker" } },
      workerModel: "legacy-worker",
      workerReasoningEffort: "high",
      fresh: true,
    });

    expect(vi.mocked(api.invoke).mock.calls[0]?.[0]).toMatchObject({
      input: {
        roleModels: { worker: { model: "approved-worker" } },
        workerModel: "legacy-worker",
        workerReasoningEffort: "high",
        fresh: true,
      },
    });
    expect(created.state).toBe("running");
    expect(parseSwarmRunOwnerSessionId(runId)).toBe(scope.sessionId);
    await vi.waitFor(() => expect(driveCount).toBe(1));
    expect(
      vi
        .mocked(api.invoke)
        .mock.calls.filter(([request]) => request.capability === "swarm.runs.drive"),
    ).toHaveLength(1);
  });

  it("routes an accepted cancellation to the abandon settlement, not the ordinary one", async () => {
    const runId = createSwarmRunId(scope.sessionId, "cancel");
    const cancelled: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "failed",
      tasks: [],
    };
    const api = fakeApi(async (request) => {
      expect(request).toMatchObject({
        capability: "swarm.runs.cancel",
        input: { runId, reason: "Cancelled by user" },
      });
      return { run: cancelled };
    });
    const onRunSettled = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const onRunAbandoned = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, onRunSettled, onRunAbandoned);

    await expect(driver.cancel(scope, runId, "Cancelled by user")).resolves.toEqual(cancelled);
    expect(onRunAbandoned).toHaveBeenCalledExactlyOnceWith(scope, cancelled);
    expect(onRunSettled).not.toHaveBeenCalled();
  });

  it("honors cancelling an already-terminal failed run via readback", async () => {
    const runId = createSwarmRunId(scope.sessionId, "cancel-terminal");
    const failed: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "failed",
      error: "root worker crashed",
      tasks: [],
    };
    const api = fakeApi(async (request) => {
      if (request.capability === "swarm.runs.cancel") {
        throw new Error("terminal runs cannot be cancelled");
      }
      expect(request.capability).toBe("swarm.runs.get");
      return { run: failed };
    });
    const onRunAbandoned = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, undefined, onRunAbandoned);

    await expect(driver.cancel(scope, runId, "abandon")).resolves.toEqual(failed);
    expect(onRunAbandoned).toHaveBeenCalledExactlyOnceWith(scope, failed);
  });

  it("rethrows a rejected cancel when the run is still live", async () => {
    const runId = createSwarmRunId(scope.sessionId, "cancel-live");
    const running: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "running",
      tasks: [],
    };
    const api = fakeApi(async (request) => {
      if (request.capability === "swarm.runs.cancel") throw new Error("cancel transport down");
      return { run: running };
    });
    const onRunAbandoned = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, undefined, onRunAbandoned);

    await expect(driver.cancel(scope, runId, "abandon")).rejects.toThrow("cancel transport down");
    expect(onRunAbandoned).not.toHaveBeenCalled();
  });

  it("settles a drive that returns a terminal failed run", async () => {
    const runId = createSwarmRunId(scope.sessionId, "failed-drive");
    const failed: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "failed",
      error: "root worker crashed",
      tasks: [],
    };
    const api = fakeApi(async (request) => {
      expect(request.capability).toBe("swarm.runs.drive");
      return { run: failed };
    });
    const onRunSettled = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, onRunSettled);

    await expect(driver.drive(scope, runId)).resolves.toEqual(failed);
    expect(onRunSettled).toHaveBeenCalledExactlyOnceWith(scope, failed);
  });

  it("does not settle a run that is merely paused", async () => {
    const runId = createSwarmRunId(scope.sessionId, "paused-drive");
    const paused: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "paused",
      tasks: [],
    };
    const api = fakeApi(async () => ({ run: paused }));
    const onRunSettled = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, onRunSettled);

    await expect(driver.drive(scope, runId)).resolves.toEqual(paused);
    expect(onRunSettled).not.toHaveBeenCalled();
  });

  it("reads back and settles a persisted terminal state when the mutation itself rejects", async () => {
    const runId = createSwarmRunId(scope.sessionId, "reject-after-fail");
    const failed: SwarmRun = {
      runId,
      objective: "Complete the program",
      scope: "marshal-program",
      state: "failed",
      error: "root worker crashed",
      tasks: [],
    };
    const api = fakeApi(async (request) => {
      if (request.capability === "swarm.runs.drive") {
        throw new Error("transport dropped after the failure event persisted");
      }
      expect(request.capability).toBe("swarm.runs.get");
      return { run: failed };
    });
    const onRunSettled = vi.fn<(scope: unknown, run: SwarmRun) => void>();
    const driver = new SwarmDriver(api, onRunSettled);

    await expect(driver.drive(scope, runId)).rejects.toThrow("transport dropped");
    expect(onRunSettled).toHaveBeenCalledExactlyOnceWith(scope, failed);
  });
});

function rootTask() {
  return {
    taskId: "root",
    role: "planner" as const,
    objective: "Complete the program",
    scope: "marshal-program",
  };
}

async function run(eventStore: InMemorySwarmRunEventStore, runId: string): Promise<SwarmRun> {
  return replaySwarmRun(await eventStore.read(runId));
}

function fakeApi(
  invoke: (request: MarshalRuntimeInvokeRequest) => Promise<unknown>,
): MarshalRuntimeApi {
  return testDouble<MarshalRuntimeApi>({
    invoke: vi.fn<MarshalRuntimeApi["invoke"]>(async (request) => success(await invoke(request))),
  });
}

function success(output: unknown): MarshalRuntimeApiResult<MarshalRuntimeInvocationValue> {
  return {
    ok: true,
    value: {
      output,
      result: { output },
    },
    receipts: [],
  };
}
