import { type RefObject } from "react";

import { ChatPanel, type ChatPanelRef } from "@/features/chat/components/ChatPanel";

import {
  deriveChatSessionPlaceholderText,
  useWorkspaceSessionSummaries,
} from "../chatSessionDisplay";
import { SessionActivityPanel } from "../SessionActivityPanel";
import { WorkspaceSessionList } from "../WorkspaceSessionList";

interface SecondarySidebarFallbackProps {
  sessionIds: string[];
  sessionId: string | null;
  activeWorkspace?: string | null;
  chatPanelRef: RefObject<ChatPanelRef | null>;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename?: (sessionId: string, name: string) => void;
}

export function SecondarySidebarFallback({
  sessionIds,
  sessionId,
  activeWorkspace,
  chatPanelRef,
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: SecondarySidebarFallbackProps) {
  const { data: sessions = [] } = useWorkspaceSessionSummaries(sessionIds, false);
  const activeSession = sessions.find((session) => session.id === sessionId);
  const placeholderText = deriveChatSessionPlaceholderText({
    workspaceName: activeWorkspace,
    activeSessionName: activeSession?.name,
  });

  return (
    <div className="relative flex size-full origin-top-left flex-col" style={{ zoom: 0.8 }}>
      <WorkspaceSessionList
        sessionIds={sessionIds}
        activeSessionId={sessionId}
        onSwitch={onSwitch}
        onNew={onNew}
        onDelete={onDelete}
        onRename={onRename}
      />
      <SessionActivityPanel sessionId={sessionId} />
      <div className="min-h-0 flex-1">
        <ChatPanel
          ref={chatPanelRef}
          sessionId={sessionId}
          welcomeContent={
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {placeholderText.welcomeText}
            </div>
          }
          hideAvatars
          hideAttachments
          hideTokenCounter
          inputPlaceholder={placeholderText.inputPlaceholder}
        />
      </div>
    </div>
  );
}
