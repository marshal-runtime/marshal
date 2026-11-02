import type { PermissionAction } from "@common/marshal-constants";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { useTransportReconnects } from "@/shared/hooks/useTransportReconnects";
import type { PermissionCardData } from "@/types/electron";

import { permissionCardsStore } from "../permissions/state/permission-cards-store";

const EMPTY: PermissionCardData[] = [];

/**
 * Thin IPC mirror of the main process PermissionCardManager.
 *
 * All transition logic, persistence, and SDK event handling live in the main
 * process. This hook subscribes to pushed state via `useSyncExternalStore`
 * and provides `respond` / `clear` actions.
 */
export function usePermissions(sessionId: string | null) {
  const getSnapshot = useMemo(
    () => (sessionId ? () => permissionCardsStore.getSnapshot(sessionId) : () => EMPTY),
    [sessionId],
  );
  const cards = useSyncExternalStore(permissionCardsStore.subscribe, getSnapshot);
  const reconnects = useTransportReconnects();

  // Fetch cards on mount / session change, and again after a phone reconnect.
  useEffect(() => {
    if (sessionId)
      void permissionCardsStore.fetch(sessionId).catch(() => {
        /* Foreground recovery refreshes pending cards. */
      });
  }, [sessionId, reconnects]);

  const respond = useCallback(
    async (requestId: string, action: PermissionAction, overridePattern?: string) => {
      const previous = sessionId ? permissionCardsStore.getSnapshot(sessionId) : [];
      // Optimistic update for responsive UI
      if (sessionId) {
        permissionCardsStore.optimisticUpdate(sessionId, (prev) =>
          prev.map((c) =>
            c.id === requestId
              ? { ...c, resolved: action === "deny" ? ("denied" as const) : ("allowed" as const) }
              : c,
          ),
        );
      }
      // Main process pushes corrected state if optimistic was wrong
      try {
        const result = await window.copilotAPI?.resolvePermission?.(
          requestId,
          action,
          overridePattern,
        );
        if (result && !result.success) throw new Error("This request is no longer pending.");
      } catch (error) {
        if (sessionId) {
          permissionCardsStore.optimisticUpdate(sessionId, () => previous);
          void permissionCardsStore.fetch(sessionId).catch(() => {});
        }
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not confirm your decision. Please reconnect and try again.",
        );
      }
    },
    [sessionId],
  );

  const clear = useCallback(() => {
    if (sessionId) {
      permissionCardsStore.clear(sessionId);
      void window.permissionsAPI?.clearCards(sessionId).catch(() => {
        /* The next snapshot restores authoritative state. */
      });
    }
  }, [sessionId]);

  return { cards, respond, clear };
}
