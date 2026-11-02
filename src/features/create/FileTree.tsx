import { createLogger } from "@common/marshal-logger";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Image,
  FileCode,
  File,
  FileCsv,
  FileDoc,
  FilePdf,
  FilePlus,
  FilePpt,
  FileXls,
  FolderPlus,
  Folder,
  FolderOpen,
} from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/marshal-ui/input";
import { SLOT, SlotRenderer, useRegistryVersion } from "@/extensions";
import { cn } from "@/lib/marshal-class-names";
import { TelemetryPath } from "@/services/telemetry/opensource";
import {
  TelemetryPath_FileTree,
  TelemetryPath_File,
  InteractiveElementMonitor_AddToChat,
  InteractiveElementMonitor_CreateFolder,
  InteractiveElementMonitor_SelectFile,
  InteractiveElementMonitor_RenameItem,
  InteractiveElementMonitor_DeleteItem,
  InteractiveElementMonitor_DuplicateItem,
} from "@/services/telemetry/schema";

import { CreateModeIcon } from "./components/CreateModeIcon";
import {
  useDirectoryListing,
  useInvalidateWorkspaceTree,
  useWorkspaceRoot,
} from "./hooks/useCreateWorkspaceData";
import { useWorkspaceUIState } from "./hooks/useCreateWorkspaceUIState";

const log = createLogger("FileTree");

// Cross-platform path helpers (renderer can't use Node's path module)
const SEP = /[\\/]/;
const pathJoin = (base: string, name: string) => `${base}/${name}`;
const pathBasename = (p: string, ext?: string) => {
  const name = p.split(SEP).pop() || "";
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
};
const pathDirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.substring(0, i) : p;
};
const pathExtname = (p: string) => {
  const name = p.split(SEP).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(dot) : "";
};

interface InlineInput {
  parentPath: string;
  value: string;
}

// Discriminated union so "new file" vs "duplicate existing file" is encoded
// in the type system rather than tracked via a parallel ref (which was easy to
// forget to reset on dismissal paths). `handleNewFileSubmit` branches on `mode`.
type NewFileInputState =
  | { mode: "new"; parentPath: string; value: string }
  | { mode: "duplicate"; parentPath: string; value: string; sourcePath: string };

interface RenameInput {
  path: string;
  value: string;
}

interface FileTreeProps {
  onFileSelect: (filePath: string) => void;
  selectedFile?: string;
  workspaceName?: string;
  onAddToChat?: (filePath: string) => void;
}

export function FileTree({
  onFileSelect,
  selectedFile,
  workspaceName,
  onAddToChat,
}: FileTreeProps) {
  // Keep tree-node icon slots reactive with a single registry subscription.
  useRegistryVersion();

  const invalidateWorkspaceTree = useInvalidateWorkspaceTree();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [isDraggingExternal, setIsDraggingExternal] = useState(false);
  // Track last-clicked item for keyboard Delete (includes folders, unlike selectedFile).
  // Ref instead of state — never rendered, only read by keyboard handler.
  const focusedItemRef = useRef<{
    path: string;
    isDirectory: boolean;
  } | null>(null);

  const handleFocusItem = useCallback((item: { path: string; isDirectory: boolean } | null) => {
    focusedItemRef.current = item;
  }, []);

  // ── Workspace root resolution (shared hook — deduplicates with CreatePanel) ──
  const { rootPath } = useWorkspaceRoot(workspaceName);

  // Root children are always visible (React Query — auto-refetches on invalidation)
  const { data: rootEntries = [] } = useDirectoryListing(rootPath || null, !!rootPath);

  // Invalidate workspace queries on filesystem changes (scoped to dir/root to avoid uiState refetch)
  useEffect(() => {
    return (
      window.workspaceAPI?.onWorkspaceChange?.(() => {
        invalidateWorkspaceTree();
      }) ?? (() => {})
    );
  }, [invalidateWorkspaceTree]);

  // ── Expanded state: restore from disk + debounced persist on toggle ──

  const { data: uiState } = useWorkspaceUIState();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Restore expanded folders when workspace/root/uiState become available (set-state-during-render)
  const loadKey = rootPath && uiState ? `${workspaceName}:${rootPath}` : null;
  if (loadKey && hydratedFor !== loadKey) {
    setHydratedFor(loadKey);
    const paths = uiState!.expandedPaths[workspaceName ?? ""] ?? [];
    setExpanded(paths.length > 0 ? new Set(paths.map((r) => pathJoin(rootPath, r))) : new Set());
  }

  // Toggle + debounced persist in one event handler (not an effect)
  const toggleExpand = useCallback(
    (p: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);

        clearTimeout(saveTimerRef.current);
        const prefix = rootPath + "/";
        const rel = [...next]
          .filter((abs) => abs.startsWith(prefix))
          .map((abs) => abs.slice(prefix.length));
        saveTimerRef.current = setTimeout(
          () => void window.workspaceAPI?.setExpandedPaths(workspaceName!, rel),
          300,
        );
        return next;
      });
    },
    [rootPath, workspaceName],
  );

  const [newFolderInput, setNewFolderInput] = useState<InlineInput | null>(null);
  const [newFileInput, setNewFileInput] = useState<NewFileInputState | null>(null);
  const [renameInput, setRenameInput] = useState<RenameInput | null>(null);
  const didSelectDuplicateRef = useRef(false);
  const didSelectRenameRef = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  // Signals that the next context-menu close should NOT restore focus
  // (because an inline input is about to appear and needs focus instead)
  const suppressCloseAutoFocusRef = useRef(false);

  const handleContextMenuCloseAutoFocus = useCallback((e: Event) => {
    if (suppressCloseAutoFocusRef.current) {
      e.preventDefault();
      suppressCloseAutoFocusRef.current = false;
    }
  }, []);

  const handleReveal = useCallback((targetPath: string) => {
    void window.workspaceAPI?.revealInFileManager(targetPath);
  }, []);

  // ── New folder from context menu ──
  const handleNewFolder = useCallback((targetPath: string, isDirectory: boolean) => {
    const parentPath = isDirectory ? targetPath : pathDirname(targetPath);
    suppressCloseAutoFocusRef.current = true;
    setNewFolderInput({ parentPath, value: "" });
    setExpanded((prev) => new Set([...prev, parentPath]));
  }, []);

  const handleNewFolderSubmit = useCallback(async () => {
    if (!newFolderInput || !newFolderInput.value.trim()) {
      setNewFolderInput(null);
      return;
    }
    await window.workspaceAPI?.createFolder(newFolderInput.parentPath, newFolderInput.value.trim());
    setNewFolderInput(null);
    invalidateWorkspaceTree();
  }, [newFolderInput, invalidateWorkspaceTree]);

  const handleNewFolderKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleNewFolderSubmit();
      } else if (e.key === "Escape") {
        setNewFolderInput(null);
      }
    },
    [handleNewFolderSubmit],
  );

  // Auto-focus the inline input when it appears — callback ref ensures
  // focus is set even when the input re-mounts (dep on newFolderInput).
  // requestAnimationFrame defers focus until after Radix ContextMenu
  // finishes its close cleanup (which may move focus to body).
  const newFolderInputCbRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node) {
        requestAnimationFrame(() => node.focus());
      }
    },
    // eslint-disable-next-line react-compiler/exhaustive-deps -- newFolderInput in deps re-fires focus on remount
    [newFolderInput],
  );

  // ── New file from context menu ──
  const handleNewFile = useCallback((targetPath: string, isDirectory: boolean) => {
    const parentPath = isDirectory ? targetPath : pathDirname(targetPath);
    suppressCloseAutoFocusRef.current = true;
    setNewFileInput({ mode: "new", parentPath, value: "" });
    setExpanded((prev) => new Set([...prev, parentPath]));
  }, []);

  // Mutation for duplicate: pending/error state belongs in the mutation, not
  // in cross-cutting imperative code. On error we keep the user informed via
  // toast + log; on success we invalidate the workspace query and navigate to
  // the new file.
  const duplicateMutation = useMutation({
    mutationFn: ({ source, dest }: { source: string; dest: string }) => {
      const api = window.workspaceAPI;
      if (!api) throw new Error("workspaceAPI not available");
      return api.duplicateItem(source, dest);
    },
    onSuccess: (result) => {
      invalidateWorkspaceTree();
      if (!result?.success) {
        log.error("duplicateItem failed:", result?.error);
        toast.error(`Failed to duplicate file: ${result?.error ?? "unknown error"}`);
        return;
      }
      if (result.newPath) {
        onFileSelect(result.newPath);
      }
    },
    onError: (error) => {
      log.error("duplicateItem threw:", error);
      toast.error(`Failed to duplicate file: ${String(error)}`);
    },
  });

  const handleNewFileSubmit = useCallback(async () => {
    if (!newFileInput || !newFileInput.value.trim()) {
      setNewFileInput(null);
      return;
    }
    const filePath = pathJoin(newFileInput.parentPath, newFileInput.value.trim());
    if (newFileInput.mode === "duplicate") {
      duplicateMutation.mutate({ source: newFileInput.sourcePath, dest: filePath });
      setNewFileInput(null);
    } else {
      await window.workspaceAPI?.writeFile(filePath, "");
      setNewFileInput(null);
      invalidateWorkspaceTree();
    }
  }, [newFileInput, invalidateWorkspaceTree, duplicateMutation]);

  const handleNewFileKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleNewFileSubmit();
      } else if (e.key === "Escape") {
        setNewFileInput(null);
      }
    },
    [handleNewFileSubmit],
  );

  const newFileInputCbRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node) {
        requestAnimationFrame(() => {
          node.focus();
          // For duplicate: pre-select the stem (before extension) on initial mount only
          if (
            newFileInput?.mode === "duplicate" &&
            newFileInput.value &&
            !didSelectDuplicateRef.current
          ) {
            didSelectDuplicateRef.current = true;
            const dot = newFileInput.value.lastIndexOf(".");
            if (dot > 0) {
              node.setSelectionRange(0, dot);
            } else {
              node.select();
            }
          }
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newFileInput],
  );

  // ── Rename from context menu ──
  const handleRename = useCallback((targetPath: string) => {
    const name = pathBasename(targetPath);
    suppressCloseAutoFocusRef.current = true;
    didSelectRenameRef.current = false;
    setRenameInput({ path: targetPath, value: name });
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameInput) return;
    const newName = renameInput.value.trim();
    const oldName = pathBasename(renameInput.path);
    if (!newName || newName === oldName) {
      setRenameInput(null);
      return;
    }
    await window.workspaceAPI?.renameItem(renameInput.path, newName);
    setRenameInput(null);
    invalidateWorkspaceTree();
  }, [renameInput, invalidateWorkspaceTree]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleRenameSubmit();
      } else if (e.key === "Escape") {
        setRenameInput(null);
      }
    },
    [handleRenameSubmit],
  );

  // Auto-focus + select rename input — callback ref pattern consistent
  // with newFolderInputCbRef (dep on renameInput forces re-invocation).
  const renameInputCbRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node && renameInput && !didSelectRenameRef.current) {
        didSelectRenameRef.current = true;
        requestAnimationFrame(() => {
          node.focus();
          const dot = renameInput.value.lastIndexOf(".");
          if (dot > 0) {
            node.setSelectionRange(0, dot);
          } else {
            node.select();
          }
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renameInput],
  );

  // ── Delete from context menu ──
  const handleDelete = useCallback(
    async (targetPath: string, isDirectory: boolean) => {
      const name = pathBasename(targetPath);
      const confirmMsg = isDirectory
        ? `Delete folder "${name}" and all its contents?`
        : `Delete "${name}"?`;
      if (!window.confirm(confirmMsg)) return;
      await window.workspaceAPI?.deleteItem(targetPath);
      // Clear selection if the deleted item was selected
      if (targetPath === selectedFile) {
        onFileSelect("");
      }
      focusedItemRef.current = null;
      invalidateWorkspaceTree();
    },
    [invalidateWorkspaceTree, selectedFile, onFileSelect],
  );

  // ── Duplicate file from context menu ──
  const handleDuplicate = useCallback((targetPath: string) => {
    const parentPath = pathDirname(targetPath);
    const ext = pathExtname(targetPath);
    const base = pathBasename(targetPath, ext);
    const suggestedName = ext ? `${base} copy${ext}` : `${base} copy`;
    didSelectDuplicateRef.current = false;
    suppressCloseAutoFocusRef.current = true;
    setNewFileInput({
      mode: "duplicate",
      parentPath,
      value: suggestedName,
      sourcePath: targetPath,
    });
    setExpanded((prev) => new Set([...prev, parentPath]));
  }, []);

  // ── Keyboard Delete/Backspace for focused item ──
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && focusedItemRef.current) {
        if (!(e.target instanceof HTMLElement)) return;
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        e.preventDefault();
        void handleDelete(focusedItemRef.current.path, focusedItemRef.current.isDirectory);
      }
    },
    [handleDelete],
  );

  // ── External file drop onto the tree area ──
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // Accept external file drops and internal workspace moves
      const hasFiles = e.dataTransfer.types.includes("Files");
      const hasInternal = e.dataTransfer.types.includes("text/x-workspace-path");
      if (hasFiles || hasInternal) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = hasInternal ? "move" : "copy";
        if (hasFiles && !isDraggingExternal) {
          setIsDraggingExternal(true);
        }
      }
    },
    [isDraggingExternal],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the tree container itself
    if (
      e.currentTarget === e.target ||
      !(e.relatedTarget instanceof Node) ||
      !e.currentTarget.contains(e.relatedTarget)
    ) {
      setIsDraggingExternal(false);
    }
  }, []);

  const copyDroppedExternalFiles = useCallback(
    async (files: FileList, targetDir: string) => {
      const droppedFiles = Array.from(files);
      if (droppedFiles.length === 0) {
        log.warn("copyExternalFiles skipped: drop contained no files");
        return;
      }

      const result = await window.workspaceAPI?.copyExternalFiles(droppedFiles, targetDir);
      if (!result) {
        log.error("copyExternalFiles failed: workspace API is unavailable");
        return;
      }
      if (!result.success) {
        log.error("copyExternalFiles failed:", result.error);
        return;
      }

      const copied = result.copied ?? 0;
      log.info("copyExternalFiles completed", { copied, fileCount: droppedFiles.length });
      if (copied > 0) {
        invalidateWorkspaceTree();
      } else {
        log.warn("copyExternalFiles completed without copying files", {
          fileCount: droppedFiles.length,
        });
      }
    },
    [invalidateWorkspaceTree],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingExternal(false);
      setDragOverPath(null);

      // Internal move takes priority — move to workspace root
      const internalPath = e.dataTransfer.getData("text/x-workspace-path");
      if (internalPath) {
        if (rootPath && internalPath !== rootPath) {
          await window.workspaceAPI?.moveItem(internalPath, rootPath);
        }
        return;
      }

      if (!rootPath) return;
      const files = e.dataTransfer.files;
      await copyDroppedExternalFiles(files, rootPath);
    },
    [copyDroppedExternalFiles, rootPath],
  );

  // ── Internal drag (move within workspace) ──
  const handleNodeDragStart = useCallback((e: React.DragEvent, nodePath: string) => {
    e.dataTransfer.setData("text/x-workspace-path", nodePath);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleNodeDragOver = useCallback(
    (e: React.DragEvent, nodeType: "file" | "directory", nodePath: string) => {
      // Accept internal moves onto directories
      if (e.dataTransfer.types.includes("text/x-workspace-path") && nodeType === "directory") {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDragOverPath(nodePath);
      }
      // Accept external files onto directories
      if (e.dataTransfer.types.includes("Files") && nodeType === "directory") {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOverPath(nodePath);
      }
    },
    [],
  );

  const handleNodeDragLeave = useCallback(() => {
    setDragOverPath(null);
  }, []);

  const handleNodeDrop = useCallback(
    async (e: React.DragEvent, targetPath: string, targetType: "file" | "directory") => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverPath(null);
      setIsDraggingExternal(false);

      if (targetType !== "directory") return;

      // Internal move
      const sourcePath = e.dataTransfer.getData("text/x-workspace-path");
      if (sourcePath) {
        if (sourcePath === targetPath) return;
        // Skip if already a direct child of this directory
        const sourceParent = pathDirname(sourcePath);
        if (sourceParent === targetPath) return;
        await window.workspaceAPI?.moveItem(sourcePath, targetPath);
        return;
      }

      // External file drop onto specific folder
      const files = e.dataTransfer.files;
      await copyDroppedExternalFiles(files, targetPath);
    },
    [copyDroppedExternalFiles],
  );

  if (!rootPath) {
    return <div className="p-4 text-[13px] text-muted-foreground">Loading workspace…</div>;
  }

  const isMac = window.platform === "darwin";
  const isEmpty = rootEntries.length === 0;

  return (
    <TelemetryPath_FileTree>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "relative min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto text-[13px] outline-none select-none",
              isDraggingExternal &&
                "rounded-sm outline-2 -outline-offset-2 outline-primary outline-dashed",
            )}
            ref={treeRef}
            tabIndex={0}
            onKeyDown={handleTreeKeyDown}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Inline input at root level */}
            {newFolderInput && newFolderInput.parentPath === rootPath && (
              <div className="flex items-center gap-1.5 px-2 py-0.5" style={{ paddingLeft: 8 }}>
                <span className="flex shrink-0 items-center text-muted-foreground">
                  <FolderPlus size={13} />
                </span>
                <Input
                  ref={newFolderInputCbRef}
                  type="text"
                  autoFocus
                  className="h-6 min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
                  value={newFolderInput.value}
                  placeholder="folder name"
                  onChange={(e) => setNewFolderInput({ ...newFolderInput, value: e.target.value })}
                  onKeyDown={handleNewFolderKeyDown}
                  onBlur={handleNewFolderSubmit}
                />
              </div>
            )}
            {newFileInput && newFileInput.parentPath === rootPath && (
              <div className="flex items-center gap-1.5 px-2 py-0.5" style={{ paddingLeft: 8 }}>
                <span className="flex shrink-0 items-center text-muted-foreground">
                  <FilePlus size={13} />
                </span>
                <Input
                  ref={newFileInputCbRef}
                  type="text"
                  autoFocus
                  className="h-6 min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
                  value={newFileInput.value}
                  placeholder="file name"
                  onChange={(e) => setNewFileInput({ ...newFileInput, value: e.target.value })}
                  onKeyDown={handleNewFileKeyDown}
                  onBlur={handleNewFileSubmit}
                />
              </div>
            )}
            {rootEntries.map((entry, i) => {
              const entryPath = pathJoin(rootPath, entry.name);
              return (
                <TelemetryPath key={entryPath} id={i}>
                  <TelemetryPath_File>
                    <TreeNodeView
                      name={entry.name}
                      path={entryPath}
                      type={entry.type}
                      depth={0}
                      expanded={expanded}
                      selectedFile={selectedFile}
                      dragOverPath={dragOverPath}
                      newFolderInput={newFolderInput}
                      newFolderInputRef={newFolderInputCbRef}
                      onNewFolderChange={(value) =>
                        newFolderInput && setNewFolderInput({ ...newFolderInput, value })
                      }
                      onNewFolderKeyDown={handleNewFolderKeyDown}
                      onNewFolderSubmit={handleNewFolderSubmit}
                      newFileInput={newFileInput}
                      newFileInputRef={newFileInputCbRef}
                      onNewFileChange={(value) =>
                        newFileInput && setNewFileInput({ ...newFileInput, value })
                      }
                      onNewFileKeyDown={handleNewFileKeyDown}
                      onNewFileSubmit={handleNewFileSubmit}
                      renameInput={renameInput}
                      renameInputRef={renameInputCbRef}
                      onRenameChange={(value) =>
                        renameInput && setRenameInput({ ...renameInput, value })
                      }
                      onRenameKeyDown={handleRenameKeyDown}
                      onRenameSubmit={handleRenameSubmit}
                      onToggle={toggleExpand}
                      onFileSelect={onFileSelect}
                      onFocusItem={handleFocusItem}
                      onNewFolder={handleNewFolder}
                      onNewFile={handleNewFile}
                      onRename={handleRename}
                      onDelete={handleDelete}
                      onDuplicate={handleDuplicate}
                      onReveal={handleReveal}
                      onNodeDragStart={handleNodeDragStart}
                      onNodeDragOver={handleNodeDragOver}
                      onNodeDragLeave={handleNodeDragLeave}
                      onNodeDrop={handleNodeDrop}
                      onContextMenuCloseAutoFocus={handleContextMenuCloseAutoFocus}
                      onAddToChat={onAddToChat}
                    />
                  </TelemetryPath_File>
                </TelemetryPath>
              );
            })}
            {isEmpty && (
              <div className="px-5 py-4 text-center">
                <p className="m-0 mb-1.5 text-[13px] text-muted-foreground">
                  This workspace is empty.
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                  Drag &amp; drop files here, or right-click to reveal in the{" "}
                  {isMac ? "Finder" : "Explorer"}.
                </p>
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleContextMenuCloseAutoFocus}>
          <InteractiveElementMonitor_CreateFolder callback={() => handleNewFolder(rootPath, true)}>
            {(cb) => <ContextMenuItem onSelect={cb}>New Folder</ContextMenuItem>}
          </InteractiveElementMonitor_CreateFolder>
          <ContextMenuItem onSelect={() => handleNewFile(rootPath, true)}>New File</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleReveal(rootPath)}>
            Reveal in {isMac ? "Finder" : "Explorer"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </TelemetryPath_FileTree>
  );
}

function TreeNodeView({
  name,
  path,
  type,
  depth,
  expanded,
  selectedFile,
  dragOverPath,
  newFolderInput,
  newFolderInputRef,
  onNewFolderChange,
  onNewFolderKeyDown,
  onNewFolderSubmit,
  newFileInput,
  newFileInputRef,
  onNewFileChange,
  onNewFileKeyDown,
  onNewFileSubmit,
  renameInput,
  renameInputRef,
  onRenameChange,
  onRenameKeyDown,
  onRenameSubmit,
  onToggle,
  onFileSelect,
  onFocusItem,
  onNewFolder,
  onNewFile,
  onRename,
  onDelete,
  onDuplicate,
  onReveal,
  onNodeDragStart,
  onNodeDragOver,
  onNodeDragLeave,
  onNodeDrop,
  onContextMenuCloseAutoFocus,
  onAddToChat,
}: {
  name: string;
  path: string;
  type: "file" | "directory";
  depth: number;
  expanded: Set<string>;
  selectedFile?: string;
  dragOverPath: string | null;
  newFolderInput: InlineInput | null;
  newFolderInputRef: React.RefCallback<HTMLInputElement>;
  onNewFolderChange: (value: string) => void;
  onNewFolderKeyDown: (e: React.KeyboardEvent) => void;
  onNewFolderSubmit: () => void;
  newFileInput: NewFileInputState | null;
  newFileInputRef: React.RefCallback<HTMLInputElement>;
  onNewFileChange: (value: string) => void;
  onNewFileKeyDown: (e: React.KeyboardEvent) => void;
  onNewFileSubmit: () => void;
  renameInput: RenameInput | null;
  renameInputRef: React.RefCallback<HTMLInputElement>;
  onRenameChange: (value: string) => void;
  onRenameKeyDown: (e: React.KeyboardEvent) => void;
  onRenameSubmit: () => void;
  onToggle: (path: string) => void;
  onFileSelect: (path: string) => void;
  onFocusItem: (item: { path: string; isDirectory: boolean } | null) => void;
  onNewFolder: (targetPath: string, isDirectory: boolean) => void;
  onNewFile: (targetPath: string, isDirectory: boolean) => void;
  onRename: (targetPath: string) => void;
  onDelete: (targetPath: string, isDirectory: boolean) => void;
  onDuplicate: (targetPath: string) => void;
  onReveal: (targetPath: string) => void;
  onNodeDragStart: (e: React.DragEvent, path: string) => void;
  onNodeDragOver: (e: React.DragEvent, type: "file" | "directory", path: string) => void;
  onNodeDragLeave: () => void;
  onNodeDrop: (e: React.DragEvent, path: string, type: "file" | "directory") => void;
  onContextMenuCloseAutoFocus: (e: Event) => void;
  onAddToChat?: (filePath: string) => void;
}) {
  const isDir = type === "directory";
  const isExpanded = expanded.has(path);
  const isSelected = path === selectedFile;
  const isDragTarget = dragOverPath === path;
  const showNewFolderInput = newFolderInput && newFolderInput.parentPath === path;
  const showNewFileInput = newFileInput && newFileInput.parentPath === path;
  const isRenaming = renameInput?.path === path;
  // Each expanded directory fetches its own children via React Query
  const { data: childEntries = [] } = useDirectoryListing(isDir ? path : null, isExpanded);

  const handleClick = () => {
    onFocusItem({ path, isDirectory: isDir });
    if (isDir) {
      onToggle(path);
    } else {
      onFileSelect(isSelected ? "" : path);
    }
  };

  return (
    <div>
      {isRenaming ? (
        <div
          className="flex items-center gap-1.5 px-2 py-0.5"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {!isDir && (
            <span className="flex shrink-0 items-center leading-none">
              <FileIcon name={renameInput.value || name} />
            </span>
          )}
          <Input
            ref={renameInputRef}
            type="text"
            className="h-6 min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
            value={renameInput.value}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={onRenameSubmit}
          />
        </div>
      ) : (
        <InteractiveElementMonitor_SelectFile callback={handleClick}>
          {(cb) => (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1 truncate rounded-sm border-none bg-transparent px-2 py-[3px] text-left text-[13px] text-muted-foreground transition-colors duration-100 [font:inherit]",
                    "hover:bg-muted hover:text-foreground",
                    isSelected && "bg-muted text-primary",
                    isDragTarget && "bg-primary/15 outline-1 -outline-offset-1 outline-primary",
                  )}
                  style={{ paddingLeft: `${depth * 16 + 8}px` }}
                  onClick={cb}
                  onDoubleClick={() => {
                    if (!isDir) void window.workspaceAPI?.openFile(path);
                  }}
                  draggable
                  onDragStart={(e) => onNodeDragStart(e, path)}
                  onDragOver={(e) => onNodeDragOver(e, type, path)}
                  onDragLeave={onNodeDragLeave}
                  onDrop={(e) => onNodeDrop(e, path, type)}
                >
                  {isDir && (
                    <span
                      className={cn(
                        "inline-flex w-4 shrink-0 items-center justify-center text-[11px] text-muted-foreground transition-transform duration-150 ease-in-out",
                        isExpanded && "rotate-90",
                      )}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                        <path
                          d="M3 1.5L7 5L3 8.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  )}
                  {!isDir && <span className="inline-block w-4 shrink-0" />}
                  <span className="flex shrink-0 items-center leading-none">
                    {isDir ? (
                      isExpanded ? (
                        <FolderOpen size={14} />
                      ) : (
                        <Folder size={14} />
                      )
                    ) : (
                      <SlotRenderer
                        slotId={SLOT.CREATE_PANEL_TREE_NODE_ICON}
                        slotCtx={{
                          fileExtension: pathExtname(path).replace(/^\./, "").toLowerCase(),
                        }}
                        fallback={<FileIcon name={name} />}
                        subscribeToRegistry={false}
                      />
                    )}
                  </span>
                  <span className="overflow-hidden text-ellipsis">{name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent onCloseAutoFocus={onContextMenuCloseAutoFocus}>
                {!isDir && onAddToChat && (
                  <>
                    <InteractiveElementMonitor_AddToChat callback={() => onAddToChat(path)}>
                      {(addCb) => <ContextMenuItem onSelect={addCb}>Add to Chat</ContextMenuItem>}
                    </InteractiveElementMonitor_AddToChat>
                    <ContextMenuSeparator />
                  </>
                )}
                <InteractiveElementMonitor_CreateFolder callback={() => onNewFolder(path, isDir)}>
                  {(cb2) => <ContextMenuItem onSelect={cb2}>New Folder</ContextMenuItem>}
                </InteractiveElementMonitor_CreateFolder>
                <ContextMenuItem onSelect={() => onNewFile(path, isDir)}>New File</ContextMenuItem>
                <InteractiveElementMonitor_RenameItem callback={() => onRename(path)}>
                  {(cb2) => <ContextMenuItem onSelect={cb2}>Rename</ContextMenuItem>}
                </InteractiveElementMonitor_RenameItem>
                {!isDir && (
                  <InteractiveElementMonitor_DuplicateItem callback={() => onDuplicate(path)}>
                    {(cb2) => <ContextMenuItem onSelect={cb2}>Duplicate</ContextMenuItem>}
                  </InteractiveElementMonitor_DuplicateItem>
                )}
                <ContextMenuSeparator />
                <InteractiveElementMonitor_DeleteItem callback={() => onDelete(path, isDir)}>
                  {(cb2) => (
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={cb2}
                    >
                      Delete
                    </ContextMenuItem>
                  )}
                </InteractiveElementMonitor_DeleteItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onReveal(path)}>
                  Reveal in {window.platform === "darwin" ? "Finder" : "Explorer"}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}
        </InteractiveElementMonitor_SelectFile>
      )}
      {isDir && (
        <div
          className={cn(
            "overflow-hidden transition-all duration-200 ease-in-out",
            isExpanded ? "max-h-[5000px] opacity-100" : "max-h-0 opacity-0",
          )}
        >
          {isExpanded && showNewFolderInput && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              <span className="flex shrink-0 items-center text-muted-foreground">
                <FolderPlus size={13} />
              </span>
              <Input
                ref={newFolderInputRef}
                type="text"
                autoFocus
                className="h-6 min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
                value={newFolderInput.value}
                placeholder="folder name"
                onChange={(e) => onNewFolderChange(e.target.value)}
                onKeyDown={onNewFolderKeyDown}
                onBlur={onNewFolderSubmit}
              />
            </div>
          )}
          {isExpanded && showNewFileInput && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              <span className="flex shrink-0 items-center text-muted-foreground">
                <FilePlus size={13} />
              </span>
              <Input
                ref={newFileInputRef}
                type="text"
                autoFocus
                className="h-6 min-w-0 flex-1 rounded-sm px-1.5 py-0.5 text-xs"
                value={newFileInput.value}
                placeholder="file name"
                onChange={(e) => onNewFileChange(e.target.value)}
                onKeyDown={onNewFileKeyDown}
                onBlur={onNewFileSubmit}
              />
            </div>
          )}
          {isExpanded &&
            childEntries.map((entry) => {
              const childPath = pathJoin(path, entry.name);
              return (
                <TreeNodeView
                  key={childPath}
                  name={entry.name}
                  path={childPath}
                  type={entry.type}
                  depth={depth + 1}
                  expanded={expanded}
                  selectedFile={selectedFile}
                  dragOverPath={dragOverPath}
                  newFolderInput={newFolderInput}
                  newFolderInputRef={newFolderInputRef}
                  onNewFolderChange={onNewFolderChange}
                  onNewFolderKeyDown={onNewFolderKeyDown}
                  onNewFolderSubmit={onNewFolderSubmit}
                  newFileInput={newFileInput}
                  newFileInputRef={newFileInputRef}
                  onNewFileChange={onNewFileChange}
                  onNewFileKeyDown={onNewFileKeyDown}
                  onNewFileSubmit={onNewFileSubmit}
                  renameInput={renameInput}
                  renameInputRef={renameInputRef}
                  onRenameChange={onRenameChange}
                  onRenameKeyDown={onRenameKeyDown}
                  onRenameSubmit={onRenameSubmit}
                  onToggle={onToggle}
                  onFileSelect={onFileSelect}
                  onFocusItem={onFocusItem}
                  onNewFolder={onNewFolder}
                  onNewFile={onNewFile}
                  onRename={onRename}
                  onDelete={onDelete}
                  onDuplicate={onDuplicate}
                  onReveal={onReveal}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDragOver={onNodeDragOver}
                  onNodeDragLeave={onNodeDragLeave}
                  onNodeDrop={onNodeDrop}
                  onContextMenuCloseAutoFocus={onContextMenuCloseAutoFocus}
                  onAddToChat={onAddToChat}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}

const ICON_SIZE = 13;

export function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["doc", "docx"].includes(ext))
    return (
      <span data-testid="icon-word">
        <FileDoc size={ICON_SIZE} />
      </span>
    );
  if (["xls", "xlsx"].includes(ext))
    return (
      <span data-testid="icon-excel">
        <FileXls size={ICON_SIZE} />
      </span>
    );
  if (["ppt", "pptx"].includes(ext))
    return (
      <span data-testid="icon-powerpoint">
        <FilePpt size={ICON_SIZE} />
      </span>
    );
  if (["pdf"].includes(ext))
    return (
      <span data-testid="icon-pdf">
        <FilePdf size={ICON_SIZE} />
      </span>
    );
  if (["csv"].includes(ext))
    return (
      <span data-testid="icon-csv">
        <FileCsv size={ICON_SIZE} />
      </span>
    );
  if (["md", "markdown", "mdx"].includes(ext))
    return (
      <span data-testid="icon-markdown">
        <CreateModeIcon size={ICON_SIZE} />
      </span>
    );
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext))
    return (
      <span data-testid="icon-image">
        <Image size={ICON_SIZE} />
      </span>
    );
  if (["json", "yaml", "yml", "toml", "js", "ts", "tsx", "jsx", "css", "html"].includes(ext))
    return (
      <span data-testid="icon-code">
        <FileCode size={ICON_SIZE} />
      </span>
    );
  return (
    <span data-testid="icon-generic">
      <File size={ICON_SIZE} />
    </span>
  );
}
