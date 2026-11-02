import { readYamlField } from "@common/foundation/parsing/frontmatter";
import { DEFAULT_WORKSPACE_KEY } from "@common/workspace-display";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SlotRenderer, SLOT } from "@/extensions";
import type { CreateSlotContextBase, PrimarySidebarContext } from "@/extensions";
import { TelemetryPath_CoCreate, TelemetryPath_Editor } from "@/services/telemetry/schema";
import { useLayout } from "@/shared/contexts/useMarshalLayout";

import { MAX_ZOOM, MIN_ZOOM, useZoom, useZoomKeyboardShortcuts } from "./hooks/state/useZoom";
import { useInvalidateWorkspaceTree, useWorkspaceRoot } from "./hooks/useCreateWorkspaceData";
import { useWorkspaceUIState } from "./hooks/useCreateWorkspaceUIState";
import { EditorFallback } from "./slots/EditorFallback";
import { PrimarySidebarFallback } from "./slots/PrimarySidebarFallback";
import { ZoomControls } from "./ZoomControls";

interface CreatePanelProps {
  isOpen: boolean;
  onBack?: () => void;
  /** Called when a file is selected or workspace switches so the main nav history can track it. */
  onNavigateFile?: (filePath: string | undefined, workspaceName: string) => void;
}

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
export const LEFT_NAV_WIDTH = 256;
const DEFAULT_SIDEBAR_WIDTH = LEFT_NAV_WIDTH;

function useResizable(defaultWidth: number, min: number, max: number, invertDrag = false) {
  // Stored user-chosen width. We derive the rendered width by clamping to current bounds,
  // so if the window briefly shrinks and re-expands, the user's preferred width is restored.
  const [storedWidth, setStoredWidth] = useState(defaultWidth);
  const width = Math.min(max, Math.max(min, storedWidth));
  const isDragging = useRef(false);
  const moveRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const upRef = useRef<(() => void) | null>(null);
  // Track latest min/max so an in-flight drag uses fresh bounds even if the
  // viewport resizes mid-drag.
  const minRef = useRef(min);
  const maxRef = useRef(max);
  useEffect(() => {
    minRef.current = min;
    maxRef.current = max;
  }, [min, max]);

  // Clean up drag listeners on unmount
  useEffect(() => {
    return () => {
      if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
      if (upRef.current) document.removeEventListener("mouseup", upRef.current);
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startW = width;

      const onMove = (ev: MouseEvent) => {
        const delta = invertDrag ? startX - ev.clientX : ev.clientX - startX;
        setStoredWidth(Math.min(maxRef.current, Math.max(minRef.current, startW + delta)));
      };
      const onUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        moveRef.current = null;
        upRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      moveRef.current = onMove;
      upRef.current = onUp;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, invertDrag],
  );

  return { width, handleMouseDown };
}

export function CreatePanel({ isOpen, onBack, onNavigateFile }: CreatePanelProps) {
  const { sidebarCollapsed } = useLayout();
  const queryClient = useQueryClient();
  const { data: uiState, isLoading: uiStateLoading } = useWorkspaceUIState();
  const activeWorkspace = uiState?.activeWorkspace ?? DEFAULT_WORKSPACE_KEY;
  const sidebar = useResizable(DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);

  // User-controlled zoom for the Co-Create content area. Persisted via
  // preferencesAPI; keyboard shortcuts only fire while this panel is mounted.
  // `isHydrated` gates the content render so we don't show the default 100%
  // for one tick before snapping to the user's persisted zoom.
  const { zoom, isHydrated: zoomHydrated, zoomIn, zoomOut, reset: resetZoom } = useZoom();
  useZoomKeyboardShortcuts({ zoomIn, zoomOut, reset: resetZoom }, isOpen);

  // Resolve workspace root (shared hook — deduplicates with FileTree)
  const { rootPath } = useWorkspaceRoot(activeWorkspace);
  const invalidateWorkspaceTree = useInvalidateWorkspaceTree();

  // Derive selected file from persisted React Query cache — single source of truth
  const persistedRelPath = uiState?.selectedFiles?.[activeWorkspace];
  const selectedFile =
    !uiStateLoading && rootPath && persistedRelPath ? `${rootPath}/${persistedRelPath}` : null;

  // Persist selected file via mutation with optimistic cache update (mirrors switchWorkspace)
  const selectFileMutation = useMutation({
    mutationFn: ({ workspaceName, rel }: { workspaceName: string; rel: string | undefined }) =>
      window.workspaceAPI?.setSelectedFile(workspaceName, rel) ??
      Promise.resolve({ success: true }),
    onMutate: ({ workspaceName, rel }) => {
      const prev = queryClient.getQueryData<typeof uiState>(["workspace", "uiState"]);
      queryClient.setQueryData(["workspace", "uiState"], (old: typeof uiState) => {
        if (!old) return old;
        const selectedFiles = { ...old.selectedFiles };
        if (rel) selectedFiles[workspaceName] = rel;
        else delete selectedFiles[workspaceName];
        return { ...old, selectedFiles };
      });
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(["workspace", "uiState"], context.prev);
    },
  });

  const handleFileSelect = useCallback(
    (filePath: string | null) => {
      if (!rootPath || !activeWorkspace) return;
      const normalized = filePath ? filePath.replace(/\\/g, "/") : "";
      const prefix = rootPath + "/";
      const rel = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
      selectFileMutation.mutate({ workspaceName: activeWorkspace, rel });
    },
    [rootPath, activeWorkspace, selectFileMutation],
  );

  // Track the async-loaded frontmatter type keyed by file path so render-time
  // derivation can distinguish "loaded for this file" from a stale result.
  const [loadedFileType, setLoadedFileType] = useState<{
    path: string;
    type: string | null;
  } | null>(null);

  // Async: read frontmatter type when a markdown file becomes selected, including
  // on initial mount when a file is already selected via persisted state. Null cases
  // (no file, non-markdown) are handled at render time — no synchronous setState here.
  useEffect(() => {
    let cancelled = false;
    const ext = selectedFile?.split(".").pop()?.toLowerCase();
    if (selectedFile && (ext === "md" || ext === "markdown" || ext === "mdx")) {
      void (async () => {
        try {
          const result = await window.workspaceAPI?.readFile(selectedFile);
          if (!cancelled) {
            let fileType: string | null = null;
            if (result?.success && result.content) {
              // Extract frontmatter block from content
              const fmMatch = result.content.match(/^---\n([\s\S]*?)\n---/);
              if (fmMatch?.[1]) {
                fileType = readYamlField(fmMatch[1], "type") ?? null;
              }
            }
            setLoadedFileType({
              path: selectedFile,
              type: fileType,
            });
          }
        } catch {
          if (!cancelled) setLoadedFileType({ path: selectedFile, type: null });
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // Derive the active file type synchronously during render — null for no file,
  // non-markdown files, or while the async read is still in flight.
  const extFileType = useMemo(() => {
    if (!selectedFile) return null;
    const ext = selectedFile.split(".").pop()?.toLowerCase();
    if (ext !== "md" && ext !== "markdown" && ext !== "mdx") return null;
    return loadedFileType?.path === selectedFile ? loadedFileType.type : null;
  }, [selectedFile, loadedFileType]);

  const switchWorkspace = useMutation({
    mutationFn: (name: string) =>
      window.workspaceAPI?.setActiveWorkspace(name) ?? Promise.resolve({ success: true }),
    onMutate: (name: string) => {
      const prev = queryClient.getQueryData<typeof uiState>(["workspace", "uiState"]);
      queryClient.setQueryData(["workspace", "uiState"], (old: typeof uiState) =>
        old
          ? { ...old, activeWorkspace: name }
          : { activeWorkspace: name, expandedPaths: {}, selectedFiles: {} },
      );
      return { prev };
    },
    onError: (_err, _name, context) => {
      if (context?.prev) queryClient.setQueryData(["workspace", "uiState"], context.prev);
    },
  });

  const handleWorkspaceSwitch = useCallback(
    (name: string) => {
      switchWorkspace.mutate(name);
      onNavigateFile?.(undefined, name);
    },
    [switchWorkspace, onNavigateFile],
  );

  const handleFileError = useCallback(() => {
    handleFileSelect(null);
    // File failed to read (likely deleted externally) — refresh the tree so
    // the stale entry disappears from the sidebar instead of staying
    // clickable. Use the tree-only helper to avoid racing the optimistic
    // selection clear in handleFileSelect above.
    invalidateWorkspaceTree();
  }, [handleFileSelect, invalidateWorkspaceTree]);

  // Context for the primary sidebar — includes onFileSelect so custom sidebar
  // components can drive file selection without touching window.* directly.
  const sidebarCtx = useMemo<PrimarySidebarContext>(
    () => ({
      activeFile: selectedFile,
      activeFileType: extFileType,
      workspace: activeWorkspace,
      sessionId: null,
      onFileSelect: handleFileSelect,
    }),
    [selectedFile, extFileType, activeWorkspace, handleFileSelect],
  );

  // Context for all other slots — base fields only, no onFileSelect.
  const contentCtx = useMemo<CreateSlotContextBase>(
    () => ({
      activeFile: selectedFile,
      activeFileType: extFileType,
      workspace: activeWorkspace,
      sessionId: null,
    }),
    [selectedFile, extFileType, activeWorkspace],
  );

  if (!isOpen) return null;

  return (
    <TelemetryPath_CoCreate>
      <WorkspaceDocumentScope
        value={
          activeWorkspace ? { workspaceName: activeWorkspace, applicationScope: "workspace" } : null
        }
      >
        <div className="flex size-full overflow-hidden bg-background">
          {/* Left sidebar */}
          <div
            className="shrink-0 overflow-hidden border-r border-border bg-accent transition-[width] duration-200 ease-in-out"
            style={{
              width: sidebarCollapsed ? 0 : sidebar.width,
              borderRightWidth: sidebarCollapsed ? 0 : undefined,
            }}
          >
            <div
              className="flex h-full flex-col overflow-hidden"
              style={{ width: sidebar.width, minWidth: sidebar.width }}
            >
              <SlotRenderer
                slotId={SLOT.CREATE_PRIMARY_SIDEBAR}
                slotCtx={sidebarCtx}
                fallback={
                  <PrimarySidebarFallback
                    onBack={onBack}
                    activeWorkspace={activeWorkspace}
                    onSwitch={handleWorkspaceSwitch}
                    selectedFile={selectedFile ?? undefined}
                    onFileSelect={handleFileSelect}
                  />
                }
              />
            </div>
          </div>

          {/* Sidebar resize handle */}
          <div
            className="relative shrink-0 cursor-col-resize bg-transparent transition-[width,opacity] duration-200 ease-in-out before:absolute before:-inset-x-0.5 before:inset-y-0 hover:bg-primary"
            style={{ width: sidebarCollapsed ? 0 : 4, opacity: sidebarCollapsed ? 0 : 1 }}
            onMouseDown={sidebarCollapsed ? undefined : sidebar.handleMouseDown}
          />

          {/* Main content */}
          <TelemetryPath_Editor>
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card">
              {/* Content header slot — empty by default; extensions inject breadcrumbs / action bars here */}
              <SlotRenderer slotId={SLOT.CREATE_CONTENT_HEADER} slotCtx={contentCtx} />
              {/* Editor slot — extensions replace the entire content area */}
              <SlotRenderer
                slotId={SLOT.CREATE_EDITOR}
                slotCtx={contentCtx}
                fallback={
                  <EditorFallback
                    selectedFile={selectedFile}
                    onError={handleFileError}
                    zoom={zoom}
                    zoomHydrated={zoomHydrated}
                  />
                }
              />

              {/* Floating zoom controls — outside the zoomed surfaces so they
                stay at 100% and don't move when the user changes zoom. */}
              {zoomHydrated && (
                <ZoomControls
                  zoom={zoom}
                  onZoomIn={zoomIn}
                  onZoomOut={zoomOut}
                  onReset={resetZoom}
                  minZoom={MIN_ZOOM}
                  maxZoom={MAX_ZOOM}
                  className="absolute right-3 bottom-3 z-10"
                />
              )}
            </div>
          </TelemetryPath_Editor>
        </div>
      </WorkspaceDocumentScope>
    </TelemetryPath_CoCreate>
  );
}
import { WorkspaceDocumentScope } from "@/features/runtime-ui/WorkspaceDocumentScope";
