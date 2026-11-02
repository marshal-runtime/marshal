// Ownership: permissions tool registry hook.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { ToolCategory } from "@/types/electron";

async function fetchCategories(): Promise<ToolCategory[]> {
  try {
    const result = await window.permissionsAPI?.listTools();
    if (result?.success && result.categories) {
      return result.categories;
    }
  } catch {
    // IPC failure — return empty so the panel renders without tools
  }
  return [];
}

export function useToolRegistry() {
  const queryClient = useQueryClient();

  // Re-fetch when MCP tool discovery completes in the main process
  useEffect(() => {
    const unsubscribe = window.mcpsAPI?.onToolsUpdated?.(() => {
      void queryClient.invalidateQueries({ queryKey: ["permissions", "tools"] });
    });
    return () => unsubscribe?.();
  }, [queryClient]);

  const { data: categories = [], isLoading: loading } = useQuery({
    queryKey: ["permissions", "tools"],
    queryFn: fetchCategories,
    staleTime: Infinity, // refetched when mcp:tools-updated fires
    refetchOnMount: "always", // servers may have been added/removed while panel was closed
  });

  return { categories, loading };
}
