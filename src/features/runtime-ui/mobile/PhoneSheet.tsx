import type { RuntimeUiInstance } from "@common/runtime-ui";
import { runtimeUiInstanceTitle } from "@common/runtime-ui-layout";
import { useState } from "react";

import { ChevronDown, ChevronUp } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/marshal-class-names";

import { useExpandedView } from "../expanded/expandedView";
import { ExpandedPlaceholder, ExpandViewButton } from "../expanded/ExpandViewButton";
import { RuntimeUiViewBody } from "../RuntimeUiViewBody";
import { PhoneMoveMenu } from "./PhoneMoveMenu";
import { useLongPress } from "./useLongPress";
import { useSheetDetents } from "./useSheetDetents";

function newestFocus(views: readonly RuntimeUiInstance[]): RuntimeUiInstance | undefined {
  return views.reduce<RuntimeUiInstance | undefined>(
    (newest, view) => (!newest || view.focusedAt > newest.focusedAt ? view : newest),
    undefined,
  );
}

/**
 * Bottom-dock views on the phone: an iOS sheet under the chat. It starts as a
 * strip so the conversation keeps the screen; drag the grabber between strip,
 * half and nearly full height, or tap a tab to open it.
 */
export function PhoneSheet({ views }: { readonly views: readonly RuntimeUiInstance[] }) {
  const sheet = useSheetDetents();
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = views.find((view) => view.instanceId === activeId) ?? newestFocus(views);
  const open = sheet.detent !== "strip" || sheet.dragging;
  const expanded = useExpandedView()?.expandedId === active?.instanceId;
  return (
    <section
      className={cn(
        "flex shrink-0 flex-col rounded-t-2xl border-t border-border bg-card shadow-[0_-8px_24px_rgb(0_0_0/0.08)]",
        !sheet.dragging && "transition-[height] duration-300 ease-out",
      )}
      style={sheet.style}
      aria-label="Bottom sheet"
      data-phone-sheet=""
      data-testid="mobile-bottom-sheet"
      data-expanded={open ? "true" : "false"}
      data-detent={sheet.detent}
    >
      <div className="shrink-0" data-phone-sheet-strip="">
        <div
          className="flex h-5 w-full touch-none items-center justify-center"
          aria-hidden
          data-testid="mobile-bottom-sheet-grabber"
          {...sheet.grabber}
        >
          <span className="h-1.25 w-9 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="flex h-11 items-center gap-1 overflow-x-auto px-2 pb-1">
          {views.map((view) => (
            <SheetTab
              key={view.instanceId}
              view={view}
              selected={active?.instanceId === view.instanceId}
              onSelect={() => {
                setActiveId(view.instanceId);
                if (sheet.detent === "strip") sheet.setDetent("half");
              }}
            />
          ))}
          <span className="ml-auto" />
          {active && (
            <ExpandViewButton
              instance={active}
              title={runtimeUiInstanceTitle(active)}
              className="size-9 shrink-0"
            />
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-9 shrink-0"
            aria-label={open ? "Collapse sheet" : "Expand sheet"}
            data-testid="mobile-bottom-sheet-toggle"
            onClick={() => sheet.setDetent(open ? "strip" : "half")}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </Button>
        </div>
      </div>
      {open && active && (
        <div
          data-phone-sheet-body=""
          className="flex min-h-0 flex-1 flex-col border-t border-border"
        >
          {expanded ? <ExpandedPlaceholder /> : <RuntimeUiViewBody instance={active} fill />}
        </div>
      )}
    </section>
  );
}

function SheetTab({
  view,
  selected,
  onSelect,
}: {
  readonly view: RuntimeUiInstance;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useLongPress(() => setMenuOpen(true), onSelect);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={selected ? "secondary" : "ghost"}
          className="h-9 max-w-44 shrink-0 touch-pan-x rounded-full select-none"
          data-testid="mobile-sheet-tab"
          {...press}
        >
          <span className="truncate">{runtimeUiInstanceTitle(view)}</span>
        </Button>
      </DropdownMenuTrigger>
      <PhoneMoveMenu view={view} />
    </DropdownMenu>
  );
}
