import { useRef, useState, type ReactNode } from "react";

import { SessionActivityPanel } from "@/features/create/SessionActivityPanel";
import { RuntimeUiBottomPanelLayout } from "@/features/runtime-ui/RuntimeUiBottomPanel";
import { useElementSize } from "@/shared/hooks/useResizablePanel";

import { ChatPanel, type ChatPanelProps } from "./ChatPanel";

export function ChatPanelWithActivity({
  sessionId,
  secondaryPanel,
  ...props
}: ChatPanelProps & { secondaryPanel?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerSize = useElementSize(containerRef);
  const [activityWidth, setActivityWidth] = useState(sessionId ? 392 : 0);
  // Reserve space for chat even while the panel is expanded on a narrow window.
  const panelAvailableWidth = Math.max(
    0,
    containerSize.width - Math.min(360, containerSize.width * 0.4),
  );

  return (
    <div
      ref={containerRef}
      className="relative flex size-full overflow-hidden"
      data-testid="chat-panel-with-activity"
    >
      <div className="min-w-0 flex-1" data-testid="chat-panel-activity-reserved-space">
        <RuntimeUiBottomPanelLayout>
          <ChatPanel sessionId={sessionId} {...props} />
        </RuntimeUiBottomPanelLayout>
      </div>
      {secondaryPanel}
      <div
        className="h-full shrink-0 overflow-visible"
        style={{ width: sessionId ? Math.min(activityWidth, panelAvailableWidth) : 0 }}
        data-testid="chat-panel-activity-rail"
      >
        <SessionActivityPanel
          sessionId={sessionId ?? null}
          layout="rail"
          onLayoutWidthChange={setActivityWidth}
          availableWidth={panelAvailableWidth}
        />
      </div>
    </div>
  );
}
