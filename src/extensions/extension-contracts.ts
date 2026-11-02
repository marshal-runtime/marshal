import type { Skill, WorkspaceDirEntry } from "@common/marshal-ipc-contract";

/**
 * Scoped capability API injected into every registered slot component as `props.api`.
 *
 * This is the ONLY surface extension components should use to communicate with
 * Electron. Direct `window.*` access from slot components is prohibited — the
 * TypeScript signature enforces this at authoring time.
 *
 * The implementation is assembled by `ExtensionClient.buildApi()` and routes calls
 * through the appropriate IPC channels:
 * - `chat.send` → `window.copilotAPI.send`
 * - `workspace.*` → `workspace:readFile/writeFile/listDir` IPC channels
 * - `skills.list` → `skills:list` IPC channel
 *
 * **Note:** Per-extension capability enforcement is not yet implemented on the
 * main process side. Any renderer code can currently access these channels.
 * A future version will gate access by extension ID.
 *
 * ── Capability surface ────────────────────────────────────────────────────────
 *
 * | Namespace        | Backed by (IPC channel)                    |
 * |------------------|--------------------------------------------|
 * | `chat.send`      | `window.copilotAPI.send`                   |
 * | `workspace.*`    | `workspace:readFile/writeFile/listDir`     |
 * | `skills.list`    | `skills:list`                              |
 */
export interface ExtensionAPI {
  /** Chat integration. */
  readonly chat: {
    /**
     * Send a message to the Co-create chat session.
     * @param message - Text to send.
     * @param sessionId - Target session. Defaults to the active session when omitted.
     */
    send(message: string, sessionId?: string): Promise<{ success: boolean; error?: string }>;
  };

  /** Workspace file operations. Scoped to the active Co-create workspace directory. */
  readonly workspace: {
    /**
     * Read a file's text content.
     * Returns `null` when the file does not exist or cannot be read.
     */
    readFile(filePath: string): Promise<string | null>;

    /**
     * Write (or overwrite) a file.
     * Parent directories are created automatically.
     */
    writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }>;

    /**
     * List the entries in a directory.
     * Returns an empty array when the directory does not exist or is unreadable.
     */
    listDir(dirPath: string): Promise<WorkspaceDirEntry[]>;
  };

  /** Skills management. */
  readonly skills: {
    list(): Promise<Skill[]>;
  };

  /** The ID of the extension that registered this slot. Injected by `ExtensionClient`. */
  readonly extensionId: string;
}
