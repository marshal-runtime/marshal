import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import { useState, type DragEvent, type RefObject } from "react";

import { ExternalLink } from "@/components/icons";
import { cn } from "@/lib/marshal-class-names";

/** What a dock drag is carrying: one tab, or a whole group (its tab-strip background). */
export type DockDragSubject =
  | { readonly kind: "panel"; readonly panelId: string }
  | { readonly kind: "group"; readonly group: DockviewGroupPanel };

const FLOAT_SIZE = { width: 520, height: 380 };

/** Floats the dragged tab or group as a window whose title bar sits under the pointer. */
function floatAtPoint(
  api: DockviewApi,
  subject: DockDragSubject,
  root: HTMLElement,
  point: { readonly clientX: number; readonly clientY: number },
): void {
  const bounds = root.getBoundingClientRect();
  const width = Math.min(FLOAT_SIZE.width, bounds.width - 16);
  const height = Math.min(FLOAT_SIZE.height, bounds.height - 16);
  const x = Math.min(
    Math.max(point.clientX - bounds.left - width / 2, 8),
    bounds.width - width - 8,
  );
  const y = Math.min(Math.max(point.clientY - bounds.top - 8, 8), bounds.height - height - 8);
  const item = subject.kind === "panel" ? api.getPanel(subject.panelId) : subject.group;
  if (!item) return;
  api.addFloatingGroup(item, { x, y, width, height });
  if (subject.kind === "panel") api.getPanel(subject.panelId)?.api.setActive();
}

/**
 * Shown while a tab is dragged: dropping on it floats the tab. Dockview only
 * floats on shift+drag, which nobody discovers, and every other spot in the
 * dock is a docking target.
 */
export function DockFloatDropZone({
  api,
  subject,
  rootRef,
}: {
  readonly api: DockviewApi;
  readonly subject: RefObject<DockDragSubject | null>;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}) {
  const [over, setOver] = useState(false);
  const accept = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const dragged = subject.current;
    if (dragged && rootRef.current) floatAtPoint(api, dragged, rootRef.current, event);
  };
  return (
    <div
      className={cn(
        "absolute top-3 left-1/2 z-10001 flex h-10 -translate-x-1/2 items-center gap-2 rounded-full border-2 border-dashed px-4 text-xs font-medium shadow-lg transition-colors",
        over
          ? "border-(--brand-action) bg-(--brand-action) text-(--brand-action-fg)"
          : "border-(--brand-stroke) bg-(--brand-subtle) text-(--brand-badge-text)",
      )}
      data-testid="session-dock-float-zone"
      data-over={over || undefined}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setOver(false);
      }}
      onDrop={drop}
    >
      <ExternalLink className="pointer-events-none size-3.5" />
      Drop here to float
    </div>
  );
}
