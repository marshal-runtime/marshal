import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeServiceContainer } from "@marshal/runtime";
import {
  DelegationManager,
  createRuntimeDelegationProvider,
  type DelegationAdapterPort,
  type DelegationAdapterSnapshot,
  type DelegationAdapterSpawnRequest,
  type DelegationContext,
  type DelegationRecord,
  type DelegationStore,
} from "@marshal/runtime/delegation";
import { FileDelegationStore } from "@marshal/runtime/effects";
import {
  FileSwarmRunEventStore,
  replaySwarmRun,
  type SwarmRun,
  type SwarmRunEventStore,
  type SwarmRunCreateConfiguration,
  type SwarmRunTarget,
} from "@marshal/swarm";
import type { SwarmSourceOptions } from "@marshal/swarm";

import type {
  MSettings,
  ReasoningEffort,
  SessionRuntimeAgentRole,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type { RuntimeTranscriptPage, RuntimeTranscriptRequest } from "../session-transcript";
import { delegationLaunchOverride } from "./agent-launch-override";
import type { MarshalRuntimeAgentPort } from "./agent-orchestration";
import type { MarshalRuntimeScope } from "./contracts";
import { prepareDelegationInstructions } from "./delegation-instructions";
import { createCallTimeAgentPort } from "./providers";
import { parseSwarmRunOwnerSessionId, type SwarmDriver } from "./swarm-driver";
import { classifySwarmLaunchFailure } from "./swarm-launch-failure";
import {
  bindMarshalSwarmServices,
  SWARM_EVENT_STORE_SERVICE,
  SWARM_TRANSCRIPT_READER_SERVICE,
} from "./swarm-services";
import {
  MarshalSwarmWorktreeLifecycle,
  type MarshalSwarmCleanupAdvice,
  type MarshalSwarmLifecycleSessionPort,
} from "./swarm-worktree-lifecycle";
import type { MarshalRuntimeUiController } from "./ui-controller";

const log = createLogger("MarshalSwarmProduction");
const execFileAsync = promisify(execFile);
const DEFAULT_PAUSE_MESSAGE =
  "Pause cooperatively at the next safe point. Preserve current progress and await further instructions.";
type SwarmDelegationRole = Extract<
  SessionRuntimeAgentRole,
  "planner" | "worker" | "reviewer" | "reconciler"
>;

interface MarshalSwarmSessionPort {
  runtimeContinuationEpoch?(source: string, target: string): number;
  sendRuntimeContinuation?(
    source: string,
    target: string,
    prompt: string,
    epoch: number,
  ): Promise<{ delivery: "accepted" | "held"; messageId?: string }>;
  cancelRuntimeContinuations?(source: string, target: string): Promise<void>;
  listWorkspacesForSelfTools(): Array<{ name: string; path: string }>;
  getSessionAsync(
    sessionId: string,
  ): Promise<{ workspaceName?: string; originWorkspaceName?: string } | null>;
}

interface MarshalSwarmProductionOptions {
  readonly rootDirectory: string;
  readonly serviceContainer: RuntimeServiceContainer;
  readonly sessions: MarshalSwarmSessionPort &
    MarshalSwarmLifecycleSessionPort & {
      getDefaultModel(): string;
      isModelAvailable(model: string): boolean;
      releaseRuntimeTaskController(sessionId: string, expectedDelegationId: string): Promise<void>;
      readRuntimeTranscript(input: RuntimeTranscriptRequest): Promise<RuntimeTranscriptPage>;
    };
  readonly deliverCleanupAdvice: (advice: MarshalSwarmCleanupAdvice) => Promise<void>;
  readonly getSettings: () => MSettings;
  /**
   * Terminal handoff for an adopted run that ended `failed` (including
   * cancellation). Controller ownership is deliberately NOT released on this
   * path — `swarm.runs.recoverSystemFailure` recovers a transport-
   * misclassified failure in place and requires the flag to still be set —
   * but the owning session's goal must learn the reason instead of staying
   * silently `pursuing` behind a run that will never call back.
   * `delegationId` is the failed run's root delegation: the receiver must
   * match it against the session's current controller ownership so a
   * historical failure never touches a goal owned by a newer controller or
   * not controller-owned at all. `abandoned` marks an explicit cancel, whose
   * matching controller is released right after this handoff — the goal is
   * then resumable — while an ordinary failure keeps ownership retained.
   */
  readonly onRunTerminalFailure?: (input: {
    sessionId: string;
    runId: string;
    delegationId: string;
    reason: string;
    abandoned: boolean;
  }) => void | Promise<void>;
}

interface StagedRunCreation {
  readonly targets?: readonly SwarmRunTarget[];
  readonly configuration?: SwarmRunCreateConfiguration;
}

class StagedSwarmRunEventStore implements SwarmRunEventStore {
  private readonly staged = new Map<string, StagedRunCreation>();

  constructor(
    private readonly inner: SwarmRunEventStore,
    private readonly onMutation?: (runId: string) => void,
    private readonly resolveMissingTargets?: (
      runId: string,
      scope: string,
    ) => Promise<readonly SwarmRunTarget[] | undefined>,
  ) {}

  stage(runId: string, creation: StagedRunCreation): void {
    this.staged.set(runId, creation);
  }

  async create(
    runId: string,
    objective: string,
    scope: string,
    targetRef?: string,
    targetHead?: string,
    targets?: readonly SwarmRunTarget[],
    configuration?: SwarmRunCreateConfiguration,
  ): Promise<void> {
    const staged = this.staged.get(runId);
    this.staged.delete(runId);
    const resolvedTargets =
      targets ?? staged?.targets ?? (await this.resolveMissingTargets?.(runId, scope));
    await this.inner.create(
      runId,
      objective,
      scope,
      targetRef,
      targetHead,
      resolvedTargets,
      configuration ?? staged?.configuration,
    );
    this.onMutation?.(runId);
  }

  append(runId: string, event: Parameters<SwarmRunEventStore["append"]>[1]): Promise<void> {
    return this.inner.append(runId, event).then(() => this.onMutation?.(runId));
  }
  read(runId: string): Promise<readonly import("@marshal/swarm").SwarmRunEvent[]> {
    return this.inner.read(runId);
  }
  list(): Promise<readonly string[]> {
    return this.inner.list();
  }
}

export class MarshalDelegationAdapter implements DelegationAdapterPort {
  constructor(
    private readonly store: DelegationStore,
    private readonly sessions: MarshalSwarmSessionPort,
    private readonly agents: MarshalRuntimeAgentPort,
    private readonly lifecycle?: MarshalSwarmWorktreeLifecycle,
    private readonly isModelAvailable?: (model: string) => boolean,
    private readonly instructionDirectory?: string,
  ) {}

  async spawn(
    { delegationId, request }: DelegationAdapterSpawnRequest,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const signal = linkedAbortSignal(context);
    try {
      const ownerScope = await this.ownerScope(context);
      const workspace = this.resolveWorkspace(
        request.scope === undefined
          ? ownerScope.workspaceName
          : requiredText(request.scope, "request.scope"),
      );
      const reasoningEffort = parseReasoningEffort(request.reasoningEffort);
      const model =
        request.model === undefined ? undefined : requiredText(request.model, "request.model");
      if (model !== undefined && this.isModelAvailable?.(model) === false) {
        throw new Error(
          `Configured delegation model "${model}" is unavailable; no fallback was selected.`,
        );
      }
      const role = parseDelegationRole(request.role);
      const createsWorktree = workspaceModeUsesWorktree(request.workspaceMode, role);
      let baseRef =
        request.baseRef === undefined
          ? undefined
          : requiredText(request.baseRef, "request.baseRef");
      if (this.lifecycle !== undefined && createsWorktree) {
        const record = await this.store.get(delegationId);
        if (!record) {
          throw new Error(`Delegation "${delegationId}" was not recorded before launch.`);
        }
        if (record.parentDelegationId !== undefined) {
          const integrationRef = await this.lifecycle.resolveIntegrationRefForDelegation(
            record.parentDelegationId,
            workspace.name,
          );
          if (integrationRef !== undefined) baseRef = integrationRef;
        }
      }
      const task = await prepareDelegationInstructions(
        request.prompt,
        runtimeAgentRoleFor(role),
        this.instructionDirectory,
      );
      const launch = () =>
        this.agents.launch({
          scope: ownerScope,
          task,
          idempotencyKey:
            delegationId.length > 256
              ? createHash("sha256").update(delegationId).digest("hex")
              : delegationId,
          runtimeDelegationId: delegationId,
          ...(typeof context.invocation?.metadata?.runtimeExtensionIdentity === "string"
            ? { runtimeTaskController: context.invocation.metadata.runtimeExtensionIdentity }
            : {}),
          workspaceName: workspace.name,
          repoPath: workspace.path,
          runtimeAgentRole: runtimeAgentRoleFor(role),
          sessionId: request.backend === ownerScope.sessionId ? ownerScope.sessionId : undefined,
          ...(model === undefined ? {} : { model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(baseRef === undefined ? {} : { baseRef }),
          ...delegationLaunchOverride(request),
          createWorktree: createsWorktree,
          signal: signal.value,
        });
      const agent = await (this.lifecycle
        ? this.lifecycle.admitLaunch(ownerScope, createsWorktree, signal.value, launch)
        : launch());
      return { adapterHandle: agent.id, state: "running", ...executionEvidence(agent) };
    } catch (error) {
      const environmental = this.lifecycle?.environmentalError(error);
      return {
        state: "failed",
        error: environmental ? { ...environmental } : { message: plainError(error) },
      };
    } finally {
      signal.dispose();
    }
  }

  async wait(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const signal = linkedAbortSignal(context);
    try {
      const scope = await this.ownerScope(context);
      const result = await this.agents.wait(scope, adapterHandle, {
        signal: signal.value,
      });
      if (result.state !== "completed") {
        return {
          adapterHandle,
          state: "failed",
          error: `Native agent "${adapterHandle}" stopped waiting before completion.`,
        };
      }
      // Reclamation consults durable task completion and idle session state;
      // settling a conversation alone never makes its worktree eligible.
      if (roleHasIsolatedWorktree(result.agent.runtimeAgentRole) && result.agent.repoPath) {
        void this.reclaimSettledWorktrees(adapterHandle, scope);
      }
      return {
        adapterHandle,
        state: "done",
        ...executionEvidence(result.agent),
        ...executionEvidence(result),
      };
    } catch (error) {
      const message = plainError(error);
      const agent = await this.ownerScope(context)
        .then((scope) => this.agents.get(scope, adapterHandle))
        .catch(() => null);
      return {
        adapterHandle,
        state: "failed",
        error: message,
        ...(agent ? executionEvidence(agent) : {}),
      };
    } finally {
      signal.dispose();
    }
  }

  /** Explicit task finalization, independent of whether the conversation is idle. */
  async complete(
    adapterHandle: string,
    context: DelegationContext,
    delegationId?: string,
  ): Promise<DelegationAdapterSnapshot> {
    const scope = await this.ownerScope(context);
    const agent = await this.agents.get(scope, adapterHandle);
    if (!agent) throw new Error(`Native agent "${adapterHandle}" was not found.`);
    const { record, records } = await this.delegationForHandle(
      adapterHandle,
      context,
      delegationId,
    );
    const changeRefs = collectDescendantChangeRefs(records, record.delegationId);
    let reconciliationRequired = false;
    if (roleUsesWorktree(agent.runtimeAgentRole) && agent.repoPath) {
      const changeRef = await gitChangeRef(agent.repoPath);
      if (!changeRefs.includes(changeRef)) changeRefs.push(changeRef);
      const promotion = await this.lifecycle?.promoteCompletedDelegation({
        delegationId: record.delegationId,
        worktreePath: agent.repoPath,
      });
      reconciliationRequired = promotion?.status === "stale";
    }
    // Completing an adopted main conversation closes its task; it must not
    // silently merge generated work into the user's live checkout. A delegated
    // root retains the existing canonical integration lifecycle.
    const adoptedOwner = record.ownerSessionId === adapterHandle;
    if (this.lifecycle && record.parentDelegationId === undefined && !adoptedOwner) {
      await this.lifecycle.integrateRoot({
        rootDelegationId: record.delegationId,
        records,
        ownerScope: scope,
      });
    }
    return {
      adapterHandle,
      state: "done",
      ...executionEvidence(agent),
      ...(changeRefs.length ? { changeRefs } : {}),
      ...(reconciliationRequired || adoptedOwner
        ? {
            result: {
              integrationWarning: adoptedOwner
                ? "Task completed with outputs preserved on their branches; the owner checkout was not changed. Final integration requires a separate explicit action."
                : "Completed work was not fast-forward integrated; reconciliation is required.",
            },
          }
        : {}),
    };
  }

  /** Verify the original adopted owner without launching, sending, or finalizing work. */
  async recover(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const signal = linkedAbortSignal(context);
    try {
      const scope = await this.ownerScope(context);
      if (adapterHandle !== scope.sessionId)
        throw new Error("Only the existing adopted owner can be recovered by this adapter.");
      const agent = await this.agents.get(scope, adapterHandle, signal.value);
      if (!agent) throw new Error("Recovery requires an existing owner session.");
      return {
        adapterHandle,
        state: agent.state === "running" ? "running" : "done",
        ...executionEvidence(agent),
      };
    } finally {
      signal.dispose();
    }
  }

  async continue(
    adapterHandle: string,
    prompt: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const signal = linkedAbortSignal(context);
    try {
      const epoch =
        this.sessions.runtimeContinuationEpoch?.(requiredScopeValue(context), adapterHandle) ?? 0;
      const scope = await this.ownerScope(context);
      // The controller reevaluates after the current turn. Do not leave another
      // automatic prompt queued behind work that may be paused in the meantime.
      {
        const activeOwner = await this.agents.get(scope, adapterHandle, signal.value);
        if (!activeOwner)
          throw new Error("Native continuation target is unavailable or outside owner authority.");
        if (activeOwner.state === "running") {
          return {
            adapterHandle,
            state: "running",
            continuationDelivery: "held",
            ...executionEvidence(activeOwner),
          };
        }
      }
      if (this.sessions.sendRuntimeContinuation) {
        let delivery: "accepted" | "held";
        try {
          const receipt = await this.sessions.sendRuntimeContinuation(
            scope.sessionId,
            adapterHandle,
            prompt,
            epoch,
          );
          delivery = receipt.delivery;
        } catch (error) {
          // A backend restoration can invalidate the reserved send before any
          // prompt reaches the model. Keep the controller notification pending.
          if (plainError(error) === "Session send was superseded before it started") {
            const active = await this.agents.get(scope, adapterHandle, signal.value);
            if (!active) throw error;
            return {
              adapterHandle,
              state: "running",
              continuationDelivery: "held",
              ...executionEvidence(active),
            };
          }
          if (
            adapterHandle !== scope.sessionId ||
            plainError(error) !== "Another message or turn is already active for this session"
          )
            throw error;
          const active = await this.agents.get(scope, adapterHandle, signal.value);
          if (active?.state !== "running") throw error;
          return {
            adapterHandle,
            state: "running",
            continuationDelivery: "held",
            ...executionEvidence(active),
          };
        }
        const agent = await this.agents.get(scope, adapterHandle, signal.value);
        return {
          adapterHandle,
          state: "running",
          continuationDelivery: delivery,
          ...(agent ? executionEvidence(agent) : {}),
        };
      }
      let held = false;
      const result = await this.agents
        .send(scope, adapterHandle, prompt, "queue", signal.value)
        .catch(async (error: unknown) => {
          // The owner may start a turn after the read above. Only recover this
          // specific contention error with fresh evidence of an active owner.
          if (
            adapterHandle === scope.sessionId &&
            plainError(error) === "Another message or turn is already active for this session"
          ) {
            const activeOwner = await this.agents.get(scope, adapterHandle, signal.value);
            if (activeOwner?.state === "running") {
              held = true;
              return { accepted: true, agent: activeOwner, messageId: undefined };
            }
          }
          throw error;
        });
      if (!result.accepted) {
        return {
          adapterHandle,
          state: "failed",
          error: `Native agent "${adapterHandle}" did not accept the continuation.`,
        };
      }
      // The adopted owner uses sendMessage, which returns after sending without
      // a subagent delivery record. Only child continuations require that ID.
      if (!result.messageId && adapterHandle !== scope.sessionId) {
        return {
          adapterHandle,
          state: "failed",
          error: `Native agent "${adapterHandle}" returned no continuation message ID.`,
        };
      }
      return {
        adapterHandle,
        state: "running",
        continuationDelivery: held ? "held" : "accepted",
        ...executionEvidence(result.agent),
      };
    } catch (error) {
      return { adapterHandle, state: "failed", error: plainError(error) };
    } finally {
      signal.dispose();
    }
  }

  /**
   * Pausing a run fans across every task that was running when the pause was
   * requested, including ones whose session has since been deleted by a failed
   * launch. A missing or already-idle agent is the desired end state, so it
   * resolves instead of failing the pause.
   */
  async pause(adapterHandle: string, reason: string, context: DelegationContext): Promise<void> {
    const signal = linkedAbortSignal(context);
    try {
      const scope = await this.ownerScope(context);
      await this.sessions.cancelRuntimeContinuations?.(scope.sessionId, adapterHandle);
      const agent = await this.agents.get(scope, adapterHandle, signal.value);
      if (!agent || agent.state === "idle") return;
      const detail = reason.trim();
      try {
        await this.agents.send(
          scope,
          adapterHandle,
          detail ? `${DEFAULT_PAUSE_MESSAGE} Reason: ${detail}` : DEFAULT_PAUSE_MESSAGE,
          "interrupt",
          signal.value,
        );
      } catch (error) {
        if (!isTerminalAgentFailure(error)) throw error;
        log.warn("Swarm pause target was already terminal.", { adapterHandle });
      }
    } finally {
      signal.dispose();
    }
  }

  async cancel(
    adapterHandle: string,
    context: DelegationContext,
  ): Promise<DelegationAdapterSnapshot> {
    const signal = linkedAbortSignal(context);
    try {
      const scope = await this.ownerScope(context);
      await this.agents.cancel(scope, adapterHandle, signal.value);
      return {
        adapterHandle,
        state: "failed",
        error: `Native agent "${adapterHandle}" was cancelled.`,
      };
    } catch (error) {
      return { adapterHandle, state: "failed", error: plainError(error) };
    } finally {
      signal.dispose();
    }
  }

  private async reclaimSettledWorktrees(
    adapterHandle: string,
    ownerScope: MarshalRuntimeScope,
  ): Promise<void> {
    if (!this.lifecycle) return;
    try {
      const { record, records } = await this.delegationForHandle(adapterHandle);
      await this.lifecycle.reclaimCapturedWorktrees({
        delegationId: record.delegationId,
        records,
        ownerScope,
      });
    } catch (error) {
      log.warn("Settled swarm worktree reclamation failed.", { adapterHandle }, error);
    }
  }

  private async delegationForHandle(
    adapterHandle: string,
    context?: DelegationContext,
    delegationId?: string,
  ): Promise<{ readonly record: DelegationRecord; readonly records: readonly DelegationRecord[] }> {
    const records = await this.store.list();
    // A native owner can coordinate multiple runs. The manager supplies the
    // authorized target record, so finalization must not infer it from a session.
    if (delegationId !== undefined) {
      const record = records.find((candidate) => candidate.delegationId === delegationId);
      if (!record || record.adapterHandle !== adapterHandle) {
        throw new Error(
          `Delegation "${delegationId}" does not match native agent "${adapterHandle}".`,
        );
      }
      return { record, records };
    }
    const trustedDelegationId =
      context?.scope?.sessionId === adapterHandle
        ? context.invocation?.metadata?.delegationId
        : undefined;
    const matches = records.filter(
      (record) =>
        record.adapterHandle === adapterHandle ||
        (record.adapterHandle === undefined && record.delegationId === trustedDelegationId),
    );
    if (matches.length !== 1) {
      throw new Error(`Native agent "${adapterHandle}" has no portable delegation ID.`);
    }
    return { record: matches[0], records };
  }

  private resolveWorkspace(resourceId: string): { name: string; path: string } {
    const matches = this.sessions
      .listWorkspacesForSelfTools()
      .filter((workspace) => workspace.name === resourceId);
    if (matches.length !== 1) {
      throw new Error(
        `Swarm resource "${resourceId}" must resolve to exactly one registered repository root. Reassign the task to one registered resource.`,
      );
    }
    return matches[0];
  }

  private async ownerScope(context: DelegationContext): Promise<MarshalRuntimeScope> {
    const sessionId = requiredScopeValue(context);
    const session = await this.sessions.getSessionAsync(sessionId);
    if (!session) throw new Error(`Native session "${sessionId}" was not found.`);
    const workspaceName = session.workspaceName?.trim() || session.originWorkspaceName?.trim();
    if (!workspaceName) {
      throw new Error(`Native session "${sessionId}" has no workspace name.`);
    }
    return { sessionId, workspaceName };
  }
}

export function collectDescendantChangeRefs(
  records: readonly DelegationRecord[],
  delegationId: string,
): string[] {
  const visited = new Set<string>();
  const changeRefs: string[] = [];
  const collect = (parentDelegationId: string) => {
    if (visited.has(parentDelegationId)) return;
    visited.add(parentDelegationId);
    for (const child of records) {
      if (child.parentDelegationId !== parentDelegationId) continue;
      collect(child.delegationId);
      for (const changeRef of child.changeRefs ?? []) {
        if (!changeRefs.includes(changeRef)) changeRefs.push(changeRef);
      }
    }
  };
  collect(delegationId);
  return changeRefs;
}

export function createMarshalSwarmProduction(options: MarshalSwarmProductionOptions) {
  const rootDirectory = path.resolve(options.rootDirectory);
  const agents = createCallTimeAgentPort(options.serviceContainer);
  const delegationStore = new FileDelegationStore({
    rootDirectory: path.join(rootDirectory, "delegation"),
  });
  const eventStore = new StagedSwarmRunEventStore(
    new FileSwarmRunEventStore(rootDirectory),
    undefined,
    (runId, scopeName) => captureMissingRunTargets(lifecycle, options.sessions, runId, scopeName),
  );
  const lifecycle: MarshalSwarmWorktreeLifecycle = new MarshalSwarmWorktreeLifecycle({
    eventStore,
    sessions: options.sessions,
    agents,
    deliverCleanupAdvice: options.deliverCleanupAdvice,
    stageRunCreation: (runId, creation) => eventStore.stage(runId, creation),
  });
  const serviceBindingHandles = Promise.all([
    bindMarshalSwarmServices(
      options.serviceContainer,
      path.join(rootDirectory, "runs"),
      options.getSettings,
      (configured) => {
        const selected = configured ?? options.sessions.getDefaultModel();
        if (!options.sessions.isModelAvailable(selected)) {
          throw new Error(
            `Configured Swarm model "${selected}" is unavailable; no fallback was selected.`,
          );
        }
        return selected;
      },
    ),
    options.serviceContainer.bind(SWARM_EVENT_STORE_SERVICE, { useValue: eventStore }),
    options.serviceContainer.bind(SWARM_TRANSCRIPT_READER_SERVICE, {
      useValue: { read: (input) => options.sessions.readRuntimeTranscript(input) },
    }),
  ]).then(([handles, eventStoreHandle, transcriptReaderHandle]) => [
    ...handles,
    eventStoreHandle,
    transcriptReaderHandle,
  ]);
  const adapter = new MarshalDelegationAdapter(
    delegationStore,
    options.sessions,
    agents,
    lifecycle,
    (model) => options.sessions.isModelAvailable(model),
    path.join(rootDirectory, "instructions"),
  );
  const manager = new DelegationManager({ store: delegationStore, adapter });
  const delegationProvider = createRuntimeDelegationProvider({ manager });
  const swarmServiceContainer =
    options.serviceContainer as unknown as import("@marshal/swarm").SwarmServiceContainer; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- pinned Swarm compatibility boundary
  const swarmOptions: SwarmSourceOptions = {
    eventStore,
    // The pinned archive's container type predates Runtime's shared container; both
    // use symbol-keyed get/bind, so this is the single compatibility boundary.
    serviceContainer: swarmServiceContainer,
  };
  const handOffTerminalFailure = async (
    scope: MarshalRuntimeScope,
    run: SwarmRun,
    abandoned: boolean,
  ): Promise<string | null> => {
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (!root?.delegationId) {
      // Without the root delegation there is no way to prove this run is the
      // session's current controller; routing by session ID alone could block
      // an unrelated goal.
      log.warn(
        "Terminal failed swarm run carries no root delegation; skipping goal handoff (ownership unprovable).",
        { runId: run.runId },
      );
      return null;
    }
    try {
      await options.onRunTerminalFailure?.({
        sessionId: scope.sessionId,
        runId: run.runId,
        delegationId: root.delegationId,
        reason: swarmRunFailureReason(run),
        abandoned,
      });
    } catch (error) {
      log.warn("Swarm terminal-failure handoff failed.", { runId: run.runId }, error);
    }
    return root.delegationId;
  };

  const onRunSettled = async (scope: MarshalRuntimeScope, run: SwarmRun) => {
    if (run.state === "failed") {
      // Keep controller ownership and the captured worktrees: recoverSystemFailure
      // needs both to recover a misclassified failure in place. Only the reason
      // travels up, so the owning goal does not stay silently `pursuing`.
      await handOffTerminalFailure(scope, run, false);
      return;
    }
    if (run.state !== "completed") return;
    try {
      await lifecycle.retireCompletedRun(run, await delegationStore.list(), scope);
    } catch (error) {
      log.warn("Completed swarm worktree retirement failed.", { runId: run.runId }, error);
    }
    const root = run.tasks.find((task) => task.parentTaskId === undefined);
    if (root?.delegationId) {
      await options.sessions.releaseRuntimeTaskController(scope.sessionId, root.delegationId);
    }
  };

  const onRunAbandoned = async (scope: MarshalRuntimeScope, run: SwarmRun) => {
    if (run.state !== "failed") return;
    // Explicit cancel is the supported abandon path for a genuinely failed
    // run: surface the terminal reason on the goal first, then relinquish
    // ONLY this run's controller (compare-and-delete — an old cancel can
    // never release a newer controller) so the user can resume the goal.
    const delegationId = await handOffTerminalFailure(scope, run, true);
    if (delegationId) {
      await options.sessions.releaseRuntimeTaskController(scope.sessionId, delegationId);
    }
  };

  return {
    delegationSource: () => delegationProvider,
    swarmOptions,
    serviceBindingHandles,
    worktreeLifecycle: lifecycle,
    onRunSettled,
    onRunAbandoned,
    setUiController: (_controller: MarshalRuntimeUiController) => undefined,
    recoverPersistedRuns: (driver: SwarmDriver) =>
      recoverPersistedRuns(eventStore, driver, onRunSettled),
  };
}

/** Capture the owner workspace when a run is created without staged targets. */
export async function captureMissingRunTargets(
  lifecycle: MarshalSwarmWorktreeLifecycle,
  sessions: MarshalSwarmSessionPort,
  runId: string,
  scopeName: string,
): Promise<readonly SwarmRunTarget[] | undefined> {
  let ownerSessionId: string;
  try {
    ownerSessionId = parseSwarmRunOwnerSessionId(runId);
  } catch {
    return undefined;
  }
  const session = await sessions.getSessionAsync(ownerSessionId);
  const workspaceName =
    session?.workspaceName?.trim() || session?.originWorkspaceName?.trim() || scopeName;
  const workspace = sessions
    .listWorkspacesForSelfTools()
    .find((candidate) => candidate.name === workspaceName);
  if (!workspace) return undefined;
  const target = await lifecycle.captureTarget(workspace.name, workspace.path);
  await lifecycle.initializeIntegration(runId, [target]);
  return [target];
}

export async function recoverPersistedRuns(
  eventStore: SwarmRunEventStore,
  driver: Pick<SwarmDriver, "drive">,
  onRunSettled: (scope: MarshalRuntimeScope, run: SwarmRun) => Promise<void>,
): Promise<void> {
  let runIds: readonly string[];
  try {
    runIds = await eventStore.list();
  } catch (error) {
    log.error("Persisted swarm discovery failed.", {}, error);
    return;
  }

  await Promise.all(
    runIds.map(async (runId) => {
      try {
        const run = replaySwarmRun(await eventStore.read(runId));
        const scope = {
          sessionId: parseSwarmRunOwnerSessionId(runId),
          workspaceName: run.scope,
        };
        // running → drive; the driver settles the outcome (including a
        // terminal state read back after a mutation error). A run found
        // already terminal after restart gets the same settlement as a live
        // one: completed retires and releases; failed hands the reason to the
        // owning goal while retaining controller ownership.
        if (run.state === "running") await driver.drive(scope, runId);
        else if (run.state === "completed" || run.state === "failed") {
          await onRunSettled(scope, run);
        }
        // paused/blocked runs stay adopted and wait for an explicit resume.
      } catch (error) {
        // Without a replayable run there is no root delegation proving which
        // controller this run corresponds to; routing a goal handoff by
        // session ID alone could block an unrelated goal. Log the evidence
        // gap instead of guessing.
        log.error(
          "Persisted swarm recovery failed; no ownership evidence for a goal handoff.",
          { runId },
          error,
        );
      }
    }),
  );
}

/** Bounded, user-visible reason for a terminal `failed` run. */
function swarmRunFailureReason(run: SwarmRun): string {
  const error = run.error;
  const text =
    typeof error === "string"
      ? error
      : error === undefined || error === null
        ? ""
        : JSON.stringify(error);
  return (text.trim() || "The swarm run ended failed without a recorded error.").slice(0, 500);
}

function requiredScopeValue(context: DelegationContext): string {
  return requiredText(context.scope?.sessionId, "context.scope.sessionId");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  switch (value) {
    case undefined:
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      throw new TypeError(`request.reasoningEffort has unsupported value "${value}".`);
  }
}

function parseDelegationRole(value: string | undefined): SwarmDelegationRole | "swarm" {
  switch (value) {
    case undefined:
      return "swarm";
    case "planner":
    case "worker":
    case "reviewer":
    case "reconciler":
      return value;
    default:
      throw new TypeError(`request.role has unsupported value "${value}".`);
  }
}

function roleUsesWorktree(role: SessionRuntimeAgentRole | undefined): boolean {
  return role === undefined || role === "swarm" || role === "worker" || role === "reconciler";
}

/** Reviewers read in an isolated worktree too, but never capture a change ref from it. */
function roleHasIsolatedWorktree(role: SessionRuntimeAgentRole | undefined): boolean {
  return roleUsesWorktree(role) || role === "reviewer";
}

function workspaceModeUsesWorktree(
  workspaceMode: "isolated" | "shared" | undefined,
  role: SwarmDelegationRole | "swarm",
): boolean {
  if (workspaceMode !== undefined) return workspaceMode === "isolated";
  return roleUsesWorktree(role);
}

function runtimeAgentRoleFor(role: SwarmDelegationRole | "swarm"): SessionRuntimeAgentRole {
  // The ordinary planner role disables every tool, but Swarm planners must curate the Field Guide.
  return role === "planner" ? "swarm" : role;
}

function plainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A deleted, stale, or already-stopped agent cannot be paused again, and saying
 * so is not a new failure.
 */
function isTerminalAgentFailure(error: unknown): boolean {
  const failure = classifySwarmLaunchFailure(error);
  return failure.category === "terminal" && failure.code !== "ABORTED";
}

function executionEvidence(value: {
  readonly id?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly transcriptRef?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly usageByModel?: readonly {
    readonly model?: string;
    readonly usage: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly costUsd?: number;
    };
  }[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly costUsd?: number;
  };
}) {
  return {
    ...((value.sessionId ?? value.id) ? { sessionId: value.sessionId ?? value.id } : {}),
    ...(value.executionId ? { executionId: value.executionId } : {}),
    ...(value.transcriptRef ? { transcriptRef: value.transcriptRef } : {}),
    ...(value.model
      ? { model: value.model }
      : value.usageByModel && value.usageByModel.length > 1
        ? { model: undefined }
        : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.usage ? { usage: value.usage } : {}),
    ...(value.usageByModel ? { usageByModel: value.usageByModel } : {}),
  };
}

function linkedAbortSignal(context: DelegationContext): {
  readonly value?: AbortSignal;
  readonly dispose: () => void;
} {
  const source = context.signal;
  if (!source) return { dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener?.("abort", abort, { once: true });
  return {
    value: controller.signal,
    dispose: () => source.removeEventListener?.("abort", abort),
  };
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return requiredText(result.stdout.trim(), "Git output");
}

async function gitChangeRef(cwd: string): Promise<string> {
  try {
    return await gitText(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch (error) {
    if (!isGitExitCode(error, 1)) throw error;
    return gitText(cwd, ["rev-parse", "HEAD"]);
  }
}

function isGitExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
