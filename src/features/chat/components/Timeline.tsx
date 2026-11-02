import type { PermissionAction } from "@common/marshal-constants";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, type RefObject } from "react";

import { RuntimeUiMessageCards } from "@/features/runtime-ui/cards/ConversationCards";
import { usePublishTimelineMessages } from "@/features/runtime-ui/cards/conversationCardStore";
import { TelemetryPath } from "@/services/telemetry/opensource";
import { TelemetryPath_Message } from "@/services/telemetry/schema";

import type { TimelineRun } from "../hooks/useTimeline";
import { AssistantRun } from "./AssistantRun";
import { ChatMessage } from "./ChatMessage";
import { TimelineBoundary } from "./TimelineBoundary";
import { useRowResizeMeasure } from "./useRowResizeMeasure";

interface TimelineProps {
  runs: TimelineRun[];
  scrollRef: RefObject<HTMLElement | null>;
  sessionId?: string | null;
  soulId?: string | null;
  onPermissionRespond: (requestId: string, action: PermissionAction) => void;
  onPermissionDismiss?: (requestId: string) => void;
  onMessageDismiss?: (messageId: string) => void;
  dismissedToolNoticeKeys?: ReadonlySet<string>;
  onToolNoticeDismiss?: (noticeKey: string) => void;
  onActionSelect?: (messageId: string, label: string) => void;
  retainedAnchorMessageId?: string | null;
}

export function Timeline({
  runs,
  scrollRef,
  sessionId,
  soulId,
  onPermissionRespond,
  onPermissionDismiss,
  onMessageDismiss,
  dismissedToolNoticeKeys,
  onToolNoticeDismiss,
  onActionSelect,
  retainedAnchorMessageId,
}: TimelineProps) {
  const virtualListRef = useRef<HTMLDivElement>(null);
  const retainedAnchorRunIndex = retainedAnchorMessageId
    ? runs.findIndex((run) =>
        run.items.some(
          (item) => item.kind === "message" && item.data.id === retainedAnchorMessageId,
        ),
      )
    : -1;
  const estimateRunSize = (index: number) => {
    const role = runs[index]?.role;
    if (role === "assistant") return 180;
    if (role === "event") return 96;
    if (role === "system") return 80;
    return 96;
  };
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => {
      const run = runs[index];
      if (!run) return "live-run";
      const first = run.items[0];
      return first?.kind === "permissions" ? (first.data[0]?.id ?? `run-${index}`) : first.data.id;
    },
    estimateSize: estimateRunSize,
    measureElement: (element) => {
      const measured = element.getBoundingClientRect().height;
      if (measured > 0) return measured;
      const index = Number(element.getAttribute("data-index"));
      return estimateRunSize(index);
    },
    overscan: 6,
    rangeExtractor: (range) => {
      const start = Math.max(0, range.startIndex - range.overscan);
      const end = Math.min(range.count - 1, range.endIndex + range.overscan);
      const indexes = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
        return start + index;
      });
      if (retainedAnchorRunIndex >= 0 && !indexes.includes(retainedAnchorRunIndex)) {
        indexes.push(retainedAnchorRunIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    initialRect: { width: 720, height: 800 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback(rect.height > 0 ? rect : { width: rect.width || 720, height: 800 }),
      ),
    scrollMargin: virtualListRef.current?.offsetTop ?? 0,
  });

  const measureRow = useRowResizeMeasure(virtualizer.measureElement);

  const timelineMessages = useMemo(
    () =>
      runs.flatMap((run) =>
        run.items.flatMap((item) =>
          item.kind === "message" ? [{ id: item.data.id, at: item.data.timestamp.getTime() }] : [],
        ),
      ),
    [runs],
  );
  usePublishTimelineMessages(timelineMessages);

  const renderRun = (index: number) => {
    const run = runs[index];
    if (!run) return null;
    return (
      <>
        {renderRunBody(run, index)}
        <RuntimeUiMessageCards
          messageIds={run.items.flatMap((item) => (item.kind === "message" ? [item.data.id] : []))}
        />
      </>
    );
  };

  const renderRunBody = (run: TimelineRun, index: number) => {
    if (run.role === "event") {
      return (
        <TelemetryPath id={index}>
          <TelemetryPath_Message>
            <TimelineBoundary message={run.items[0].data} />
          </TelemetryPath_Message>
        </TelemetryPath>
      );
    }

    if (run.role !== "assistant") {
      return (
        <TelemetryPath id={index}>
          <TelemetryPath_Message>
            <ChatMessage
              message={run.items[0].data}
              sessionId={sessionId}
              onDismiss={onMessageDismiss}
              dismissedToolNoticeKeys={dismissedToolNoticeKeys}
              onToolNoticeDismiss={onToolNoticeDismiss}
              onActionSelect={onActionSelect}
            />
          </TelemetryPath_Message>
        </TelemetryPath>
      );
    }
    return (
      <TelemetryPath id={index}>
        <TelemetryPath_Message>
          <AssistantRun
            items={run.items}
            soulId={soulId}
            onPermissionRespond={onPermissionRespond}
            onPermissionDismiss={onPermissionDismiss}
            renderMessage={(message) => (
              <ChatMessage
                message={message}
                sessionId={sessionId}
                onDismiss={onMessageDismiss}
                dismissedToolNoticeKeys={dismissedToolNoticeKeys}
                onToolNoticeDismiss={onToolNoticeDismiss}
                onActionSelect={onActionSelect}
              />
            )}
          />
        </TelemetryPath_Message>
      </TelemetryPath>
    );
  };

  return (
    <>
      {/* Spacer — replaces removed DateSeparator */}
      <div className="h-9 shrink-0" aria-hidden="true" />
      <div
        ref={virtualListRef}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
        data-testid="timeline-virtual-list"
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            ref={measureRow}
            data-index={virtualRow.index}
            data-testid="timeline-virtual-row"
            className="absolute top-0 left-0 w-full pb-4"
            style={{
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {renderRun(virtualRow.index)}
          </div>
        ))}
      </div>
    </>
  );
}
