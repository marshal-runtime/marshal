import type { PermissionAction } from "@common/marshal-constants";
import { useMemo } from "react";

import type { PermissionCardData } from "@/types/electron";

import { useLiveSessionView } from "../hooks/useSessionView";
import type { ReasoningState } from "../types";
import { AssistantRun } from "./AssistantRun";
import type { ToolStatus } from "./ChatMessage";
import { LiveTrailing } from "./LiveTrailing";

interface LiveTurnProps {
  sessionId: string | null;
  soulId?: string | null;
  continuesAssistantRun: boolean;
  activeCards: PermissionCardData[];
  onRespond: (requestId: string, action: PermissionAction) => void;
  dismissedToolNoticeKeys: ReadonlySet<string>;
  onToolNoticeDismiss: (noticeKey: string) => void;
}

export function LiveTurn({
  sessionId,
  soulId,
  continuesAssistantRun,
  activeCards,
  onRespond,
  dismissedToolNoticeKeys,
  onToolNoticeDismiss,
}: LiveTurnProps) {
  const view = useLiveSessionView(sessionId);
  const isWaiting = view.status === "submitted" || view.status === "streaming";
  const reasoning: ReasoningState = useMemo(
    () => ({
      content: view.reasoning?.text ?? "",
      duration: view.reasoning?.durationSeconds ?? null,
    }),
    [view.reasoning],
  );
  const toolStatuses: ToolStatus[] = useMemo(
    () =>
      view.toolStatuses.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        activityKind: tool.activityKind,
        running: tool.running,
        input: tool.input,
        output: tool.output,
        success: tool.success,
        cancelled: tool.cancelled,
        error: tool.error,
      })),
    [view.toolStatuses],
  );

  if (!isWaiting && activeCards.length === 0) return null;

  const trailing = (
    <LiveTrailing
      isWaiting={isWaiting}
      sessionId={sessionId}
      streamingContent={view.streamingText}
      toolStatuses={toolStatuses}
      reasoning={reasoning}
      dismissedToolNoticeKeys={dismissedToolNoticeKeys}
      onToolNoticeDismiss={onToolNoticeDismiss}
      activeCards={activeCards}
      contentBlocks={view.contentBlocks}
    />
  );

  return (
    <div className={continuesAssistantRun ? "ml-12" : undefined} data-testid="live-turn">
      {continuesAssistantRun ? (
        trailing
      ) : (
        <AssistantRun
          items={[]}
          soulId={soulId}
          onPermissionRespond={onRespond}
          renderMessage={() => null}
          trailing={trailing}
        />
      )}
    </div>
  );
}
