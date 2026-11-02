/**
 * IPC handlers for chat-windows namespace.
 */
import type { ChatWindowManager } from "../../../chat-window-manager";
import type { IpcDeps } from "../../types";
import { isValidChatWindowBounds } from "./validation";

export interface ChatWindowsIpcDeps extends Pick<IpcDeps, "ipcHandle"> {
  // Narrow to just the method this layer needs — keeps `broadcast` and
  // `closeAll` out of the IPC handler's API surface (setter-narrowing
  // convention used elsewhere in the codebase).
  chatWindowManager: Pick<ChatWindowManager, "open">;
}

export function registerChatWindowsHandlers({
  ipcHandle,
  chatWindowManager,
}: ChatWindowsIpcDeps): void {
  ipcHandle("chat-windows:open", (_event, sessionId: string, bounds?: { x: number; y: number }) => {
    if (!sessionId || typeof sessionId !== "string") {
      return { success: false, error: "sessionId is required" };
    }
    // IPC is a runtime boundary — TS only guards the compile-time call site.
    // `null` propagates from JSON and is not caught by `!== undefined`; without
    // the typeof check, reading `.x` on null throws here. A NaN would also
    // propagate through the Math.max/min clamp (NaN-preserving) and land
    // BrowserWindow at (0, 0) on the primary display.
    if (!isValidChatWindowBounds(bounds)) {
      return { success: false, error: "bounds.x and bounds.y must be finite numbers" };
    }
    const result = chatWindowManager.open(sessionId, bounds);
    return { success: true, alreadyOpen: result.alreadyOpen };
  });
}
