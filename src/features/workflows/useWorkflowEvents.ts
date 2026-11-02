// src/features/workflows/useWorkflowEvents.ts
//
// Live event subscription + snapshot reducer hooks for the Workflows tab.
//
// Three hooks, three subscriptions (R1-FIXES C-UI §14):
//   • useRunSnapshot(runId) — pull initial snapshot, then fold batched events
//                             (30Hz channel) AND coarse status pushes.
//   • useRunTick(runId)     — 1Hz top-bar gauge, never re-reduces.
//   • usePermissionInbox()  — dual-routed `workflow:permission-request`
//                             events bound for the Workflows tab.
//
// All three are safe to call before IMPL-ENGINE has wired the IPC handlers:
//   • Missing `window.workflowsAPI` returns a noop subscription.
//   • Missing snapshot RPC falls back to an `EMPTY_SNAPSHOT` placeholder.

import type {
  RunSnapshot,
  WorkflowEvent,
  WorkflowPermissionRequestEvent,
  WorkflowRunStatusEvent,
  WorkflowRunTickEvent,
} from "@common/workflows-contract";
import { reduceMany, EMPTY_SNAPSHOT } from "@common/workflows-reducer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

const NOOP = (): void => {};
const EVENTS_RING_LIMIT = 500;

export interface UseRunSnapshotResult {
  snapshot: RunSnapshot;
  /** Most recent events received (capped at 500 to bound memory). */
  recentEvents: WorkflowEvent[];
  /** `true` while the initial pull is in flight. */
  loading: boolean;
  /** Error message from the initial pull, or null. */
  error: string | null;
  /** Re-pull the snapshot — useful after retry actions. */
  refresh: () => Promise<void>;
}

async function fetchSnapshot(runId: string): Promise<RunSnapshot> {
  const api = window.workflowsAPI;
  if (!api) return EMPTY_SNAPSHOT(runId);
  try {
    const result = await api.getRun(runId);
    if (result.success && result.snapshot) return result.snapshot;
  } catch {
    // fall through — return empty placeholder so the UI renders.
  }
  return EMPTY_SNAPSHOT(runId);
}

export function useRunSnapshot(runId: string | null | undefined): UseRunSnapshotResult {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["workflows", "snapshot", runId], [runId]);

  const initialQuery = useQuery<RunSnapshot>({
    queryKey,
    queryFn: () => fetchSnapshot(runId!),
    enabled: !!runId,
  });

  // Live-folded snapshot — starts null and is initialised by the first
  // batch handler against the most recent initial-query value. We never
  // copy `initial → folded` inside an effect (that violates the react-
  // compiler set-state-in-effect rule); instead the subscribe effect
  // captures the latest `initial` in its closure and re-subscribes
  // when the initial pull resolves (one extra subscribe per run — fine).
  const initial = initialQuery.data;

  const [folded, setFolded] = useState<RunSnapshot | null>(null);
  const [recentEvents, setRecentEvents] = useState<WorkflowEvent[]>([]);

  // Subscribe to batched event pushes — pure subscription effect.
  useEffect(() => {
    if (!runId) return NOOP;
    const api = window.workflowsAPI;
    if (!api?.subscribeRunEvents) return NOOP;
    const baseAtSub = initial ?? EMPTY_SNAPSHOT(runId);
    return api.subscribeRunEvents(runId, ({ batch }) => {
      if (!batch || batch.length === 0) return;
      setFolded((prev) => reduceMany(prev ?? baseAtSub, batch));
      setRecentEvents((prev) => {
        const merged = prev.concat(batch);
        const overflow = merged.length - EVENTS_RING_LIMIT;
        return overflow > 0 ? merged.slice(overflow) : merged;
      });
    });
  }, [runId, initial]);

  // Coarse status pushes — covers terminal transitions when the engine has
  // no further events to flush.
  useEffect(() => {
    if (!runId) return NOOP;
    const api = window.workflowsAPI;
    if (!api?.subscribeRunStatus) return NOOP;
    const baseAtSub = initial ?? EMPTY_SNAPSHOT(runId);
    return api.subscribeRunStatus(runId, (evt: WorkflowRunStatusEvent) => {
      setFolded((prev) => {
        const base = prev ?? baseAtSub;
        const errorSummary = evt.error
          ? {
              message: evt.error.message,
              code: evt.error.errorClass,
            }
          : base.errorSummary;
        return {
          ...base,
          status: evt.status,
          endedAt: evt.finishedAt ?? base.endedAt,
          errorSummary,
        };
      });
    });
  }, [runId, initial]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey, runId]);

  const snapshot = folded ?? initialQuery.data ?? EMPTY_SNAPSHOT(runId ?? "pending");

  return {
    snapshot,
    recentEvents,
    loading: initialQuery.isLoading,
    error: initialQuery.error?.message ?? null,
    refresh,
  };
}

/** 1Hz tick for the top-bar gauge — never re-reduces the snapshot. */
export function useRunTick(runId: string | null | undefined): WorkflowRunTickEvent | null {
  const [tick, setTick] = useState<WorkflowRunTickEvent | null>(null);
  useEffect(() => {
    if (!runId) return NOOP;
    const api = window.workflowsAPI;
    if (!api?.subscribeRunTick) return NOOP;
    return api.subscribeRunTick(runId, (evt) => setTick(evt));
  }, [runId]);
  return tick;
}

export interface PermissionInboxItem extends WorkflowPermissionRequestEvent {
  /** Stable per-request id used as React key + dedupe target. */
  readonly id: string;
  readonly cardId: string;
}

function cardIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Workflow-tab permission inbox — aggregates `workflow:permission-request`
 * events dual-routed from the engine, and exposes a respond helper. The
 * caller renders the items, picks Allow / Deny, then calls `respond`.
 */
export function usePermissionInbox(): {
  items: PermissionInboxItem[];
  respond: (item: PermissionInboxItem, allow: boolean) => Promise<void>;
  dismiss: (id: string) => void;
} {
  const [items, setItems] = useState<PermissionInboxItem[]>([]);
  useEffect(() => {
    const api = window.workflowsAPI;
    if (!api?.subscribePermissionRequests) return NOOP;
    return api.subscribePermissionRequests((evt) => {
      const cardId =
        cardIdFromPayload(evt.cardPayload) ?? `${evt.subagentSessionId}:${evt.receivedAt}`;
      const id = `${evt.runId}:${cardId}`;
      setItems((prev) =>
        prev.some((i) => i.id === id) ? prev : [...prev, { ...evt, id, cardId }],
      );
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const respond = useCallback(
    async (item: PermissionInboxItem, allow: boolean) => {
      const api = window.workflowsAPI;
      if (api?.permissionResponse) {
        try {
          await api.permissionResponse({
            runId: item.runId,
            subagentSessionId: item.subagentSessionId,
            cardId: item.cardId,
            allow,
          });
        } catch {
          // Swallow — caller has already removed the item from the UI.
        }
      }
      dismiss(item.id);
    },
    [dismiss],
  );

  // Stabilize the items reference across no-op renders.
  const memoItems = useMemo(() => items, [items]);
  return { items: memoItems, respond, dismiss };
}
