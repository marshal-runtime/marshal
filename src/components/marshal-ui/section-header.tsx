import type { ReactNode } from "react";

import { cn } from "@/lib/marshal-class-names";

const SECTION_TITLE_CLASSES =
  "text-xs font-semibold tracking-[0.96px] text-warning-primary uppercase";
const SECTION_WRAPPER_CLASSES = "flex flex-col gap-2 pt-2";

interface SectionHeaderProps {
  children: ReactNode;
  className?: string;
  /**
   * Render the Figma "Settings title" pattern: 8px top padding, 8px gap,
   * and a 1px divider beneath the title. Pass `divider={false}` when
   * the section content sits on its own background (Figma divider exception)
   * or for non-Settings panels that don't follow the spec.
   */
  divider?: boolean;
}

export function SectionHeader({ children, className, divider = true }: SectionHeaderProps) {
  if (!divider) {
    return <h3 className={cn(SECTION_TITLE_CLASSES, className)}>{children}</h3>;
  }
  return (
    <div className={cn(SECTION_WRAPPER_CLASSES, className)}>
      <h3 className="text-xs leading-[1.4] font-semibold tracking-[0.96px] text-warning-primary uppercase">
        {children}
      </h3>
      <div
        aria-hidden="true"
        data-testid="section-header-divider"
        className="h-px w-full bg-border/50"
      />
    </div>
  );
}
