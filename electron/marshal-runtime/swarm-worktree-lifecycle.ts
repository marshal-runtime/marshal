import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { DelegationRecord } from "@marshal/runtime/delegation";
import {
  replaySwarmRun,
  swarmRunTargets,
  type SwarmRun,
  type SwarmRunEventStore,
  type SwarmRunTarget,
  type SwarmTask,
} from "@marshal/swarm";

import { createLogger } from "../../common/marshal-logger";
import { WorktreeCreationError } from "../worktree-creation-error";
import type { MarshalRuntimeAgentPort } from "./agent-orchestration";
import type { MarshalRuntimeScope } from "./contracts";
import { requireDeclaredTarget } from "./swarm-baseline-service";
import {
  SwarmIntegrationRefs,
  type SwarmIntegrationHead,
  type SwarmIntegrationPromotion,
} from "./swarm-integration-ref";
import {
  SwarmSessionAdmission,
  type SwarmSessionAdmissionOptions,
} from "./swarm-session-admission";

const log = createLogger("MarshalSwarmWorktreeLifecycle");
const execFileAsync = promisify(execFile);
const MAX_LAUNCH_ATTEMPTS = 3;
const CLEANUP_ADVISOR_IDEMPOTENCY_KEY = "marshal-swarm-storage-cleanup-advisor";
const MIN_FREE_BYTES = 8 * 1024 ** 3;
const HEADROOM_CACHE_MS = 5_000;

/** A captured branch and head that a completed task never folded into `I(scope)`. */
export interface SwarmOutstandingIsland {
  readonly scope: string;
  readonly taskId: string;
  readonly changeRef: string;
}

export interface MarshalSwarmEnvironmentalError {
  readonly kind: "environmental";
  readonly category: string;
  readonly operation: "worktree.create";
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
  readonly attempts: 3;
}

export interface SwarmWorktreeRetirementRequest {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly integrationProof: () => boolean | Promise<boolean>;
}

export interface MarshalSwarmLifecycleSessionPort {
  listWorkspacesForSelfTools(): Array<{ name: string; path: string }>;
  removeSessionWorktree(request: SwarmWorktreeRetirementRequest): Promise<void>;
}

export interface MarshalSwarmCleanupAdvice {
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly answer: string;
}

/** Free-space probe shape; `node:fs/promises` `statfs` satisfies it. */
export type SwarmStorageProbe = (
  target: string,
) => Promise<{ readonly bavail: number | bigint; readonly bsize: number | bigint }>;

export interface MarshalSwarmWorktreeLifecycleOptions {
  readonly eventStore: SwarmRunEventStore;
  readonly sessions: MarshalSwarmLifecycleSessionPort;
  readonly agents: MarshalRuntimeAgentPort;
  readonly deliverCleanupAdvice: (advice: MarshalSwarmCleanupAdvice) => Promise<void>;
  /** Test seam. Bounds concurrent session *starts* for formal swarm launches only. */
  readonly admission?: SwarmSessionAdmissionOptions;
  /** Test seam. */
  readonly minFreeBytes?: number;
  /** Test seam. Defaults to the worktree destination volume plus the app-data/event volume. */
  readonly storageVolumes?: () => readonly string[] | Promise<readonly string[]>;
  /** Test seam. */
  readonly statfs?: SwarmStorageProbe;
  /** Test seam. */
  readonly now?: () => number;
  /** Test seam. Owns every `refs/swarm/<run>/integration/<scope>` operation. */
  readonly integration?: SwarmIntegrationRefs;
  readonly stageRunCreation?: (
    runId: string,
    creation: {
      readonly targets: readonly SwarmRunTarget[];
      readonly configuration: {
        readonly workerModel: string;
        readonly workerReasoningEffort: string;
      };
    },
  ) => void;
}

interface WorktreeCreationFailure {
  readonly category: string;
  readonly code: string;
  readonly message: string;
}

interface WorktreeState {
  readonly commonDirectory: string;
  readonly head: string;
  readonly clean: boolean;
}

interface RepositorySnapshot extends WorktreeState {
  readonly ref: string;
}

interface StorageShortfall {
  readonly volume: string;
  readonly freeBytes: number;
}

interface HeadroomVerdict {
  readonly checkedAt: number;
  readonly shortfall: StorageShortfall | undefined;
}

class MarshalSwarmEnvironmentalFailure extends Error {
  override readonly name = "MarshalSwarmEnvironmentalFailure";

  constructor(readonly payload: MarshalSwarmEnvironmentalError) {
    super(payload.message);
  }
}

export class MarshalSwarmWorktreeLifecycle {
  private cleanupAdvisorPromise: Promise<void> | undefined;
  private readonly admission: SwarmSessionAdmission;
  private readonly minFreeBytes: number;
  private readonly probeStorage: SwarmStorageProbe;
  private readonly now: () => number;
  private storageVolumesPromise: Promise<readonly string[]> | undefined;
  private headroom: HeadroomVerdict | undefined;
  private readonly runIdByDelegation = new Map<string, string>();
  private readonly reclaiming = new Set<string>();
  readonly integration: SwarmIntegrationRefs;

  constructor(private readonly options: MarshalSwarmWorktreeLifecycleOptions) {
    this.admission = new SwarmSessionAdmission(options.admission);
    this.minFreeBytes = options.minFreeBytes ?? MIN_FREE_BYTES;
    this.probeStorage = options.statfs ?? ((target) => statfs(target));
    this.now = options.now ?? (() => Date.now());
    this.integration = options.integration ?? new SwarmIntegrationRefs();
  }

  /** Captures one declared resource repository at its exact current head. */
  async captureTarget(scope: string, repositoryPath: string): Promise<SwarmRunTarget> {
    // Capture is ref/HEAD based; unrelated canonical edits are preserved for final ff-only integration.
    const snapshot = await repositorySnapshot(repositoryPath);
    if (!snapshot.ref.startsWith("refs/heads/")) {
      throw new Error("Swarm requires the canonical target to be on a local branch.");
    }
    return { scope, ref: snapshot.ref, head: snapshot.head };
  }

  /** One integration ref per declared target, at exactly the captured head. */
  async initializeIntegration(
    runId: string,
    targets: readonly SwarmRunTarget[],
  ): Promise<readonly SwarmIntegrationHead[]> {
    const heads: SwarmIntegrationHead[] = [];
    for (const target of targets) {
      const repositoryPath = this.resolveWorkspace(target.scope).path;
      // eslint-disable-next-line no-await-in-loop -- one ref per declared repository, at create time
      const head = await this.integration.initialize(
        repositoryPath,
        runId,
        target.scope,
        target.head,
      );
      heads.push(head);
    }
    return heads;
  }

  repositoryPathForScope(scope: string): string {
    return this.resolveWorkspace(scope).path;
  }

  stageRunCreation(
    runId: string,
    creation: {
      readonly targets: readonly SwarmRunTarget[];
      readonly configuration: {
        readonly workerModel: string;
        readonly workerReasoningEffort: string;
      };
    },
  ): void {
    this.options.stageRunCreation?.(runId, creation);
  }

  async resolveIntegrationRefForDelegation(
    parentDelegationId: string,
    childScope: string,
  ): Promise<string | undefined> {
    const located = await this.findRunByDelegation(parentDelegationId);
    if (!located) return undefined;
    const target = requireDeclaredTarget(located.run, childScope);
    // Custom run IDs and recovered legacy runs can have a captured target without
    // passing through the create-time initializer. Never hand Git a merely named ref.
    // initialize is create-only: it preserves any existing, already advanced baseline.
    const integration = await this.integration.initialize(
      this.resolveWorkspace(target.scope).path,
      located.run.runId,
      target.scope,
      target.head,
    );
    return integration.ref;
  }

  /**
   * Advances `I(scope)` from a terminal worker or reconciler. Both promote by
   * fast-forward only: a reconciler based on the current head fast-forwards by
   * construction, and a worker that is not a fast-forward stays an island for a
   * reconciler to fold in. The host never merges, so it never resolves a
   * conflict. Promotion is best effort — a completed task is never failed
   * because its result could not be promoted.
   */
  async promoteCompletedDelegation(input: {
    readonly delegationId: string;
    readonly worktreePath: string;
  }): Promise<SwarmIntegrationPromotion | undefined> {
    try {
      const located = await this.findRunByDelegation(input.delegationId);
      if (!located || located.run.state !== "running") return undefined;
      const { run, task } = located;
      if (task.role !== "worker" && task.role !== "reconciler") return undefined;

      const target = requireDeclaredTarget(run, task.scope);
      const canonicalPath = this.resolveWorkspace(task.scope).path;
      const worktree = await repositorySnapshot(input.worktreePath);
      if (!worktree.clean) {
        log.warn("Swarm promotion skipped an unclean worktree.", { taskId: task.taskId });
        return undefined;
      }
      const canonical = await repositorySnapshot(canonicalPath);
      if (!samePath(canonical.commonDirectory, worktree.commonDirectory)) {
        log.warn("Swarm promotion skipped a foreign repository.", { taskId: task.taskId });
        return undefined;
      }
      await this.integration.initialize(canonicalPath, run.runId, task.scope, target.head);
      const promotion = await this.integration.promote(
        canonicalPath,
        run.runId,
        task.scope,
        worktree.head,
      );
      if (promotion.status === "stale") {
        log.info("Swarm island awaits reconciliation.", {
          taskId: task.taskId,
          scope: task.scope,
        });
      }
      return promotion;
    } catch (error) {
      log.warn("Swarm integration promotion failed.", { delegationId: input.delegationId }, error);
      return undefined;
    }
  }

  /**
   * Gives back the worktree of every successful worker or reconciler in this
   * delegation's run whose captured branch the run journal already records and
   * whose exact commit already resolves from the canonical checkout, and of
   * every successful reviewer whose clean HEAD a local branch contains. The branch
   * is what carries the work — it outlives its worktree — so reclaiming the
   * directory neither integrates nor loses anything, and a run converges
   * identically when every attempt is skipped. Best effort by construction: it
   * never throws, never forces, and never deletes a branch.
   */
  async reclaimCapturedWorktrees(input: {
    readonly delegationId: string;
    readonly records: readonly DelegationRecord[];
    readonly ownerScope: MarshalRuntimeScope;
  }): Promise<void> {
    try {
      const located = await this.findRunByDelegation(input.delegationId);
      if (!located) return;
      const { run } = located;
      const scopes = new Set(swarmRunTargets(run).map((target) => target.scope));
      for (const task of run.tasks) {
        if (!scopes.has(task.scope)) continue;
        const sessionId = capturedTaskSessionId(task, input.records);
        if (!sessionId) continue;
        // eslint-disable-next-line no-await-in-loop -- one guarded removal at a time, under the session lifecycle lock
        await this.reclaimTaskWorktree(task, sessionId, input.ownerScope);
      }
    } catch (error) {
      log.warn(
        "Swarm captured-worktree reclaim could not run.",
        { delegationId: input.delegationId },
        error,
      );
    }
  }

  private async reclaimTaskWorktree(
    task: SwarmTask,
    sessionId: string,
    ownerScope: MarshalRuntimeScope,
  ): Promise<void> {
    if (this.reclaiming.has(sessionId)) return;
    this.reclaiming.add(sessionId);
    try {
      const agent = await this.options.agents.get(ownerScope, sessionId);
      if (!agent || agent.state !== "idle" || !agent.repoPath) return;
      const worktreePath = agent.repoPath;
      // An already-reclaimed worktree must not be probed again on every later pass.
      if (!existsSync(worktreePath)) return;
      const canonicalPath = this.resolveWorkspace(task.scope).path;
      // A shared-workspace task runs in the canonical checkout and owns nothing.
      if (samePath(canonicalPath, worktreePath)) return;
      const changeRefs = task.changeRefs ?? [];
      const proof =
        task.role === "reviewer"
          ? () => this.readOnlyProof(canonicalPath, worktreePath)
          : async () =>
              (await this.captureProof(canonicalPath, worktreePath, changeRefs)) !== undefined;
      if (!(await proof())) return;

      await this.options.sessions.removeSessionWorktree({
        sessionId,
        worktreePath,
        integrationProof: proof,
      });
      log.info("Swarm reclaimed a captured worktree.", {
        taskId: task.taskId,
        scope: task.scope,
      });
    } catch (error) {
      log.warn("Swarm captured-worktree reclaim was skipped.", { taskId: task.taskId }, error);
    } finally {
      this.reclaiming.delete(sessionId);
    }
  }

  /**
   * The capture proof, re-run inside `removeSessionWorktree`'s lifecycle lock:
   * the worktree still holds exactly the branch this task recorded in the run
   * journal, has nothing uncommitted, belongs to the scope's repository, and
   * that branch resolves from the canonical checkout at exactly the worktree
   * HEAD. `refs/heads/*` is shared by every linked worktree, so once the
   * canonical checkout names the exact commit, removing the worktree cannot
   * lose it and the change ref stays resolvable for later reconcilers and for
   * island determination.
   */
  private async captureProof(
    canonicalPath: string,
    worktreePath: string,
    changeRefs: readonly string[],
  ): Promise<SwarmIntegrationHead | undefined> {
    const worktree = await repositorySnapshot(worktreePath);
    if (!worktree.clean || !changeRefs.includes(worktree.ref)) return undefined;
    const canonical = await repositorySnapshot(canonicalPath);
    if (!samePath(canonical.commonDirectory, worktree.commonDirectory)) return undefined;
    const durable = await this.integration.resolveOptional(canonicalPath, worktree.ref);
    return durable === worktree.head ? { ref: worktree.ref, head: worktree.head } : undefined;
  }

  /**
   * The read-only proof for a settled reviewer, re-run inside the same lock: the
   * worktree has nothing uncommitted, belongs to the scope's repository, and a
   * local branch contains its HEAD, attached or detached, so removal cannot lose a commit.
   */
  private async readOnlyProof(canonicalPath: string, worktreePath: string): Promise<boolean> {
    const [canonicalDirectory, worktree] = await Promise.all([
      gitCommonDirectory(canonicalPath),
      worktreeState(worktreePath),
    ]);
    if (!worktree.clean || !samePath(canonicalDirectory, worktree.commonDirectory)) return false;
    const containing = await gitText(canonicalPath, [
      "for-each-ref",
      "--count=1",
      "--contains",
      worktree.head,
      "--format=%(refname)",
      "refs/heads/",
    ]);
    return containing.length > 0;
  }

  /**
   * Admits one formal swarm session start: FIFO-queued behind the start cap and
   * spacing, retried only for classified-retryable worktree/session-start
   * failures, and — for worktree-backed roles only — preceded by the cached disk
   * headroom preflight. The slot is released as soon as the launch dispatch
   * settles, so running agents are never capped.
   */
  async admitLaunch<T>(
    scope: MarshalRuntimeScope,
    createsWorktree: boolean,
    signal: AbortSignal | undefined,
    launch: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.admission.run(
        async () => {
          if (createsWorktree) await this.assertStorageHeadroom(scope);
          return launch();
        },
        {
          signal,
          onAttemptFailed: ({ attempt, failure, willRetry, backoffMs }) => {
            log.warn("Swarm session start failed.", {
              attempt,
              kind: failure.kind,
              category: failure.category,
              code: failure.code,
              willRetry,
              backoffMs,
            });
          },
        },
      );
    } catch (error) {
      throw this.exhaustedLaunchError(scope, signal, error);
    }
  }

  environmentalError(error: unknown): MarshalSwarmEnvironmentalError | undefined {
    return error instanceof MarshalSwarmEnvironmentalFailure ? error.payload : undefined;
  }

  /**
   * Final canonical integration, one declared repository at a time. Each
   * canonical branch fast-forwards to that repository's integration head and
   * nothing else — the host never merges, and no descendant session, branch, or
   * worktree needs to still exist. Per repository the update is atomic; across
   * repositories it is deterministic-order best effort, because two git
   * repositories cannot be updated atomically.
   */
  async integrateRoot(input: {
    readonly rootDelegationId: string;
    readonly records: readonly DelegationRecord[];
    readonly ownerScope: MarshalRuntimeScope;
  }): Promise<readonly SwarmIntegrationHead[]> {
    const run = await this.findRun(input.rootDelegationId);
    const targets = swarmRunTargets(run);
    if (targets.length === 0) throw new Error("Swarm target ref is missing.");
    const rootTask = run.tasks.find((task) => task.parentTaskId === undefined);
    if (!rootTask) throw new Error("Swarm run has no root task.");
    const tasks = descendantTasks(run, rootTask.taskId);
    const descendants = delegationRecordsForTasks(tasks, input.records);
    this.requireTerminalDescendants(tasks, descendants);
    await this.reportOutstandingIslands(run, targets);

    const integrated: SwarmIntegrationHead[] = [];
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- one canonical repository at a time, in declared order
      integrated.push(await this.integrateTarget(run, target));
    }
    return integrated;
  }

  private async integrateTarget(
    run: SwarmRun,
    target: SwarmRunTarget,
  ): Promise<SwarmIntegrationHead> {
    const targetRef = requiredText(target.ref, "Swarm target ref");
    const targetHead = requiredCommit(target.head, "Swarm target HEAD");
    const canonicalPath = this.resolveWorkspace(target.scope).path;
    const integration = await this.integration.initialize(
      canonicalPath,
      run.runId,
      target.scope,
      targetHead,
    );

    const canonicalBefore = await repositorySnapshot(canonicalPath);
    if (canonicalBefore.ref !== targetRef) {
      throw new Error("Canonical target branch changed while the swarm was running.");
    }
    if (!(await isAncestor(canonicalPath, targetHead, integration.head))) {
      throw new Error("Swarm integration head is not based on the recorded target HEAD.");
    }
    if (canonicalBefore.head !== targetHead && canonicalBefore.head !== integration.head) {
      throw new Error("Canonical target HEAD changed while the swarm was running.");
    }
    if (canonicalBefore.head !== integration.head) {
      await gitText(canonicalPath, ["merge", "--ff-only", integration.head]);
    }

    const canonicalAfter = await repositorySnapshot(canonicalPath);
    if (canonicalAfter.ref !== targetRef || canonicalAfter.head !== integration.head) {
      throw new Error("Canonical target did not exactly match the integrated head.");
    }
    return { ref: integration.ref, head: canonicalAfter.head };
  }

  /**
   * Work that a completed task captured but never promoted. Determined against
   * the current integration refs and the durable captured branches, so it stays
   * answerable after a worktree or session is gone. It is reported, never
   * enforced: promotion is compare-and-swap and forward-only, so `I(scope)`
   * provably contains everything that was promoted, and anything else is simply
   * not integrated.
   */
  async outstandingIslands(
    run: SwarmRun,
    targets: readonly SwarmRunTarget[] = swarmRunTargets(run),
  ): Promise<readonly SwarmOutstandingIsland[]> {
    const scopes = new Set(targets.map((target) => target.scope));
    const islands: SwarmOutstandingIsland[] = [];
    for (const task of run.tasks) {
      if (task.state !== "completed" || !scopes.has(task.scope)) continue;
      if (task.role !== "worker" && task.role !== "reconciler") continue;
      const canonicalPath = this.resolveWorkspace(task.scope).path;
      for (const changeRef of task.changeRefs ?? []) {
        // eslint-disable-next-line no-await-in-loop -- one ancestry probe per captured branch
        const commit = await this.integration.resolveOptional(canonicalPath, changeRef);
        // A captured branch that no longer exists was reclaimed, not stranded:
        // promotion is forward-only, so there is nothing left to determine.
        if (commit === undefined) continue;
        // eslint-disable-next-line no-await-in-loop -- one ancestry probe per captured branch
        const contained = await this.integration.contains(
          canonicalPath,
          run.runId,
          task.scope,
          commit,
        );
        if (!contained) islands.push({ scope: task.scope, taskId: task.taskId, changeRef });
      }
    }
    return islands;
  }

  private async reportOutstandingIslands(
    run: SwarmRun,
    targets: readonly SwarmRunTarget[],
  ): Promise<void> {
    try {
      const islands = await this.outstandingIslands(run, targets);
      if (islands.length === 0) return;
      log.warn("Swarm run has captured work outside its integration refs.", {
        runId: run.runId,
        outstanding: islands.length,
      });
    } catch (error) {
      log.warn("Swarm outstanding-island determination failed.", { runId: run.runId }, error);
    }
  }

  async retireCompletedRun(
    run: SwarmRun,
    records: readonly DelegationRecord[],
    ownerScope: MarshalRuntimeScope,
  ): Promise<void> {
    if (run.state !== "completed") return;
    const targets = swarmRunTargets(run);
    if (targets.length === 0) throw new Error("Swarm target ref is missing.");
    for (const target of targets) {
      const canonicalPath = this.resolveWorkspace(target.scope).path;
      // eslint-disable-next-line no-await-in-loop -- every declared repository is proven before reclaim
      const canonical = await repositorySnapshot(canonicalPath);
      if (
        canonical.ref !== requiredText(target.ref, "Swarm target ref") ||
        // eslint-disable-next-line no-await-in-loop -- every declared repository is proven before reclaim
        !(await isAncestor(
          canonicalPath,
          requiredCommit(target.head, "Swarm target HEAD"),
          canonical.head,
        ))
      ) {
        throw new Error("Completed swarm canonical target no longer matches its durable target.");
      }
    }
    const rootTask = run.tasks.find((task) => task.parentTaskId === undefined);
    if (!rootTask) throw new Error("Swarm run has no root task.");
    const tasks = descendantTasks(run, rootTask.taskId);
    await this.retireIntegratedDescendants(
      run,
      delegationRecordsForTasks(tasks, records),
      ownerScope,
    );
  }

  /**
   * Retryable worktree creation that survived every attempt becomes the existing
   * environmental payload verbatim (`operation: "worktree.create"`,
   * `attempts: 3`, `retryable: false`) so the portable pause matcher keeps
   * firing. Anything else — abort, fatal, or an already-environmental preflight
   * refusal — propagates unchanged.
   */
  private exhaustedLaunchError(
    scope: MarshalRuntimeScope,
    signal: AbortSignal | undefined,
    error: unknown,
  ): unknown {
    if (signal?.aborted) return error;
    const failure = structuredWorktreeCreationFailure(error);
    if (!failure) return error;
    if (failure.code === "ENOSPC") this.startCleanupAdvisorOnce(scope);
    return new MarshalSwarmEnvironmentalFailure({
      kind: "environmental",
      category: failure.category,
      operation: "worktree.create",
      code: failure.code,
      message: failure.message,
      retryable: false,
      attempts: MAX_LAUNCH_ATTEMPTS,
    });
  }

  /**
   * One cached `statfs` pair — the worktree destination volume and the
   * app-data/event volume, which is where the session JSONL appends that
   * actually ran the disk out live. Never a monitor or a daemon: a probe error
   * admits the launch.
   */
  private async assertStorageHeadroom(scope: MarshalRuntimeScope): Promise<void> {
    const shortfall = await this.storageShortfall();
    if (!shortfall) return;
    this.startCleanupAdvisorOnce(scope);
    throw new MarshalSwarmEnvironmentalFailure({
      kind: "environmental",
      category: "capacity",
      operation: "worktree.create",
      code: "ENOSPC",
      message: `Swarm launch refused: volume ${shortfall.volume} has ${shortfall.freeBytes} bytes free, below the ${this.minFreeBytes} byte floor.`,
      retryable: false,
      attempts: MAX_LAUNCH_ATTEMPTS,
    });
  }

  private async storageShortfall(): Promise<StorageShortfall | undefined> {
    const cached = this.headroom;
    const now = this.now();
    if (cached && now - cached.checkedAt < HEADROOM_CACHE_MS) return cached.shortfall;

    let shortfall: StorageShortfall | undefined;
    try {
      const volumes = await this.resolveStorageVolumes();
      for (const volume of volumes) {
        // eslint-disable-next-line no-await-in-loop -- two probes, and one failure admits the launch
        const stats = await this.probeStorage(volume);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (freeBytes >= this.minFreeBytes) continue;
        shortfall = { volume: volumeRoot(volume), freeBytes };
        break;
      }
    } catch (error) {
      log.warn("Swarm storage headroom probe failed; admitting the launch.", {}, error);
      this.headroom = { checkedAt: now, shortfall: undefined };
      return undefined;
    }

    this.headroom = { checkedAt: now, shortfall };
    return shortfall;
  }

  private resolveStorageVolumes(): Promise<readonly string[]> {
    if (this.options.storageVolumes) {
      return Promise.resolve(this.options.storageVolumes());
    }
    // Loaded lazily so this module stays importable (and testable) outside a
    // live Electron main process.
    this.storageVolumesPromise ??= defaultStorageVolumes();
    return this.storageVolumesPromise;
  }

  private async findRun(rootDelegationId: string): Promise<SwarmRun> {
    const matches: SwarmRun[] = [];
    for (const runId of await this.options.eventStore.list()) {
      // Run logs are read in durable order so duplicate root ownership is diagnosed deterministically.
      // eslint-disable-next-line no-await-in-loop
      const run = replaySwarmRun(await this.options.eventStore.read(runId));
      if (
        run.tasks.some(
          (task) => task.parentTaskId === undefined && task.delegationId === rootDelegationId,
        )
      ) {
        matches.push(run);
      }
    }
    if (matches.length !== 1) {
      throw new Error("Root delegation must resolve to exactly one durable swarm run.");
    }
    return matches[0];
  }

  private resolveWorkspace(scope: string): { name: string; path: string } {
    const matches = this.options.sessions
      .listWorkspacesForSelfTools()
      .filter((workspace) => workspace.name === scope);
    if (matches.length !== 1) {
      throw new Error(`Swarm target "${scope}" must resolve to one registered repository.`);
    }
    return matches[0];
  }

  private requireTerminalDescendants(
    tasks: readonly SwarmTask[],
    descendants: readonly DelegationRecord[],
  ): void {
    for (const task of tasks) {
      if (task.state !== "completed" && task.state !== "failed") {
        throw new Error("All descendant tasks must be terminal before integration.");
      }
    }
    for (const record of descendants) {
      if (record.state !== "done" && record.state !== "failed") {
        throw new Error("All descendant delegations must be terminal before integration.");
      }
    }
  }

  private async retireIntegratedDescendants(
    run: SwarmRun,
    descendants: readonly DelegationRecord[],
    ownerScope: MarshalRuntimeScope,
  ): Promise<void> {
    const targets = swarmRunTargets(run);
    for (const record of descendants) {
      const task = run.tasks.find((candidate) => candidate.delegationId === record.delegationId);
      const target = targets.find((candidate) => candidate.scope === task?.scope);
      if (
        !task ||
        !target ||
        task.role === "planner" ||
        task.state !== "completed" ||
        record.state !== "done" ||
        !record.adapterHandle
      ) {
        continue;
      }

      try {
        const canonicalPath = this.resolveWorkspace(task.scope).path;
        // Retirement is intentionally sequential to avoid overlapping session/worktree deletion.
        // eslint-disable-next-line no-await-in-loop
        const agent = await this.options.agents.get(ownerScope, record.adapterHandle);
        if (!agent || agent.state !== "idle" || !agent.repoPath) continue;
        const worktreePath = agent.repoPath;
        if (!existsSync(worktreePath)) continue;
        // eslint-disable-next-line no-await-in-loop
        const snapshot = await worktreeState(worktreePath);
        // eslint-disable-next-line no-await-in-loop
        const canonicalSnapshot = await repositorySnapshot(canonicalPath);
        if (
          !snapshot.clean ||
          canonicalSnapshot.ref !== target.ref ||
          !samePath(canonicalSnapshot.commonDirectory, snapshot.commonDirectory)
        ) {
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        if (!(await isAncestor(canonicalPath, snapshot.head, canonicalSnapshot.head))) continue;

        // eslint-disable-next-line no-await-in-loop
        await this.options.sessions.removeSessionWorktree({
          sessionId: record.adapterHandle,
          worktreePath,
          integrationProof: () =>
            this.proveIntegratedWorktree({
              canonicalPath,
              canonicalHead: canonicalSnapshot.head,
              targetRef: target.ref,
              worktreePath,
            }),
        });
      } catch (error) {
        log.warn(
          "Guarded swarm worktree retirement failed after canonical integration.",
          { sessionId: record.adapterHandle },
          error,
        );
      }
    }
  }

  /**
   * Locates the run and task a delegation belongs to. The delegation-to-run
   * mapping never changes once recorded, so it is memoised; the run itself is
   * always replayed fresh.
   */
  private async findRunByDelegation(
    delegationId: string,
  ): Promise<{ readonly run: SwarmRun; readonly task: SwarmTask } | undefined> {
    const cached = this.runIdByDelegation.get(delegationId);
    if (cached !== undefined) {
      const run = replaySwarmRun(await this.options.eventStore.read(cached));
      const task = run.tasks.find((candidate) => candidate.delegationId === delegationId);
      return task ? { run, task } : undefined;
    }
    for (const runId of await this.options.eventStore.list()) {
      // eslint-disable-next-line no-await-in-loop -- the first match short-circuits and is then memoised
      const run = replaySwarmRun(await this.options.eventStore.read(runId));
      const task = run.tasks.find((candidate) => candidate.delegationId === delegationId);
      if (!task) continue;
      this.runIdByDelegation.set(delegationId, runId);
      return { run, task };
    }
    return undefined;
  }

  private async proveIntegratedWorktree(input: {
    readonly canonicalPath: string;
    readonly canonicalHead: string;
    readonly targetRef: string;
    readonly worktreePath: string;
  }): Promise<boolean> {
    const [canonical, worktree] = await Promise.all([
      repositorySnapshot(input.canonicalPath),
      worktreeState(input.worktreePath),
    ]);
    if (
      canonical.ref !== input.targetRef ||
      canonical.head !== input.canonicalHead ||
      !worktree.clean ||
      !samePath(canonical.commonDirectory, worktree.commonDirectory)
    ) {
      return false;
    }
    return isAncestor(input.canonicalPath, worktree.head, input.canonicalHead);
  }

  private startCleanupAdvisorOnce(scope: MarshalRuntimeScope): void {
    if (this.cleanupAdvisorPromise) return;
    const promise = this.runCleanupAdvisor(scope);
    this.cleanupAdvisorPromise = promise;
    void promise.catch((error: unknown) => {
      log.error("Storage cleanup advisor failed.", {}, error);
    });
  }

  private async runCleanupAdvisor(scope: MarshalRuntimeScope): Promise<void> {
    // The advisor exists to diagnose exactly the saturation that fills the
    // admission queue, so it must never wait behind it.
    const advisor = await this.admission.runUnadmitted(() =>
      this.options.agents.launch({
        scope,
        task: cleanupAdvisorPrompt(),
        idempotencyKey: CLEANUP_ADVISOR_IDEMPOTENCY_KEY,
        workspaceName: scope.workspaceName,
        runtimeAgentRole: "planner",
        createWorktree: false,
        name: "Storage cleanup advisor",
      }),
    );
    const result = await this.options.agents.wait(scope, advisor.id);
    if (result.state !== "completed" || !result.result?.trim()) {
      throw new Error("Storage cleanup advisor completed without a report.");
    }
    await this.options.deliverCleanupAdvice({
      sessionId: scope.sessionId,
      workspaceName: scope.workspaceName,
      answer: result.result,
    });
  }
}

function structuredWorktreeCreationFailure(error: unknown): WorktreeCreationFailure | undefined {
  if (!(error instanceof WorktreeCreationError) || !error.retryable) return undefined;
  return {
    category: error.category,
    code: error.code,
    message: error.message || "Worktree creation failed.",
  };
}

/**
 * The worktree destination volume and the app-data/event volume. The deployed
 * exhaustion surfaced as session-event append failures on the app-data volume,
 * not as `git worktree add` failures, so probing only the worktree root repeats
 * the miss.
 */
async function defaultStorageVolumes(): Promise<readonly string[]> {
  const [{ getAppDataDir }, { loadSettingsFromDisk }, { resolveWorktreeRoot }] = await Promise.all([
    import("../app-paths"),
    import("../settings-store"),
    import("../worktree-root"),
  ]);
  const appDataDir = getAppDataDir();
  return [resolveWorktreeRoot(appDataDir, loadSettingsFromDisk().worktreeDir), appDataDir];
}

/** Volume root only — a capacity message must not carry a working path. */
function volumeRoot(target: string): string {
  return path.parse(path.resolve(target)).root || target;
}

/**
 * A task is a reclaim candidate only when it settled successfully and resolves
 * to exactly one settled delegation and its session: a read-only reviewer, or a
 * worker or reconciler whose captured branch the run journal already holds.
 */
function capturedTaskSessionId(
  task: SwarmTask,
  records: readonly DelegationRecord[],
): string | undefined {
  if (task.role === "planner") return undefined;
  if (task.state !== "completed" || !task.delegationId) return undefined;
  if (task.role !== "reviewer" && (task.changeRefs ?? []).length === 0) return undefined;
  const matches = records.filter((record) => record.delegationId === task.delegationId);
  if (matches.length !== 1 || matches[0].state !== "done") return undefined;
  return matches[0].adapterHandle;
}

function delegationRecordsForTasks(
  tasks: readonly SwarmTask[],
  records: readonly DelegationRecord[],
): DelegationRecord[] {
  const descendants: DelegationRecord[] = [];
  for (const task of tasks) {
    if (!task.delegationId) continue;
    const matches = records.filter((record) => record.delegationId === task.delegationId);
    if (matches.length !== 1) {
      throw new Error(`Swarm task "${task.taskId}" must resolve to exactly one delegation.`);
    }
    descendants.push(matches[0]);
  }
  return descendants;
}

function descendantTasks(run: SwarmRun, rootTaskId: string): SwarmTask[] {
  const descendants: SwarmTask[] = [];
  const selected = new Set([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of run.tasks) {
      if (!task.parentTaskId || !selected.has(task.parentTaskId) || selected.has(task.taskId)) {
        continue;
      }
      selected.add(task.taskId);
      descendants.push(task);
      changed = true;
    }
  }
  return descendants;
}

async function repositorySnapshot(repositoryPath: string): Promise<RepositorySnapshot> {
  const [state, ref] = await Promise.all([
    worktreeState(repositoryPath),
    gitText(repositoryPath, ["symbolic-ref", "--quiet", "HEAD"]),
  ]);
  return { ...state, ref };
}

/** Repository state that does not require HEAD to be on a branch. */
async function worktreeState(repositoryPath: string): Promise<WorktreeState> {
  const [commonDirectory, head, status] = await Promise.all([
    gitCommonDirectory(repositoryPath),
    gitText(repositoryPath, ["rev-parse", "HEAD"]),
    gitText(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=normal"], false),
  ]);
  return {
    commonDirectory,
    head: requiredCommit(head, "Repository HEAD"),
    clean: status.length === 0,
  };
}

async function gitCommonDirectory(repositoryPath: string): Promise<string> {
  return path.resolve(
    await gitText(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await gitText(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (isGitExitCode(error, 1)) return false;
    throw error;
  }
}

function cleanupAdvisorPrompt(): string {
  return [
    "A Marshal swarm could not create a worktree because storage is exhausted.",
    "You are outside the formal swarm and have no tools.",
    "Give concise, read-only advice for finding reclaimable build caches and other disposable artifacts.",
    "Never delete anything, claim cleanup happened, or recommend deleting any worktree.",
    "Require explicit user review and approval before every cleanup action.",
  ].join("\n");
}

async function gitText(cwd: string, args: readonly string[], trim = true): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return trim ? result.stdout.trim() : result.stdout;
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is missing.`);
  return normalized;
}

function requiredCommit(value: string | undefined, label: string): string {
  const commit = requiredText(value, label);
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`${label} is invalid.`);
  return commit;
}

function isGitExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
