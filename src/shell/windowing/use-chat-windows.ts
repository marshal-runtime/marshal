// Marshal-owned module.
/**
 * Hook for opening chat sessions in popout windows.
 *
 * Returns a stable callback that asks the main process to open the given
 * session in its own BrowserWindow, or focuses an existing popout if one
 * is already open. Returns `undefined` when the API isn't available
 * (E2E mock mode, web preview, etc.) so callers can hide UI gracefully.
 */
import { createLogger } from "@common/marshal-logger";
import { useCallback } from "react";

const log = createLogger("useChatWindows");

export interface UseChatWindowsResult {
  /** True when the chat-windows IPC bridge is available in this renderer. */
  isAvailable: boolean;
  /**
   * Open (or focus) a popout window for the given session.
   * Resolves once the main process has acknowledged. When `bounds` is
   * provided (screen-space coords from a drag), the new window opens near
   * those coords; otherwise OS-default placement is used.
   */
  openInNewWindow: (sessionId: string, bounds?: { x: number; y: number }) => Promise<void>;
}

export function useChatWindows(): UseChatWindowsResult {
  const api = window.chatWindowsAPI;
  const isAvailable = !!api;

  const openInNewWindow = useCallback(
    async (sessionId: string, bounds?: { x: number; y: number }): Promise<void> => {
      if (!api) {
        log.warn("chatWindowsAPI unavailable; ignoring openInNewWindow");
        return;
      }
      const result = await api.open(sessionId, bounds);
      if (!result.success) {
        log.error("Failed to open chat in new window:", result.error);
      }
    },
    [api],
  );

  return { isAvailable, openInNewWindow };
}
