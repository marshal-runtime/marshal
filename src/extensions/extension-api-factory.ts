import type { ExtensionAPI } from "./extension-contracts";

/**
 * Builds and caches scoped `ExtensionAPI` objects for registered extensions.
 *
 * Each extension receives a scoped API instance where:
 * - `chat.send`   routes through `window.copilotAPI`
 * - `workspace.*` routes through `window.workspaceAPI`
 * - `skills.list` routes through `window.skillsAPI`
 *
 * Note: this is a renderer-side API contract, not per-extension runtime
 * permission enforcement in the main process.
 */
export class ExtensionApiBuilder {
  private readonly _apiCache = new Map<string, ExtensionAPI>();

  /**
   * Return the cached `ExtensionAPI` for `extensionId`, building it on first call.
   *
   * The same reference is returned on every subsequent call — safe to use as a
   * React prop or effect dependency without causing spurious re-renders.
   */
  build(extensionId: string): ExtensionAPI {
    const cached = this._apiCache.get(extensionId);
    if (cached) return cached;

    const chat = Object.freeze({
      send: (message: string, sessionId?: string) =>
        window.copilotAPI?.send(message, sessionId) ??
        Promise.resolve({ success: false, error: "copilotAPI unavailable" }),
    });

    const workspace = Object.freeze({
      readFile: async (filePath: string) => {
        const r = await window.workspaceAPI?.readFile(filePath);
        return r?.success ? (r.content ?? null) : null;
      },
      writeFile: async (filePath: string, content: string) =>
        (await window.workspaceAPI?.writeFile(filePath, content)) ?? {
          success: false,
          error: "workspaceAPI unavailable",
        },
      listDir: async (dirPath: string) => {
        const r = await window.workspaceAPI?.listDir(dirPath);
        return r?.success ? (r.entries ?? []) : [];
      },
    });

    const skills = Object.freeze({
      list: async () => {
        const r = await window.skillsAPI?.list();
        return r?.success ? (r.skills ?? []) : [];
      },
    });

    const api = Object.freeze({
      extensionId,
      chat,
      workspace,
      skills,
    }) as ExtensionAPI;

    this._apiCache.set(extensionId, api);
    return api;
  }

  /** Evict the cached API for an extension (call when the extension is deregistered). */
  evict(extensionId: string): void {
    this._apiCache.delete(extensionId);
  }
}
