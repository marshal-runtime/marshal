import { runtimeUiInstanceTitle } from "@common/runtime-ui-layout";
import { use, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { RuntimeUiContext } from "../runtimeUiContext";
import { RuntimeUiViewBody } from "../RuntimeUiViewBody";
import { ExpandedViewContext, type ExpandedViewControl } from "./expandedView";
import { useSwipeDown } from "./useSwipeDown";

// The phone app is pinned to the visible viewport (src/remote/viewport.ts), so
// the keyboard shrinks a full-screen view instead of covering it.
const PHONE_VISIBLE_AREA: CSSProperties = {
  top: "var(--remote-top, 0px)",
  left: "var(--remote-left, 0px)",
  width: "var(--remote-width, 100vw)",
  height: "var(--remote-height, 100dvh)",
};

/** Lets any card, sheet, or tab open its view full screen on this device. */
export function RuntimeUiExpandedViewProvider({ children }: { readonly children: ReactNode }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const control = useMemo<ExpandedViewControl>(
    () => ({ expandedId, expand: setExpandedId, collapse: () => setExpandedId(null) }),
    [expandedId],
  );
  return (
    <ExpandedViewContext value={control}>
      {children}
      <ExpandedViewOverlay control={control} />
    </ExpandedViewContext>
  );
}

function ExpandedViewOverlay({ control }: { readonly control: ExpandedViewControl }) {
  const model = use(RuntimeUiContext);
  const instance = model?.instances.find((view) => view.instanceId === control.expandedId);
  const { collapse } = control;
  const swipe = useSwipeDown(collapse);
  useEffect(() => {
    if (!instance) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapse, instance]);
  if (!instance) return null;
  const title = runtimeUiInstanceTitle(instance);
  const phone = Boolean(window.marshalRemote);
  // Portaled above the dock's floating windows and transient cards (z-1100).
  return createPortal(
    <div
      className={cn(
        "fixed z-1200 flex animate-in bg-background/70 text-foreground backdrop-blur-sm duration-200 fade-in-0",
        phone ? "p-0" : "inset-0 p-4",
      )}
      style={phone ? PHONE_VISIBLE_AREA : undefined}
      data-testid="runtime-ui-expanded"
      data-full-screen=""
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <section
        className={cn(
          "m-auto flex size-full animate-in flex-col overflow-hidden bg-card duration-300 ease-out slide-in-from-bottom-8",
          phone
            ? "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            : "max-h-[calc(100dvh-2rem)] max-w-6xl rounded-2xl border border-border shadow-2xl",
          !swipe.dragging && "transition-transform",
        )}
        style={swipe.offset ? { transform: `translateY(${swipe.offset}px)` } : undefined}
      >
        <header
          className="relative flex shrink-0 touch-none flex-col items-stretch border-b border-border select-none"
          data-testid="runtime-ui-expanded-header"
          {...swipe.handlers}
        >
          {phone && (
            <span
              aria-hidden
              className="mx-auto mt-2 h-1.25 w-9 rounded-full bg-muted-foreground/40"
            />
          )}
          <div className="flex min-h-12 items-center gap-2 px-2">
            <span className="w-16 shrink-0" />
            <h2 className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">
              {title}
            </h2>
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-16 shrink-0 text-[15px] font-semibold text-primary"
              data-testid="runtime-ui-expanded-done"
              onClick={collapse}
            >
              Done
            </Button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <RuntimeUiViewBody instance={instance} fill />
        </div>
      </section>
    </div>,
    document.body,
  );
}
