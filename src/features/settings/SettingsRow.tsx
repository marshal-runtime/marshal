import type { ReactNode } from "react";

import { Label } from "@/components/marshal-ui/label";
import { cn } from "@/lib/marshal-class-names";

interface SettingsRowProps {
  /** Plain string — rendered inside a <Label> when htmlFor is set, so must be valid label content. */
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}

/**
 * One setting inside a SettingsSection card: label and description on the left,
 * the control on the right. Rows carry their own bottom hairline; the card clips
 * the last one so stacked rows read as a single divided list.
 */
export function SettingsRow({
  label,
  description,
  children,
  className,
  htmlFor,
}: SettingsRowProps) {
  // Wrap only the label text in <Label htmlFor> when one is given so
  // getByLabelText resolves to just the row's primary label, not the
  // description sentence below it.
  return (
    <div
      data-slot="settings-control-tile"
      className={cn(
        "grid gap-x-6 gap-y-2.5 border-b border-border/60 py-3.5",
        "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {htmlFor ? (
          <Label
            htmlFor={htmlFor}
            className="cursor-pointer text-[13px] font-medium tracking-[-0.01em] text-foreground"
          >
            {label}
          </Label>
        ) : (
          <span className="text-[13px] font-medium tracking-[-0.01em] text-foreground">
            {label}
          </span>
        )}
        {description ? (
          <span className="max-w-xl text-xs/5 text-muted-foreground">{description}</span>
        ) : null}
      </div>
      <div
        data-slot="settings-control-action"
        className="flex min-w-0 items-center justify-start sm:justify-end"
      >
        {children}
      </div>
    </div>
  );
}
