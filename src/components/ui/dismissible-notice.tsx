import { X } from "@/components/icons";
import * as React from "react";

import { cn } from "@/lib/marshal-class-names";

import { Button } from "../marshal-ui/marshal-button";

type NoticeDismissButtonProps = Omit<React.ComponentProps<typeof Button>, "children">;

function NoticeDismissButton({
  className,
  "aria-label": ariaLabel = "Dismiss",
  ...props
}: NoticeDismissButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("shrink-0", className)}
      aria-label={ariaLabel}
      {...props}
    >
      <X className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

interface DismissibleNoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  noticeKey: string;
  dismissLabel?: string;
  dismissButtonClassName?: string;
  onDismiss?: () => void;
}

function DismissibleNotice({
  noticeKey,
  dismissLabel = "Dismiss",
  dismissButtonClassName,
  onDismiss,
  className,
  children,
  ...props
}: DismissibleNoticeProps) {
  const [dismissedNoticeKey, setDismissedNoticeKey] = React.useState<string | null>(null);

  if (dismissedNoticeKey === noticeKey) return null;

  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
      <NoticeDismissButton
        className={dismissButtonClassName}
        aria-label={dismissLabel}
        onClick={() => {
          setDismissedNoticeKey(noticeKey);
          onDismiss?.();
        }}
      />
    </div>
  );
}

export { DismissibleNotice, NoticeDismissButton };
