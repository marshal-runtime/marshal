import { use, useEffect, useRef, useState, type ReactNode } from "react";

import { useElementSize, useResizablePanel } from "@/shared/hooks/useResizablePanel";

import { RuntimeUiContext } from "./runtimeUiContext";
import { RuntimeUiInstanceFrame } from "./RuntimeUiHost";

const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 300;
// Chat keeps at least this much room above the panel.
const RESERVED_CHAT_HEIGHT = 200;

/**
 * Wraps a chat column and docks `bottom-panel` runtime applications (a
 * terminal, a log viewer) underneath it, resizable by dragging the divider.
 */
export function RuntimeUiBottomPanelLayout({ children }: { readonly children: ReactNode }) {
  const model = use(RuntimeUiContext);
  const instances = model?.bySurface["bottom-panel"] ?? [];
  const containerRef = useRef<HTMLDivElement>(null);
  const containerSize = useElementSize(containerRef);
  const maxHeight = Math.max(MIN_HEIGHT, containerSize.height - RESERVED_CHAT_HEIGHT);
  const panel = useResizablePanel({
    storageKey: "marshal.runtimeUi.bottomPanelHeight",
    axis: "vertical",
    defaultSize: DEFAULT_HEIGHT,
    minSize: MIN_HEIGHT,
    maxSize: maxHeight,
    expandedSize: maxHeight,
    growDirection: "negative",
  });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return undefined;
    const stop = () => setDragging(false);
    document.addEventListener("mouseup", stop);
    return () => document.removeEventListener("mouseup", stop);
  }, [dragging]);

  return (
    <div ref={containerRef} className="flex size-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {instances.length > 0 && (
        <section
          className="relative flex shrink-0 flex-col border-t border-border bg-card"
          style={{ height: panel.size }}
          aria-label="Runtime bottom panel"
          data-testid="runtime-ui-bottom-panel"
        >
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize bottom panel"
            aria-valuemin={panel.minSize}
            aria-valuemax={panel.maxSize}
            aria-valuenow={Math.round(panel.size)}
            tabIndex={0}
            className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize focus-visible:bg-ring/40"
            onMouseDown={(event) => {
              setDragging(true);
              panel.handleMouseDown(event);
            }}
            onKeyDown={panel.handleKeyDown}
            data-testid="runtime-ui-bottom-panel-resize"
          />
          <RuntimeUiInstanceFrame instances={instances} className="min-h-0 flex-1" />
          {dragging && <div className="absolute inset-0 z-20 cursor-row-resize" />}
        </section>
      )}
    </div>
  );
}
