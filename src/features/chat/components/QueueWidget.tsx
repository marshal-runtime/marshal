import { Loader2, Send, X, Zap } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";

import type { QueuedMessage } from "../hooks/useMessageQueue";

interface QueueWidgetProps {
  items: QueuedMessage[];
  /** Text of an in-flight steering message, shown while the turn is interrupted. */
  steeringText?: string | null;
  /** Send a queued item immediately, interrupting the current turn (steer). */
  onSteer: (id: string) => void;
  /** Remove a queued item without sending it. */
  onRemove: (id: string) => void;
}

/**
 * Renders queued chat messages above the composer (mirrors the GoalWidget
 * placement). Each item can be removed, or "steered" — sent immediately by
 * interrupting the running turn. While a steer is in flight, a transient
 * "Steering…" row shows the interrupting message.
 */
export function QueueWidget({ items, steeringText, onSteer, onRemove }: QueueWidgetProps) {
  if (items.length === 0 && !steeringText) return null;

  return (
    <div className="flex flex-col gap-1" data-testid="queue-widget">
      {steeringText && (
        <div
          className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-foreground"
          data-testid="steering-row"
        >
          <Loader2 size={14} className="shrink-0 animate-spin text-amber-600" />
          <span className="shrink-0 font-medium text-amber-700">Steering</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{steeringText}</span>
        </div>
      )}

      {items.map((item, index) => (
        <div
          key={item.id}
          className="flex items-center gap-2 rounded-lg bg-(--bg-hover) px-3 py-2 text-sm"
          data-testid="queued-message"
        >
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{item.text}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={() => onSteer(item.id)}
            aria-label="Steer this message now"
            title="Send now, interrupting the running turn"
            data-testid="queued-steer-btn"
          >
            <Zap size={13} /> Steer
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onRemove(item.id)}
            aria-label="Remove from queue"
            data-testid="queued-remove-btn"
          >
            <X size={14} />
          </Button>
        </div>
      ))}

      {items.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          <Send size={11} className="mr-1 inline" />
          {items.length === 1 ? "1 message queued" : `${items.length} messages queued`} — sends when
          the current turn finishes
        </p>
      )}
    </div>
  );
}
