/**
 * Naming for the default workspace, shared by both processes.
 *
 * The persisted map key, the on-disk directory under the managed workspace
 * root, and the `origin: "scratchpad"` discriminant all keep the original
 * value so existing installs need no migration. Only presentation changes,
 * which is why switch/rename/delete callers still compare against the key.
 *
 * This lives in `common/` rather than beside the store because
 * `electron/workspace-store.ts` pulls in `fs`/`path` and cannot be imported
 * by the renderer — and a second copy of these literals would be invisible to
 * every gate we have.
 */

/** Persisted map key and on-disk directory name. Frozen: renaming orphans state. */
export const DEFAULT_WORKSPACE_KEY = "Scratchpad";

/** Runtime authority key for sessions that do not have a named workspace. */
export const DEFAULT_RUNTIME_WORKSPACE_KEY = "marshal";

/** What the user sees wherever the default workspace is named. */
export const DEFAULT_WORKSPACE_DISPLAY_NAME = "Marshal's workspace";

/** Maps a stored workspace name to its display form. */
export function workspaceDisplayName(name: string): string {
  return name === DEFAULT_WORKSPACE_KEY ? DEFAULT_WORKSPACE_DISPLAY_NAME : name;
}
