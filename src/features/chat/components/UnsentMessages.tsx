import { useState } from "react";

import { Check, CircleAlert, Copy, Paperclip, RotateCcw, Trash2 } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";

import type { VisibleUnsentMessage } from "../state/unsentMessages";

function UnsentMessageBubble({
  message,
  onRetry,
  onDelete,
}: {
  message: VisibleUnsentMessage;
  onRetry: (message: VisibleUnsentMessage) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileNames = [
    ...message.files.map((file) => file.name),
    ...(message.droppedFileNames ?? []),
  ];

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry(message);
    } finally {
      setRetrying(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable; the text stays visible in the bubble.
    }
  };

  return (
    <div className="flex flex-col items-end gap-1" data-testid="message-unsent">
      <div className="max-w-[580px] rounded-[12px] border border-dashed border-destructive/50 bg-message-user-bg px-4 py-2 opacity-90">
        {fileNames.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {fileNames.map((name, idx) => (
              // eslint-disable-next-line react/no-array-index-key -- names can repeat, no stable IDs
              <Badge key={`file-${idx}`} variant="secondary" className="gap-1">
                <Paperclip size={10} />
                <span className="max-w-[150px] truncate">{name}</span>
              </Badge>
            ))}
          </div>
        )}
        <div className="text-base leading-[1.7] wrap-break-word whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
      </div>
      <div
        className="flex max-w-[580px] items-start gap-1.5 text-xs text-destructive"
        role="status"
      >
        <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          <span className="font-medium">Not sent.</span> {message.reason}
          {message.droppedFileNames?.length
            ? ` ${message.droppedFileNames.length} pasted image(s) were too large to keep and won't be resent.`
            : ""}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          className="h-9 px-3"
          onClick={() => void retry()}
          disabled={retrying}
          data-testid="unsent-retry"
        >
          <RotateCcw className={retrying ? "animate-spin" : undefined} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        <Button
          variant="ghost"
          className="h-9 px-3"
          onClick={() => void copy()}
          data-testid="unsent-copy"
        >
          {copied ? <Check /> : <Copy width={12} height={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          variant="ghost"
          className="h-9 px-3 text-muted-foreground"
          onClick={() => onDelete(message.id)}
          disabled={retrying}
          aria-label="Delete unsent message"
          data-testid="unsent-delete"
        >
          <Trash2 />
          Delete
        </Button>
      </div>
    </div>
  );
}

export function UnsentMessages({
  messages,
  onRetry,
  onDelete,
}: {
  messages: VisibleUnsentMessage[];
  onRetry: (message: VisibleUnsentMessage) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="unsent-messages">
      {messages.map((message) => (
        <UnsentMessageBubble
          key={message.id}
          message={message}
          onRetry={onRetry}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
