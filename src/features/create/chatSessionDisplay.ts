import { DEFAULT_SESSION_NAME, isHiddenInternalControlMessage } from "@common/marshal-ipc-contract";
import { useQuery } from "@tanstack/react-query";

import type { StoredSession } from "@/types/electron";

export interface ChatSessionSummary {
  id: string;
  name: string;
  updatedAt: string;
  isBusy: boolean;
  lastMessage?: string;
}

export interface ChatSessionPlaceholderText {
  welcomeText: string;
  inputPlaceholder: string;
}

export function getChatSessionPreview(
  session: Pick<StoredSession, "messages">,
): string | undefined {
  return session.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !isHiddenInternalControlMessage(message) &&
        !message.goalContinuation &&
        !message.suppressedAgentStatusResponse,
    )
    .map((message) => message.content.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .at(-1);
}

export function deriveChatSessionSummary(
  session: Pick<StoredSession, "id" | "name" | "updatedAt" | "messages">,
  isBusy = false,
): ChatSessionSummary {
  return {
    id: session.id,
    name: session.name,
    updatedAt: session.updatedAt,
    isBusy,
    lastMessage: getChatSessionPreview(session),
  };
}

export function deriveChatSessionPlaceholderText({
  workspaceName,
  activeSessionName,
}: {
  workspaceName?: string | null;
  activeSessionName?: string | null;
}): ChatSessionPlaceholderText {
  const workspace = workspaceName?.trim();
  const sessionName = activeSessionName?.trim();
  const namedSession =
    sessionName && sessionName !== DEFAULT_SESSION_NAME ? sessionName : undefined;

  if (workspace && namedSession) {
    return {
      welcomeText: `Continue ${namedSession} in ${workspace}`,
      inputPlaceholder: `Ask about ${namedSession}...`,
    };
  }

  if (workspace) {
    return {
      welcomeText: `Start a workspace chat for ${workspace}`,
      inputPlaceholder: `Ask about ${workspace}...`,
    };
  }

  if (namedSession) {
    return {
      welcomeText: `Continue ${namedSession}`,
      inputPlaceholder: `Ask about ${namedSession}...`,
    };
  }

  return {
    welcomeText: "Start a workspace chat",
    inputPlaceholder: "Ask about this workspace...",
  };
}

export function workspaceSessionSummariesQueryKey(sessionIds: string[]) {
  return ["workspace", "sessions", sessionIds] as const;
}

async function fetchWorkspaceSessionSummaries(sessionIds: string[]): Promise<ChatSessionSummary[]> {
  if (!window.sessionsAPI || sessionIds.length === 0) return [];

  const results = await Promise.all(
    sessionIds.map((id) => window.sessionsAPI.get(id, { messageLimit: 1 })),
  );
  return results
    .filter((result): result is typeof result & { session: StoredSession } =>
      Boolean(result.success && result.session),
    )
    .map((result) => deriveChatSessionSummary(result.session, !!result.isBusy));
}

export function useWorkspaceSessionSummaries(
  sessionIds: string[],
  refetchInterval: number | false,
) {
  return useQuery({
    queryKey: workspaceSessionSummariesQueryKey(sessionIds),
    queryFn: () => fetchWorkspaceSessionSummaries(sessionIds),
    enabled: sessionIds.length > 0,
    refetchInterval,
  });
}
