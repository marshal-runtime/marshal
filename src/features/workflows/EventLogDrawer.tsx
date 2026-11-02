// src/features/workflows/EventLogDrawer.tsx
//
// Collapsible bottom drawer showing raw events as they arrive. Useful for
// debugging — every renderer (default + custom) gets the same drawer.

import type { WorkflowEvent } from "@common/workflows-contract";
import { ChevronDown, ChevronUp } from "@/components/icons";
import { useMemo, useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface EventLogDrawerProps {
  events: ReadonlyArray<WorkflowEvent>;
}

interface FormattedRow {
  key: string;
  time: string;
  type: string;
  payload: string;
}

function formatRows(events: ReadonlyArray<WorkflowEvent>): FormattedRow[] {
  return events.map((evt, idx) => {
    const d = new Date(evt.ts);
    // Pure HH:MM:SS — avoids `toLocaleTimeString` (locale read = impure).
    const pad = (n: number) => n.toString().padStart(2, "0");
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const payload =
      evt.payload && Object.keys(evt.payload).length > 0 ? JSON.stringify(evt.payload) : "";
    return {
      key: `${evt.seq}-${idx}`,
      time,
      type: evt.type,
      payload,
    };
  });
}

export function EventLogDrawer({ events }: EventLogDrawerProps) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => (open ? formatRows(events) : []), [open, events]);
  return (
    <div className="shrink-0 border-t border-border bg-background" aria-live="polite">
      <Button
        variant="ghost"
        size="sm"
        className="flex w-full justify-between rounded-none px-4 py-2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-xs tracking-wide text-muted-foreground uppercase">
          Event log ({events.length})
        </span>
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </Button>
      {open && (
        <ScrollArea className="h-48 border-t border-border">
          <ol className="flex flex-col font-mono text-xs">
            {rows.length === 0 && (
              <li className="px-4 py-3 text-muted-foreground">No events yet.</li>
            )}
            {rows.map((row) => (
              <li
                key={row.key}
                className="grid grid-cols-[80px_1fr] gap-2 px-4 py-1 hover:bg-muted"
              >
                <span className="text-muted-foreground">{row.time}</span>
                <span className="truncate">
                  <span className="font-semibold">{row.type}</span>
                  {row.payload && <span className="ml-2 text-muted-foreground">{row.payload}</span>}
                </span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  );
}
