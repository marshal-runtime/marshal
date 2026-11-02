import { BrowserWindow } from "electron";

export function getTargetWindow(
  event: Electron.IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender && !sender.isDestroyed()) return sender;
  const fallback = getWindow();
  if (fallback && !fallback.isDestroyed()) return fallback;
  return null;
}
