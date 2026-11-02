/**
 * Unified pill used to represent any "thing" attached to the chat: file
 * uploads, context entities (People / File / Event), and inline chips
 * inside the Lexical editor.
 *
 * Two sizes:
 *   - "md" (default) — used above the chat input. h-11, rounded-2xl, neutral
 *     card chrome, optional remove button in the top-right corner.
 *   - "sm" — used inline inside the editor. h-6, rounded-lg, scaled for
 *     reading inline with text. No remove button (Lexical handles deletion).
 *
 * The image kind renders a square thumbnail instead of an icon + label so
 * file uploads with a `dataUrl` keep their preview behavior.
 */

import { X } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { type EntityPillKind, entityPillLabel } from "./entity-pill-kind";
import { EntityPillIcon } from "./entity-pill-visual";

interface EntityPillProps {
  kind: EntityPillKind;
  size?: "sm" | "md";
  onRemove?: () => void;
  /** Used for the remove button's accessible name. Defaults to the label. */
  ariaLabel?: string;
  className?: string;
}

export function EntityPill({ kind, size = "md", onRemove, ariaLabel, className }: EntityPillProps) {
  const label = entityPillLabel(kind);
  const removeLabel = ariaLabel ?? `Remove ${label}`;
  const removeButton =
    size === "md" && onRemove ? (
      <PillRemoveButton onClick={onRemove} ariaLabel={removeLabel} />
    ) : null;

  // Image kind: square thumbnail (matches uploaded-file preview behavior).
  if (kind.type === "image") {
    return (
      <div className={cn("relative shrink-0", className)} data-testid="file-preview">
        <img
          src={kind.dataUrl}
          alt={label}
          className={cn("rounded-2xl object-cover", size === "md" ? "size-11" : "size-6")}
          data-testid="file-preview-img"
        />
        {removeButton}
      </div>
    );
  }

  const sizeClasses =
    size === "md"
      ? "h-11 max-w-[200px] gap-1.5 rounded-2xl px-3 text-sm"
      : "h-6 max-w-[180px] gap-1 rounded-lg px-1.5 text-xs";

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center border border-border bg-card",
        sizeClasses,
        className,
      )}
      data-testid="file-preview"
      data-entity-pill-kind={kind.type}
    >
      <EntityPillIcon kind={kind} size={size} />
      <span className="truncate">{label}</span>
      {removeButton}
    </div>
  );
}

function PillRemoveButton({ onClick, ariaLabel }: { onClick: () => void; ariaLabel: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="absolute -top-1.5 -right-1.5 size-5 rounded-full border border-border bg-background p-0 shadow-sm"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <X size={10} />
    </Button>
  );
}
