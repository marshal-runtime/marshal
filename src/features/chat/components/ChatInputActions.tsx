import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { ArrowUp, Loader2, Minimize2, Square } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InteractiveElementMonitor_Send,
  InteractiveElementMonitor_Stop,
} from "@/services/telemetry/schema";
import { useBackendCapabilitiesQuery } from "@/shared/hooks/useBackendCapabilities";

/** Press-and-hold duration (ms) on the Send button that queues during an active turn. */
const LONG_PRESS_MS = 500;
const SESSION_COMPACTION_MUTATION_KEY = ["sessions", "compact"] as const;

interface ChatInputActionsProps {
  sessionId?: string | null;
  sdkReady: boolean;
  isWaiting: boolean;
  isCancelling: boolean;
  /** True when the composer has content to send/enqueue/steer. */
  hasContent: boolean;
  showTokenCount: boolean;
  currentTokens?: number;
  tokenLimit?: number;
  inputTokens?: number;
  canSubmit: boolean;
  onSubmit: (target: ChatInputActionTarget | null) => void;
  onStop: () => void;
  /** Steer: interrupt the running turn and send the composer content now. */
  onSteer: (target: ChatInputActionTarget | null) => void;
}

export interface ChatInputActionTarget {
  sessionId: string;
  isWaiting: boolean;
  isCancelling: boolean;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Right-side compose-bar controls: compaction, token counter, and send/stop.
 *
 * Button behavior:
 *   - idle: Send (arrow) submits a new turn.
 *   - running + empty composer: Stop (square) aborts the turn.
 *   - running + non-empty composer: Send (arrow) steers immediately. A
 *     long-press queues the message instead.
 */
export function ChatInputActions({
  sessionId,
  sdkReady,
  isWaiting,
  isCancelling,
  hasContent,
  showTokenCount,
  currentTokens,
  tokenLimit,
  inputTokens,
  canSubmit,
  onSubmit,
  onStop,
  onSteer,
}: ChatInputActionsProps) {
  // While a turn runs, the square Stop button reverts to the arrow Send button
  // the moment the user starts typing (queue/steer affordance).
  const showStop = isWaiting && !hasContent;

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const pendingSubmitTargetRef = useRef<ChatInputActionTarget | null | undefined>(undefined);
  const backendCapabilities = useBackendCapabilitiesQuery();
  const queryClient = useQueryClient();
  const [compactionTarget, setCompactionTarget] = useState<string | null>(null);
  const compactMutation = useMutation({
    mutationKey: SESSION_COMPACTION_MUTATION_KEY,
    mutationFn: async (targetSessionId: string) => {
      if (!window.sessionsAPI) {
        throw new Error("Session is not ready for compaction.");
      }
      const result = await window.sessionsAPI.compact(targetSessionId);
      if (!result.success) {
        throw new Error(result.error || "Session compaction failed.");
      }
    },
    onSuccess: () => toast.success("Session compacted"),
    onError: (error) =>
      toast.error("Could not compact session", {
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const compactingSessionIds = useMutationState({
    filters: {
      exact: true,
      mutationKey: SESSION_COMPACTION_MUTATION_KEY,
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });
  const isCompactingSession = sessionId ? compactingSessionIds.includes(sessionId) : false;
  const supportsCompaction = backendCapabilities.capabilities?.sessionCompaction === true;
  const compactDisabledReason = backendCapabilities.isLoading
    ? "Checking provider compaction support..."
    : !supportsCompaction
      ? "Provider does not support session compaction"
      : !sdkReady
        ? "Session is not ready for compaction"
        : isWaiting || isCancelling
          ? "Wait for the current response to finish"
          : isCompactingSession
            ? "Compacting session..."
            : null;
  const compactTooltip = compactDisabledReason ?? "Compact session context";
  const confirmCompaction = () => {
    const targetSessionId = compactionTarget;
    setCompactionTarget(null);
    if (
      !targetSessionId ||
      queryClient.isMutating({
        exact: true,
        mutationKey: SESSION_COMPACTION_MUTATION_KEY,
        predicate: (mutation) => mutation.state.variables === targetSessionId,
      }) > 0
    ) {
      return;
    }
    compactMutation.mutate(targetSessionId);
  };

  const captureTarget = useCallback(
    (): ChatInputActionTarget | null => (sessionId ? { sessionId, isWaiting, isCancelling } : null),
    [sessionId, isWaiting, isCancelling],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const submitCapturedTarget = useCallback(() => {
    const target = pendingSubmitTargetRef.current;
    pendingSubmitTargetRef.current = undefined;
    if (target?.isWaiting) {
      onSteer(target);
      return;
    }
    onSubmit(target ?? null);
  }, [onSteer, onSubmit]);

  // Long-press only queues while a turn is running and there is content.
  const armLongPress = useCallback(() => {
    didLongPress.current = false;
    if (!isWaiting || !hasContent || !canSubmit) return;
    const target = captureTarget();
    if (!target) return;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      onSubmit(target);
    }, LONG_PRESS_MS);
  }, [isWaiting, hasContent, canSubmit, captureTarget, onSubmit]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      {sessionId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex"
              tabIndex={compactDisabledReason ? 0 : -1}
              data-testid="compact-session-tooltip-trigger"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-full text-muted-foreground hover:bg-(--bg-hover)"
                disabled={compactDisabledReason !== null}
                aria-label="Compact session"
                aria-busy={isCompactingSession}
                data-testid="compact-session-btn"
                onClick={() => {
                  const targetSessionId = sessionId;
                  if (
                    !targetSessionId ||
                    queryClient.isMutating({
                      exact: true,
                      mutationKey: SESSION_COMPACTION_MUTATION_KEY,
                      predicate: (mutation) => mutation.state.variables === targetSessionId,
                    }) > 0
                  ) {
                    return;
                  }
                  setCompactionTarget(targetSessionId);
                }}
              >
                {isCompactingSession ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Minimize2 size={16} />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{compactTooltip}</TooltipContent>
        </Tooltip>
      )}

      <Dialog
        open={compactionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCompactionTarget(null);
        }}
      >
        <DialogContent showCloseButton={false} data-testid="confirm-session-compaction-dialog">
          <DialogHeader>
            <DialogTitle>Compact this session?</DialogTitle>
            <DialogDescription>
              Older provider context will be summarized, so some details may no longer be available
              to the model. Your visible chat history will remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompactionTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCompaction}
              data-testid="confirm-session-compaction"
            >
              Compact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showTokenCount && currentTokens != null && tokenLimit != null && (
        <span
          className="self-center text-xs whitespace-nowrap text-muted-foreground"
          title={`${currentTokens.toLocaleString()} / ${tokenLimit.toLocaleString()} tokens`}
        >
          {formatTokenCount(currentTokens)}/{formatTokenCount(tokenLimit)}
        </span>
      )}
      {showTokenCount && (currentTokens == null || tokenLimit == null) && inputTokens != null && (
        <span
          className="self-center text-xs whitespace-nowrap text-muted-foreground"
          title={`${inputTokens.toLocaleString()} input tokens sent in the latest turn`}
        >
          {formatTokenCount(inputTokens)} sent
        </span>
      )}

      {showStop ? (
        <InteractiveElementMonitor_Stop callback={onStop}>
          {(cb) => (
            <Button
              type="button"
              size="icon"
              className="size-10 rounded-full bg-neutral-heavy text-brand-action-fg hover:bg-neutral-heavy-hover"
              onClick={cb}
              disabled={isCancelling}
              aria-label={isCancelling ? "Cancelling" : "Stop"}
              aria-busy={isCancelling}
              data-testid="stop-btn"
            >
              <Square size={16} fill="currentColor" strokeWidth={0} />
            </Button>
          )}
        </InteractiveElementMonitor_Stop>
      ) : (
        <InteractiveElementMonitor_Send
          callback={submitCapturedTarget}
          interactionDisabled={!canSubmit}
        >
          {(cb, isDisabled) => (
            // type="button" (not "submit"): the click already fires Send via the
            // InteractiveElementMonitor_Send wrapper above and runs the submit
            // logic via onClick.
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="size-10 rounded-full bg-(--bg-hover) hover:bg-(--bg-hover-strong)"
              disabled={isDisabled}
              aria-label={isWaiting ? "Steer now (hold to queue)" : "Send"}
              title={isWaiting ? "Steer now — hold to queue for later" : "Send"}
              data-testid="send-btn"
              data-mode={isWaiting ? "steer" : "send"}
              onClick={(e) => {
                // A completed long-press already queued; swallow the click.
                if (didLongPress.current) {
                  didLongPress.current = false;
                  e.preventDefault();
                  return;
                }
                clearLongPress();
                pendingSubmitTargetRef.current = captureTarget();
                cb();
              }}
              onPointerDown={armLongPress}
              onPointerUp={clearLongPress}
              onPointerLeave={clearLongPress}
              onPointerCancel={clearLongPress}
            >
              <ArrowUp size={20} />
            </Button>
          )}
        </InteractiveElementMonitor_Send>
      )}
    </div>
  );
}
