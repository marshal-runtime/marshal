import type {
  SessionListOptions,
  SessionPermissionMode,
  SessionSandboxConfig,
  SessionSource,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type { PermissionPolicy } from "../permission-policy";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { SessionViewIpcBroker } from "../session-view-ipc-broker";
import { summarizeMessageToolCalls } from "../session-view-payload";
import type { IpcDeps } from "./types";
import { withTimeout } from "./with-timeout";

const log = createLogger("SessionsIpc");

function withoutMessages<T extends { messages: unknown[] }>(session: T): T {
  return { ...session, messages: [] };
}

export function registerSessionsHandlers({
  sessionManager,
  ipcHandle,
  permissionPolicy,
  sessionViewIpcBroker,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle"> & {
  permissionPolicy: PermissionPolicy;
  sessionViewIpcBroker: SessionViewIpcBroker;
}) {
  sharedIpcHandle(ipcHandle)("sessions:list", async (query?: string) => {
    try {
      if (query?.trim()) {
        const results = await sessionManager.searchSessions(query.trim());
        return { success: true, results };
      }
      const sessions = await sessionManager.listSessions();
      return { success: true, sessions };
    } catch (error) {
      log.error("Failed to list sessions:", error);
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("sessions:listWithOptions", async (options?: SessionListOptions) => {
    try {
      const query = options?.query?.trim();
      if (query) {
        const results = await sessionManager.searchSessions(query);
        return { success: true, results };
      }
      if (options?.limit !== undefined || options?.beforeSessionId !== undefined) {
        const page = await sessionManager.listSessionsPage(options);
        return { success: true, ...page };
      }
      const sessions = await sessionManager.listSessions({
        includeWorkflowRuns: options?.includeWorkflowRuns,
        sources: options?.sources,
        excludeSources: options?.excludeSources,
      });
      return { success: true, sessions };
    } catch (error) {
      log.error("Failed to list sessions:", error);
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "sessions:create",
    async (
      model?: string,
      soul?: string,
      options?: {
        name?: string;
        source?: SessionSource;
        parentSessionId?: string;
        permissionMode?: SessionPermissionMode;
        workspaceName?: string;
        setActive?: boolean;
        sandbox?: SessionSandboxConfig;
      },
    ) => {
      try {
        const session =
          options?.source === "user" || options?.source === "workspace"
            ? await sessionManager.createInteractiveSession(model, soul, options)
            : await sessionManager.createSession(model, soul, options);
        return { success: true, session };
      } catch (error) {
        log.error("Failed to create session:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("sessions:createMain", async (_event, model, soul, selection) => {
    try {
      const session = await sessionManager.createMainSession(model, soul, selection);
      return { success: true, session };
    } catch (error) {
      log.error("Failed to create main session:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "sessions:createOrReuseEmpty",
    async (
      _event,
      options?: {
        source?: "user" | "workspace";
        workspaceName?: string;
        activeSessionId?: string;
      },
    ) => {
      try {
        const reused = await sessionManager.findAndReuseEmpty(
          options?.source,
          options?.activeSessionId,
          options?.workspaceName,
        );
        if (reused) {
          return { success: true, session: reused, reused: true };
        }
        // No reusable session — caller should use sessions:create
        return { success: true, session: undefined, reused: false };
      } catch (error) {
        log.error("Failed to find reusable empty session:", error);
        return { success: false, reused: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)("sessions:compact", async (sessionId: string) => {
    try {
      await sessionManager.compactSession(sessionId);
      return { success: true };
    } catch (error) {
      log.error("Failed to compact session:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("sessions:switch", async (_event, sessionId: string) => {
    try {
      const result = await sessionManager.switchSession(sessionId);
      if (result.kind === "loaded") {
        return { success: true, session: withoutMessages(result.session) };
      }
      if (result.kind === "hydrating") return { success: true, hydrating: true };
      return { success: false, error: "Session not found" };
    } catch (error) {
      log.error("Failed to switch session:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("sessions:delete", async (_event, sessionId: string) => {
    try {
      const newActiveId = await sessionManager.deleteSession(sessionId, { cause: "user-ipc" });
      // Per-session cleanup chain runs inside SessionManager.deleteSession
      // via the delete-hook registry (composed by main.ts).
      return { success: true, newActiveId };
    } catch (error) {
      log.error("Failed to delete session:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("sessions:delete-all", async (_event, options) => {
    try {
      if (options?.preserveWorkflowGroups) {
        await withTimeout(30_000, sessionManager.deleteAllSessionsPreservingWorkflowGroups());
        return { success: true };
      }
      permissionPolicy.clearAll();
      await withTimeout(30_000, sessionManager.deleteAllSessions());
      return { success: true };
    } catch (error) {
      log.error("Failed to delete all sessions:", error);
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "sessions:rename",
    async (sessionId: string, name: string, aiGeneratedTitle?: string) => {
      try {
        await sessionManager.renameSession(sessionId, name, aiGeneratedTitle);
        return { success: true };
      } catch (error) {
        log.error("Failed to rename session:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)("sessions:mark-read", async (sessionId: string) => {
    try {
      sessionManager.markRead(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("sessions:setPinned", async (sessionId: string, pinned: boolean) => {
    try {
      const applied = await sessionManager.setPinned(sessionId, pinned);
      if (!applied) return { success: false, error: `Session not found: ${sessionId}` };
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "sessions:get",
    async (sessionId: string, options?: { messageLimit?: number }) => {
      try {
        const isBusy = sessionManager.isSessionBusy(sessionId);
        const turnState = isBusy ? sessionManager.getTurnState(sessionId) : undefined;
        const messageLimit = options?.messageLimit;

        // Paginated path: resolve only the last `messageLimit` messages without
        // reconstructing the full chunked history.
        if (messageLimit !== undefined) {
          const page = await sessionManager.getSessionMessagesPage(sessionId, messageLimit, true);
          return {
            success: true,
            session: page
              ? {
                  ...page.session,
                  messages: page.session.messages.map(summarizeMessageToolCalls),
                }
              : undefined,
            isBusy,
            turnState: turnState ?? undefined,
            messagePage: page ? { hasMore: page.hasMore, total: page.total } : undefined,
          };
        }

        const session = (await sessionManager.getSessionForDisplay(sessionId)) ?? undefined;
        return {
          success: true,
          session,
          isBusy,
          turnState: turnState ?? undefined,
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)(
    "sessions:getMessages",
    async (sessionId: string, options?: { beforeMessageId?: string; limit?: number }) => {
      try {
        const session = await sessionManager.getSessionForDisplay(sessionId);
        if (!session) return { success: false, error: "Session not found" };
        const limit = Math.max(1, Math.min(options?.limit ?? 20, 200));
        const beforeIndex = options?.beforeMessageId
          ? session.messages.findIndex((message) => message.id === options.beforeMessageId)
          : session.messages.length;
        const end = beforeIndex >= 0 ? beforeIndex : session.messages.length;
        const start = Math.max(0, end - limit);
        return {
          success: true,
          messages: session.messages.slice(start, end).map(summarizeMessageToolCalls),
          hasMore: start > 0,
          total: session.messages.length,
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)(
    "sessions:getToolCallDetails",
    async (sessionId: string, messageId: string, toolCallIndex: number) => {
      try {
        const session = await sessionManager.getSessionForDisplay(sessionId);
        const message = session?.messages.find((candidate) => candidate.id === messageId);
        const toolCall = message?.toolCalls?.[toolCallIndex];
        return toolCall
          ? { success: true, toolCall }
          : { success: false, error: "Tool call not found" };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)("sessions:getView", (sessionId: string) => {
    try {
      const { view } = sessionManager.getSessionView(sessionId);
      return { success: true, view };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("sessions:subscribeView", (event, sessionId: string) => {
    try {
      return {
        success: true,
        snapshot: sessionViewIpcBroker.subscribe(event.sender.id, sessionId),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("sessions:unsubscribeView", (event, sessionId: string) => {
    sessionViewIpcBroker.unsubscribe(event.sender.id, sessionId);
    return { success: true };
  });

  ipcHandle("sessions:ackView", (event, sessionId: string, epoch: string, sequence: number) => ({
    success: true,
    accepted: sessionViewIpcBroker.acknowledge(event.sender.id, sessionId, epoch, sequence),
  }));

  ipcHandle("sessions:resyncView", (event, sessionId: string) => {
    try {
      return {
        success: true,
        snapshot: sessionViewIpcBroker.resync(event.sender.id, sessionId),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("sessions:setModel", async (sessionId: string, model: string) => {
    try {
      await sessionManager.setSessionModel(sessionId, model);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "sessions:patchQuestionSelection",
    async (sessionId: string, messageId: string, selectedAnswer: string) => {
      try {
        const success = sessionManager.patchQuestionSelection(sessionId, messageId, selectedAnswer);
        return success
          ? { success: true }
          : { success: false, error: "Message or question not found" };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle(
    "sessions:messageSubagent",
    async (
      _event,
      sessionId: string,
      message: string,
      options?: {
        deliveryMode?: "wait-if-idle" | "queue" | "interrupt";
        waitForResponse?: boolean;
        timeoutMs?: number;
        replaceQueued?: boolean;
      },
    ) => {
      try {
        return await sessionManager.sendMessageToSubagent({
          sessionId,
          message,
          deliveryMode: options?.deliveryMode ?? "queue",
          waitForResponse: options?.waitForResponse ?? false,
          timeoutMs: options?.timeoutMs,
          ...(options?.replaceQueued ? { replaceQueued: true } : {}),
        });
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle(
    "sessions:sendReviewComments",
    async (
      _event,
      sessionId: string,
      message: string,
      options?: {
        deliveryMode?: "wait-if-idle" | "queue";
        waitForResponse?: boolean;
        timeoutMs?: number;
      },
    ) => {
      try {
        return await sessionManager.sendReviewCommentsToSession({
          sessionId,
          message,
          deliveryMode: options?.deliveryMode ?? "queue",
          waitForResponse: options?.waitForResponse ?? false,
          timeoutMs: options?.timeoutMs,
        });
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );
}
