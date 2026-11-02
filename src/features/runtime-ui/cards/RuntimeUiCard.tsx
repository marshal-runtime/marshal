import type { RuntimeUiInstance, RuntimeUiSurface } from "@common/runtime-ui";
import { runtimeUiInstanceTitle } from "@common/runtime-ui-layout";
import { use } from "react";

import {
  Ellipsis,
  ExternalLink,
  MessageSquare,
  PanelBottom,
  PanelRightOpen,
  X,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/marshal-class-names";

import { useExpandedView } from "../expanded/expandedView";
import { ExpandedPlaceholder, ExpandViewButton } from "../expanded/ExpandViewButton";
import { RuntimeUiContext } from "../runtimeUiContext";
import { RuntimeUiViewBody } from "../RuntimeUiViewBody";

const MOVE_TARGETS: readonly {
  readonly surface: RuntimeUiSurface;
  readonly label: string;
  readonly icon: typeof MessageSquare;
}[] = [
  { surface: "tab", label: "Open as chat tab", icon: MessageSquare },
  { surface: "panel", label: "Move to side dock", icon: PanelRightOpen },
  { surface: "bottom-panel", label: "Move to bottom dock", icon: PanelBottom },
  { surface: "floating", label: "Float", icon: ExternalLink },
];

const HEADER_BUTTON = "pointer-coarse:size-9";

function expiryLabel(expiresAt: string): string {
  const time = new Date(expiresAt);
  if (Number.isNaN(time.getTime())) return "";
  return `Closes at ${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * One card: a permanent conversation card, a transient floating card, or a
 * view bound to a message slot. The title bar carries move and close; the
 * body takes its natural height up to a cap and scrolls beyond it.
 */
export function RuntimeUiCard({
  instance,
  variant,
}: {
  readonly instance: RuntimeUiInstance;
  readonly variant: "card" | "transient" | "slot";
}) {
  const model = use(RuntimeUiContext);
  const title = runtimeUiInstanceTitle(instance);
  const pending = model?.pending.get(instance.instanceId);
  const expiresAt = instance.transient?.expiresAt;
  const expanded = useExpandedView()?.expandedId === instance.instanceId;
  return (
    <section
      className={cn(
        "flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
        variant === "transient" ? "shadow-xl" : "shadow-sm",
      )}
      aria-label={title}
      data-runtime-ui-surface={instance.surface}
      data-runtime-ui-card={variant}
      data-instance-id={instance.instanceId}
      data-testid="runtime-ui-card"
    >
      <header className="flex min-h-9 items-center gap-1.5 border-b border-border px-3 py-1 pointer-coarse:min-h-11 pointer-coarse:pr-1.5">
        <p className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>
          {title}
        </p>
        {expiresAt && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {expiryLabel(expiresAt)}
          </span>
        )}
        {pending && (
          <span className="shrink-0 text-[11px] text-muted-foreground" role="status">
            {pending.operation === "close" ? "Closing…" : "Updating…"}
          </span>
        )}
        <ExpandViewButton instance={instance} title={title} className={HEADER_BUTTON} />
        {model && variant !== "transient" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className={HEADER_BUTTON}
                aria-label={`Move ${title}`}
                data-testid="runtime-ui-card-menu"
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {MOVE_TARGETS.map((target) => (
                <DropdownMenuItem
                  key={target.surface}
                  onSelect={() => void model.focus(instance, target.surface)}
                >
                  <target.icon className="size-3.5" />
                  {target.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {model && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={HEADER_BUTTON}
            aria-label={`Close ${title}`}
            disabled={pending?.operation === "close"}
            data-testid="runtime-ui-card-close"
            onClick={() => void model.close(instance)}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </header>
      <div
        className={cn(
          "min-h-0 overflow-auto",
          variant === "transient" ? "max-h-[40vh]" : "max-h-112",
        )}
      >
        {expanded ? (
          <ExpandedPlaceholder />
        ) : (
          <RuntimeUiViewBody instance={instance} fill={false} className="p-3" />
        )}
      </div>
    </section>
  );
}
