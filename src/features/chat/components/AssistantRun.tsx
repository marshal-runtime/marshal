import type { PermissionAction } from "@common/marshal-constants";
import type { ReactNode } from "react";

import { MarshalBotIcon } from "@/assets/icons/nav-icons";
import type { PermissionCardData } from "@/types/electron";

import type { AssistantTimelineItem } from "../hooks/useTimeline";
import type { Message } from "./ChatMessage";
import { PermissionCard } from "./PermissionCard";

interface AssistantRunProps {
  items: AssistantTimelineItem[];
  soulId?: string | null;
  onPermissionRespond: (requestId: string, action: PermissionAction) => void;
  onPermissionDismiss?: (requestId: string) => void;
  /** Render a message item — delegates to ChatMessage without the avatar */
  renderMessage: (message: Message) => ReactNode;
  /** Extra node (streaming, pending permissions) appended as a trailing step */
  trailing?: ReactNode;
}

/**
 * Renders a group of consecutive assistant-side items (messages +
 * permission cards) under a single avatar with a connecting line.
 */
export function AssistantRun({
  items,
  onPermissionRespond,
  onPermissionDismiss,
  renderMessage,
  trailing,
}: AssistantRunProps) {
  return (
    <div className="flex gap-3" data-testid="assistant-run">
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-active-subtle text-foreground"
        data-testid="assistant-run-avatar"
      >
        <MarshalBotIcon className="text-foreground" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-4">
          {items.map((item, i) => (
            // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
            <div key={item.kind === "message" ? item.data.id : `perm-${i}`}>
              {item.kind === "message" ? (
                renderMessage(item.data)
              ) : (
                <div className="flex flex-col gap-2" data-testid="assistant-run-permissions">
                  {item.data.map((card: PermissionCardData) => (
                    <PermissionCard
                      key={card.id}
                      request={card}
                      onRespond={onPermissionRespond}
                      onDismiss={onPermissionDismiss}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {trailing && <div>{trailing}</div>}
        </div>
      </div>
    </div>
  );
}
