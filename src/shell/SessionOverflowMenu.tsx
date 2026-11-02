import { Ellipsis, ExternalLink, PenLine, Trash2 } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SessionOverflowMenuProps {
  onRename: () => void;
  onDelete: () => void;
  onOpenInNewWindow?: () => void;
  onOpenChange?: (open: boolean) => void;
}

export function SessionOverflowMenu({
  onRename,
  onDelete,
  onOpenInNewWindow,
  onOpenChange,
}: SessionOverflowMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className="w-0 shrink-0 overflow-hidden rounded-full p-0 text-xs text-muted-foreground opacity-0 group-focus-within:w-auto group-focus-within:p-1 group-focus-within:opacity-100 group-hover:w-auto group-hover:p-1 group-hover:opacity-100 hover:bg-muted"
          aria-label="More actions"
          onClick={(e) => e.stopPropagation()}
        >
          <Ellipsis size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="right"
        // Radix portals the menu to <body>, but React synthetic click events
        // still bubble through the JSX parent tree to the chat row's onClick,
        // which would switch the active session in the main window. Stopping
        // propagation here keeps menu actions (Rename, Open in New Window,
        // Delete) from moving the main window's session pointer.
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem onSelect={onRename}>
          <PenLine size={14} /> Rename
        </DropdownMenuItem>
        {onOpenInNewWindow && (
          <DropdownMenuItem onSelect={onOpenInNewWindow}>
            <ExternalLink size={14} /> Open in New Window
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 size={14} /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
