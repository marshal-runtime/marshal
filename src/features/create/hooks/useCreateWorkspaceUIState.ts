import type { WorkspaceUIState } from "@common/marshal-ipc-contract";
import { useQuery } from "@tanstack/react-query";

/** Fetch and cache the workspace UI state (active workspace + expanded paths). */
export function useWorkspaceUIState() {
  return useQuery<WorkspaceUIState | null>({
    queryKey: ["workspace", "uiState"],
    queryFn: async () => {
      const uiStateResult = await window.workspaceAPI?.getUIState();
      return uiStateResult?.success ? (uiStateResult.state ?? null) : null;
    },
    staleTime: Infinity, // only changes via explicit writes, no auto-refetch
  });
}
