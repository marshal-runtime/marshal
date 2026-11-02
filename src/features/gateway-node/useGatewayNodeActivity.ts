import type { NodeActivityEntry } from "@common/marshal-ipc-contract";
import { useQuery } from "@tanstack/react-query";

import { GATEWAY_NODE_ACTIVITY_KEY } from "./wireGatewayNodeActivity";

export function useGatewayNodeActivity(): {
  entries: NodeActivityEntry[];
  loaded: boolean;
} {
  const apiAvailable = typeof window !== "undefined" && !!window.gatewayNodeAPI;
  const { data, isSuccess } = useQuery({
    queryKey: GATEWAY_NODE_ACTIVITY_KEY,
    queryFn: async () => {
      const api = window.gatewayNodeAPI;
      if (!api) return [] as NodeActivityEntry[];
      const res = await api.getActivity();
      return res.success ? res.entries : [];
    },
    enabled: apiAvailable,
    // staleTime Infinity: live updates come via wireGatewayNodeActivity → invalidateQueries;
    // a background refetch would clobber entries that landed since the snapshot.
    staleTime: Infinity,
    placeholderData: [],
  });
  return {
    entries: data ?? [],
    loaded: !apiAvailable || isSuccess,
  };
}
