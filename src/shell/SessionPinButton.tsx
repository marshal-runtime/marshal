import { PushPin } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { LoaderCircle } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

interface SessionPinButtonProps {
  sessionId: string;
  sessionName: string;
  isPinned?: boolean;
}

export function SessionPinButton({ sessionId, sessionName, isPinned }: SessionPinButtonProps) {
  const queryClient = useQueryClient();
  const pinMutation = useMutation({
    mutationFn: async (pinned: boolean) => {
      const result = await window.sessionsAPI?.setPinned(sessionId, pinned);
      if (!result) throw new Error("Session pinning is not available");
      if (!result.success) throw new Error(result.error ?? "Session pinning failed");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });

  const persistedPinned = isPinned ?? false;
  const optimisticPinned = pinMutation.isPending
    ? (pinMutation.variables ?? persistedPinned)
    : persistedPinned;
  const actionLabel = optimisticPinned ? `Unpin ${sessionName}` : `Pin ${sessionName}`;
  const errorMessage =
    pinMutation.isError && pinMutation.error instanceof Error
      ? pinMutation.error.message
      : undefined;

  return (
    <Button
      variant="ghost"
      type="button"
      className={cn(
        "h-6 w-0 shrink-0 overflow-hidden rounded-full p-0 text-muted-foreground opacity-0 transition-[width,padding,opacity,color] group-focus-within:w-6 group-focus-within:p-1 group-focus-within:opacity-100 group-hover:w-6 group-hover:p-1 group-hover:opacity-100 hover:bg-muted",
        optimisticPinned && "w-6 p-1 text-foreground opacity-100",
        pinMutation.isError && "w-6 p-1 text-destructive opacity-100",
      )}
      aria-label={actionLabel}
      aria-pressed={optimisticPinned}
      aria-invalid={pinMutation.isError || undefined}
      title={errorMessage ?? actionLabel}
      disabled={pinMutation.isPending}
      onClick={(event) => {
        event.stopPropagation();
        pinMutation.mutate(!optimisticPinned);
      }}
    >
      {pinMutation.isPending ? (
        <LoaderCircle className="size-3.5 animate-spin" data-testid="session-pin-pending" />
      ) : (
        <PushPin size={14} weight={optimisticPinned ? "fill" : "regular"} />
      )}
    </Button>
  );
}
