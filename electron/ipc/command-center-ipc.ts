import { createLogger } from "../../common/marshal-logger";
import type { CommandCenterManager } from "../command-center/manager";
import type { IpcDeps } from "./types";

const log = createLogger("CommandCenterIpc");

export interface CommandCenterIpcDeps {
  ipcHandle: IpcDeps["ipcHandle"];
  getWindow: IpcDeps["getWindow"];
  sessionManager: IpcDeps["sessionManager"];
  commandCenterManager: CommandCenterManager;
}

export function registerCommandCenterHandlers({
  ipcHandle,
  getWindow,
  sessionManager,
  commandCenterManager,
}: CommandCenterIpcDeps): void {
  commandCenterManager.attachBroadcaster((snapshot) => {
    getWindow()?.webContents.send("command-center:snapshot", snapshot);
  });

  ipcHandle("command-center:getSnapshot", () => {
    try {
      return { success: true, snapshot: commandCenterManager.getSnapshot() };
    } catch (err) {
      log.warn("command-center:getSnapshot failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcHandle("command-center:refresh", () => {
    try {
      return { success: true, snapshot: commandCenterManager.refresh() };
    } catch (err) {
      log.warn("command-center:refresh failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcHandle("command-center:upsertTodo", async (_event, todo) => {
    try {
      return { success: true, snapshot: await commandCenterManager.upsertTodo(todo) };
    } catch (err) {
      log.warn("command-center:upsertTodo failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcHandle("command-center:deleteTodo", async (_event, todoId) => {
    try {
      return { success: true, snapshot: await commandCenterManager.deleteTodo(todoId) };
    } catch (err) {
      log.warn("command-center:deleteTodo failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcHandle("command-center:openSession", async (_event, sessionReference) => {
    try {
      const sessions = await sessionManager.listSessions();
      const sessionId =
        commandCenterManager.resolveSessionId(
          sessionReference,
          sessions.map((session) => session.id),
        ) ??
        sessions.find((session) => session.id === sessionReference)?.id ??
        sessions.find((session) => session.backendId === sessionReference)?.id;
      if (!sessionId) {
        return { success: false, error: "Session not found" };
      }
      const session = await sessionManager.switchSession(sessionId);
      if (!session) {
        return { success: false, error: "Session not found" };
      }
      getWindow()?.webContents.send("sessions:switch-to", sessionId);
      return { success: true };
    } catch (err) {
      log.warn("command-center:openSession failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcHandle("command-center:getSessionActivity", async (_event, sessionId) => {
    try {
      const sessions = await sessionManager.listSessionActivityTree(sessionId);
      return {
        success: true,
        activity: commandCenterManager.getSessionActivity(sessionId, sessions),
        sessions,
      };
    } catch (err) {
      log.warn("command-center:getSessionActivity failed:", err);
      return { success: false, error: errorMessage(err) };
    }
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
