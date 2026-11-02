// common/workflows-reducer.ts
//
// Pure reducer that derives a `RunSnapshot` from a sequence of
// `WorkflowEvent`s. Used by both the main process (for the
// `workflows:getRun` snapshot response) and the renderer (for live
// event-stream tail). Keeping the reducer pure + dependency-free means
// the same code path computes the snapshot in both directions, so the
// renderer doesn't drift from the engine's authoritative view.
//
// Exhaustiveness: the switch is exhaustive on `event.type`; adding a
// new variant in `workflows-contract/events.ts` makes typecheck fail
// here until the new arm is added.

import type {
  AgentHandleSummary,
  ArtifactRefSummary,
  FanOutUnit,
  RunSnapshot,
  StepView,
  WorkflowEvent,
} from "./workflows-contract";

export interface ReducerSeed {
  readonly runId: string;
  readonly workflowId?: string;
}

export function createInitialSnapshot(seed: ReducerSeed): RunSnapshot {
  return {
    runId: seed.runId,
    runFamilyId: seed.runId,
    workflowId: seed.workflowId ?? "",
    workflowVersion: "",
    status: "pending",
    startedAt: 0,
    steps: [],
    agents: {},
    artifacts: [],
    capacity: { used: 0, cap: 0, queueLength: 0 },
    events: { lastSeq: -1 },
  };
}

/**
 * Apply a single event to a snapshot. Always returns a new object — never
 * mutates the input. The renderer relies on referential equality to decide
 * whether to re-render.
 */
export function reduceRun(snapshot: RunSnapshot, event: WorkflowEvent): RunSnapshot {
  const baseUpdate = { events: { lastSeq: event.seq } };
  switch (event.type) {
    case "run.started":
      return {
        ...snapshot,
        ...baseUpdate,
        workflowId: event.payload.workflowId,
        workflowVersion: event.payload.workflowVersion,
        runFamilyId: event.payload.runFamilyId,
        parentRunId: event.payload.parentRunId,
        schedule: event.payload.schedule,
        status: "running",
        startedAt: event.payload.startedAt,
      };
    case "run.completed":
      return {
        ...snapshot,
        ...baseUpdate,
        status: "succeeded",
        endedAt: event.ts,
        result: event.payload.result,
      };
    case "run.failed":
      return {
        ...snapshot,
        ...baseUpdate,
        status: "failed",
        endedAt: event.ts,
        errorSummary: {
          message: event.payload.error.message,
          stack: event.payload.error.stack,
        },
      };
    case "run.cancelled":
      return {
        ...snapshot,
        ...baseUpdate,
        status: "cancelled",
        endedAt: event.ts,
      };
    case "run.crashed":
      return {
        ...snapshot,
        ...baseUpdate,
        status: "crashed",
        endedAt: event.ts,
        errorSummary: {
          message: event.payload.error.message,
          stack: event.payload.error.stack,
          code: event.payload.code,
        },
      };
    case "step.started": {
      const step: StepView = {
        id: event.payload.stepKey,
        label: event.payload.label,
        parentStepKey: event.payload.parentStepKey,
        status: "running",
        startedAt: event.payload.startedAt,
        depth: computeDepth(snapshot.steps, event.payload.parentStepKey),
        kind: "sequential",
        directAgents: [],
        artifacts: [],
      };
      return {
        ...snapshot,
        ...baseUpdate,
        steps: upsertStep(snapshot.steps, step),
      };
    }
    case "step.completed": {
      return {
        ...snapshot,
        ...baseUpdate,
        steps: upsertStep(snapshot.steps, {
          id: event.payload.stepKey,
          label: event.payload.label,
          parentStepKey: findParent(snapshot.steps, event.payload.stepKey),
          status: "succeeded",
          endedAt: event.ts,
          durationMs: event.payload.durationMs,
          result: event.payload.result,
        }),
      };
    }
    case "step.failed": {
      return {
        ...snapshot,
        ...baseUpdate,
        steps: upsertStep(snapshot.steps, {
          id: event.payload.stepKey,
          label: event.payload.label,
          parentStepKey: findParent(snapshot.steps, event.payload.stepKey),
          status: "failed",
          endedAt: event.ts,
          durationMs: event.payload.durationMs,
          error: {
            message: event.payload.error.message,
            stack: event.payload.error.stack,
          },
        }),
      };
    }
    case "step.skipped-replay": {
      return {
        ...snapshot,
        ...baseUpdate,
        steps: upsertStep(snapshot.steps, {
          id: event.payload.stepKey,
          label: event.payload.label,
          parentStepKey: findParent(snapshot.steps, event.payload.stepKey),
          status: "skipped",
          result: event.payload.result,
        }),
      };
    }
    case "fanOut.started": {
      const units = event.payload.itemKeys.map(
        (itemKey): FanOutUnit => ({
          handleId: "",
          itemKey,
          status: "queued",
          sessionId: null,
          startedAt: null,
          finishedAt: null,
        }),
      );
      return {
        ...snapshot,
        ...baseUpdate,
        steps: patchStepById(snapshot.steps, event.payload.stepKey, (s) => ({
          ...s,
          kind: "fanOut",
          maxConcurrency: event.payload.maxConcurrency,
          units,
        })),
      };
    }
    case "fanOut.unit-completed":
      return {
        ...snapshot,
        ...baseUpdate,
        steps: patchUnit(snapshot.steps, event.payload.stepKey, event.payload.itemKey, (u) => ({
          ...u,
          status: "succeeded",
          finishedAt: event.ts,
        })),
      };
    case "fanOut.unit-failed":
      return {
        ...snapshot,
        ...baseUpdate,
        steps: patchUnit(snapshot.steps, event.payload.stepKey, event.payload.itemKey, (u) => ({
          ...u,
          status: "failed",
          finishedAt: event.ts,
        })),
      };
    case "fanOut.completed":
      // Per-unit terminal status already arrived via fanOut.unit-*; the
      // parent step's status comes from step.completed / step.failed.
      return { ...snapshot, ...baseUpdate };
    case "agent.spawn-requested": {
      const { handleId, stepKey, agentName, displayName, fanOutStepKey, fanOutUnitKey } =
        event.payload;
      const handle: AgentHandleSummary = {
        handleId,
        sessionId: "",
        stepKey,
        agentName,
        displayName,
        status: "queued",
        identity: agentName ?? displayName ?? "agent",
        turnCount: 0,
        lastMessageAt: null,
      };
      let steps = addDirectAgent(snapshot.steps, stepKey, handleId);
      if (fanOutStepKey != null && fanOutUnitKey != null) {
        steps = patchUnit(steps, fanOutStepKey, fanOutUnitKey, (u) => ({ ...u, handleId }));
      }
      return {
        ...snapshot,
        ...baseUpdate,
        steps,
        agents: { ...snapshot.agents, [handleId]: handle },
      };
    }
    case "agent.spawned": {
      const { handleId, sessionId, agentName, stepKey, fanOutStepKey, fanOutUnitKey } =
        event.payload;
      const existing = snapshot.agents[handleId];
      const effStepKey = stepKey ?? existing?.stepKey ?? "";
      const handle: AgentHandleSummary = {
        handleId,
        sessionId,
        stepKey: effStepKey,
        agentName: agentName ?? existing?.agentName,
        displayName: existing?.displayName,
        status: "running",
        identity: existing?.identity ?? agentName ?? existing?.displayName ?? "agent",
        turnCount: existing?.turnCount ?? 0,
        lastMessageAt: existing?.lastMessageAt ?? null,
        lastMessageSnippet: existing?.lastMessageSnippet,
      };
      let steps = snapshot.steps;
      if (effStepKey !== "") steps = addDirectAgent(steps, effStepKey, handleId);
      if (fanOutStepKey != null && fanOutUnitKey != null) {
        steps = patchUnit(steps, fanOutStepKey, fanOutUnitKey, (u) => ({
          ...u,
          handleId,
          sessionId,
          startedAt: u.startedAt ?? event.ts,
          status: u.status === "queued" ? "running" : u.status,
        }));
      }
      return {
        ...snapshot,
        ...baseUpdate,
        steps,
        agents: { ...snapshot.agents, [handleId]: handle },
      };
    }
    case "agent.message": {
      const existing = snapshot.agents[event.payload.handleId];
      if (!existing) return { ...snapshot, ...baseUpdate };
      const isAssistant = event.payload.role === "assistant";
      return {
        ...snapshot,
        ...baseUpdate,
        agents: {
          ...snapshot.agents,
          [event.payload.handleId]: {
            ...existing,
            turnCount: (existing.turnCount ?? 0) + (isAssistant ? 1 : 0),
            lastMessageAt: event.ts,
            lastMessageSnippet: truncateSnippet(event.payload.content),
          },
        },
      };
    }
    case "agent.replied":
    case "subagent.queued":
    case "ctx.emit":
      // Message-grade events: not aggregated beyond agent.message above. The
      // UI subscribes to the raw event stream for these (per c-ui §7.3).
      return { ...snapshot, ...baseUpdate };
    case "agent.spawn-complete": {
      const existing = snapshot.agents[event.payload.handleId];
      if (!existing) return { ...snapshot, ...baseUpdate };
      return {
        ...snapshot,
        ...baseUpdate,
        agents: {
          ...snapshot.agents,
          [event.payload.handleId]: { ...existing, status: "completed" },
        },
      };
    }
    case "agent.spawn-failed": {
      const existing = snapshot.agents[event.payload.handleId];
      if (!existing) return { ...snapshot, ...baseUpdate };
      return {
        ...snapshot,
        ...baseUpdate,
        agents: {
          ...snapshot.agents,
          [event.payload.handleId]: { ...existing, status: "failed" },
        },
      };
    }
    case "artifact.saved": {
      const ref: ArtifactRefSummary = {
        key: event.payload.key,
        storageKey: event.payload.storageKey,
        namespace: event.payload.namespace,
        mime: event.payload.mime,
        sizeBytes: event.payload.sizeBytes,
        writtenAt: event.ts,
        stepKey: event.payload.stepKey,
      };
      const steps = event.payload.stepKey
        ? addStepArtifact(snapshot.steps, event.payload.stepKey, event.payload.key)
        : snapshot.steps;
      return {
        ...snapshot,
        ...baseUpdate,
        steps,
        artifacts: [...snapshot.artifacts, ref],
      };
    }
    case "artifact.credential-redacted":
    case "state.read":
    case "state.written":
    case "state.deleted":
    case "state.credential-redacted":
      // Surfaced as a count in `totals`/UI badge in a later iteration. For
      // V1, the event is observable through the raw event stream.
      return { ...snapshot, ...baseUpdate };
    case "schedule.cursor-advanced":
      return { ...snapshot, ...baseUpdate, scheduleCursor: event.payload.next };
    case "stage.context-exposed":
      return {
        ...snapshot,
        ...baseUpdate,
        stageContexts: upsertStageContext(snapshot.stageContexts ?? [], event.payload),
      };
    case "investigation.completion-transitioned":
      return {
        ...snapshot,
        ...baseUpdate,
        investigationCompletions: {
          ...(snapshot.investigationCompletions ?? {}),
          [event.payload.incidentId]: event.payload,
        },
      };
    case "action-center.items-set":
      return {
        ...snapshot,
        ...baseUpdate,
        actionCenterItems: event.payload.replace
          ? event.payload.items
          : [...(snapshot.actionCenterItems ?? []), ...event.payload.items],
      };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return snapshot;
    }
  }
}

function upsertStageContext<T extends { readonly stageId: string }>(
  contexts: ReadonlyArray<T>,
  next: T,
): ReadonlyArray<T> {
  const idx = contexts.findIndex((context) => context.stageId === next.stageId);
  if (idx < 0) return [...contexts, next];
  const out = contexts.slice();
  out[idx] = next;
  return out;
}

/** Replace an existing step by id, or append. Preserves array order. */
function upsertStep(steps: ReadonlyArray<StepView>, next: StepView): ReadonlyArray<StepView> {
  const idx = steps.findIndex((s) => s.id === next.id);
  if (idx < 0) return [...steps, next];
  const out = steps.slice();
  out[idx] = { ...steps[idx], ...next };
  return out;
}

function findParent(steps: ReadonlyArray<StepView>, stepKey: string): string {
  const existing = steps.find((s) => s.id === stepKey);
  if (existing) return existing.parentStepKey;
  // Reconstruct: stepKey is <parentKey>/<n>:<label>; strip the trailing segment.
  const lastSlash = stepKey.lastIndexOf("/");
  return lastSlash >= 0 ? stepKey.slice(0, lastSlash) : "";
}

/** Shallow-patch a step by id. No-op when the step is not present yet. */
function patchStepById(
  steps: ReadonlyArray<StepView>,
  stepKey: string,
  patch: (s: StepView) => StepView,
): ReadonlyArray<StepView> {
  const idx = steps.findIndex((s) => s.id === stepKey);
  if (idx < 0) return steps;
  const out = steps.slice();
  out[idx] = patch(out[idx]);
  return out;
}

/** Patch a single fanOut unit (matched by itemKey) on its parent step. */
function patchUnit(
  steps: ReadonlyArray<StepView>,
  stepKey: string,
  itemKey: string,
  patch: (u: FanOutUnit) => FanOutUnit,
): ReadonlyArray<StepView> {
  return patchStepById(steps, stepKey, (s) =>
    s.units ? { ...s, units: s.units.map((u) => (u.itemKey === itemKey ? patch(u) : u)) } : s,
  );
}

/** Append an agent handle id to a step's directAgents (deduped). */
function addDirectAgent(
  steps: ReadonlyArray<StepView>,
  stepKey: string,
  handleId: string,
): ReadonlyArray<StepView> {
  return patchStepById(steps, stepKey, (s) => {
    const cur = s.directAgents ?? [];
    return cur.includes(handleId) ? s : { ...s, directAgents: [...cur, handleId] };
  });
}

/** Append an artifact key to a step's artifact subset (deduped). */
function addStepArtifact(
  steps: ReadonlyArray<StepView>,
  stepKey: string,
  key: string,
): ReadonlyArray<StepView> {
  return patchStepById(steps, stepKey, (s) => {
    const cur = s.artifacts ?? [];
    return cur.includes(key) ? s : { ...s, artifacts: [...cur, key] };
  });
}

/** Nesting depth from the root step (0 = top-level). */
function computeDepth(steps: ReadonlyArray<StepView>, parentStepKey: string): number {
  if (parentStepKey === "") return 0;
  const parent = steps.find((s) => s.id === parentStepKey);
  if (parent?.depth != null) return parent.depth + 1;
  // Fallback when the parent step event was not seen: count path segments.
  return parentStepKey.split("/").filter(Boolean).length;
}

/** One-line, length-bounded preview of an agent message for the card UI. */
function truncateSnippet(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}\u2026` : oneLine;
}

/** Replay a complete event log into a fresh snapshot. */
export function replaySnapshot(seed: ReducerSeed, events: Iterable<WorkflowEvent>): RunSnapshot {
  let snapshot = createInitialSnapshot(seed);
  for (const e of events) snapshot = reduceRun(snapshot, e);
  return snapshot;
}

// ── UI-facing aliases (REV-IMPL integration) ─────────────────────────
// IMPL-UI's reducer exported a different shape of helpers. We keep the
// names alive as thin aliases so UI consumers (hooks, tests) keep
// compiling. The engine's reducer above is the single source of truth.

/** Alias of `createInitialSnapshot` taking positional `(runId, workflowId)`. */
export const EMPTY_SNAPSHOT = (runId: string, workflowId = "unknown"): RunSnapshot =>
  createInitialSnapshot({ runId, workflowId });

/** Fold a batch of events into the snapshot. */
export function reduceMany(
  snapshot: RunSnapshot,
  events: ReadonlyArray<WorkflowEvent>,
): RunSnapshot {
  let next = snapshot;
  for (const e of events) next = reduceRun(next, e);
  return next;
}

import type { RunStatus } from "./workflows-contract";

/** A status that ends the run — used by the UI to disable cancel/retry controls. */
export function isTerminalStatus(s: RunStatus): boolean {
  return s === "succeeded" || s === "failed" || s === "cancelled" || s === "crashed";
}
