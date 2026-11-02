import { useState, type ReactNode } from "react";

import { CheckCircle2, ChevronRight } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";
import { MarkdownRenderer } from "@/plugins/streamdown-config";
import { useTimeout } from "@/runtime-ui/hooks/use-timeout";

export interface MessageReasoning {
  text: string;
  durationSeconds: number | null;
}

interface CollapsibleSectionProps {
  label: ReactNode;
  testId?: string;
  toggleTestId?: string;
  /** Controlled open state — if provided, onToggle must also be provided */
  open?: boolean;
  onToggle?: () => void;
  defaultOpen?: boolean;
  disabled?: boolean;
  /** Show green checkmark instead of chevron (for completed/committed sections) */
  completed?: boolean;
  /** Auto-collapse after mounting open (ms). Only works in uncontrolled mode. */
  autoCollapseMs?: number;
  children?: ReactNode;
}

/** Shared collapsible chevron + animated body used by all indicator components. */
export function CollapsibleSection({
  label,
  testId,
  toggleTestId,
  open: controlledOpen,
  onToggle,
  defaultOpen = false,
  disabled,
  completed,
  autoCollapseMs,
  children,
}: CollapsibleSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [userToggled, setUserToggled] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const toggle = isControlled
    ? onToggle!
    : () => {
        setUserToggled(true);
        setInternalOpen((o) => !o);
      };

  useTimeout(
    () => setInternalOpen(false),
    !isControlled && autoCollapseMs && !userToggled ? autoCollapseMs : null,
  );

  return (
    <div data-testid={testId}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={disabled ? undefined : toggle}
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          "h-auto gap-2 p-1 text-sm leading-[1.4] text-foreground-secondary hover:text-foreground disabled:opacity-50",
          completed ? "font-semibold" : "font-normal",
        )}
        data-testid={toggleTestId}
      >
        {completed ? (
          <CheckCircle2 size={18} className="shrink-0 text-foreground" aria-hidden />
        ) : (
          <ChevronRight
            size={18}
            className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            data-open={open}
            aria-hidden
          />
        )}
        <span>{label}</span>
      </Button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden pl-7">{children}</div>
      </div>
    </div>
  );
}

export function CommittedReasoning({ reasoning }: { reasoning: MessageReasoning }) {
  const label =
    reasoning.durationSeconds !== null
      ? `Thought for ${reasoning.durationSeconds}s`
      : "Thought process";
  return (
    <CollapsibleSection
      label={label}
      testId="committed-reasoning"
      toggleTestId="committed-reasoning-toggle"
      completed
    >
      <div
        className="max-h-40 overflow-y-auto text-sm text-muted-foreground"
        data-testid="committed-reasoning-content"
      >
        <MarkdownRenderer>{reasoning.text}</MarkdownRenderer>
      </div>
    </CollapsibleSection>
  );
}
