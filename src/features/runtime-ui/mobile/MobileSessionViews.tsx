import type { RuntimeUiInstance, RuntimeUiSurface } from "@common/runtime-ui";
import { runtimeUiInstanceTitle } from "@common/runtime-ui-layout";
import { use, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/marshal-class-names";

import { RuntimeUiTransientCards } from "../cards/ConversationCards";
import { useExpandedView } from "../expanded/expandedView";
import { ExpandedPlaceholder, ExpandViewButton } from "../expanded/ExpandViewButton";
import { RuntimeUiContext } from "../runtimeUiContext";
import { RuntimeUiViewBody } from "../RuntimeUiViewBody";
import { PhoneMoveMenu } from "./PhoneMoveMenu";
import { PhoneSheet } from "./PhoneSheet";
import { useLongPress } from "./useLongPress";

const EMPTY: readonly RuntimeUiInstance[] = [];
const TAB_SURFACES: readonly RuntimeUiSurface[] = ["tab", "panel", "floating"];

function byOpened(left: RuntimeUiInstance, right: RuntimeUiInstance) {
  return left.openedAt.localeCompare(right.openedAt);
}

function newestFocus(views: readonly RuntimeUiInstance[]): RuntimeUiInstance | undefined {
  return views.reduce<RuntimeUiInstance | undefined>(
    (newest, view) => (!newest || view.focusedAt > newest.focusedAt ? view : newest),
    undefined,
  );
}

/**
 * The phone's arrangement of a session's views. Side and floating views read
 * as tabs beside Chat (there is no room to dock beside it), bottom-dock views
 * share a sheet under the chat, and transient cards float above the composer.
 * Long-press any tab to open it full screen, move it, or close it.
 */
export function MobileSessionViews({ children }: { readonly children: ReactNode }) {
  const model = use(RuntimeUiContext);
  const views = useMemo(
    () =>
      model ? TAB_SURFACES.flatMap((surface) => model.bySurface[surface]).sort(byOpened) : EMPTY,
    [model],
  );
  const sheetViews = useMemo(
    () => [...(model?.bySurface["bottom-panel"] ?? EMPTY)].sort(byOpened),
    [model],
  );
  const focused = newestFocus(views);
  const focusSignature = focused ? `${focused.instanceId}:${focused.focusedAt}` : null;
  // Opening the conversation shows Chat; only focus that changes afterwards switches tabs.
  const loaded = model?.status === "ready";
  const [selection, setSelection] = useState<{
    readonly id: string | null;
    readonly seen: string | null;
    readonly loaded: boolean;
  }>({ id: null, seen: focusSignature, loaded });
  if (selection.seen !== focusSignature || selection.loaded !== loaded) {
    // The first loaded snapshot is the starting state, not a focus change.
    const follow = selection.loaded && selection.seen !== focusSignature;
    setSelection({
      id: follow ? (focused?.instanceId ?? selection.id) : selection.id,
      seen: focusSignature,
      loaded,
    });
  }
  const selected = views.find((view) => view.instanceId === selection.id);
  const select = (id: string | null) => setSelection({ id, seen: focusSignature, loaded });
  const expanded = useExpandedView()?.expandedId === selected?.instanceId;

  return (
    <div className="relative flex size-full min-h-0 flex-col" data-testid="mobile-session-views">
      {views.length > 0 && (
        <div
          className="flex min-h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-background px-2"
          role="tablist"
          aria-label="Session views"
        >
          <PhoneTab label="Chat" selected={!selected} onSelect={() => select(null)} />
          {views.map((view) => (
            <PhoneTab
              key={view.instanceId}
              view={view}
              label={runtimeUiInstanceTitle(view)}
              selected={selected?.instanceId === view.instanceId}
              onSelect={() => select(view.instanceId)}
            />
          ))}
          {selected && (
            <ExpandViewButton
              instance={selected}
              title={runtimeUiInstanceTitle(selected)}
              className="sticky right-0 mb-0.5 ml-auto size-10 shrink-0 bg-background"
            />
          )}
        </div>
      )}
      <div className={cn("min-h-0 flex-1", selected ? "hidden" : "flex flex-col")}>{children}</div>
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col bg-card" data-testid="mobile-session-view">
          {expanded ? <ExpandedPlaceholder /> : <RuntimeUiViewBody instance={selected} fill />}
        </div>
      )}
      {sheetViews.length > 0 && <PhoneSheet views={sheetViews} />}
      <RuntimeUiTransientCards className="absolute inset-x-2 bottom-2 z-40 max-h-[70%] overflow-y-auto" />
    </div>
  );
}

function PhoneTab({
  view,
  label,
  selected,
  onSelect,
}: {
  readonly view?: RuntimeUiInstance;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useLongPress(() => view && setMenuOpen(true), onSelect);
  const tab = (
    <Button
      type="button"
      variant="ghost"
      role="tab"
      aria-selected={selected}
      className={cn(
        "h-10 max-w-48 shrink-0 touch-pan-x rounded-b-none border-b-2 px-3 select-none",
        selected ? "border-primary" : "border-transparent",
      )}
      data-testid="mobile-session-tab"
      {...(view ? press : { onClick: onSelect })}
    >
      <span className="truncate">{label}</span>
    </Button>
  );
  if (!view) return tab;
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{tab}</DropdownMenuTrigger>
      <PhoneMoveMenu view={view} />
    </DropdownMenu>
  );
}
