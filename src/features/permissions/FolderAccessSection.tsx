import { ChevronRight, Lock, X } from "@/components/icons";
import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import { cn } from "@/lib/marshal-class-names";
import type { PermissionsConfig } from "@/types/electron";

interface FolderAccessSectionProps {
  permissions: PermissionsConfig;
  onUpdate: (permissions: PermissionsConfig) => void;
  disabled?: boolean;
}

type Scope = "read" | "write";

const SCOPE_FIELD: Record<Scope, "allowedReadFolders" | "allowedWriteFolders"> = {
  read: "allowedReadFolders",
  write: "allowedWriteFolders",
};

export function FolderAccessSection({ permissions, onUpdate, disabled }: FolderAccessSectionProps) {
  const [open, setOpen] = useState(false);

  const remove = (scope: Scope, folder: string) => {
    if (disabled) return;
    const field = SCOPE_FIELD[scope];
    const next = (permissions[field] ?? []).filter((f) => f !== folder);
    onUpdate({ ...permissions, [field]: next });
  };

  const renderGroup = (scope: Scope, title: string, folders: string[]) => (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {folders.length === 0 ? (
        <span className="block text-xs text-muted-foreground/70">No folders granted.</span>
      ) : (
        folders.map((folder) => (
          <div
            key={folder}
            className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5"
          >
            <span
              className="block w-full min-w-0 flex-1 truncate text-left font-mono text-xs"
              title={folder}
            >
              {folder}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 shrink-0"
              aria-label={`Remove ${scope} access to ${folder}`}
              onClick={() => remove(scope, folder)}
              disabled={disabled}
            >
              <X size={12} />
            </Button>
          </div>
        ))
      )}
    </div>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn(disabled && "opacity-50")}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label="Folder access"
          className="flex w-full cursor-pointer items-center gap-2 py-1"
        >
          <ChevronRight
            size={14}
            className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")}
          />
          <span className="text-sm font-normal text-muted-foreground">Folder access</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-6 space-y-3 pb-1">
          <span className="block text-xs text-muted-foreground/70">
            Folders outside your workspace you&apos;ve granted access to. Reads and writes are
            separate.
          </span>
          {disabled && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Lock size={12} />
              <span>Locked by organization policy</span>
            </div>
          )}
          {renderGroup("read", "Read access", permissions.allowedReadFolders ?? [])}
          {renderGroup("write", "Write access", permissions.allowedWriteFolders ?? [])}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
