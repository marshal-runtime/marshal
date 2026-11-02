export const DEFAULT_CHAT_WORKSPACE_STORAGE_KEY = "marshal.default-chat-workspace.v1";

export function getDefaultChatWorkspace(): string | undefined {
  try {
    return window.localStorage.getItem(DEFAULT_CHAT_WORKSPACE_STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setDefaultChatWorkspace(workspaceName?: string): void {
  try {
    if (workspaceName)
      window.localStorage.setItem(DEFAULT_CHAT_WORKSPACE_STORAGE_KEY, workspaceName);
    else window.localStorage.removeItem(DEFAULT_CHAT_WORKSPACE_STORAGE_KEY);
  } catch {
    // The selection remains usable for this click when persistence is unavailable.
  }
}
