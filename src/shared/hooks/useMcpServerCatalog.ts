// Ownership: shared catalog hooks.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { McpServerInfo } from "@/types/electron";

export function useMcpServers(enabled = true) {
  const queryClient = useQueryClient();

  // Auto-refresh when tool discovery completes in the main process.
  // OAuth-completion / server-status invalidation lives in wireMcpOAuth(qc) so
  // it stays active even when no consumer of useMcpServers is mounted.
  useEffect(() => {
    const unsubscribeTools = window.mcpsAPI?.onToolsUpdated?.(() => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    });
    return () => {
      unsubscribeTools?.();
    };
  }, [queryClient]);

  return useQuery<McpServerInfo[]>({
    queryKey: ["mcp-servers"],
    queryFn: async () => {
      const result = await window.mcpsAPI?.list();
      if (!result?.success) return [];
      return result.servers ?? [];
    },
    enabled,
  });
}
