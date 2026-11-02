import type { PairedDevice, PendingDeviceRequest } from "@common/marshal-ipc-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useIpcMutation } from "@/shared/hooks/useIpcMutation";

// Sentinel returned when gateway URL isn't local. Match this exact string
// (not just `success: false`) so transient network failures don't get
// silently treated as "panel doesn't apply here".
const NON_LOCAL_GATEWAY_SENTINEL = "not-supported-non-local";

const QUERY_KEY = ["gateway-pending-devices"] as const;

export interface LocalDeviceApprovalsResult {
  isLocal: boolean;
  pending: PendingDeviceRequest[];
  paired: PairedDevice[];
  isLoading: boolean;
  approving: boolean;
  approveError: string | null;
  approve: (requestId: string) => void;
  refresh: () => void;
}

export function useLocalDeviceApprovals(): LocalDeviceApprovalsResult {
  const queryClient = useQueryClient();

  const query = useQuery<{
    isLocal: boolean;
    pending: PendingDeviceRequest[];
    paired: PairedDevice[];
  }>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      if (!window.gatewayAuthAPI) {
        return { isLocal: false, pending: [], paired: [] };
      }
      const res = await window.gatewayAuthAPI.listPendingDevices();
      if (!res.success) {
        if (res.error === NON_LOCAL_GATEWAY_SENTINEL) {
          return { isLocal: false, pending: [], paired: [] };
        }
        throw new Error(res.error ?? "listPendingDevices failed");
      }
      return {
        isLocal: true,
        pending: res.pending ?? [],
        paired: res.paired ?? [],
      };
    },
    enabled: !!window.gatewayAuthAPI,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const approveMutation = useIpcMutation({
    mutationFn: async (requestId: string) => {
      if (!window.gatewayAuthAPI) {
        return { success: false, error: "gatewayAuthAPI unavailable" };
      }
      return window.gatewayAuthAPI.approveDevice(requestId);
    },
    fallbackErrorMessage: "Failed to approve device",
    // onSettled (not onSuccess): a mid-flight approval the server already accepted must clear the pending row even if our reply errored.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return {
    isLocal: query.data?.isLocal ?? false,
    pending: query.data?.pending ?? [],
    paired: query.data?.paired ?? [],
    isLoading: query.isLoading,
    approving: approveMutation.isPending,
    approveError: approveMutation.error instanceof Error ? approveMutation.error.message : null,
    approve: approveMutation.mutate,
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  };
}
