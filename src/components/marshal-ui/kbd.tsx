import * as React from "react";

import { cn } from "@/lib/marshal-class-names";

const KBD_CLASSES =
  "inline-flex items-center justify-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-muted-foreground";

function splitShortcutKeys(shortcut: string): string[] {
  const trimmed = shortcut.trim();
  if (!trimmed) return [];

  if (trimmed.includes("+")) {
    const parts = trimmed.split("+");
    if (parts.at(-1) === "") {
      return [...parts.slice(0, -1).filter(Boolean), "+"];
    }
    return parts.filter(Boolean);
  }

  const leadingModifier = trimmed.match(/^([⌘⌥⇧⌃])(.+)$/);
  if (leadingModifier) {
    return [leadingModifier[1], leadingModifier[2]];
  }

  return [trimmed];
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn(KBD_CLASSES, className)} {...props} />;
}

function KbdGroup({ className, role = "img", ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      role={role}
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

function renderShortcutKeys(shortcut: string): React.ReactNode[] {
  const keyCounts = new Map<string, number>();
  return splitShortcutKeys(shortcut).map((key) => {
    const keyCount = keyCounts.get(key) ?? 0;
    keyCounts.set(key, keyCount + 1);
    return <Kbd key={`${key}-${keyCount}`}>{key}</Kbd>;
  });
}

// eslint-disable-next-line react/only-export-components -- shortcut helpers are the public contract for this primitive.
export { Kbd, KbdGroup, renderShortcutKeys, splitShortcutKeys };
