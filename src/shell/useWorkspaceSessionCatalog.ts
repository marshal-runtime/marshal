// Renderer-owned workspace session catalog.
import { DEFAULT_SESSION_NAME } from "@common/marshal-ipc-contract";
import { useState, useRef, useCallback } from "react";

/**
 * Manages workspace session state: 1:N mapping of workspaces to sessions,
 * active session tracking per workspace, and CRUD handlers.
 *
 * Extracted from useSessionManager to keep each hook focused on a single concern.
 */
export function useWorkspaceSessions() {
  // 1:N mapping — each workspace can have multiple sessions
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, string[]>>({});
  // Track which session is active per workspace
  const [activeWorkspaceSession, setActiveWorkspaceSession] = useState<Record<string, string>>({});
  const newWorkspaceChatInFlight = useRef(false);
  const pendingWorkspaceSessions = useRef(new Set<string>());
  // Last session created by "New Chat" — passed to main process for double-click guard
  const lastNewChatSessionId = useRef<string | undefined>(undefined);

  /** Restore workspace session mappings from persisted session list (called on init). */
  const restoreFromSessions = useCallback(
    (
      sessions: Array<{ id: string; source?: string; workspaceName?: string; updatedAt?: string }>,
    ) => {
      const wsMap: Record<string, string[]> = {};
      const wsActive: Record<string, string> = {};
      for (const s of sessions) {
        if (s.source === "workspace" && s.workspaceName) {
          if (!wsMap[s.workspaceName]) wsMap[s.workspaceName] = [];
          wsMap[s.workspaceName].push(s.id);
        }
      }
      // Sort each workspace's sessions by updatedAt (most recent first)
      for (const [ws, ids] of Object.entries(wsMap)) {
        const sorted = ids.sort((a, b) => {
          const sa = sessions.find((s) => s.id === a);
          const sb = sessions.find((s) => s.id === b);
          return (sb?.updatedAt ?? "").localeCompare(sa?.updatedAt ?? "");
        });
        wsMap[ws] = sorted;
        wsActive[ws] = sorted[0];
      }
      if (Object.keys(wsMap).length > 0) {
        setWorkspaceSessions(wsMap);
        setActiveWorkspaceSession(wsActive);
      }
    },
    [],
  );

  /** Ensure a workspace has at least one session. No-op if it already does. */
  const handleWorkspaceSessionNeeded = useCallback(
    (workspaceName: string) => {
      if (workspaceSessions[workspaceName]?.length > 0) return;
      if (pendingWorkspaceSessions.current.has(workspaceName)) return;
      pendingWorkspaceSessions.current.add(workspaceName);
      void window.sessionsAPI
        ?.create(undefined, undefined, {
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName,
        })
        .then((result) => {
          if (result.success && result.session) {
            const id = result.session.id;
            setWorkspaceSessions((prev) => ({
              ...prev,
              [workspaceName]: [...(prev[workspaceName] ?? []), id],
            }));
            setActiveWorkspaceSession((prev) => ({ ...prev, [workspaceName]: id }));
          }
        })
        .finally(() => {
          pendingWorkspaceSessions.current.delete(workspaceName);
        });
    },
    [workspaceSessions, setActiveWorkspaceSession],
  );

  /** Create a new session in a workspace and make it active. */
  const handleNewWorkspaceSession = useCallback(
    async (workspaceName: string) => {
      if (newWorkspaceChatInFlight.current) return;
      newWorkspaceChatInFlight.current = true;
      try {
        if (!window.sessionsAPI) return;

        // Check if the last "New Chat" session is still empty — reuse it
        const reuseResult = await window.sessionsAPI.createOrReuseEmpty({
          source: "workspace",
          workspaceName,
          activeSessionId: lastNewChatSessionId.current,
        });
        if (reuseResult.success && reuseResult.reused && reuseResult.session) {
          setActiveWorkspaceSession((prev) => ({
            ...prev,
            [workspaceName]: reuseResult.session!.id,
          }));
          return;
        }

        // No reusable session — create a new one
        const createResult = await window.sessionsAPI.create(undefined, undefined, {
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName,
        });
        if (createResult.success && createResult.session) {
          const id = createResult.session.id;
          lastNewChatSessionId.current = id;
          setWorkspaceSessions((prev) => ({
            ...prev,
            [workspaceName]: [id, ...(prev[workspaceName] ?? [])],
          }));
          setActiveWorkspaceSession((prev) => ({ ...prev, [workspaceName]: id }));
        }
      } finally {
        newWorkspaceChatInFlight.current = false;
      }
    },
    [setActiveWorkspaceSession],
  );

  /** Switch the active session within a workspace. */
  const handleSwitchWorkspaceSession = useCallback(
    async (workspaceName: string, sessionId: string) => {
      if (!window.sessionsAPI) return;
      const result = await window.sessionsAPI.switch(sessionId);
      if (result.success) {
        setActiveWorkspaceSession((prev) => ({ ...prev, [workspaceName]: sessionId }));
      }
    },
    [setActiveWorkspaceSession],
  );

  /** Delete a session from a workspace and switch to the next one (or create new). */
  const handleDeleteWorkspaceSession = useCallback(
    async (workspaceName: string, sessionId: string) => {
      if (!window.sessionsAPI) return;
      const result = await window.sessionsAPI.delete(sessionId);
      if (!result.success) return;

      // Compute remaining from current state before calling setters
      const remaining = (workspaceSessions[workspaceName] ?? []).filter((id) => id !== sessionId);
      setWorkspaceSessions((prev) => ({ ...prev, [workspaceName]: remaining }));

      const wasActive = activeWorkspaceSession[workspaceName] === sessionId;
      if (wasActive) {
        if (remaining.length > 0) {
          await window.sessionsAPI.switch(remaining[0]);
          setActiveWorkspaceSession((prev) => ({ ...prev, [workspaceName]: remaining[0] }));
        } else {
          // No sessions left — create a new one
          const r = await window.sessionsAPI.create(undefined, undefined, {
            name: DEFAULT_SESSION_NAME,
            source: "workspace",
            workspaceName,
          });
          if (r.success && r.session) {
            const id = r.session.id;
            setWorkspaceSessions((p) => ({ ...p, [workspaceName]: [id] }));
            setActiveWorkspaceSession((p) => ({ ...p, [workspaceName]: id }));
          }
        }
      }
    },
    [workspaceSessions, activeWorkspaceSession, setActiveWorkspaceSession],
  );

  return {
    workspaceSessions,
    activeWorkspaceSession,
    restoreFromSessions,
    handleWorkspaceSessionNeeded,
    handleNewWorkspaceSession,
    handleSwitchWorkspaceSession,
    handleDeleteWorkspaceSession,
  };
}
