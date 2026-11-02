import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AIInvestigatorEvent,
  AIInvestigatorProgressLogEntry,
  AIInvestigatorState,
  AIInvestigatorStatus,
} from "@/types/electron";

export interface UseAIInvestigatorResult {
  /** Tri-state availability gate:
   *   - `null`: probe still in flight (don't render the button yet).
   *   - `false`: gh missing / no access — button stays hidden.
   *   - `true`: feature is available. */
  available: boolean | null;
  state: AIInvestigatorState;
  log: AIInvestigatorProgressLogEntry[];
  title: string | null;
  body: string | null;
  issueUrl: string | null;
  fallbackUrl: string | null;
  error: string | null;
  /** Destination the report will be filed against, surfaced for UI labels.
   *  Null when not configured. */
  target: string | null;
  /** Display name of the configured issue-reporter provider (e.g. "GitHub"). */
  providerName: string | null;
  isStartPending: boolean;
  isPostPending: boolean;
  start: (input: { userDescription: string }) => Promise<void>;
  cancel: () => Promise<void>;
  post: () => Promise<void>;
  /** Reset to idle. Calls api.reset() so both renderer and manager are cleared. */
  reset: () => void;
}

const EMPTY_STATUS: AIInvestigatorStatus = {
  state: "idle",
  userDescription: "",
  log: [],
};

function statusToHookState(s: AIInvestigatorStatus) {
  return {
    state: s.state,
    log: s.log,
    title: s.title ?? null,
    body: s.body ?? null,
    issueUrl: s.issueUrl ?? null,
    fallbackUrl: s.fallbackUrl ?? null,
    error: s.error ?? null,
    target: s.target ?? null,
    providerName: s.providerName ?? null,
  };
}

/**
 * Hook that owns the renderer-side mirror of AIInvestigatorManager state.
 *
 * The main process is the source of truth — the hook subscribes to
 * `aiInvestigator:event` for live updates and pulls a fresh snapshot on mount so
 * re-opens of the modal during an investigation see the current state.
 *
 * Availability, start, cancel, post, and reset are managed via React Query
 * mutations so pending/error states are tracked without manual flag state.
 */
export function useAIInvestigator(): UseAIInvestigatorResult {
  const api = window.aiInvestigatorAPI;
  const [snapshot, setSnapshot] = useState(() => statusToHookState(EMPTY_STATUS));

  // Availability probe — result is memoized in main, so re-queries are cheap.
  const availabilityQuery = useQuery({
    queryKey: ["ai-investigator", "availability", !!api],
    queryFn: () => api!.checkAvailability(),
    enabled: !!api,
  });

  const available: boolean | null = !api
    ? false
    : availabilityQuery.isPending
      ? null
      : availabilityQuery.isError
        ? false
        : availabilityQuery.data?.success
          ? availabilityQuery.data.available
          : false;

  // Pull initial status + subscribe to events.
  useEffect(() => {
    if (!api) return () => {};
    let cancelled = false;
    void api.getStatus().then((res) => {
      if (cancelled) return;
      if (res.success && res.status) setSnapshot(statusToHookState(res.status));
    });
    const unsubscribe = api.onEvent((event: AIInvestigatorEvent) => {
      if (event.type === "status") {
        setSnapshot((prev) => ({ ...prev, state: event.state }));
      } else if (event.type === "progress") {
        setSnapshot((prev) => ({
          ...prev,
          log: [...prev.log, { timestamp: new Date().toISOString(), message: event.message }],
        }));
      } else if (event.type === "ready") {
        setSnapshot((prev) => ({ ...prev, state: "ready", title: event.title, body: event.body }));
      } else if (event.type === "posted") {
        setSnapshot((prev) => ({
          ...prev,
          state: "posted",
          issueUrl: event.issueUrl ?? null,
          fallbackUrl: event.fallbackUrl ?? null,
        }));
      } else if (event.type === "error") {
        setSnapshot((prev) => ({ ...prev, state: "error", error: event.error }));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  const startMutation = useMutation({
    mutationFn: async (input: { userDescription: string }) => {
      const res = await api!.start(input);
      if (!res.success) throw new Error(res.error ?? "Failed to start");
      return res;
    },
    onError: (err) =>
      setSnapshot((prev) => ({
        ...prev,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      })),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api!.cancel(),
    onError: (err) =>
      setSnapshot((prev) => ({
        ...prev,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      })),
  });

  const postMutation = useMutation({
    mutationFn: async () => {
      const res = await api!.post();
      if (!res.success) throw new Error(res.error ?? "Failed to post");
      return res;
    },
    onError: (err) =>
      setSnapshot((prev) => ({
        ...prev,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      })),
  });

  const resetMutation = useMutation({
    mutationFn: () => api!.reset(),
    onSuccess: () => setSnapshot(statusToHookState(EMPTY_STATUS)),
    onError: (err) =>
      setSnapshot((prev) => ({
        ...prev,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      })),
  });

  // Destructure the stable `mutate`/`mutateAsync` references so the
  // useCallbacks below can list them as deps without depending on the whole
  // mutation object (which has unstable identity across renders).
  const { mutateAsync: startMutateAsync } = startMutation;
  const { mutateAsync: cancelMutateAsync } = cancelMutation;
  const { mutateAsync: postMutateAsync } = postMutation;
  const { mutate: resetMutate } = resetMutation;

  const start = useCallback(
    async (input: { userDescription: string }): Promise<void> => {
      if (!api) return;
      await startMutateAsync(input).catch(() => {
        // error handled by onError above
      });
    },
    [api, startMutateAsync],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (!api) return;
    await cancelMutateAsync().catch(() => {});
  }, [api, cancelMutateAsync]);

  const post = useCallback(async (): Promise<void> => {
    if (!api) return;
    await postMutateAsync().catch(() => {});
  }, [api, postMutateAsync]);

  const reset = useCallback(() => {
    if (!api) {
      setSnapshot(statusToHookState(EMPTY_STATUS));
      return;
    }
    resetMutate();
  }, [api, resetMutate]);

  return useMemo<UseAIInvestigatorResult>(
    () => ({
      ...snapshot,
      available,
      isStartPending: startMutation.isPending,
      isPostPending: postMutation.isPending,
      start,
      cancel,
      post,
      reset,
    }),
    [
      snapshot,
      available,
      startMutation.isPending,
      postMutation.isPending,
      start,
      cancel,
      post,
      reset,
    ],
  );
}
