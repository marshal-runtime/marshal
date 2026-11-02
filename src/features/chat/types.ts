import type {
  PermissionCardData,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
} from "@/types/electron";

import type { Message } from "./components/ChatMessage";

export interface ReasoningState {
  content: string;
  duration: number | null;
}

/** Shape of the ["session", sessionId] query cache entry. */
export interface SessionData {
  messages: Message[];
  isBusy: boolean;
  soul: string | undefined;
  permissionCards: PermissionCardData[];
  turnState: null;
  workspaceName?: string;
  workspaceIdentity?: WorkspaceInstanceIdentity;
  workspaceBindingInvalid?: boolean;
  repositoryAgent?: SessionRepositoryAgent;
  hasOlderMessages?: boolean;
  totalMessages?: number;
}
