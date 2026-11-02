import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { DelegationRecord } from "@marshal/runtime/delegation";
import {
  replaySwarmRun,
  type SwarmRunEvent,
  type SwarmRunEventStore,
  type SwarmRunTarget,
  type SwarmTask,
} from "@marshal/swarm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import { WorktreeCreationError } from "../worktree-creation-error";
import type { MarshalRuntimeAgentPort, MarshalRuntimeAgentSummary } from "./agent-orchestration";
import type { MarshalRuntimeScope } from "./contracts";
import type { SwarmAdmissionDelayReason } from "./swarm-session-admission";
import {
  MarshalSwarmWorktreeLifecycle,
  type MarshalSwarmLifecycleSessionPort,
  type MarshalSwarmWorktreeLifecycleOptions,
  type SwarmStorageProbe,
} from "./swarm-worktree-lifecycle";

const execFileAsync = promisify(execFile);

const scope: MarshalRuntimeScope = { sessionId: "owner-1", workspaceName: "marshal-program" };
const WORKTREE_VOLUME = "Q:\\worktrees";
const APP_DATA_VOLUME = "C:\\Users\\test\\.marshal";
const GIGABYTE = 1024 ** 3;

interface RecordedDelay {
  readonly milliseconds: number;
  readonly reason: SwarmAdmissionDelayReason;
}

function createLifecycle(overrides: Partial<MarshalSwarmWorktreeLifecycleOptions> = {}): {
  lifecycle: MarshalSwarmWorktreeLifecycle;
  delays: RecordedDelay[];
} {
  const delays: RecordedDelay[] = [];
  const lifecycle = new MarshalSwarmWorktreeLifecycle({
    eventStore: testDouble<SwarmRunEventStore>({}),
    sessions: testDouble<MarshalSwarmLifecycleSessionPort>({}),
    agents: testDouble<MarshalRuntimeAgentPort>({}),
    deliverCleanupAdvice: vi.fn<MarshalSwarmWorktreeLifecycleOptions["deliverCleanupAdvice"]>(
      async () => undefined,
    ),
    admission: {
      startSpacingMs: 0,
      sleep: async (milliseconds, reason, signal) => {
        delays.push({ milliseconds, reason });
        if (signal?.aborted) throw signal.reason;
        await Promise.resolve();
      },
    },
    // Both probes report ample space unless a test overrides them.
    storageVolumes: () => [WORKTREE_VOLUME, APP_DATA_VOLUME],
    statfs: async () => ({ bavail: 64 * GIGABYTE, bsize: 1 }),
    ...overrides,
  });
  return { lifecycle, delays };
}

function retryableSessionStart(): Error {
  return new Error("Couldn't start session: createSession timed out after 45000ms");
}

describe("MarshalSwarmWorktreeLifecycle.admitLaunch", () => {
  it("retries a classified-retryable session start and returns the later success", async () => {
    const { lifecycle, delays } = createLifecycle();
    const launch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryableSessionStart())
      .mockResolvedValueOnce("agent-1");

    await expect(lifecycle.admitLaunch(scope, true, undefined, launch)).resolves.toBe("agent-1");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([{ milliseconds: expect.any(Number), reason: "retry-backoff" }]);
  });

  it("never retries an abort, a stopped coordinator, a stale start, or a deleting chat", async () => {
    for (const message of [
      "Marshal Runtime agent wait was aborted.",
      "SessionStartCoordinator stopped before the session started",
      "Stale session start was superseded",
      "This chat is being deleted",
    ]) {
      const { lifecycle } = createLifecycle();
      const launch = vi.fn<() => Promise<string>>().mockRejectedValue(new Error(message));

      // eslint-disable-next-line no-await-in-loop -- each terminal message is proven independently
      await expect(lifecycle.admitLaunch(scope, true, undefined, launch)).rejects.toThrow(message);
      expect(launch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry an ambiguous failure", async () => {
    const { lifecycle } = createLifecycle();
    const launch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("backend rejected session creation"));

    await expect(lifecycle.admitLaunch(scope, true, undefined, launch)).rejects.toThrow(
      "backend rejected session creation",
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when a pause aborts the launch during backoff", async () => {
    const controller = new AbortController();
    const { lifecycle } = createLifecycle();
    const launch = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      controller.abort(new Error("Swarm run paused."));
      throw retryableSessionStart();
    });

    await expect(lifecycle.admitLaunch(scope, true, controller.signal, launch)).rejects.toThrow(
      "createSession timed out after 45000ms",
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("preserves the environmental payload when retryable worktree creation is exhausted", async () => {
    const { lifecycle } = createLifecycle();
    const launch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new WorktreeCreationError("capacity", "ENOSPC", "No space left on device"),
      );

    const error = await lifecycle
      .admitLaunch(scope, true, undefined, launch)
      .catch((caught: unknown) => caught);

    expect(launch).toHaveBeenCalledTimes(3);
    expect(lifecycle.environmentalError(error)).toEqual({
      kind: "environmental",
      category: "capacity",
      operation: "worktree.create",
      code: "ENOSPC",
      message: "No space left on device",
      retryable: false,
      attempts: 3,
    });
  });

  it("admits a non-worktree role without probing storage", async () => {
    const statfs = vi.fn<SwarmStorageProbe>(async () => ({ bavail: 0, bsize: 4096 }));
    const { lifecycle } = createLifecycle({ statfs });

    await expect(
      lifecycle.admitLaunch(scope, false, undefined, async () => "planner-1"),
    ).resolves.toBe("planner-1");
    expect(statfs).not.toHaveBeenCalled();
  });
});

describe("MarshalSwarmWorktreeLifecycle storage preflight", () => {
  it("refuses a worktree-backed launch when the worktree volume is low", async () => {
    const launch = vi.fn<() => Promise<string>>();
    const { lifecycle } = createLifecycle({
      statfs: async (target) => ({
        bavail: target === WORKTREE_VOLUME ? GIGABYTE : 64 * GIGABYTE,
        bsize: 1,
      }),
    });

    const error = await lifecycle
      .admitLaunch(scope, true, undefined, launch)
      .catch((caught: unknown) => caught);

    expect(launch).not.toHaveBeenCalled();
    expect(lifecycle.environmentalError(error)).toEqual(
      expect.objectContaining({
        kind: "environmental",
        category: "capacity",
        operation: "worktree.create",
        code: "ENOSPC",
        retryable: false,
        attempts: 3,
      }),
    );
    expect(lifecycle.environmentalError(error)?.message).toContain(
      path.parse(path.resolve("Q:\\")).root,
    );
  });

  it("refuses when only the app-data and event volume is low", async () => {
    const launch = vi.fn<() => Promise<string>>();
    const { lifecycle } = createLifecycle({
      statfs: async (target) => ({
        bavail: target === APP_DATA_VOLUME ? GIGABYTE : 64 * GIGABYTE,
        bsize: 1,
      }),
    });

    const error = await lifecycle
      .admitLaunch(scope, true, undefined, launch)
      .catch((caught: unknown) => caught);

    expect(launch).not.toHaveBeenCalled();
    expect(lifecycle.environmentalError(error)?.code).toBe("ENOSPC");
    expect(lifecycle.environmentalError(error)?.message).toContain(
      path.parse(path.resolve("C:\\")).root,
    );
  });

  it("fails open when the probe itself errors", async () => {
    const { lifecycle } = createLifecycle({
      statfs: async () => {
        throw new Error("statfs is unavailable on this volume");
      },
    });

    await expect(
      lifecycle.admitLaunch(scope, true, undefined, async () => "agent-1"),
    ).resolves.toBe("agent-1");
  });

  it("caches the verdict so a burst of launches does not probe per launch", async () => {
    let clock = 1_000;
    const statfs = vi.fn<SwarmStorageProbe>(async () => ({ bavail: 64 * GIGABYTE, bsize: 1 }));
    const { lifecycle } = createLifecycle({ statfs, now: () => clock });

    await lifecycle.admitLaunch(scope, true, undefined, async () => "a");
    await lifecycle.admitLaunch(scope, true, undefined, async () => "b");
    expect(statfs).toHaveBeenCalledTimes(2);

    clock += 5_000;
    await lifecycle.admitLaunch(scope, true, undefined, async () => "c");
    expect(statfs).toHaveBeenCalledTimes(4);
  });

  it("starts the read-only cleanup advisor outside admission and never deletes anything", async () => {
    const launch = vi
      .fn<MarshalRuntimeAgentPort["launch"]>()
      .mockResolvedValue(testDouble({ id: "advisor-1" }));
    const wait = vi
      .fn<MarshalRuntimeAgentPort["wait"]>()
      .mockResolvedValue(
        testDouble({ state: "completed", result: "Review these caches before deleting anything." }),
      );
    const deliverCleanupAdvice = vi.fn<
      MarshalSwarmWorktreeLifecycleOptions["deliverCleanupAdvice"]
    >(async () => undefined);
    const { lifecycle } = createLifecycle({
      agents: testDouble<MarshalRuntimeAgentPort>({ launch, wait }),
      deliverCleanupAdvice,
      admission: { maxConcurrentStarts: 1, startSpacingMs: 0, sleep: async () => undefined },
      statfs: async () => ({ bavail: GIGABYTE, bsize: 1 }),
    });

    // The failing preflight holds the only start slot when it triggers the
    // advisor, and the blocked launch below takes that slot the instant it is
    // released and never gives it back. An advisor subject to admission would
    // therefore never reach `agents.launch`.
    const refused = lifecycle
      .admitLaunch(scope, true, undefined, async () => "never")
      .catch(() => undefined);
    const saturated = lifecycle.admitLaunch(
      scope,
      false,
      undefined,
      () => new Promise<string>(() => undefined),
    );
    void saturated.catch(() => undefined);
    await refused;

    await vi.waitFor(() => expect(deliverCleanupAdvice).toHaveBeenCalledTimes(1));
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ createWorktree: false, name: "Storage cleanup advisor" }),
    );
    const prompt = launch.mock.calls[0]?.[0]?.task;
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("Never delete anything");
    expect(prompt).toContain("Never delete anything, claim cleanup happened");
  });
});

describe("MarshalSwarmWorktreeLifecycle integration convergence", () => {
  const RUN_ID = "owner-1.20260826T000000000Z";
  let root: string;
  let repositories: Map<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "swarm-convergence-"));
    repositories = new Map([
      ["marshal-program", await createRepository(root, "marshal")],
      ["runtime-program", await createRepository(root, "runtime")],
    ]);
  });

  afterEach(async () => {
    // Windows keeps git handles briefly after the last child exits.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("captures every declared repository at its exact head", async () => {
    const lifecycle = convergenceLifecycle([]);

    const targets = await Promise.all(
      [...repositories].map(([scopeName, repository]) =>
        lifecycle.captureTarget(scopeName, repository),
      ),
    );

    expect(targets).toEqual([
      {
        scope: "marshal-program",
        ref: "refs/heads/main",
        head: await head(repositories.get("marshal-program")!),
      },
      {
        scope: "runtime-program",
        ref: "refs/heads/main",
        head: await head(repositories.get("runtime-program")!),
      },
    ]);
  });

  it("captures the canonical head without disturbing unrelated local work", async () => {
    const lifecycle = convergenceLifecycle([]);
    const repository = repositories.get("marshal-program")!;
    await writeFile(path.join(repository, "dirty.txt"), "dirty\n", "utf8");

    await expect(lifecycle.captureTarget("marshal-program", repository)).resolves.toMatchObject({
      scope: "marshal-program",
      ref: "refs/heads/main",
      head: await head(repository),
    });
    expect(await readFile(path.join(repository, "dirty.txt"), "utf8")).toBe("dirty\n");
  });

  it("initialises one integration ref per declared target at the captured head", async () => {
    const lifecycle = convergenceLifecycle([]);
    const targets = await declaredTargets();

    const heads = await lifecycle.initializeIntegration(RUN_ID, targets);

    expect(heads).toEqual(
      targets.map((target) => ({
        ref: lifecycle.integration.refFor(RUN_ID, target.scope),
        head: target.head,
      })),
    );
    const persisted = await Promise.all(
      targets.map((target) =>
        gitOut(repositories.get(target.scope)!, [
          "rev-parse",
          lifecycle.integration.refFor(RUN_ID, target.scope),
        ]),
      ),
    );
    expect(persisted).toEqual(targets.map((target) => target.head));
  });

  it("repairs a missing integration ref for a custom legacy run before a real child worktree launch", async () => {
    const runId = "code-review-wave1c";
    const repository = repositories.get("marshal-program")!;
    const capturedHead = await head(repository);
    const lifecycle = convergenceLifecycle(
      [
        {
          type: "run.created",
          protocolVersion: 2,
          runId,
          objective: "Build an extension",
          scope: "marshal-program",
          targetRef: "main",
          targetHead: capturedHead,
        },
        taskAdded("root", "planner", "marshal-program"),
        taskStarted("root", "root-delegation"),
      ],
      runId,
    );
    await writeFile(path.join(repository, "later.txt"), "canonical advanced\n");
    await git(repository, ["add", "later.txt"]);
    await git(repository, ["commit", "-q", "-m", "unrelated later commit"]);
    const canonicalHead = await head(repository);
    const integrationRef = lifecycle.integration.refFor(runId, "marshal-program");
    expect(await lifecycle.integration.read(repository, runId, "marshal-program")).toBeUndefined();

    expect(
      await lifecycle.resolveIntegrationRefForDelegation("root-delegation", "marshal-program"),
    ).toBe(integrationRef);
    const childPath = path.join(root, "new-child");
    await git(repository, [
      "worktree",
      "add",
      "-b",
      "marshal/subagent/regression",
      childPath,
      integrationRef,
    ]);
    expect(await head(childPath)).toBe(capturedHead);
    expect(await head(repository)).toBe(canonicalHead);
    expect(await readFile(path.join(repository, "later.txt"), "utf8")).toBe("canonical advanced\n");
  });

  it("preserves an advanced integration ref when resolving another child baseline", async () => {
    const repository = repositories.get("marshal-program")!;
    const targets = await declaredTargets();
    const lifecycle = convergenceLifecycle([
      runCreated(targets),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
    ]);
    await lifecycle.initializeIntegration(RUN_ID, targets);
    const worker = await worktreeCommit(repository, root, "completed-worker", targets[0].head);
    await lifecycle.integration.promote(repository, RUN_ID, "marshal-program", worker.head);
    const integrationRef = await lifecycle.resolveIntegrationRefForDelegation(
      "root-delegation",
      "marshal-program",
    );
    expect(integrationRef).toBe(lifecycle.integration.refFor(RUN_ID, "marshal-program"));
    expect(await gitOut(repository, ["rev-parse", integrationRef!])).toBe(worker.head);
    expect(await head(repository)).toBe(targets[0].head);
  });

  it("rejects undeclared scopes and captured commits from another repository before creating refs", async () => {
    const repository = repositories.get("marshal-program")!;
    const foreignHead = await head(repositories.get("runtime-program")!);
    const lifecycle = convergenceLifecycle([
      runCreated([{ scope: "marshal-program", ref: "main", head: foreignHead }]),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
    ]);
    await expect(
      lifecycle.resolveIntegrationRefForDelegation("root-delegation", "runtime-program"),
    ).rejects.toThrow("not one of the run's declared");
    await expect(
      lifecycle.resolveIntegrationRefForDelegation("root-delegation", "marshal-program"),
    ).rejects.toThrow("does not resolve to a commit");
    expect(await lifecycle.integration.read(repository, RUN_ID, "marshal-program")).toBeUndefined();
    expect(
      await lifecycle.resolveIntegrationRefForDelegation("unknown-delegation", "marshal-program"),
    ).toBeUndefined();
  });

  it("fast-forward promotes a completed worker and leaves a non-fast-forward island captured", async () => {
    const repository = repositories.get("marshal-program")!;
    const targets = await declaredTargets();
    const first = await worktreeCommit(repository, root, "worker-1", targets[0].head);
    const second = await worktreeCommit(repository, root, "worker-2", targets[0].head);
    const lifecycle = convergenceLifecycle([
      runCreated(targets),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
      taskAdded("w1", "worker", "marshal-program", "root"),
      taskStarted("w1", "w1-delegation"),
      taskCompleted("w1", [first.branch]),
      taskAdded("w2", "worker", "marshal-program", "root"),
      taskStarted("w2", "w2-delegation"),
      taskCompleted("w2", [second.branch]),
    ]);
    await lifecycle.initializeIntegration(RUN_ID, targets);

    const promoted = await lifecycle.promoteCompletedDelegation({
      delegationId: "w1-delegation",
      worktreePath: first.path,
    });
    const island = await lifecycle.promoteCompletedDelegation({
      delegationId: "w2-delegation",
      worktreePath: second.path,
    });

    expect(promoted).toEqual({
      status: "promoted",
      ref: lifecycle.integration.refFor(RUN_ID, "marshal-program"),
      head: first.head,
      previousHead: targets[0].head,
    });
    expect(island?.status).toBe("stale");
    expect(await lifecycle.integration.read(repository, RUN_ID, "marshal-program")).toEqual({
      ref: lifecycle.integration.refFor(RUN_ID, "marshal-program"),
      head: first.head,
    });
  });

  it("never promotes a planner or a reviewer", async () => {
    const repository = repositories.get("marshal-program")!;
    const targets = await declaredTargets();
    const review = await worktreeCommit(repository, root, "reviewer-1", targets[0].head);
    const lifecycle = convergenceLifecycle([
      runCreated(targets),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
      taskAdded("r1", "reviewer", "marshal-program", "root"),
      taskStarted("r1", "r1-delegation"),
    ]);
    await lifecycle.initializeIntegration(RUN_ID, targets);

    await expect(
      lifecycle.promoteCompletedDelegation({
        delegationId: "root-delegation",
        worktreePath: review.path,
      }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.promoteCompletedDelegation({
        delegationId: "r1-delegation",
        worktreePath: review.path,
      }),
    ).resolves.toBeUndefined();
    expect(await lifecycle.integration.read(repository, RUN_ID, "marshal-program")).toEqual({
      ref: lifecycle.integration.refFor(RUN_ID, "marshal-program"),
      head: targets[0].head,
    });
  });

  it("fast-forwards every declared canonical branch after the captured worktrees are gone", async () => {
    const targets = await declaredTargets();
    const marshal = repositories.get("marshal-program")!;
    const runtime = repositories.get("runtime-program")!;
    const marshalWork = await worktreeCommit(marshal, root, "reconciler-marshal", targets[0].head);
    const runtimeWork = await worktreeCommit(runtime, root, "reconciler-runtime", targets[1].head);
    const lifecycle = convergenceLifecycle([
      runCreated(targets),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
      taskAdded("rm", "reconciler", "marshal-program", "root"),
      taskStarted("rm", "rm-delegation"),
      {
        type: "task.artifact",
        taskId: "rm",
        artifact: {
          uri: "file:///marshal-result.md",
          summary: "Integrated Marshal work",
          kind: "reconciliation",
        },
      },
      taskCompleted("rm", [marshalWork.branch]),
      taskAdded("rr", "reconciler", "runtime-program", "root"),
      taskStarted("rr", "rr-delegation"),
      {
        type: "task.artifact",
        taskId: "rr",
        artifact: {
          uri: "file:///runtime-result.md",
          summary: "Integrated Runtime work",
          kind: "reconciliation",
        },
      },
      taskCompleted("rr", [runtimeWork.branch]),
    ]);
    await lifecycle.initializeIntegration(RUN_ID, targets);
    await lifecycle.promoteCompletedDelegation({
      delegationId: "rm-delegation",
      worktreePath: marshalWork.path,
    });
    await lifecycle.promoteCompletedDelegation({
      delegationId: "rr-delegation",
      worktreePath: runtimeWork.path,
    });
    // Every captured worktree and branch is destroyed before integration.
    await removeWorktree(marshal, marshalWork);
    await removeWorktree(runtime, runtimeWork);

    const integrated = await lifecycle.integrateRoot({
      rootDelegationId: "root-delegation",
      records: [
        delegationRecord("root-delegation"),
        delegationRecord("rm-delegation"),
        delegationRecord("rr-delegation"),
      ],
      ownerScope: scope,
    });

    expect(integrated).toEqual([
      {
        ref: lifecycle.integration.refFor(RUN_ID, "marshal-program"),
        head: marshalWork.head,
      },
      {
        ref: lifecycle.integration.refFor(RUN_ID, "runtime-program"),
        head: runtimeWork.head,
      },
    ]);
    expect(await head(marshal)).toBe(marshalWork.head);
    expect(await head(runtime)).toBe(runtimeWork.head);
  });

  it("determines outstanding islands against the current integration refs", async () => {
    const repository = repositories.get("marshal-program")!;
    const targets = await declaredTargets();
    const promotedWork = await worktreeCommit(repository, root, "worker-1", targets[0].head);
    const islandWork = await worktreeCommit(repository, root, "worker-2", targets[0].head);
    const run = [
      runCreated(targets),
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
      taskAdded("w1", "worker", "marshal-program", "root"),
      taskStarted("w1", "w1-delegation"),
      taskCompleted("w1", [promotedWork.branch]),
      taskAdded("w2", "worker", "marshal-program", "root"),
      taskStarted("w2", "w2-delegation"),
      taskCompleted("w2", [islandWork.branch]),
    ];
    const lifecycle = convergenceLifecycle(run);
    await lifecycle.initializeIntegration(RUN_ID, targets);
    await lifecycle.promoteCompletedDelegation({
      delegationId: "w1-delegation",
      worktreePath: promotedWork.path,
    });
    // Neither captured worktree survives; only the promoted branch is reclaimed.
    await removeWorktree(repository, promotedWork);
    await removeWorktree(repository, islandWork);

    const withBranches = await lifecycle.outstandingIslands(replaySwarmRun(run));
    await git(repository, ["branch", "-q", "-D", "marshal/subagent/worker-1"]);
    const afterReclaim = await lifecycle.outstandingIslands(replaySwarmRun(run));

    // The promoted branch is contained while it exists and is undeterminable
    // once reclaimed; either way it is never reported as outstanding.
    expect(withBranches).toEqual([
      { scope: "marshal-program", taskId: "w2", changeRef: islandWork.branch },
    ]);
    expect(afterReclaim).toEqual(withBranches);
  });

  function convergenceLifecycle(
    events: readonly SwarmRunEvent[],
    runId = RUN_ID,
  ): MarshalSwarmWorktreeLifecycle {
    return createLifecycle({
      eventStore: testDouble<SwarmRunEventStore>({
        list: async () => [runId],
        read: async () => events,
      }),
      sessions: testDouble<MarshalSwarmLifecycleSessionPort>({
        listWorkspacesForSelfTools: () =>
          [...repositories].map(([name, repositoryPath]) => ({ name, path: repositoryPath })),
      }),
    }).lifecycle;
  }

  async function declaredTargets(): Promise<SwarmRunTarget[]> {
    return Promise.all(
      [...repositories].map(async ([scopeName, repository]) => ({
        scope: scopeName,
        ref: "refs/heads/main",
        head: await head(repository),
      })),
    );
  }

  function runCreated(targets: readonly SwarmRunTarget[]): SwarmRunEvent {
    return {
      type: "run.created",
      protocolVersion: 2,
      runId: RUN_ID,
      objective: "Complete both programs",
      scope: "marshal-program",
      targetRef: targets[0].ref,
      targetHead: targets[0].head,
      targets,
    };
  }
});

describe("MarshalSwarmWorktreeLifecycle captured-worktree reclaim", () => {
  const RUN_ID = "owner-1.20260826T010000000Z";
  const SESSION_ID = "w1-delegation-agent";
  let root: string;
  let repository: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "swarm-reclaim-"));
    repository = await createRepository(root, "marshal");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reclaims a captured worker worktree, preserving the branch at its exact commit", async () => {
    const work = await worktreeCommit(repository, root, "worker-1", "main");
    const harness = await reclaimHarness({ changeRefs: [work.branch], repoPath: work.path });
    await harness.lifecycle.initializeIntegration(RUN_ID, harness.targets);

    await harness.reclaim();

    expect(harness.removed).toEqual([SESSION_ID]);
    expect(existsSync(work.path)).toBe(false);
    // The change ref survives and still resolves to exactly the captured commit,
    // so a later reconciler and island determination keep working.
    expect(await gitOut(repository, ["rev-parse", work.branch])).toBe(work.head);
    expect(await harness.lifecycle.outstandingIslands(replaySwarmRun(harness.events))).toEqual([
      { scope: "marshal-program", taskId: "w1", changeRef: work.branch },
    ]);
  });

  it("leaves a dirty worktree in place", async () => {
    const work = await worktreeCommit(repository, root, "worker-1", "main");
    await writeFile(path.join(work.path, "scratch.txt"), "uncommitted\n", "utf8");
    const harness = await reclaimHarness({ changeRefs: [work.branch], repoPath: work.path });

    await harness.reclaim();

    expect(harness.removeSessionWorktree).not.toHaveBeenCalled();
    expect(existsSync(work.path)).toBe(true);
  });

  it("leaves a worktree the run journal never captured", async () => {
    const work = await worktreeCommit(repository, root, "worker-1", "main");
    const uncaptured = await reclaimHarness({ repoPath: work.path });
    const mismatched = await reclaimHarness({
      changeRefs: ["refs/heads/marshal/subagent/other"],
      repoPath: work.path,
    });

    await uncaptured.reclaim();
    await mismatched.reclaim();

    expect(uncaptured.removeSessionWorktree).not.toHaveBeenCalled();
    expect(mismatched.removeSessionWorktree).not.toHaveBeenCalled();
    expect(existsSync(work.path)).toBe(true);
  });

  it("reclaims a settled detached reviewer, never a live agent or a shared workspace", async () => {
    const work = await worktreeCommit(repository, root, "worker-1", "main");
    const live = await reclaimHarness({
      changeRefs: [work.branch],
      repoPath: work.path,
      agentState: "running",
    });
    const shared = await reclaimHarness({ changeRefs: [work.branch], repoPath: repository });

    await live.reclaim();
    await shared.reclaim();

    expect(live.removeSessionWorktree).not.toHaveBeenCalled();
    expect(shared.removeSessionWorktree).not.toHaveBeenCalled();
    expect(existsSync(work.path)).toBe(true);

    await git(work.path, ["checkout", "--detach", work.branch]);
    const reviewer = await reclaimHarness({ role: "reviewer", repoPath: work.path });
    await reviewer.reclaim();

    expect(reviewer.removed).toEqual([SESSION_ID]);
    expect(await gitOut(repository, ["rev-parse", work.branch])).toBe(work.head);
  });

  it("removes once across repeated passes", async () => {
    const work = await worktreeCommit(repository, root, "worker-1", "main");
    const harness = await reclaimHarness({ changeRefs: [work.branch], repoPath: work.path });

    await harness.reclaim();
    await harness.reclaim();
    await harness.reclaim();

    expect(harness.removeSessionWorktree).toHaveBeenCalledTimes(1);
    expect(await gitOut(repository, ["rev-parse", work.branch])).toBe(work.head);
  });

  interface ReclaimCase {
    readonly role?: SwarmTask["role"];
    readonly changeRefs?: readonly string[];
    readonly repoPath?: string;
    readonly agentState?: MarshalRuntimeAgentSummary["state"];
  }

  async function reclaimHarness(options: ReclaimCase) {
    const targets: SwarmRunTarget[] = [
      { scope: "marshal-program", ref: "refs/heads/main", head: await head(repository) },
    ];
    const events: SwarmRunEvent[] = [
      {
        type: "run.created",
        runId: RUN_ID,
        objective: "Reclaim captured worktrees",
        scope: "marshal-program",
        targetRef: targets[0].ref,
        targetHead: targets[0].head,
        targets,
      },
      taskAdded("root", "planner", "marshal-program"),
      taskStarted("root", "root-delegation"),
      taskAdded("w1", options.role ?? "worker", "marshal-program", "root"),
      taskStarted("w1", "w1-delegation"),
      taskCompleted("w1", options.changeRefs),
    ];
    const removed: string[] = [];
    const removeSessionWorktree = vi.fn<MarshalSwarmLifecycleSessionPort["removeSessionWorktree"]>(
      async (request) => {
        if (!(await request.integrationProof())) {
          throw new Error("Cannot remove a worktree before its changes are integrated");
        }
        // Mirrors the guarded host removal: never forced, never touches the branch.
        await git(repository, ["worktree", "remove", request.worktreePath]);
        removed.push(request.sessionId);
      },
    );
    const { lifecycle } = createLifecycle({
      eventStore: testDouble<SwarmRunEventStore>({
        list: async () => [RUN_ID],
        read: async () => events,
      }),
      sessions: testDouble<MarshalSwarmLifecycleSessionPort>({
        listWorkspacesForSelfTools: () => [{ name: "marshal-program", path: repository }],
        removeSessionWorktree,
      }),
      agents: testDouble<MarshalRuntimeAgentPort>({
        get: vi.fn<MarshalRuntimeAgentPort["get"]>(async (_ownerScope, agentId) =>
          agentId === SESSION_ID
            ? testDouble<MarshalRuntimeAgentSummary>({
                id: agentId,
                state: options.agentState ?? "idle",
                ...(options.repoPath ? { repoPath: options.repoPath } : {}),
              })
            : null,
        ),
      }),
    });
    const records = [
      delegationRecord("root-delegation"),
      testDouble<DelegationRecord>({
        delegationId: "w1-delegation",
        adapterHandle: SESSION_ID,
        state: "done",
      }),
    ];
    return {
      lifecycle,
      events,
      targets,
      removed,
      removeSessionWorktree,
      reclaim: () =>
        lifecycle.reclaimCapturedWorktrees({
          delegationId: "root-delegation",
          records,
          ownerScope: scope,
        }),
    };
  }
});

function taskAdded(
  taskId: string,
  role: SwarmTask["role"],
  taskScope: string,
  parentTaskId?: string,
): SwarmRunEvent {
  return {
    type: "task.added",
    task: {
      taskId,
      role,
      objective: `Do ${taskId}`,
      scope: taskScope,
      ...(parentTaskId ? { parentTaskId } : {}),
    },
  };
}

function taskStarted(taskId: string, delegationId: string): SwarmRunEvent {
  return { type: "task.started", taskId, delegationId };
}

function taskCompleted(taskId: string, changeRefs?: readonly string[]): SwarmRunEvent {
  return { type: "task.completed", taskId, result: "done", ...(changeRefs ? { changeRefs } : {}) };
}

function delegationRecord(delegationId: string): DelegationRecord {
  return testDouble<DelegationRecord>({
    delegationId,
    adapterHandle: `${delegationId}-agent`,
    state: "done",
  });
}

async function createRepository(root: string, name: string): Promise<string> {
  const repository = path.join(root, name);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch", "main"]);
  await git(repository, ["config", "user.email", "swarm@example.test"]);
  await git(repository, ["config", "user.name", "Swarm"]);
  await writeFile(path.join(repository, "README.md"), `${name}\n`, "utf8");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-q", "-m", "base"]);
  return repository;
}

interface CapturedWork {
  readonly path: string;
  readonly branch: string;
  readonly head: string;
}

async function worktreeCommit(
  repository: string,
  root: string,
  name: string,
  baseRef: string,
): Promise<CapturedWork> {
  const worktreePath = path.join(root, "worktrees", name);
  const branch = `refs/heads/marshal/subagent/${name}`;
  await git(repository, [
    "worktree",
    "add",
    "-q",
    "-b",
    `marshal/subagent/${name}`,
    worktreePath,
    baseRef,
  ]);
  await writeFile(path.join(worktreePath, `${name}.txt`), `${name}\n`, "utf8");
  await git(worktreePath, ["add", `${name}.txt`]);
  await git(worktreePath, ["commit", "-q", "-m", name]);
  return { path: worktreePath, branch, head: await head(worktreePath) };
}

async function removeWorktree(repository: string, work: CapturedWork): Promise<void> {
  await git(repository, ["worktree", "remove", "--force", work.path]);
}

function head(repository: string): Promise<string> {
  return gitOut(repository, ["rev-parse", "HEAD"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await gitOut(cwd, args);
}

async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, windowsHide: true });
  return result.stdout.trim();
}
