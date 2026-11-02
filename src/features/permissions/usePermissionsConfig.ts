// Ownership: permissions configuration hooks.
import type { PermissionsEnvelope } from "@common/marshal-ipc-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { useIpcMutation } from "@/shared/hooks/useIpcMutation";
import type { PermissionsConfig } from "@/types/electron";

const QUERY_KEY = ["permissions", "config"] as const;

async function getPermissionsConfigEnvelope(): Promise<PermissionsEnvelope> {
  const r = await window.permissionsAPI!.getConfig();
  if (!r.success) throw new Error(r.error);
  return r.envelope;
}

export function usePermissions() {
  const queryClient = useQueryClient();

  // Invalidate when the main process reports a settings change — covers
  // mutations we didn't initiate, e.g. "Always allow pattern" on a permission
  // card, which writes through PermissionPolicy → settingsManager.update()
  // without going through this hook's save() path.
  //
  // NOTE: `wireQueryInvalidations` (mounted once at app boot) also subscribes
  // to settings:changed and invalidates this query key. That global listener
  // is the authoritative source for the "Always allow → reopen Settings"
  // flow when SettingsPanel is unmounted. This in-hook listener
  // is kept for redundancy and for environments where the global wire-up
  // hasn't run (e.g. isolated unit tests).
  useEffect(() => {
    if (!window.settingsAPI?.onChanged) return undefined;
    return window.settingsAPI.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  }, [queryClient]);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getPermissionsConfigEnvelope,
    staleTime: Infinity,
  });

  const save = useIpcMutation({
    mutationFn: (patch: Partial<PermissionsConfig>) => window.permissionsAPI!.saveConfig(patch),
    fallbackErrorMessage: "Failed to save permissions",
    onMutate: async (patch: Partial<PermissionsConfig>) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const previous = queryClient.getQueryData<PermissionsEnvelope>(QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<PermissionsEnvelope>(QUERY_KEY, {
          ...previous,
          permissions: { ...previous.permissions, ...patch },
        });
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(QUERY_KEY, context.previous);
      }
    },
    onSuccess: (result) => {
      if (result.success && result.rejectedShellPatterns?.length) {
        toast.warning(
          `${result.rejectedShellPatterns.length} shell pattern(s) couldn't be saved in gateway mode (only bare binary names are supported): ${result.rejectedShellPatterns.join(", ")}`,
        );
      }
    },
    // settings:changed listener now drives invalidation for external writes;
    // drop onSettled to avoid double-invalidation on our own saves.
  });

  return {
    envelope: query.data,
    isLoading: query.isLoading,
    error: query.error,
    save: (patch: Partial<PermissionsConfig>) => save.mutate(patch),
    isSaving: save.isPending,
  };
}

/**
 * Narrow selector hook for components that only need the controllable flags,
 * not the full envelope or save capability (e.g. HeartbeatPanel).
 * Shares the same query cache entry as usePermissions — TanStack Query
 * deduplicates the fetch; the `select` transform is memoized per render.
 */
export function usePermissionsControllable() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: getPermissionsConfigEnvelope,
    select: (env) => ({
      controllable: env.controllable,
      hasUnrepresentablePatterns: env.hasUnrepresentablePatterns,
    }),
    staleTime: Infinity,
  });
}
