import type {
  RelayProviderActionRequest,
  RelayProviderKey,
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
} from "@common/relay-provider-settings";
import { getRelayProviderIdentity } from "@common/relay-provider-settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addRelayProviderSetupEvent,
  RELAY_PROVIDER_SETTINGS_QUERY_KEY,
  RELAY_PROVIDER_SETUP_QUERY_KEY,
  type RelayProviderSetupEvents,
} from "./relayProviderQueryKeys";

interface RelayProviderMutation {
  action: "connect" | "disconnect" | "reset" | "relink" | "provision";
  request: RelayProviderActionRequest;
}

export function useRelayProviderSettings(enabled = true) {
  const queryClient = useQueryClient();
  const providersQuery = useQuery<RelayProviderRuntimeSnapshot[]>({
    queryKey: RELAY_PROVIDER_SETTINGS_QUERY_KEY,
    queryFn: async () => {
      if (!window.relayProviderSettingsAPI) return [];
      const result = await window.relayProviderSettingsAPI.list();
      if (!result.success || !result.providers) {
        throw new Error(result.error ?? "Failed to read relay provider status");
      }
      return result.providers;
    },
    enabled,
  });
  const setupQuery = useQuery<RelayProviderSetupEvents>({
    queryKey: RELAY_PROVIDER_SETUP_QUERY_KEY,
    queryFn: async () => ({}),
    initialData: {},
    staleTime: Infinity,
  });

  const mutation = useMutation<RelayProviderSetupEvent, Error, RelayProviderMutation>({
    mutationFn: async ({ action, request }) => {
      if (!window.relayProviderSettingsAPI) {
        throw new Error("Relay provider settings API is unavailable");
      }
      const result = await window.relayProviderSettingsAPI[action](request);
      if (!result.success || !result.setup) {
        throw new Error(result.error ?? `Failed to ${action} relay provider`);
      }
      return result.setup;
    },
    onSuccess: (event) => {
      queryClient.setQueryData<RelayProviderSetupEvents>(
        RELAY_PROVIDER_SETUP_QUERY_KEY,
        (current = {}) => addRelayProviderSetupEvent(current, event),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: RELAY_PROVIDER_SETTINGS_QUERY_KEY });
    },
  });

  const runAction = (
    action: RelayProviderMutation["action"],
    providerKey: RelayProviderKey,
    accountId?: string,
  ) =>
    mutation.mutateAsync({
      action,
      request: {
        ...getRelayProviderIdentity(providerKey),
        ...(accountId ? { accountId } : {}),
      },
    });

  return {
    providers: providersQuery.data ?? [],
    setupEvents: setupQuery.data,
    isPending: providersQuery.isPending,
    queryError: providersQuery.error,
    runAction,
    pendingAction: mutation.isPending ? mutation.variables : undefined,
    actionError: mutation.error,
  };
}
