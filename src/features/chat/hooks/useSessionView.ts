/**
 * useSessionView — subscribes to session:view IPC events and maintains
 * the session view in React Query cache.
 *
 * The main process owns the view state (SessionViewBuilder). This hook
 * just pushes snapshots into the query cache for rendering. The renderer
 * is passive — it never accumulates streaming text or manages state machines.
 */

import { DEFAULT_SESSION_VIEW } from "@common/marshal-ipc-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startTransition, useEffect } from "react";

import { useTransportReconnects } from "@/shared/hooks/useTransportReconnects";
import type {
  SessionMessage,
  SessionView,
  SessionViewDelivery,
  SessionViewSnapshot,
} from "@/types/electron";

import { appendToMessageWindow, isTranscriptHeld } from "../state/messageWindow";
import type { SessionData } from "../types";

export interface SessionViewControls {
  status: SessionView["status"];
  sessionStatus: string | null;
  tokenUsage: SessionView["tokenUsage"];
  lastTurnUsage: SessionView["lastTurnUsage"];
}

const selectSessionViewControls = (view: SessionView): SessionViewControls => ({
  status: view.status,
  sessionStatus: view.sessionStatus,
  tokenUsage: view.tokenUsage,
  lastTurnUsage: view.lastTurnUsage,
});

function useSessionViewQuery<T>(sessionId: string | null, select: (view: SessionView) => T): T {
  const { data } = useQuery<SessionView, Error, T>({
    queryKey: ["session-view", sessionId],
    queryFn: async () => DEFAULT_SESSION_VIEW,
    enabled: false,
    staleTime: 0,
    select,
  });
  return data ?? select(DEFAULT_SESSION_VIEW);
}

function useSessionViewSubscription(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const reconnects = useTransportReconnects();

  // Register this renderer's interest before main starts routing full snapshots.
  // A monotonic cursor detects a renderer restart or any delivery gap.
  useEffect(() => {
    if (!sessionId || !window.sessionsAPI?.onViewEvent) return undefined;
    let active = true;
    let initializing = true;
    let cursor: Pick<SessionViewSnapshot, "epoch" | "sequence"> | null = null;
    let resyncing = false;
    let bufferedDuringResync: SessionViewDelivery | null = null;

    const setView = (nextView: SessionView) => {
      startTransition(() => {
        queryClient.setQueryData<SessionView>(["session-view", sessionId], nextView);
      });
    };

    const loadFallbackView = async () => {
      try {
        const result = await window.sessionsAPI.getView(sessionId);
        if (active && result.success && result.view) setView(result.view);
      } catch {
        // Keep the last cache value. A later delivery will retry resync.
      }
    };

    const applyCommittedMessages = (event: SessionViewDelivery) => {
      if (event.committedMessages.length === 0) return;
      const existing = queryClient.getQueryData<SessionData>(["session", sessionId]);
      if (!existing) {
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        return;
      }

      const incoming = event.committedMessages.map((message: SessionMessage) => ({
        ...message,
        timestamp: new Date(message.timestamp),
        optimistic: false,
      }));
      startTransition(() => {
        queryClient.setQueryData<SessionData>(["session", sessionId], (current) => {
          if (!current) return current;
          const merged = appendToMessageWindow(current.messages, incoming, {
            preserveLoadedHistory: isTranscriptHeld(sessionId),
          });
          if (
            merged.addedCount === 0 &&
            merged.removedDuplicateCount === 0 &&
            merged.replacedCount === 0 &&
            merged.trimmedCount === 0
          ) {
            return current;
          }
          return {
            ...current,
            messages: merged.messages,
            hasOlderMessages: current.hasOlderMessages === true || merged.trimmedCount > 0,
            totalMessages:
              Math.max(current.totalMessages ?? 0, current.messages.length) + merged.addedCount,
          };
        });
      });
    };

    const applyDelivery = (event: SessionViewDelivery): boolean => {
      if (!cursor || event.epoch !== cursor.epoch || event.sequence !== cursor.sequence + 1) {
        return false;
      }
      cursor = { epoch: event.epoch, sequence: event.sequence };
      void window.sessionsAPI.ackView(sessionId, event.epoch, event.sequence).catch(() => {
        /* Reconnection resubscribes with a fresh snapshot. */
      });
      applyCommittedMessages(event);
      setView(event.view);
      return true;
    };

    const resync = (gapEvent: SessionViewDelivery) => {
      bufferedDuringResync = gapEvent;
      if (resyncing) return;
      resyncing = true;
      let resyncApplied = false;
      void window.sessionsAPI
        .resyncView(sessionId)
        .then((result) => {
          if (!active) return;
          if (!result.success || !result.snapshot) {
            void loadFallbackView();
            void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
            return;
          }
          resyncApplied = true;
          cursor = result.snapshot;
          setView(result.snapshot.view);
          void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        })
        .catch(() => {
          void loadFallbackView();
          void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        })
        .finally(() => {
          if (!active) return;
          resyncing = false;
          const buffered = bufferedDuringResync;
          bufferedDuringResync = null;
          if (!resyncApplied) return;
          if (buffered && cursor) {
            if (buffered.sequence <= cursor.sequence) {
              applyCommittedMessages(buffered);
            } else if (!applyDelivery(buffered)) {
              resync(buffered);
            }
          }
        });
    };

    const unsubscribe = window.sessionsAPI.onViewEvent((event: SessionViewDelivery) => {
      if (event.sessionId !== sessionId) return;
      if (initializing || resyncing) {
        bufferedDuringResync = event;
      } else if (!applyDelivery(event)) {
        resync(event);
      }
    });

    void window.sessionsAPI
      .subscribeView(sessionId)
      .then((result) => {
        if (!active) return;
        if (!result.success || !result.snapshot) {
          initializing = false;
          void loadFallbackView();
          return;
        }
        void queryClient.cancelQueries({ queryKey: ["session-view", sessionId] });
        cursor = result.snapshot;
        setView(result.snapshot.view);
        initializing = false;
        const buffered = bufferedDuringResync;
        bufferedDuringResync = null;
        if (buffered) {
          if (buffered.sequence <= cursor.sequence) {
            applyCommittedMessages(buffered);
          } else if (!applyDelivery(buffered)) {
            resync(buffered);
          }
        }
      })
      .catch(() => {
        initializing = false;
        void loadFallbackView();
      });

    return () => {
      active = false;
      unsubscribe();
      void window.sessionsAPI.unsubscribeView(sessionId).catch(() => {
        /* A closed transport already removes its subscriptions. */
      });
    };
  }, [sessionId, queryClient, reconnects]);
}

export function useSessionView(sessionId: string | null): SessionView {
  useSessionViewSubscription(sessionId);
  return useSessionViewQuery(sessionId, (view) => view);
}

export function useSessionViewControls(sessionId: string | null): SessionViewControls {
  useSessionViewSubscription(sessionId);
  return useSessionViewQuery(sessionId, selectSessionViewControls);
}

export function useLiveSessionView(sessionId: string | null): SessionView {
  return useSessionViewQuery(sessionId, (view) => view);
}
