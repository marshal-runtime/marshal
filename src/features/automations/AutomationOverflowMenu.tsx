import { Rocket, ClipboardList, Download, Trash2, Loader, Ellipsis } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface AutomationOverflowMenuProps {
  running: boolean;
  /** When false, the Export action is hidden (gated on backend capability). */
  canExport?: boolean;
  onRunNow: () => void;
  onHistory: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export function AutomationOverflowMenu({
  running,
  canExport = true,
  onRunNow,
  onHistory,
  onExport,
  onDelete,
}: AutomationOverflowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <Ellipsis size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={running} onSelect={onRunNow}>
          {running ? <Loader size={14} /> : <Rocket size={14} />} Run now
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onHistory}>
          <ClipboardList size={14} /> History
        </DropdownMenuItem>
        {canExport && (
          <DropdownMenuItem onSelect={onExport}>
            <Download size={14} /> Export
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
