import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { app, BrowserWindow, dialog, shell } from "electron";

import { createLogger } from "../../common/marshal-logger";
import { installE2EWorkspaceFixtures } from "../e2e-workspace-fixtures";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { RuntimeDocumentAccessStore } from "../security/runtime-document-access-store";
import { createWorkspacePathCapabilityStore } from "../security/workspace-path-capability-store";
import type { SessionManager } from "../sessions";
import {
  DEFAULT_WORKSPACE_DISPLAY_NAME,
  deleteWorkspaceEntry,
  getWorkspaceRegistry,
  getWorkspaceRoot,
  getWorkspaceUIState,
  listRegisteredWorkspaces,
  reconcileActiveWorkspace,
  registerExistingWorkspace,
  registerManagedWorkspace,
  renameWorkspaceEntry,
  resolveRegisteredWorkspace,
  SCRATCHPAD_WORKSPACE_NAME,
  setActiveWorkspace,
  setExpandedPaths,
  setSelectedFile,
  validateWorkspaceName,
} from "../workspace-store";
import { createIpcHandle } from "./ipc-handle";
import { checkArrayLength, checkStringSize, IPC_LIMITS } from "./ipc-limits";

const log = createLogger("WorkspaceIpc");

export interface DirEntry {
  name: string;
  type: "file" | "directory";
}

const DEFAULT_WORKSPACE = SCRATCHPAD_WORKSPACE_NAME;
const SYMLINK_IMPORT_ERROR = "Symbolic links cannot be imported into the workspace";
const WORKSPACE_ACCESS_ERROR = "This location isn't available in the current workspace";

function validateExternalImportSource(source: string): { error?: string } {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    return { error: SYMLINK_IMPORT_ERROR };
  }
  if (!stat.isDirectory()) {
    return {};
  }
  for (const entry of fs.readdirSync(source)) {
    const childResult = validateExternalImportSource(path.join(source, entry));
    if (childResult.error) return childResult;
  }
  return {};
}

/** Check if a dirent is a directory, following symlinks/junctions. */
export function isDirEntry(e: fs.Dirent): boolean {
  return e.isDirectory() || e.isSymbolicLink();
}

function isSameOrInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Resolve and validate that a path is inside a registered workspace root.
 *  Uses fs.realpathSync to follow symlinks — prevents symlink-based sandbox escapes. */
export function sandboxed(
  workspaceDir: string,
  targetPath: string,
): { resolved: string } | { error: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(targetPath));
  } catch {
    // Target doesn't exist yet (e.g., new file write) — resolve parent instead
    const parent = path.dirname(path.resolve(targetPath));
    try {
      const realParent = fs.realpathSync(parent);
      resolved = path.join(realParent, path.basename(targetPath));
    } catch {
      return { error: WORKSPACE_ACCESS_ERROR };
    }
  }

  for (const workspace of listRegisteredWorkspaces(workspaceDir)) {
    if (isSameOrInside(workspace.path, resolved)) {
      return { resolved };
    }
  }

  return { error: WORKSPACE_ACCESS_ERROR };
}

function readablePath(
  workspaceDir: string,
  targetPath: string,
  readCapability: string | undefined,
  documentAccess: RuntimeDocumentAccessStore | undefined,
): { resolved: string } | { error: string } {
  const workspacePath = sandboxed(workspaceDir, targetPath);
  if (!("error" in workspacePath)) return workspacePath;
  if (!readCapability || !documentAccess) return workspacePath;
  return documentAccess.resolve(readCapability, targetPath);
}

/** Validate workspace/folder name. */
export function validateName(name: string): string | null {
  return validateWorkspaceName(name);
}

function copyExternalIntoWorkspace(
  source: string,
  dest: string,
): { copied: boolean; error?: string } {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    return { copied: false, error: SYMLINK_IMPORT_ERROR };
  }
  if (stat.isDirectory()) {
    const createdDest = !fs.existsSync(dest);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      const childResult = copyExternalIntoWorkspace(
        path.join(source, entry),
        path.join(dest, entry),
      );
      if (childResult.error) {
        if (createdDest) fs.rmSync(dest, { recursive: true, force: true });
        return childResult;
      }
    }
    return { copied: true };
  }
  fs.copyFileSync(source, dest);
  return { copied: true };
}

/**
 * Register IPC handlers for the workspace file browser.
 * Used by Create mode's file tree and workspace management.
 */
export function registerWorkspaceHandlers(
  workspaceDir: string,
  getWindow?: () => BrowserWindow | null,
  sessionManager?: SessionManager,
  documentAccess?: RuntimeDocumentAccessStore,
) {
  const ipcHandle = createIpcHandle();
  const pathCapabilities = createWorkspacePathCapabilityStore();
  const externalFileImportBridgeTokens = new Map<number, string>();
  installE2EWorkspaceFixtures(workspaceDir);

  // Ensure Scratchpad always exists
  const scratchpadPath = path.join(workspaceDir, DEFAULT_WORKSPACE);
  if (!fs.existsSync(scratchpadPath)) {
    fs.mkdirSync(scratchpadPath, { recursive: true });
  }
  reconcileActiveWorkspace(workspaceDir);

  // Watch workspace directories for changes and notify renderer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchersByPath = new Map<string, fs.FSWatcher>();

  function notifyChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send("workspace:changed");
      }
    }, 300);
  }

  function notifyRegistryChange() {
    const win = getWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send("workspace:registry-changed");
    }
  }

  function watchDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (watchersByPath.has(resolved)) return; // Already watching
    try {
      const w = fs.watch(resolved, { recursive: true }, (_event, filename) => {
        if (!filename || filename.startsWith(".")) return;
        notifyChange();
      });
      w.unref();
      watchersByPath.set(resolved, w);
    } catch (err) {
      log.warn(`Failed to watch ${dir}:`, err);
    }
  }

  function unwatchDir(dir: string): void {
    const resolved = path.resolve(dir);
    const w = watchersByPath.get(resolved);
    if (w) {
      w.close();
      watchersByPath.delete(resolved);
    }
  }

  // Watch default workspace directory
  watchDir(workspaceDir);

  // Watch all external workspace directories from registry
  for (const workspace of listRegisteredWorkspaces(workspaceDir)) {
    if (workspace.external) watchDir(workspace.path);
  }

  // Clean up watchers and pending timer on app quit
  app.once("will-quit", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchersByPath.values()) w.close();
    watchersByPath.clear();
  });

  // ── Workspace CRUD ──────────────────────────────────────────────

  sharedIpcHandle(ipcHandle)("workspace:listWorkspaces", () => {
    try {
      reconcileActiveWorkspace(workspaceDir);
      const registered = listRegisteredWorkspaces(workspaceDir);
      for (const workspace of registered) {
        if (workspace.external) watchDir(workspace.path);
      }
      const workspaces = registered.map((workspace) => workspace.name);
      const workspaceBindings = registered.map((workspace) => ({
        name: workspace.name,
        identity: workspace.identity,
      }));
      const externalNames = registered
        .filter((workspace) => workspace.external)
        .map((workspace) => workspace.name);
      return {
        success: true,
        workspaces,
        workspaceBindings,
        externalWorkspaces: externalNames,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:listRepositoryAgents", (_event, workspaceName: string) => {
    try {
      if (!sessionManager) {
        return { success: false, error: "Session manager is not available" };
      }
      const agents = sessionManager.listRepositoryAgentsForMainSession(workspaceName);
      return { success: true, agents };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "workspace:createWorkspace",
    async (event, name: string, externalPickToken?: string) => {
      try {
        const performCreate = async () => {
          const nameError = validateName(name);
          if (nameError) return { success: false, error: nameError };

          const trimmedName = name.trim();

          if (externalPickToken) {
            // Picker tokens are single-use once presented, even if later filesystem validation fails.
            const consumed = pathCapabilities.consume(externalPickToken, {
              kind: "directory",
              webContentsId: event.sender.id,
            });
            if ("error" in consumed) return { success: false, error: consumed.error };

            const externalPath = consumed.paths[0];
            if (!externalPath) {
              return { success: false, error: "Invalid or expired workspace path token" };
            }
            // Validate external path exists and is a directory
            if (!fs.existsSync(externalPath)) {
              return { success: false, error: "Selected folder does not exist" };
            }
            const stat = fs.statSync(externalPath);
            if (!stat.isDirectory()) {
              return { success: false, error: "Selected path is not a directory" };
            }
            const workspace = registerExistingWorkspace(trimmedName, externalPath, workspaceDir);
            watchDir(workspace.path);
            notifyRegistryChange();
            return { success: true };
          }

          registerManagedWorkspace(trimmedName, workspaceDir);
          notifyRegistryChange();
          return { success: true };
        };

        return sessionManager
          ? await sessionManager.runWorkspaceLifecycleOperation(performCreate)
          : await performCreate();
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("workspace:renameWorkspace", async (_event, oldName: string, newName: string) => {
    try {
      if (oldName === DEFAULT_WORKSPACE) {
        return { success: false, error: `Cannot rename ${DEFAULT_WORKSPACE_DISPLAY_NAME}` };
      }
      const oldNameError = validateName(oldName);
      if (oldNameError) return { success: false, error: oldNameError };
      const nameError = validateName(newName);
      if (nameError) return { success: false, error: nameError };
      if (oldName === newName.trim()) return { success: true };

      const performRename = async () => {
        const registry = getWorkspaceRegistry();
        const trimmedNew = newName.trim();
        const existing = resolveRegisteredWorkspace(oldName, workspaceDir);
        if (!registry[oldName] || !existing) {
          return { success: false, error: "Workspace not found" };
        }

        const registryCollision = Object.keys(registry).some(
          (name) => name !== oldName && name.toLowerCase() === trimmedNew.toLowerCase(),
        );
        const filesystemCollision =
          !registry[oldName]?.externalPath &&
          fs
            .readdirSync(workspaceDir, { withFileTypes: true })
            .some(
              (entry) =>
                entry.name !== oldName && entry.name.toLowerCase() === trimmedNew.toLowerCase(),
            );
        if (registryCollision || filesystemCollision) {
          return { success: false, error: "A workspace with that name already exists" };
        }

        // Handle external workspace rename (no folder move needed)
        if (registry[oldName]?.externalPath) {
          renameWorkspaceEntry(oldName, trimmedNew);
          try {
            await sessionManager?.renameSessionsByWorkspace(oldName, trimmedNew, {
              lifecycleLocked: true,
            });
          } catch (sessionErr) {
            renameWorkspaceEntry(trimmedNew, oldName);
            throw sessionErr;
          }
          notifyRegistryChange();
          return { success: true };
        }

        // Handle default workspace rename (move folder on disk)
        const oldPath = existing.path;
        const newPath = path.join(path.dirname(oldPath), trimmedNew);
        if (!fs.existsSync(oldPath)) return { success: false, error: "Workspace not found" };
        // Update store and sessions first — if anything fails, roll back
        renameWorkspaceEntry(oldName, trimmedNew);
        try {
          await sessionManager?.renameSessionsByWorkspace(oldName, trimmedNew, {
            lifecycleLocked: true,
          });
          fs.renameSync(oldPath, newPath);
        } catch (err) {
          renameWorkspaceEntry(trimmedNew, oldName);
          try {
            await sessionManager?.renameSessionsByWorkspace(trimmedNew, oldName, {
              lifecycleLocked: true,
            });
          } catch (rollbackErr) {
            log.error("renameWorkspace: session rollback failed:", rollbackErr);
          }
          throw err;
        }
        notifyRegistryChange();
        return { success: true };
      };

      return sessionManager
        ? await sessionManager.runWorkspaceLifecycleOperation(performRename)
        : await performRename();
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:deleteWorkspace", async (_event, name: string) => {
    try {
      if (name === DEFAULT_WORKSPACE)
        return { success: false, error: `Cannot delete ${DEFAULT_WORKSPACE_DISPLAY_NAME}` };
      const nameError = validateName(name);
      if (nameError) return { success: false, error: nameError };

      const performDelete = async () => {
        const registry = getWorkspaceRegistry();
        const existing = resolveRegisteredWorkspace(name, workspaceDir);
        const registryEntry = registry[name];
        if (!registryEntry || !existing) {
          return { success: false, error: "Workspace not found" };
        }

        if (registryEntry.externalPath) {
          const extPath = registryEntry.externalPath;
          const commitExternalRemoval = () => {
            deleteWorkspaceEntry(name);
            unwatchDir(extPath);
            notifyRegistryChange();
          };
          if (sessionManager) {
            await sessionManager.deleteSessionsByWorkspace(name, {
              lifecycleLocked: true,
              beforeWorkspaceRemoval: commitExternalRemoval,
            });
          } else {
            commitExternalRemoval();
          }
          return { success: true };
        }

        const wsPath = existing.path;
        const tombstonePath = path.join(
          path.dirname(wsPath),
          `.m-workspace-delete-${randomUUID()}`,
        );
        let tombstoned = false;
        let registryDeleted = false;
        const commitManagedRemoval = () => {
          fs.renameSync(wsPath, tombstonePath);
          tombstoned = true;
          deleteWorkspaceEntry(name);
          registryDeleted = true;
          notifyRegistryChange();
        };
        try {
          if (sessionManager) {
            await sessionManager.deleteSessionsByWorkspace(name, {
              lifecycleLocked: true,
              beforeWorkspaceRemoval: commitManagedRemoval,
            });
          } else {
            commitManagedRemoval();
          }
          try {
            fs.rmSync(tombstonePath, { recursive: true, force: true });
          } catch (cleanupError) {
            log.warn(`Workspace tombstone cleanup failed for ${name}:`, cleanupError);
          }
          return { success: true };
        } catch (error) {
          if (
            !registryDeleted &&
            tombstoned &&
            fs.existsSync(tombstonePath) &&
            !fs.existsSync(wsPath)
          ) {
            fs.renameSync(tombstonePath, wsPath);
          } else if (registryDeleted && tombstoned) {
            try {
              fs.rmSync(tombstonePath, { recursive: true, force: true });
            } catch (cleanupError) {
              log.warn(`Committed workspace tombstone cleanup failed for ${name}:`, cleanupError);
            }
          }
          throw error;
        }
      };

      return sessionManager
        ? await sessionManager.runWorkspaceLifecycleOperation(performDelete)
        : await performDelete();
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:getWorkspaceContents", (_event, name: string) => {
    try {
      const nameError = validateName(name);
      if (nameError) return { success: false, error: nameError };

      const wsPath = getWorkspaceRoot(name, workspaceDir);

      if (!fs.existsSync(wsPath)) return { success: false, error: "Workspace not found" };
      let fileCount = 0;
      let folderCount = 0;
      const MAX_DEPTH = 20;
      const walk = (dir: string, depth: number) => {
        if (depth > MAX_DEPTH) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          if (isDirEntry(e)) {
            folderCount++;
            walk(path.join(dir, e.name), depth + 1);
          } else fileCount++;
        }
      };
      walk(wsPath, 0);
      return { success: true, fileCount, folderCount };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── File/Folder browsing ────────────────────────────────────────

  ipcHandle("workspace:getRoot", (_event, workspaceName?: string) => {
    try {
      const name = workspaceName || DEFAULT_WORKSPACE;
      const nameError = validateName(name);
      if (nameError) return { success: false, error: nameError };
      return { success: true, root: getWorkspaceRoot(name, workspaceDir) };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:listDir", (_event, dirPath: string) => {
    try {
      const check = sandboxed(workspaceDir, dirPath);
      if ("error" in check) return { success: false, error: check.error };
      const entries = fs.readdirSync(check.resolved, { withFileTypes: true });
      const result: DirEntry[] = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          type: isDirEntry(e) ? ("directory" as const) : ("file" as const),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, entries: result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "workspace:searchFiles",
    (workspaceName: string | undefined, query: string) => {
      try {
        const name = workspaceName || DEFAULT_WORKSPACE;
        const nameError = validateName(name);
        if (nameError) return { success: false, error: nameError };
        const root = getWorkspaceRoot(name, workspaceDir);
        const rootCheck = sandboxed(workspaceDir, root);
        if ("error" in rootCheck) return { success: false, error: rootCheck.error };

        const normalizedQuery = query.trim().toLocaleLowerCase();
        const files: Array<{
          type: "File";
          id: string;
          referenceId: string;
          title: string;
          fileExtension?: string;
          localPath: string;
        }> = [];
        const pending = [rootCheck.resolved];
        let visited = 0;
        const MAX_VISITED_ENTRIES = 20_000;
        const MAX_RESULTS = 100;

        while (pending.length > 0 && visited < MAX_VISITED_ENTRIES) {
          const directory = pending.pop();
          if (!directory) break;
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
            visited++;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              if (entry.name !== "node_modules") pending.push(absolutePath);
              continue;
            }
            if (!entry.isFile()) continue;
            const relativePath = path.relative(rootCheck.resolved, absolutePath);
            if (normalizedQuery && !relativePath.toLocaleLowerCase().includes(normalizedQuery)) {
              continue;
            }
            const extension = path.extname(entry.name).slice(1);
            files.push({
              type: "File",
              id: absolutePath,
              referenceId: absolutePath,
              title: relativePath,
              ...(extension ? { fileExtension: extension } : {}),
              localPath: absolutePath,
            });
            if (files.length >= MAX_RESULTS) break;
          }
          if (files.length >= MAX_RESULTS) break;
        }

        files.sort((left, right) => left.title.localeCompare(right.title));
        return { success: true, files };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("workspace:readFile", (_event, filePath: string, readCapability?: string) => {
    try {
      const check = readablePath(workspaceDir, filePath, readCapability, documentAccess);
      if ("error" in check) return { success: false, error: check.error };
      const stat = fs.statSync(check.resolved);
      if (stat.size > 2 * 1024 * 1024) {
        return { success: false, error: "File too large to preview" };
      }
      const ext = path.extname(check.resolved).toLowerCase();
      const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
      if (imageExts.includes(ext)) {
        const data = fs.readFileSync(check.resolved);
        const base64 = data.toString("base64");
        const mime =
          ext === ".svg"
            ? "image/svg+xml"
            : ext === ".png"
              ? "image/png"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".bmp"
                    ? "image/bmp"
                    : "image/jpeg";
        return { success: true, type: "image", content: `data:${mime};base64,${base64}` };
      }
      const content = fs.readFileSync(check.resolved, "utf-8");
      const isMarkdown = [".md", ".markdown", ".mdx"].includes(ext);
      const isHtml = [".html", ".htm"].includes(ext);
      const isMermaid = [".mmd", ".mermaid"].includes(ext);
      return {
        success: true,
        type: isMarkdown || isMermaid ? "markdown" : isHtml ? "html" : "text",
        content: isMermaid ? "```mermaid\n" + content + "\n```" : content,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:writeFile", (_event, filePath: string, content: string) => {
    try {
      const sizeCheck = checkStringSize(content, IPC_LIMITS.FILE_CONTENT_BYTES, "File content");
      if (sizeCheck) return sizeCheck;
      const check = sandboxed(workspaceDir, filePath);
      if ("error" in check) return { success: false, error: check.error };
      fs.writeFileSync(check.resolved, content, "utf-8");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Folder CRUD within workspace ────────────────────────────────

  ipcHandle("workspace:createFolder", (_event, parentPath: string, name: string) => {
    try {
      const nameError = validateName(name);
      if (nameError) return { success: false, error: nameError };
      const check = sandboxed(workspaceDir, parentPath);
      if ("error" in check) return { success: false, error: check.error };
      const folderPath = path.join(check.resolved, name.trim());
      if (fs.existsSync(folderPath)) {
        return { success: false, error: "A folder with that name already exists" };
      }
      fs.mkdirSync(folderPath, { recursive: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:renameItem", (_event, itemPath: string, newName: string) => {
    try {
      const nameError = validateName(newName);
      if (nameError) return { success: false, error: nameError };
      const check = sandboxed(workspaceDir, itemPath);
      if ("error" in check) return { success: false, error: check.error };
      const parentDir = path.dirname(check.resolved);
      const newPath = path.join(parentDir, newName.trim());
      if (fs.existsSync(newPath)) {
        return { success: false, error: "An item with that name already exists" };
      }
      fs.renameSync(check.resolved, newPath);
      return { success: true, newPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:deleteItem", (_event, itemPath: string) => {
    try {
      const check = sandboxed(workspaceDir, itemPath);
      if ("error" in check) return { success: false, error: check.error };
      for (const workspace of listRegisteredWorkspaces(workspaceDir)) {
        if (check.resolved === workspace.path) {
          return { success: false, error: "Cannot delete the workspace root" };
        }
      }
      fs.rmSync(check.resolved, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:moveItem", (_event, sourcePath: string, destDir: string) => {
    try {
      const srcCheck = sandboxed(workspaceDir, sourcePath);
      if ("error" in srcCheck) return { success: false, error: srcCheck.error };
      const dstCheck = sandboxed(workspaceDir, destDir);
      if ("error" in dstCheck) return { success: false, error: dstCheck.error };
      if (dstCheck.resolved.startsWith(srcCheck.resolved + path.sep)) {
        return { success: false, error: "Cannot move a folder into itself" };
      }
      const name = path.basename(srcCheck.resolved);
      const newPath = path.join(dstCheck.resolved, name);
      if (fs.existsSync(newPath)) {
        return {
          success: false,
          error: "An item with that name already exists in the destination",
        };
      }
      fs.renameSync(srcCheck.resolved, newPath);
      return { success: true, newPath };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:duplicateItem", (_event, sourcePath: string, destPath: string) => {
    try {
      const srcCheck = sandboxed(workspaceDir, sourcePath);
      if ("error" in srcCheck) return { success: false, error: srcCheck.error };
      const dstCheck = sandboxed(workspaceDir, destPath);
      if ("error" in dstCheck) return { success: false, error: dstCheck.error };
      if (!fs.existsSync(srcCheck.resolved)) {
        return { success: false, error: "Source file does not exist" };
      }
      if (fs.statSync(srcCheck.resolved).isDirectory()) {
        // Files only for now; directory duplication has edge cases (symlinks, permissions)
        return { success: false, error: "Cannot duplicate a directory" };
      }
      if (fs.existsSync(dstCheck.resolved)) {
        return { success: false, error: "A file with that name already exists" };
      }
      // dereference: true so symlink-to-file produces a standalone copy, not another symlink
      fs.cpSync(srcCheck.resolved, dstCheck.resolved, { dereference: true });
      return { success: true, newPath: dstCheck.resolved };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:registerExternalFileImportBridge", (event, bridgeToken: string) => {
    if (typeof bridgeToken !== "string" || bridgeToken.trim() === "") {
      return { success: false, error: "Invalid external file import bridge token" };
    }
    const existingBridgeToken = externalFileImportBridgeTokens.get(event.sender.id);
    if (existingBridgeToken !== undefined && existingBridgeToken !== bridgeToken) {
      return { success: false, error: "External file import bridge already registered" };
    }
    if (existingBridgeToken === undefined) {
      const cleanupBridgeToken = () => {
        externalFileImportBridgeTokens.delete(event.sender.id);
      };
      event.sender.once("destroyed", cleanupBridgeToken);
      event.sender.once("did-start-navigation", cleanupBridgeToken);
    }
    externalFileImportBridgeTokens.set(event.sender.id, bridgeToken);
    return { success: true };
  });

  ipcHandle(
    "workspace:authorizeExternalFiles",
    (event, bridgeToken: string, externalPaths: string[]) => {
      try {
        if (
          typeof bridgeToken !== "string" ||
          bridgeToken.trim() === "" ||
          externalFileImportBridgeTokens.get(event.sender.id) !== bridgeToken
        ) {
          return { success: false, error: "Unauthorized external file import" };
        }
        if (!Array.isArray(externalPaths)) {
          return { success: false, error: "External files must be an array" };
        }
        const lengthCheck = checkArrayLength(
          externalPaths,
          IPC_LIMITS.ARRAY_MAX_LENGTH,
          "External files",
        );
        if (lengthCheck) return lengthCheck;
        const resolvedPaths = externalPaths
          .filter((externalPath) => typeof externalPath === "string" && externalPath.trim() !== "")
          .map((externalPath) => path.resolve(externalPath))
          .filter((externalPath) => fs.existsSync(externalPath));
        if (resolvedPaths.length === 0) {
          return { success: false, error: "No external files to import" };
        }
        const importToken = pathCapabilities.issue({
          kind: "external-files",
          paths: resolvedPaths,
          webContentsId: event.sender.id,
        });
        return { success: true, importToken };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("workspace:copyExternalFiles", (event, importToken: string, destDir: string) => {
    try {
      if (typeof importToken !== "string") {
        return { success: false, error: "Invalid or expired workspace path token" };
      }
      const consumed = pathCapabilities.consume(importToken, {
        kind: "external-files",
        webContentsId: event.sender.id,
      });
      if ("error" in consumed) return { success: false, error: consumed.error };
      const dstCheck = sandboxed(workspaceDir, destDir);
      if ("error" in dstCheck) return { success: false, error: dstCheck.error };
      if (!fs.statSync(dstCheck.resolved).isDirectory()) {
        return { success: false, error: "Destination is not a directory" };
      }
      for (const resolved of consumed.paths) {
        if (!fs.existsSync(resolved)) continue;
        const sourceCheck = validateExternalImportSource(resolved);
        if (sourceCheck.error) return { success: false, error: sourceCheck.error };
      }
      let copied = 0;
      for (const resolved of consumed.paths) {
        if (!fs.existsSync(resolved)) continue;
        const name = path.basename(resolved);
        const dest = path.join(dstCheck.resolved, name);
        const destCheck = sandboxed(workspaceDir, dest);
        if ("error" in destCheck) continue;
        if (fs.existsSync(dest)) continue; // skip duplicates
        const copyResult = copyExternalIntoWorkspace(resolved, dest);
        if (copyResult.error) {
          return { success: false, error: copyResult.error };
        }
        copied++;
      }
      return { success: true, copied };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Utility ─────────────────────────────────────────────────────

  ipcHandle("workspace:pickFolder", async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        message: "Select a folder to use as workspace",
      });
      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: "Folder selection cancelled" };
      }
      const folderPath = result.filePaths[0];
      const resolvedFolderPath = path.resolve(folderPath);
      // Validate folder exists and is readable
      if (!fs.existsSync(resolvedFolderPath)) {
        return { success: false, error: "Selected folder does not exist" };
      }
      const stat = fs.statSync(resolvedFolderPath);
      if (!stat.isDirectory()) {
        return { success: false, error: "Selected path is not a directory" };
      }
      const token = pathCapabilities.issue({
        kind: "directory",
        paths: [resolvedFolderPath],
        webContentsId: event.sender.id,
      });
      return { success: true, folderPath: resolvedFolderPath, folderToken: token };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "workspace:revealInFileManager",
    (_event, targetPath: string, readCapability?: string) => {
      try {
        const check = readablePath(workspaceDir, targetPath, readCapability, documentAccess);
        if ("error" in check) return { success: false, error: check.error };
        shell.showItemInFolder(check.resolved);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("workspace:openFile", async (_event, targetPath: string, readCapability?: string) => {
    try {
      const check = readablePath(workspaceDir, targetPath, readCapability, documentAccess);
      if ("error" in check) return { success: false, error: check.error };
      const result = await shell.openPath(check.resolved);
      if (result) return { success: false, error: result }; // openPath returns error string or ""
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // ── Workspace UI state ─────────────────────────────────────────

  ipcHandle("workspace:getUIState", () => {
    try {
      return { success: true, state: getWorkspaceUIState() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("workspace:setActiveWorkspace", (_event, name: string) => {
    try {
      const nameError = validateName(name);
      if (nameError) return { success: false, error: nameError };
      if (!resolveRegisteredWorkspace(name, workspaceDir) || !setActiveWorkspace(name)) {
        return { success: false, error: "Workspace not found" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "workspace:setExpandedPaths",
    (_event, workspaceName: string, relativePaths: string[]) => {
      try {
        setExpandedPaths(workspaceName, relativePaths);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle(
    "workspace:setSelectedFile",
    (_event, workspaceName: string, relativePath: string | undefined) => {
      try {
        const ok = setSelectedFile(workspaceName, relativePath);
        if (!ok) return { success: false, error: "Invalid workspace or path" };
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );
}
