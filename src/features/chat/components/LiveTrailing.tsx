import type { AssistantContentBlock } from "@common/marshal-ipc-contract";

import { RuntimeUiLiveTurn } from "@/features/runtime-ui/cards/ConversationCards";
import { SimplePropertyMonitor_IsStreaming } from "@/services/telemetry/schema";
import type { PermissionCardData } from "@/types/electron";

import type { ReasoningState } from "../types";
import { StreamingMessage, type ToolStatus } from "./ChatMessage";

interface LiveTrailingProps {
  isWaiting: boolean;
  sessionId: string | null;
  streamingContent: string;
  toolStatuses: ToolStatus[];
  reasoning: ReasoningState;
  dismissedToolNoticeKeys: ReadonlySet<string>;
  onToolNoticeDismiss: (noticeKey: string) => void;
  activeCards: PermissionCardData[];
  contentBlocks?: AssistantContentBlock[];
}

export function LiveTrailing({
  isWaiting,
  sessionId,
  streamingContent,
  toolStatuses,
  reasoning,
  dismissedToolNoticeKeys,
  onToolNoticeDismiss,
  activeCards,
  contentBlocks,
}: LiveTrailingProps) {
  if (!isWaiting && activeCards.length === 0) return null;
  return (
    <>
      {isWaiting && <SimplePropertyMonitor_IsStreaming value={true} />}
      {isWaiting && <RuntimeUiLiveTurn />}
      <StreamingMessage
        sessionId={sessionId}
        streamingContent={streamingContent}
        toolStatuses={toolStatuses}
        reasoning={reasoning}
        dismissedToolNoticeKeys={dismissedToolNoticeKeys}
        onToolNoticeDismiss={onToolNoticeDismiss}
        activePermissions={activeCards}
        contentBlocks={contentBlocks}
      />
    </>
  );
}
