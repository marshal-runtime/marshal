import type { RuntimeUiInstance, RuntimeUiSurface } from "@common/runtime-ui";
import { runtimeUiInstanceTitle } from "@common/runtime-ui-layout";
import { use } from "react";

import { Maximize2, MessageSquare, PanelBottom, Square, X } from "@/components/icons";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import { useExpandedView } from "../expanded/expandedView";
import { RuntimeUiContext } from "../runtimeUiContext";

const PHONE_MOVES: readonly {
  readonly surface: RuntimeUiSurface;
  readonly label: string;
  readonly icon: typeof MessageSquare;
}[] = [
  { surface: "tab", label: "Tab beside Chat", icon: MessageSquare },
  { surface: "bottom-panel", label: "Bottom sheet", icon: PanelBottom },
  { surface: "inline-card", label: "Card in the chat", icon: Square },
];

/** The long-press menu on a phone tab: full screen, move, or close. */
export function PhoneMoveMenu({ view }: { readonly view: RuntimeUiInstance }) {
  const model = use(RuntimeUiContext);
  const expandedView = useExpandedView();
  if (!model) return null;
  return (
    <DropdownMenuContent align="start" data-testid="mobile-move-menu">
      <DropdownMenuLabel className="max-w-56 truncate">
        {runtimeUiInstanceTitle(view)}
      </DropdownMenuLabel>
      {expandedView && (
        <DropdownMenuItem
          className="min-h-11"
          onSelect={() => expandedView.expand(view.instanceId)}
        >
          <Maximize2 className="size-4" />
          Full screen
        </DropdownMenuItem>
      )}
      {PHONE_MOVES.filter((move) => move.surface !== view.surface).map((move) => (
        <DropdownMenuItem
          key={move.surface}
          className="min-h-11"
          onSelect={() => void model.focus(view, move.surface)}
        >
          <move.icon className="size-4" />
          {move.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem className="min-h-11" onSelect={() => void model.close(view)}>
        <X className="size-4" />
        Close
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
