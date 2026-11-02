import type { InvocationContext } from "@marshal/runtime";
import {
  InMemorySwarmRunEventStore,
  replaySwarmRun,
  SwarmExecutor,
  SwarmServiceContainer,
} from "@marshal/swarm";
import type { SwarmRunUpdateEvent } from "@marshal/swarm";
import { describe, expect, test } from "vitest";

/**
 * Replays the SwarmRun.tla counterexamples through the SHIPPED @marshal/swarm
 * pack (node_modules, pinned marshal-swarm b820b89). These failed against the
 * previous host-16 pack; they pin the fixes in the installed artifact. The
 * source-level regressions live in marshal-swarm
 * packages/swarm/__tests__/failure-lifecycle.spec.ts.
 */

const RUN = "owner.c2Vzc2lvbi0x.run-1";

async function freshRun() {
  const store = new InMemorySwarmRunEventStore();
  await store.create(RUN, "Ship the feature", "repo");
  const append = (event: SwarmRunUpdateEvent) => store.append(RUN, event);
  const add = (taskId: string, role: "planner" | "worker", parentTaskId?: string) =>
    append({
      type: "task.added",
      task: {
        taskId,
        role,
        objective: `do ${taskId}`,
        scope: "repo",
        ...(parentTaskId ? { parentTaskId, idempotencyKey: taskId } : {}),
      },
    });
  const dispatch = (taskId: string) =>
    append({
      type: "task.dispatched",
      taskId,
      execution: { executionId: `exec-${taskId}`, kind: "dispatch", delegationId: `d-${taskId}` },
    });
  const read = async () => replaySwarmRun(await store.read(RUN));
  return { append, add, dispatch, read };
}

describe("SwarmRun.tla TerminalRunIsQuiescent", () => {
  const context = (sessionId: string) =>
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the executor reads only principal and scope
    ({ principal: { id: "owner" }, scope: { sessionId } }) as unknown as InvocationContext;

  test("a failed root leaves no pending/running/blocked tasks behind", async () => {
    const store = new InMemorySwarmRunEventStore();
    const factory = {
      execute: async (request: { input: { delegationId?: string } }) => ({
        result: { output: { delegationId: request.input.delegationId, state: "running" } },
      }),
    };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal operation factory
    const executor = new SwarmExecutor(factory as never, {
      eventStore: store,
      serviceContainer: new SwarmServiceContainer(),
    });
    await executor.create({ runId: "r", objective: "Build", scope: "a" }, context("s"));
    const append = (event: SwarmRunUpdateEvent) => store.append("r", event);
    await append({ type: "task.started", taskId: "root", delegationId: "root-d" });
    await append({
      type: "task.execution",
      taskId: "root",
      execution: { executionId: "root-x", delegationId: "root-d", sessionId: "root" },
    });
    const addWorker = (taskId: string) =>
      append({
        type: "task.added",
        task: { taskId, parentTaskId: "root", role: "worker", objective: taskId, scope: "a" },
      });
    await addWorker("root/a");
    await addWorker("root/b");
    await append({
      type: "task.dispatched",
      taskId: "root/a",
      execution: { executionId: "root/a", delegationId: "root/a", sessionId: "root/a" },
    });
    await executor.nodeOperation(
      "fail",
      { runId: "r", taskId: "root", reason: "gave up" },
      context("root"),
    );
    const run = replaySwarmRun(await store.read("r"));
    expect(run.state).toBe("failed");
    expect(run.tasks.filter((t) => !["completed", "failed"].includes(t.state))).toEqual([]);
  });
});

describe("SwarmRun.tla NoDispatchUnderDeadParent", () => {
  test("a child is not dispatched once its planner parent failed", async () => {
    const s = await freshRun();
    await s.add("root", "planner");
    await s.dispatch("root");
    await s.add("root/p", "planner", "root");
    await s.dispatch("root/p");
    await s.add("root/p/c", "worker", "root/p");
    await s.append({
      type: "task.failed",
      taskId: "root/p",
      error: "plan invalid",
      failureOrigin: "agent",
    });
    await expect(s.dispatch("root/p/c")).rejects.toThrow(/no longer live/);
  });
});

describe("reducer: run.resumed after a terminal failure", () => {
  test.each(["run.failed", "run.cancelled", "run.completed"] as const)(
    "the store rejects run.resumed after %s",
    async (terminal) => {
      const s = await freshRun();
      await s.add("root", "planner");
      await s.append(
        terminal === "run.completed" ? { type: terminal } : { type: terminal, error: "x" },
      );
      await expect(s.append({ type: "run.resumed" })).rejects.toThrow(/terminal/);
    },
  );
});
