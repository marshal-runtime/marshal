import { Target } from "@/components/icons";

import type { SlashCommand } from "./slash-commands";

interface CommandResultRowProps {
  command: SlashCommand;
}

/**
 * Content-only row for a built-in slash command. The wrapping cmdk
 * `CommandItem` (in `ContextPickerMenu`) owns the row's id, role, selection
 * state, click handler, and hover styling.
 */
export function CommandResultRow({ command }: CommandResultRowProps) {
  return (
    <div className="flex w-full items-center gap-2.5">
      <Target size={16} className="shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">/{command.name}</span>
          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px]">Command</span>
        </div>
        <span className="truncate text-xs text-muted-foreground">{command.description}</span>
      </div>
    </div>
  );
}
