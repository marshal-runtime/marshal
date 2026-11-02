import { DEFAULT_WORKSPACE_KEY, workspaceDisplayName } from "@common/workspace-display";
import { useState } from "react";

import { Check, ChevronDown, Folder, Link2Off, Pencil, Plus, Trash2 } from "@/components/icons";
import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/marshal-ui/marshal-popover";
import { Separator } from "@/components/marshal-ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/marshal-class-names";
import {
  TelemetryPath_Workspace,
  InteractiveElementMonitor_Create,
  InteractiveElementMonitor_Rename,
  InteractiveElementMonitor_Delete,
} from "@/services/telemetry/schema";
import { getDefaultChatWorkspace, setDefaultChatWorkspace } from "@/shared/default-workspace";

import { useWorkspaces } from "./hooks/useCreateWorkspaceData";

interface WorkspaceSwitcherProps {
  activeWorkspace: string;
  onSwitch: (name: string) => void;
}

export function WorkspaceSwitcher({ activeWorkspace, onSwitch }: WorkspaceSwitcherProps) {
  const [defaultChatWorkspace, setDefaultChatWorkspaceState] = useState(
    () => getDefaultChatWorkspace() ?? "",
  );
  const [isOpen, setIsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [selectedFolderToken, setSelectedFolderToken] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    name: string;
    files: number;
    folders: number;
    isExternal: boolean;
  } | null>(null);
  const { workspaces, externalWorkspaces, invalidate: invalidateWorkspaces } = useWorkspaces();

  const resetInputState = () => {
    setCreating(false);
    setSelectingFolder(false);
    setRenaming(null);
    setError(null);
    setSelectedFolderPath(null);
    setSelectedFolderToken(null);
  };

  const isDuplicateName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return workspaces.some((w) => w.toLowerCase() === trimmed.toLowerCase());
  };

  const handleCreate = async () => {
    const name = inputValue.trim();
    if (!name) return;
    if (isDuplicateName(name)) {
      setError("A workspace with that name already exists");
      return;
    }
    const result = await window.workspaceAPI?.createWorkspace(name);
    if (result?.success) {
      resetInputState();
      setInputValue("");
      invalidateWorkspaces();
      onSwitch(name);
      setIsOpen(false);
    } else {
      setError(result?.error || "Failed to create workspace");
    }
  };

  const handleSelectFolderClick = async () => {
    const result = await window.workspaceAPI?.pickFolder();
    if (result?.success && result.folderPath && result.folderToken) {
      setSelectedFolderPath(result.folderPath);
      setSelectedFolderToken(result.folderToken);
      setSelectingFolder(true);
      // Pre-fill name from folder basename
      const basename = result.folderPath.split(/[\\/]/).pop() || "";
      setInputValue(basename);
      setError(isDuplicateName(basename) ? "A workspace with that name already exists" : null);
    } else if (result?.success) {
      setError("Folder selection did not return a workspace path token");
    } else if (result?.error !== "Folder selection cancelled") {
      setError(result?.error || "Failed to select folder");
    }
  };

  const handleCreateFromFolder = async () => {
    const name = inputValue.trim();
    if (!name || !selectedFolderToken) return;
    if (isDuplicateName(name)) {
      setError("A workspace with that name already exists");
      return;
    }
    const result = await window.workspaceAPI?.createWorkspace(name, selectedFolderToken);
    if (result?.success) {
      resetInputState();
      setInputValue("");
      invalidateWorkspaces();
      onSwitch(name);
      setIsOpen(false);
    } else {
      setError(result?.error || "Failed to create workspace");
      setSelectedFolderPath(null);
      setSelectedFolderToken(null);
      setSelectingFolder(false);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const newName = inputValue.trim();
    if (!newName || newName === renaming) {
      setRenaming(null);
      return;
    }
    const result = await window.workspaceAPI?.renameWorkspace(renaming, newName);
    if (result?.success) {
      resetInputState();
      setInputValue("");
      invalidateWorkspaces();
      if (activeWorkspace === renaming) onSwitch(newName);
    } else {
      setError(result?.error || "Failed to rename workspace");
    }
  };

  const handleDeleteClick = async (name: string) => {
    const isExternal = externalWorkspaces.has(name);
    if (isExternal) {
      // No need to count files for external — we're just unlinking
      setDeleteConfirm({ name, files: 0, folders: 0, isExternal: true });
      return;
    }
    const result = await window.workspaceAPI?.getWorkspaceContents(name);
    if (result?.success) {
      setDeleteConfirm({
        name,
        files: result.fileCount ?? 0,
        folders: result.folderCount ?? 0,
        isExternal: false,
      });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;
    const result = await window.workspaceAPI?.deleteWorkspace(deleteConfirm.name);
    if (result?.success) {
      setDeleteConfirm(null);
      invalidateWorkspaces();
      if (activeWorkspace === deleteConfirm.name) onSwitch(DEFAULT_WORKSPACE_KEY);
      setIsOpen(false);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      action();
    }
    if (e.key === "Escape") {
      resetInputState();
    }
  };

  return (
    <TelemetryPath_Workspace>
      <div className="px-2 py-1">
        <Popover
          open={isOpen}
          onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) resetInputState();
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="group/btn h-auto w-full justify-start gap-2 bg-muted px-2.5 py-2 text-left hover:bg-accent has-[>svg]:px-2.5"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-[9px] leading-none font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Workspace
                </span>
                <span className="truncate text-[13px] leading-tight font-semibold text-foreground">
                  {workspaceDisplayName(activeWorkspace)}
                </span>
              </div>
              <ChevronDown
                size={14}
                className={cn(
                  "shrink-0 text-muted-foreground transition-[transform,color] duration-150 group-hover/btn:text-foreground-secondary",
                  isOpen && "rotate-180",
                )}
              />
            </Button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={4}
            className="max-h-[300px] w-(--radix-popover-trigger-width) gap-0 overflow-y-auto p-0"
          >
            {workspaces.map((name) => (
              <div
                key={name}
                className="group flex items-center px-0.5 transition-colors duration-100 hover:bg-accent"
              >
                {renaming === name ? (
                  <Input
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    className="h-auto border-primary bg-background px-2 py-1.5 text-[13px]"
                    value={inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => handleInputKeyDown(e, handleRename)}
                    onBlur={handleRename}
                  />
                ) : (
                  <>
                    <button
                      className={cn(
                        "flex-1 cursor-pointer truncate border-none bg-transparent px-2.5 py-2 text-left text-[13px] text-foreground",
                        name === activeWorkspace && "font-semibold text-primary",
                      )}
                      onClick={() => {
                        onSwitch(name);
                        setIsOpen(false);
                      }}
                    >
                      {workspaceDisplayName(name)}
                    </button>
                    <button
                      className={cn(
                        "flex size-[26px] cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent transition-[background,color] duration-100 hover:bg-muted hover:text-foreground",
                        defaultChatWorkspace === name
                          ? "text-brand-action"
                          : "text-muted-foreground opacity-0 group-hover:opacity-100",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = defaultChatWorkspace === name ? "" : name;
                        setDefaultChatWorkspace(next || undefined);
                        setDefaultChatWorkspaceState(next);
                      }}
                      aria-label={
                        defaultChatWorkspace === name
                          ? `Clear ${workspaceDisplayName(name)} as default chat workspace`
                          : `Set ${workspaceDisplayName(name)} as default chat workspace`
                      }
                      title={
                        defaultChatWorkspace === name
                          ? "Default workspace for new chats"
                          : "Use for new chats"
                      }
                    >
                      <Check
                        size={12}
                        className={defaultChatWorkspace === name ? "opacity-100" : "opacity-40"}
                      />
                    </button>
                    {name !== DEFAULT_WORKSPACE_KEY && (
                      <div className="flex gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
                        <InteractiveElementMonitor_Rename
                          callback={() => {
                            setRenaming(name);
                            setInputValue(name);
                            setError(null);
                          }}
                        >
                          {(cb) => (
                            <button
                              className="flex size-[26px] cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent text-muted-foreground transition-[background,color] duration-100 hover:bg-muted hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                cb();
                              }}
                              title="Rename"
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </InteractiveElementMonitor_Rename>
                        <InteractiveElementMonitor_Delete callback={() => handleDeleteClick(name)}>
                          {(cb) => (
                            <button
                              className={cn(
                                "flex size-[26px] cursor-pointer items-center justify-center rounded-[5px] border-none bg-transparent text-muted-foreground transition-[background,color] duration-100 hover:bg-muted",
                                externalWorkspaces.has(name)
                                  ? "hover:text-foreground"
                                  : "hover:text-destructive",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                void cb();
                              }}
                              title={externalWorkspaces.has(name) ? "Unlink" : "Delete"}
                            >
                              {externalWorkspaces.has(name) ? (
                                <Link2Off size={12} />
                              ) : (
                                <Trash2 size={12} />
                              )}
                            </button>
                          )}
                        </InteractiveElementMonitor_Delete>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}

            <Separator />

            {selectingFolder ? (
              <div className="space-y-2 p-0.5">
                <div className="px-2 pt-1 text-[11px] text-muted-foreground">
                  {selectedFolderPath && `Selected: ${selectedFolderPath.split(/[\\/]/).pop()}`}
                </div>
                <Input
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  className="h-auto border-primary bg-background px-2 py-1.5 text-[13px]"
                  placeholder="Workspace name…"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    setError(
                      isDuplicateName(e.target.value)
                        ? "A workspace with that name already exists"
                        : null,
                    );
                  }}
                  onKeyDown={(e) => handleInputKeyDown(e, handleCreateFromFolder)}
                  onBlur={() => {
                    if (!inputValue.trim()) resetInputState();
                  }}
                />
              </div>
            ) : creating ? (
              <div className="p-0.5">
                <Input
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  className="h-auto border-primary bg-background px-2 py-1.5 text-[13px]"
                  placeholder="Workspace name…"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    setError(
                      isDuplicateName(e.target.value)
                        ? "A workspace with that name already exists"
                        : null,
                    );
                  }}
                  onKeyDown={(e) => handleInputKeyDown(e, handleCreate)}
                  onBlur={() => {
                    if (!inputValue.trim()) setCreating(false);
                  }}
                />
              </div>
            ) : (
              <div className="space-y-1 p-1">
                <InteractiveElementMonitor_Create
                  callback={() => {
                    setCreating(true);
                    setInputValue("");
                    setError(null);
                  }}
                >
                  {(cb) => (
                    <button
                      className="flex w-full cursor-pointer items-center gap-1.5 rounded-[4px] border-none bg-transparent px-2 py-1.5 text-[13px] text-muted-foreground transition-[background,color] duration-100 hover:bg-accent hover:text-foreground"
                      onClick={cb}
                    >
                      <Plus size={14} />
                      New Workspace
                    </button>
                  )}
                </InteractiveElementMonitor_Create>
                <button
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-[4px] border-none bg-transparent px-2 py-1.5 text-[13px] text-muted-foreground transition-[background,color] duration-100 hover:bg-accent hover:text-foreground"
                  onClick={handleSelectFolderClick}
                >
                  <Folder size={14} />
                  Select Existing Folder
                </button>
              </div>
            )}

            {error && <div className="px-2.5 pt-1 text-[11px] text-destructive">{error}</div>}
          </PopoverContent>
        </Popover>

        <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
          <DialogContent className="max-w-[340px]">
            <DialogHeader>
              <DialogTitle>
                {deleteConfirm?.isExternal ? (
                  <>
                    Unlink workspace <strong>{deleteConfirm?.name}</strong>?
                  </>
                ) : (
                  <>
                    Delete workspace <strong>{deleteConfirm?.name}</strong>?
                  </>
                )}
              </DialogTitle>
              <DialogDescription>
                {deleteConfirm?.isExternal
                  ? "This will remove the workspace from Marshal. Your files and folders will not be affected."
                  : deleteConfirm && (deleteConfirm.files > 0 || deleteConfirm.folders > 0)
                    ? `This will remove ${deleteConfirm.files} file${deleteConfirm.files !== 1 ? "s" : ""} and ${deleteConfirm.folders} folder${deleteConfirm.folders !== 1 ? "s" : ""}.`
                    : "This workspace is empty."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={deleteConfirm?.isExternal ? "default" : "destructive"}
                onClick={handleDeleteConfirm}
              >
                {deleteConfirm?.isExternal ? "Unlink" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TelemetryPath_Workspace>
  );
}
