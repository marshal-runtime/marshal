import { useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { toast } from "sonner";

import type { ChatPanelRef } from "@/features/chat";
import type { SessionData } from "@/features/chat/types";
import { getDefaultChatWorkspace } from "@/shared/default-workspace";
import type { MainSessionContextSelection, SessionMetadata } from "@/types/electron";
import type { SessionsAPI } from "@/types/electron";

import type { NavigateFn } from "./useNavigation";

const EMPTY_SESSION_DATA: SessionData = {
  messages: [],
  isBusy: false,
  soul: undefined,
  permissionCards: [],
  turnState: null,
};

interface UseSessionManagerOptions {
  chatPanelRef: RefObject<ChatPanelRef | null>;
  navigate: NavigateFn;
  onSessionsLoaded?: (
    sessions: Array<{ id: string; source?: string; workspaceName?: string; updatedAt?: string }>,
  ) => void;
}

export function useSessionManager({
  chatPanelRef,
  navigate,
  onSessionsLoaded,
}: UseSessionManagerOptions) {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const newChatInFlight = useRef(false);
  const sessionReplacementInFlight = useRef(false);
  const commitActiveSessionId = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, []);

  const replaceActiveSession = useCallback(
    async (args: {
      soulId?: string;
      selection?: MainSessionContextSelection;
      preserveCurrent: boolean;
      preserveDraftSource?: boolean;
      allowWithoutActive?: boolean;
    }) => {
      if (!window.sessionsAPI) return;
      const previousSessionId = activeSessionIdRef.current;
      if (!previousSessionId && !args.allowWithoutActive) return;
      if (sessionReplacementInFlight.current) {
        throw new Error("A main-session context change is already in progress");
      }
      sessionReplacementInFlight.current = true;
      const sourceDraft = chatPanelRef.current?.getInput() ?? "";
      try {
        const result = await window.sessionsAPI.createMain(undefined, args.soulId, {
          ...args.selection,
          ...(args.preserveCurrent || !previousSessionId
            ? {}
            : { replaceEmptySessionId: previousSessionId }),
        });
        if (!result.success || !result.session) {
          throw new Error(result.error || "Could not create the selected main-session context");
        }

        const session: SessionMetadata = result.session;
        const primed: SessionData = {
          ...EMPTY_SESSION_DATA,
          soul: session.soul,
          ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}),
          ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
          ...(session.repositoryAgent ? { repositoryAgent: session.repositoryAgent } : {}),
        };
        queryClient.setQueryData<SessionData>(["session", session.id], primed);
        if (args.preserveDraftSource) {
          chatPanelRef.current?.migrateDraftToSession(previousSessionId, session.id, sourceDraft, {
            preserveSource: true,
          });
        } else {
          chatPanelRef.current?.migrateDraftToSession(previousSessionId, session.id, sourceDraft);
        }
        if (activeSessionIdRef.current !== previousSessionId) {
          const currentSessionId = activeSessionIdRef.current;
          if (currentSessionId) await window.sessionsAPI.switch(currentSessionId);
          throw new Error("The active chat changed before the context change completed");
        }
        commitActiveSessionId(session.id);
        chatPanelRef.current?.clearChat();
      } finally {
        sessionReplacementInFlight.current = false;
      }
    },
    [chatPanelRef, commitActiveSessionId, queryClient],
  );

  // Refresh driven by sessions:list-changed (see useSessions.ts)

  // Listen for main process telling us to switch sessions (e.g. automation runs)
  useEffect(() => {
    if (!window.sessionsAPI?.onSwitchTo) return undefined;
    const unsubscribe = window.sessionsAPI.onSwitchTo(async (sessionId: string) => {
      if (sessionReplacementInFlight.current) return;
      const result = await window.sessionsAPI.switch(sessionId);
      if (result.success) {
        // Transitional pending TanStack Router Phase 2b: the route
        // loader takes over session selection and this fallback gets deleted
        // along with activeSessionId. Hydrating responses omit session; fall
        // back to the input id.
        const activeId = result.session?.id ?? sessionId;
        commitActiveSessionId(activeId);
        navigate("chat", { sessionId: activeId });
      }
    });
    return unsubscribe;
  }, [commitActiveSessionId, navigate]);

  // Initialize: load existing sessions or create first one
  useEffect(() => {
    let cancelled = false;

    const initSessions = async () => {
      // Wait for sessionsAPI to be available (in case of timing issues)
      if (typeof window !== "undefined" && window.process?.versions?.electron) {
        let attempts = 0;
        const maxAttempts = 50;
        while (!window.sessionsAPI && attempts < maxAttempts) {
          // eslint-disable-next-line no-await-in-loop -- sequential retry
          await new Promise((resolve) => setTimeout(resolve, 100));
          attempts++;
        }
      }

      if (!window.sessionsAPI) return;

      type SessionListResult = Awaited<ReturnType<SessionsAPI["listWithOptions"]>>;
      let result: SessionListResult;
      let workspaceResult: SessionListResult;
      if (window.sessionsAPI.listWithOptions) {
        [result, workspaceResult] = await Promise.all([
          window.sessionsAPI.listWithOptions({
            excludeSources: ["workspace"],
            limit: 40,
          }),
          window.sessionsAPI.listWithOptions({ sources: ["workspace"] }),
        ]);
      } else {
        const legacyResult = await window.sessionsAPI.list();
        result = legacyResult;
        workspaceResult = legacyResult;
      }
      if (cancelled) return;

      if (workspaceResult.success) {
        onSessionsLoaded?.(workspaceResult.sessions ?? []);
      }

      if (result.success && result.sessions && result.sessions.length > 0) {
        // Switch to most recent non-workspace session (or first one)
        const selectedSession = result.selectedSession;
        const chatSession =
          (selectedSession?.source !== "workspace" && selectedSession?.source !== "workflow-run"
            ? selectedSession
            : undefined) ??
          result.sessions.find((s) => s.source !== "workspace" && s.source !== "workflow-run") ??
          result.sessions[0];
        const switchResult = await window.sessionsAPI.switch(chatSession.id);
        if (!cancelled && switchResult.success) {
          commitActiveSessionId(switchResult.session?.id ?? chatSession.id);
        }
      } else {
        // Create first session
        const createResult = await window.sessionsAPI.create(undefined, undefined, {
          source: "user",
        });
        if (!cancelled && createResult.success && createResult.session) {
          commitActiveSessionId(createResult.session.id);
        }
      }
    };
    void initSessions();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-compiler/exhaustive-deps -- init runs once on mount
  }, []);

  const handleNewChat = useCallback(
    async (requestedWorkspaceName?: string) => {
      if (sessionReplacementInFlight.current) return;
      if (newChatInFlight.current) return;
      newChatInFlight.current = true;
      try {
        navigate("chat");
        if (!window.sessionsAPI) return;

        const workspaceName = requestedWorkspaceName ?? getDefaultChatWorkspace();
        // A workspace binding describes where an ordinary chat operates; it does
        // not make the chat a legacy workspace-panel session. The sidebar excludes
        // source="workspace", so classifying New Chat that way makes it disappear
        // as soon as the session list refetches.
        const creationContext = workspaceName
          ? ({ source: "user", workspaceName } as const)
          : ({ source: "user" } as const);

        // If the current session has a draft, always create a new session
        // to preserve the draft (don't reuse the empty session).
        const hasDraft = chatPanelRef.current?.hasInput() ?? false;
        if (!hasDraft) {
          const reuseResult = await window.sessionsAPI.createOrReuseEmpty(creationContext);
          if (reuseResult.success && reuseResult.reused && reuseResult.session) {
            commitActiveSessionId(reuseResult.session.id);
            chatPanelRef.current?.clearChat();
            setTimeout(() => chatPanelRef.current?.focusInput(), 50);
            return;
          }
        }

        // Has draft or no reusable session — create a new one
        const createResult = await window.sessionsAPI.create(undefined, undefined, creationContext);
        if (createResult.success && createResult.session) {
          commitActiveSessionId(createResult.session.id);
          chatPanelRef.current?.clearChat();
          setTimeout(() => chatPanelRef.current?.focusInput(), 50);
        }
      } finally {
        newChatInFlight.current = false;
      }
    },
    [navigate, chatPanelRef, commitActiveSessionId],
  );

  const handleSoulChange = useCallback(
    async (soulId: string, selection?: MainSessionContextSelection) => {
      try {
        await replaceActiveSession({
          soulId,
          selection,
          preserveCurrent: false,
        });
      } catch (error) {
        toast.error("Could not change soul", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [replaceActiveSession],
  );

  const handleWorkspaceRoleChange = useCallback(
    async (
      selection: MainSessionContextSelection,
      context: { hasUserMessages: boolean; soulId?: string },
    ) => {
      await replaceActiveSession({
        soulId: context.soulId,
        selection,
        preserveCurrent: context.hasUserMessages,
        preserveDraftSource: context.hasUserMessages,
        allowWithoutActive: true,
      });
    },
    [replaceActiveSession],
  );

  const handleSessionSelect = useCallback(
    async (sessionId: string) => {
      if (!window.sessionsAPI) return;
      if (sessionReplacementInFlight.current) return;
      // Selection is a local navigation action. Do not hold the sidebar highlight
      // and chat pane behind memory refresh/backend resume work in the main
      // process; popout windows already bind directly to the requested ID.
      commitActiveSessionId(sessionId);
      const result = await window.sessionsAPI.switch(sessionId);
      if (result.success && result.session?.id && result.session.id !== sessionId) {
        commitActiveSessionId(result.session.id);
      }
    },
    [commitActiveSessionId],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (window.sessionsAPI) {
        const result = await window.sessionsAPI.delete(sessionId);
        if (result.success) {
          chatPanelRef.current?.clearDraft(sessionId);
          if (result.newActiveId) {
            commitActiveSessionId(result.newActiveId);
          } else {
            const createResult = await window.sessionsAPI.create(undefined, undefined, {
              source: "user",
            });
            if (createResult.success && createResult.session) {
              commitActiveSessionId(createResult.session.id);
            }
          }
        }
      }
    },
    [chatPanelRef, commitActiveSessionId],
  );

  return {
    activeSessionId,
    handleNewChat,
    handleSessionSelect,
    handleDeleteSession,
    handleSoulChange,
    handleWorkspaceRoleChange,
  };
}
