import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import type { RuntimeStartupSelection, RuntimeSwitchResult } from "@common/marshal-ipc-contract";
import { DEFAULT_RUNTIME_ID } from "@common/runtime-config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import type { MSettings } from "@/types/electron";

export function useSettings(enabled = true) {
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery<MSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      if (!window.settingsAPI) return DEFAULT_SETTINGS;
      const result = await window.settingsAPI.get();
      return result.success && result.settings ? result.settings : DEFAULT_SETTINGS;
    },
    enabled,
  });

  const settings = data ?? DEFAULT_SETTINGS;

  // Invalidate the ["settings"] cache whenever the main process reports a
  // change — covers mutations we didn't initiate (e.g. "Always allow" on a
  // permission card writes to permissions.allow from the main process).
  useEffect(() => {
    if (!window.settingsAPI?.onChanged) return undefined;
    return window.settingsAPI.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["runtime-startup-selection"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    });
  }, [queryClient]);

  const mutation = useMutation({
    mutationFn: async (updated: MSettings) => {
      const result = await window.settingsAPI?.save(updated);
      if (result && !result.success) throw new Error(result.error || "Failed to save settings");
    },
    onMutate: async (updated) => {
      await queryClient.cancelQueries({ queryKey: ["settings"] });
      const previous = queryClient.getQueryData<MSettings>(["settings"]);
      queryClient.setQueryData<MSettings>(["settings"], updated);
      return { previous };
    },
    onError: (_err, _updated, context) => {
      if (context?.previous) {
        queryClient.setQueryData<MSettings>(["settings"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const { mutate } = mutation;

  const persist = useCallback((updated: MSettings) => mutate(updated), [mutate]);
  const persistWithSuccess = useCallback(
    (updated: MSettings, onSuccess: () => void) => mutate(updated, { onSuccess }),
    [mutate],
  );

  return {
    settings,
    persist,
    persistWithSuccess,
    isPending,
    isSaving: mutation.isPending,
    saveError: mutation.error,
  };
}

export function useRuntimeStartupSelection() {
  const queryClient = useQueryClient();
  const query = useQuery<RuntimeStartupSelection>({
    queryKey: ["runtime-startup-selection"],
    queryFn: async () => {
      if (!window.settingsAPI) {
        return {
          requestedRuntimeId: DEFAULT_RUNTIME_ID,
          runtimeId: DEFAULT_RUNTIME_ID,
        };
      }
      const result = await window.settingsAPI.getRuntimeSelection();
      if (!result.success || !result.selection) {
        throw new Error(result.error ?? "Failed to read startup runtime selection");
      }
      return result.selection;
    },
    staleTime: Infinity,
  });

  const switchMutation = useMutation<RuntimeSwitchResult, Error, string>({
    mutationFn: async (runtimeId) => {
      if (!window.settingsAPI) throw new Error("Settings API is unavailable");
      const response = await window.settingsAPI.switchRuntime(runtimeId);
      if (!response.success || !response.result) {
        throw new Error(response.error ?? "Failed to switch runtime");
      }
      return response.result;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["runtime-startup-selection"], result.selection);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });

  return {
    runtimeSelection: query.data,
    isPending: query.isPending,
    switchRuntime: switchMutation.mutateAsync,
    isSwitching: switchMutation.isPending,
    switchError: switchMutation.error,
  };
}
