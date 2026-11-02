import type { AssistantContentBlock, ToolActivityKind } from "@common/marshal-ipc-contract";
import { useState, useRef, useEffect, useCallback, memo } from "react";

import { Check, Copy, Info, LoaderCircle, Paperclip } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { NoticeDismissButton } from "@/components/ui/dismissible-notice";
import { MessageMarkdown } from "@/features/runtime-ui/cards/MessageMarkdown";
import { cn } from "@/lib/marshal-class-names";
import { MarkdownRenderer } from "@/plugins/streamdown-config";
import {
  InteractiveElementMonitor_Copy,
  SimplePropertyMonitor_IsStreaming,
} from "@/services/telemetry/schema";
import { useIsMobile } from "@/shared/hooks/useIsMobile";
import { formatChatTooltip, formatMessageTime } from "@/shared/marshal-foundation/date";
import { remoteMediaUrl } from "@/shared/remote-media-url";
import type { PermissionCardData, SessionMessage } from "@/types/electron";

import { stripCtxMarkers } from "../editor/support/editor-support";
import { classifyTimelineMessage } from "../state/timelineFilters";
import type { ReasoningState } from "../types";
import { CollapsibleSection, CommittedReasoning } from "./CollapsibleIndicator";
import { InlineQuestion } from "./inline-question/InlineQuestion";
import { TimelineBoundary } from "./TimelineBoundary";
import { ToolActivityIsland } from "./ToolActivityIsland";
export type { MessageToolCall } from "@common/marshal-ipc-contract";
export type { MessageReasoning } from "./CollapsibleIndicator";

function MessageTimestamp({ date }: { date: Date }) {
  const time = formatMessageTime(date);
  if (!time) return null;
  const fullDateTime = formatChatTooltip(date);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={date.toISOString()}
          className="text-xs text-muted-foreground select-none"
          data-testid="message-timestamp"
          tabIndex={0}
        >
          {time}
        </time>
      </TooltipTrigger>
      {fullDateTime && (
        <TooltipContent side="bottom" className="text-xs" hideArrow>
          {fullDateTime}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

/**
 * Footer below a message bubble — timestamp stays visible; copy appears on
 * hover on desktop. Touch screens have no hover state, so on mobile the copy
 * button is always shown instead of being hover-gated.
 */
function MessageActionBar({
  align,
  timestamp,
  copyContent,
}: {
  align: "left" | "right";
  timestamp: Date;
  copyContent?: string;
}) {
  const isMobile = useIsMobile();
  if (isNaN(timestamp.getTime())) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 pt-1",
        align === "right" ? "justify-end" : "justify-start",
      )}
      data-testid="message-action-bar"
    >
      <MessageTimestamp date={timestamp} />
      {copyContent?.trim() && (
        <span
          className={cn(
            !isMobile &&
              "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <CopyButton content={copyContent} />
        </span>
      )}
    </div>
  );
}

export type Message = Omit<SessionMessage, "timestamp"> & {
  timestamp: Date;
  images?: string[]; // data URLs for inline image display
  fileNames?: string[]; // names of non-image file attachments
  isTerminalPrompt?: boolean;
  clientMessageId?: string;
  optimistic?: boolean;
};

export interface ToolStatus {
  id: string;
  name?: string;
  description: string;
  activityKind?: ToolActivityKind;
  running: boolean;
  input?: string;
  output?: string;
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}

/** Copy button — copies message content to clipboard.
 * Strips invisible context markers (e.g. `<!--ctx:mailto:...-->`) so the
 * clipboard contains only what the user sees in the bubble. */
function CopyButton({ content }: { content: string }) {
  const cleanContent = stripCtxMarkers(content);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cleanContent);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // clipboard unavailable
    }
  }, [cleanContent]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InteractiveElementMonitor_Copy callback={handleCopy}>
          {(cb) => (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded-full text-muted-foreground"
              onClick={cb}
              aria-label={copied ? "Copied" : "Copy message"}
              data-testid="copy-message-btn"
            >
              {copied ? <Check size={12} /> : <Copy width={10} height={12} />}
            </Button>
          )}
        </InteractiveElementMonitor_Copy>
      </TooltipTrigger>
      <TooltipContent side="bottom" hideArrow>
        {copied ? "Copied!" : "Copy"}
      </TooltipContent>
    </Tooltip>
  );
}

// Memoized message component — only re-renders when its own content changes
export const ChatMessage = memo(
  function ChatMessage(props: {
    message: Message;
    sessionId?: string | null;
    onActionSelect?: (messageId: string, label: string) => void;
    onDismiss?: (messageId: string) => void;
    dismissedToolNoticeKeys?: ReadonlySet<string>;
    onToolNoticeDismiss?: (noticeKey: string) => void;
  }) {
    const {
      message,
      sessionId,
      onActionSelect,
      onDismiss,
      dismissedToolNoticeKeys,
      onToolNoticeDismiss,
    } = props;
    const classification = classifyTimelineMessage(message);
    if (classification.renderRole === "event") return <TimelineBoundary message={message} />;

    if (classification.renderRole === "system") {
      return (
        <div
          className="group flex justify-center"
          data-message-id={message.id}
          data-testid="message-system"
        >
          <div className="max-w-[620px] rounded-lg border border-border bg-muted/50 px-4 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              System
            </div>
            {message.content && (
              <div
                className="text-sm/relaxed wrap-break-word text-foreground"
                data-testid="message-text"
              >
                <MarkdownRenderer>{message.content}</MarkdownRenderer>
              </div>
            )}
            <MessageActionBar
              align="left"
              timestamp={message.timestamp}
              copyContent={message.content}
            />
          </div>
        </div>
      );
    }

    if (message.role === "user") {
      return (
        <div
          className="group flex flex-col items-end"
          data-message-id={message.id}
          data-testid="message-user"
        >
          <SimplePropertyMonitor_IsStreaming value={false} />
          <div className="max-w-[580px] rounded-[12px] bg-message-user-bg px-4 py-2">
            {((message.fileNames && message.fileNames.length > 0) ||
              (message.images && message.images.length > 0)) && (
              <div className="mb-2 flex flex-wrap gap-1">
                {message.fileNames?.map((name, idx) => (
                  // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
                  <Badge key={`file-${idx}`} variant="secondary" className="gap-1">
                    <Paperclip size={10} />
                    <span className="max-w-[150px] truncate">{name}</span>
                  </Badge>
                ))}
                {message.images?.map((src, idx) => (
                  <img
                    // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
                    key={`img-${idx}`}
                    src={remoteMediaUrl(src)}
                    alt={`Attached ${idx + 1}`}
                    className="max-h-32 rounded-lg"
                  />
                ))}
              </div>
            )}
            {message.content && (
              <div
                className="text-base leading-[1.7] wrap-break-word text-foreground"
                data-testid="message-text"
              >
                <MarkdownRenderer>{message.content}</MarkdownRenderer>
              </div>
            )}
          </div>
          <MessageActionBar
            align="right"
            timestamp={message.timestamp}
            copyContent={message.content}
          />
        </div>
      );
    }

    const contentBlocks = message.contentBlocks?.filter((block) => {
      if (block.type === "text") return Boolean(block.content.trim());
      if (block.type === "reasoning") return Boolean(block.text.trim());
      return block.toolCalls.length > 0;
    });

    if (contentBlocks?.length) {
      const renderedBlocks = contentBlocks.map((block, index) => {
        if (block.type === "reasoning") {
          return (
            <div key={block.id} data-testid="message-reasoning-block">
              <CommittedReasoning
                reasoning={{ text: block.text, durationSeconds: block.durationSeconds }}
              />
            </div>
          );
        }
        if (block.type === "tools") {
          const blockOffset = contentBlocks
            .slice(0, index)
            .reduce(
              (count, preceding) =>
                count + (preceding.type === "tools" ? preceding.toolCalls.length : 0),
              0,
            );
          return (
            <div key={block.id} data-testid="message-tools-block">
              <ToolActivityIsland
                variant="receipt"
                sessionId={sessionId}
                messageId={message.id}
                toolCallIndexOffset={blockOffset}
                tools={block.toolCalls}
                dismissedToolNoticeKeys={dismissedToolNoticeKeys}
                onToolNoticeDismiss={onToolNoticeDismiss}
              />
            </div>
          );
        }
        const isLastBlock = index === contentBlocks.length - 1;
        return (
          <div
            key={block.id}
            className={cn(
              "flex items-start gap-2 rounded-[12px] bg-message-assistant-bg px-4 py-2",
              message.error && isLastBlock && "border border-destructive/30 bg-destructive/10",
            )}
            data-testid="message-text-block"
          >
            <div
              className="min-w-0 flex-1 text-base leading-[1.7] wrap-break-word text-foreground"
              data-testid="message-text"
            >
              <MessageMarkdown>{block.content}</MessageMarkdown>
            </div>
            {message.error && isLastBlock && onDismiss && (
              <NoticeDismissButton
                aria-label="Dismiss message error"
                onClick={() => onDismiss(message.id)}
              />
            )}
          </div>
        );
      });

      return (
        <div
          className="group flex max-w-[708px] items-start"
          data-message-id={message.id}
          data-testid="message-assistant"
        >
          <SimplePropertyMonitor_IsStreaming value={false} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {renderedBlocks}
            {message.question && onActionSelect && (
              <div className="rounded-[12px] bg-message-assistant-bg px-4 py-2">
                <InlineQuestion
                  question={message.question}
                  onSelect={(answer) => onActionSelect(message.id, answer)}
                />
              </div>
            )}
            <MessageActionBar
              align="left"
              timestamp={message.timestamp}
              copyContent={message.content}
            />
          </div>
        </div>
      );
    }

    return (
      <div
        className="group flex max-w-[708px] items-start"
        data-message-id={message.id}
        data-testid="message-assistant"
      >
        <SimplePropertyMonitor_IsStreaming value={false} />
        <div className="flex min-w-0 flex-1 flex-col">
          {(message.reasoning?.text || (message.toolCalls && message.toolCalls.length > 0)) && (
            <div className="mb-2" data-testid="message-meta">
              {message.reasoning?.text && <CommittedReasoning reasoning={message.reasoning} />}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <ToolActivityIsland
                  variant="receipt"
                  sessionId={sessionId}
                  messageId={message.id}
                  tools={message.toolCalls}
                  dismissedToolNoticeKeys={dismissedToolNoticeKeys}
                  onToolNoticeDismiss={onToolNoticeDismiss}
                />
              )}
            </div>
          )}
          <div
            className={cn(
              "flex items-start gap-2 rounded-[12px] bg-message-assistant-bg px-4 py-2",
              message.error && "border border-destructive/30 bg-destructive/10",
            )}
          >
            <div className="min-w-0 flex-1">
              {message.content && (
                <div
                  className="text-base leading-[1.7] wrap-break-word text-foreground"
                  data-testid="message-text"
                >
                  <MessageMarkdown>{message.content}</MessageMarkdown>
                </div>
              )}
              {message.question && onActionSelect && (
                <InlineQuestion
                  question={message.question}
                  onSelect={(answer) => onActionSelect(message.id, answer)}
                />
              )}
            </div>
            {message.error && onDismiss && (
              <NoticeDismissButton
                aria-label="Dismiss message error"
                onClick={() => onDismiss(message.id)}
              />
            )}
          </div>
          <MessageActionBar
            align="left"
            timestamp={message.timestamp}
            copyContent={message.content}
          />
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.role === next.message.role &&
    prev.message.content === next.message.content &&
    prev.message.internalControl === next.message.internalControl &&
    prev.message.timestamp.getTime() === next.message.timestamp.getTime() &&
    prev.message.reasoning === next.message.reasoning &&
    prev.message.toolCalls === next.message.toolCalls &&
    prev.message.contentBlocks === next.message.contentBlocks &&
    prev.message.question === next.message.question &&
    prev.message.error === next.message.error &&
    prev.message.goalContinuation === next.message.goalContinuation &&
    prev.message.goalTimelineEvent === next.message.goalTimelineEvent &&
    prev.message.agentMessage === next.message.agentMessage &&
    prev.message.images === next.message.images &&
    prev.message.fileNames === next.message.fileNames &&
    prev.sessionId === next.sessionId &&
    prev.onActionSelect === next.onActionSelect &&
    prev.onDismiss === next.onDismiss &&
    prev.dismissedToolNoticeKeys === next.dismissedToolNoticeKeys &&
    prev.onToolNoticeDismiss === next.onToolNoticeDismiss,
);

export function StreamingMessage({
  sessionId,
  streamingContent,
  toolStatuses,
  reasoning,
  dismissedToolNoticeKeys,
  onToolNoticeDismiss,
  activePermissions = [],
  contentBlocks,
}: {
  sessionId?: string | null;
  streamingContent: string;
  toolStatuses: ToolStatus[];
  reasoning: ReasoningState;
  dismissedToolNoticeKeys?: ReadonlySet<string>;
  onToolNoticeDismiss?: (noticeKey: string) => void;
  activePermissions?: PermissionCardData[];
  contentBlocks?: AssistantContentBlock[];
}) {
  const reasoningContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reasoningContentRef.current) {
      reasoningContentRef.current.scrollTop = reasoningContentRef.current.scrollHeight;
    }
  }, [reasoning.content]);

  const showProcessing =
    !contentBlocks?.length &&
    !reasoning.content.trim() &&
    !streamingContent.trim() &&
    toolStatuses.length === 0 &&
    activePermissions.length === 0;

  if (contentBlocks?.length) {
    const lastToolsIndex = contentBlocks.findLastIndex((block) => block.type === "tools");
    return (
      <div className="flex max-w-[708px] flex-col gap-2" data-testid="message-assistant">
        {contentBlocks.map((block, index) => {
          if (block.type === "reasoning") {
            return (
              <div key={block.id} data-testid="message-reasoning-block">
                <CollapsibleSection
                  label={
                    block.durationSeconds !== null
                      ? `Thought for ${block.durationSeconds}s`
                      : "Thinking\u2026"
                  }
                  testId="reasoning-indicator"
                  toggleTestId="reasoning-toggle"
                  defaultOpen
                >
                  <div
                    className="max-h-40 overflow-y-auto text-sm text-muted-foreground"
                    data-testid="reasoning-content"
                    data-streaming
                  >
                    <MarkdownRenderer>{block.text}</MarkdownRenderer>
                  </div>
                </CollapsibleSection>
              </div>
            );
          }
          if (block.type === "tools") {
            return (
              <div key={block.id} data-testid="message-tools-block">
                <ToolActivityIsland
                  variant="live"
                  sessionId={sessionId}
                  tools={block.toolCalls}
                  activePermissions={index === lastToolsIndex ? activePermissions : undefined}
                  dismissedToolNoticeKeys={dismissedToolNoticeKeys}
                  onToolNoticeDismiss={onToolNoticeDismiss}
                />
              </div>
            );
          }
          return (
            <div
              key={block.id}
              className="rounded-[12px] bg-message-assistant-bg px-4 py-2"
              data-testid="message-text-block"
            >
              <div
                className="text-base leading-[1.7] wrap-break-word text-foreground"
                data-testid="message-text"
                data-streaming
              >
                <MessageMarkdown live>{block.content}</MessageMarkdown>
              </div>
            </div>
          );
        })}
        {activePermissions.length > 0 && lastToolsIndex < 0 && (
          <ToolActivityIsland
            variant="live"
            sessionId={sessionId}
            tools={[]}
            activePermissions={activePermissions}
            dismissedToolNoticeKeys={dismissedToolNoticeKeys}
            onToolNoticeDismiss={onToolNoticeDismiss}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-[708px] flex-col" data-testid="message-assistant">
      <div className="mb-2" data-testid="message-meta">
        {showProcessing && (
          <div
            className="flex items-center gap-2 p-1 text-base text-muted-foreground"
            data-testid="reasoning-indicator"
          >
            <LoaderCircle
              className="size-4 animate-spin"
              aria-hidden
              data-testid="working-spinner"
            />
            <span className="animate-shimmer-text bg-linear-to-r from-muted-foreground via-foreground to-muted-foreground bg-size-[200%_100%] bg-clip-text text-transparent">
              Working
            </span>
          </div>
        )}
        {reasoning.content.trim() && (
          <CollapsibleSection
            label={
              reasoning.duration !== null ? `Thought for ${reasoning.duration}s` : "Thinking\u2026"
            }
            testId="reasoning-indicator"
            toggleTestId="reasoning-toggle"
            defaultOpen
          >
            <div
              className="max-h-40 overflow-y-auto text-sm text-muted-foreground"
              data-testid="reasoning-content"
              data-streaming
              ref={reasoningContentRef}
            >
              <MarkdownRenderer>{reasoning.content}</MarkdownRenderer>
            </div>
          </CollapsibleSection>
        )}
        {(toolStatuses.length > 0 || activePermissions.length > 0) && (
          <ToolActivityIsland
            variant="live"
            sessionId={sessionId}
            tools={toolStatuses}
            activePermissions={activePermissions}
            dismissedToolNoticeKeys={dismissedToolNoticeKeys}
            onToolNoticeDismiss={onToolNoticeDismiss}
          />
        )}
      </div>
      {streamingContent.trim() && (
        <div className="rounded-[12px] bg-message-assistant-bg px-4 py-2">
          <div
            className="text-base leading-[1.7] wrap-break-word text-foreground"
            data-testid="message-text"
            data-streaming
          >
            <MessageMarkdown live>{streamingContent}</MessageMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
