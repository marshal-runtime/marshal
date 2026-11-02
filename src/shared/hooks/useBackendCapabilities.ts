import type { BackendCapabilities } from "@common/marshal-ipc-contract";
import { useQuery } from "@tanstack/react-query";

const QUERY_KEY = ["backend", "capabilities"] as const;

// Capabilities are stable for the process lifetime because runtime changes
// currently require an app restart.
export function useBackendCapabilitiesQuery(): {
  capabilities: BackendCapabilities | undefined;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => window.backendAPI?.capabilities() ?? null,
    staleTime: Infinity,
    enabled: !!window.backendAPI,
  });

  return {
    capabilities: query.data ?? undefined,
    isLoading: !!window.backendAPI && query.isPending,
  };
}
