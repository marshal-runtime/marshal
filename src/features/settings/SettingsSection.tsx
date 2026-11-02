import { useId, type ReactNode } from "react";

import { cn } from "@/lib/marshal-class-names";

interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  id?: string;
  /** Optional control rendered on the right of the section header. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A Settings card: a header with title and description, then a divided list of rows. */
export function SettingsSection({
  title,
  description,
  id,
  action,
  className,
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-slot="settings-section"
      className={cn(
        "scroll-mt-16 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 pt-4 pb-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={headingId} className="text-sm font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </h3>
          {description ? (
            <p className="max-w-xl text-xs/5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="-mb-px flex flex-col px-5">{children}</div>
    </section>
  );
}

/** Free-form content inside a SettingsSection that is not a label/control row. */
export function SettingsBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3 border-b border-border/60 py-4", className)}>
      {children}
    </div>
  );
}

/** A muted footnote inside a SettingsSection. */
export function SettingsNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-b border-border/60 py-3 text-xs/5 text-muted-foreground">{children}</p>
  );
}
