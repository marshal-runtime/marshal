import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

// Cross-platform path helpers (renderer can't use Node's path module)
const workspacePathBasename = (p: string) => p.split(/[\\/]/).pop() || "";

/** Resolve and cache the workspace root path. Shared across FileTree and CreatePanel. */
export function useWorkspaceRoot(workspaceName?: string) {
  const { data: rootInfo } = useQuery({
    queryKey: ["workspace", "root", workspaceName ?? "__default__"],
    queryFn: async () => {
      const result = await window.workspaceAPI?.getRoot(workspaceName);
      if (!result?.success || !result.root) return null;
      return { path: result.root, name: workspacePathBasename(result.root) || "Workspace" };
    },
    // Revalidate on mount — workspace root may have been renamed/removed externally.
    staleTime: 0,
  });
  const rootPath = (rootInfo?.path ?? "").replace(/\\/g, "/");
  return { rootInfo, rootPath };
}

/** Fetch and cache the list of workspace names. */
export function useWorkspaces() {
  const queryClient = useQueryClient();

  const { data = { workspaces: [], externalWorkspaces: [] } } = useQuery<{
    workspaces: string[];
    externalWorkspaces: string[];
  }>({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const result = await window.workspaceAPI?.listWorkspaces();
      return {
        workspaces: result?.success ? (result.workspaces ?? []) : [],
        externalWorkspaces: result?.success ? (result.externalWorkspaces ?? []) : [],
      };
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  }, [queryClient]);

  const externalWorkspaces = useMemo(
    () => new Set(data.externalWorkspaces),
    [data.externalWorkspaces],
  );

  return {
    workspaces: data.workspaces,
    externalWorkspaces,
    invalidate,
  };
}

interface WorkspaceDirEntry {
  name: string;
  type: "file" | "directory";
}

/** Fetch and cache directory contents for a given path. */
export function useDirectoryListing(dirPath: string | null, enabled: boolean) {
  return useQuery<WorkspaceDirEntry[]>({
    queryKey: ["workspace", "dir", dirPath],
    queryFn: async () => {
      if (!dirPath) return [];
      const result = await window.workspaceAPI?.listDir(dirPath);
      return result?.success ? (result.entries ?? []) : [];
    },
    enabled: enabled && !!dirPath,
    // Filesystem state can change externally (deletes, external edits), so always
    // revalidate on mount rather than serving the global 5s stale cache.
    staleTime: 0,
  });
}

interface WorkspaceFileContent {
  type: "markdown" | "text" | "image" | "html";
  content: string;
}

/** Fetch and cache file content for a given path. */
export function useFileContent(filePath: string | null) {
  return useQuery<WorkspaceFileContent | null>({
    queryKey: ["workspace", "file", filePath],
    queryFn: async () => {
      if (!filePath) return null;
      const result = await window.workspaceAPI?.readFile(filePath);
      if (!result?.success) return null;
      return {
        type: result.type ?? "text",
        content: result.content ?? "",
      };
    },
    enabled: !!filePath,
    // Don't refetch on window focus — editor may have unsaved changes
    refetchOnWindowFocus: false,
  });
}

/**
 * Invalidate the workspace file-tree queries (`dir` and `root`) without
 * touching `uiState`.
 *
 * A broad `invalidateQueries({ queryKey: ["workspace"] })` also matches
 * `["workspace", "uiState"]` as a prefix, which refetches `getUIState` and
 * races with any in-flight optimistic update to `selectedFiles` /
 * `expandedPaths` / `activeWorkspace`. That race caused a bug (ENOENT after
 * deleting the selected file). Always prefer this helper over a broad
 * invalidation from code that mutates the filesystem.
 */
export function useInvalidateWorkspaceTree() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", "dir"] });
    void queryClient.invalidateQueries({ queryKey: ["workspace", "root"] });
  }, [queryClient]);
}
