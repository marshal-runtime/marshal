import { Loader2, MessageCircleWarning } from "@/components/icons";
import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";

import { AIInvestigatorModal } from "./AIInvestigatorModal";
import { useAIInvestigator } from "./useAIInvestigator";

/**
 * Header trigger for the AI Investigator flow.
 *
 * - Idle: opens the intake modal.
 * - Mid-investigation: re-opens the same modal in its current state (the
 *   manager singleton in main is the source of truth).
 * - Ready (modal closed): shakes periodically to draw attention so the
 *   user knows their report is waiting to be reviewed and posted.
 */
export function AIInvestigatorButton() {
  const [open, setOpen] = useState(false);
  const fb = useAIInvestigator();
  const { state, available } = fb;
  const investigating = state === "collecting" || state === "investigating";
  // Only shake when the report is actually waiting and the user isn't
  // already looking at it. Stops as soon as they open the modal.
  const needsAttention = state === "ready" && !open;

  // Hide the button entirely when the user can't use the feature
  // (no destination configured, or the provider's availability probe failed).
  // `null` = still probing — also hide to avoid a flash of an unusable control.
  if (available !== true) return null;

  const tooltipText = needsAttention
    ? "Bug report ready — click to review"
    : investigating
      ? "Investigation in progress…"
      : "Report a bug";

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(true)}
            aria-label={tooltipText}
            data-testid="ai-investigator-button"
          >
            {investigating ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <MessageCircleWarning
                size={16}
                className={cn(
                  needsAttention &&
                    "origin-center animate-attention-shake motion-reduce:animate-none",
                )}
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      <AIInvestigatorModal open={open} onOpenChange={setOpen} fb={fb} />
    </>
  );
}
