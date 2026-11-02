import fs from "node:fs/promises";
import path from "node:path";

import { FIRST_PARTY_TOOL_NAMES as TOOL } from "../../common/tool-names";
import type { ISettingsManager } from "../backend/ports";
import type { RuntimeTool } from "../backend/runtime-contract";
import { checkSensitivePath } from "../sensitive-path-permission-guard";
import { assertRealpathAllowed, type FsAccessScope } from "./path-guard";

interface SelfFsToolDeps {
  getWorkspaceDir: () => string;
  /** Session-effective out-of-workspace grants (global + "allow for session" + entity).
   *  Re-checks against exactly what the permission policy approved. */
  getEffectiveFolderGrants: () => { read: string[]; write: string[] };
  /** Only for the move-source sensitive-path deny-list (allowedSensitivePaths); folder
   *  grants come from getEffectiveFolderGrants above, not from here. */
  settingsManager: Pick<ISettingsManager, "get">;
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function err(message: string): string {
  return JSON.stringify({ success: false, error: message });
}

interface TreeNode {
  name: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export function getSelfFsTools(deps: SelfFsToolDeps): RuntimeTool[] {
  const scope = (): FsAccessScope => {
    const grants = deps.getEffectiveFolderGrants();
    return {
      workspaceDir: deps.getWorkspaceDir(),
      readGrants: grants.read,
      writeGrants: grants.write,
    };
  };

  return [
    {
      name: TOOL.listLocalFiles,
      description:
        "List the contents of a directory. Returns structured JSON entries with name, type (file/directory), and size. Use absolute paths; out-of-workspace folders prompt for access.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path" } },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        try {
          const real = await assertRealpathAllowed(args.path, "read", scope());
          const dirents = await fs.readdir(real, { withFileTypes: true });
          const entries = await Promise.all(
            dirents.map(async (d) => {
              const full = path.join(real, d.name);
              let size = 0;
              try {
                size = (await fs.stat(full)).size;
              } catch {
                /* unreadable entry — report size 0 */
              }
              return { name: d.name, type: d.isDirectory() ? "directory" : "file", size };
            }),
          );
          return JSON.stringify({ success: true, path: real, entries });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: TOOL.getLocalFileTree,
      description:
        "Return a recursive directory tree (name/type/children) with depth and entry caps. Use absolute paths; out-of-workspace folders prompt for access.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute directory path" },
          maxDepth: { type: "number", description: "Max recursion depth (default 5)" },
        },
        required: ["path"],
      },
      handler: async (args: { path: string; maxDepth?: number }) => {
        const MAX_ENTRIES = 5000;
        const maxDepth =
          typeof args.maxDepth === "number" && Number.isFinite(args.maxDepth) ? args.maxDepth : 5;
        let count = 0;
        // Set only when an entry is actually skipped because the cap was hit, so
        // a tree of exactly MAX_ENTRIES entries does not falsely report truncated.
        let dropped = false;
        const visited = new Set<string>();
        try {
          const rootReal = await assertRealpathAllowed(args.path, "read", scope());
          const walk = async (dir: string, depth: number): Promise<TreeNode[]> => {
            if (depth > maxDepth) return [];
            if (count >= MAX_ENTRIES) {
              // A directory whose children we never enumerate because the entry
              // cap was already reached — its contents are dropped.
              dropped = true;
              return [];
            }
            // Guard symlink loops: skip a real dir already visited.
            const realDir = await fs.realpath(dir).catch(() => dir);
            if (visited.has(realDir)) return [];
            visited.add(realDir);
            const dirents = await fs.readdir(dir, { withFileTypes: true });
            const children: TreeNode[] = [];
            for (const d of dirents) {
              if (count >= MAX_ENTRIES) {
                dropped = true;
                break;
              }
              count++;
              const node: TreeNode = {
                name: d.name,
                type: d.isDirectory() ? "directory" : "file",
              };
              if (d.isDirectory()) {
                // eslint-disable-next-line no-await-in-loop -- sequential walk shares the entry cap; parallelizing would race `count`
                node.children = await walk(path.join(dir, d.name), depth + 1);
              }
              children.push(node);
            }
            return children;
          };
          const tree = await walk(rootReal, 1);
          return JSON.stringify({
            success: true,
            path: rootReal,
            tree,
            truncated: dropped,
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: TOOL.statLocalPath,
      description:
        "Return metadata for a file or directory: size, isFile, isDirectory, created/modified times, mode. Use absolute paths.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path" } },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        try {
          const real = await assertRealpathAllowed(args.path, "read", scope());
          const s = await fs.stat(real);
          return JSON.stringify({
            success: true,
            path: real,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            size: s.size,
            sizeHuman: formatSize(s.size),
            modified: s.mtime.toISOString(),
            created: s.birthtime.toISOString(),
            mode: s.mode.toString(8),
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: TOOL.createLocalDirectory,
      description:
        "Create a directory (recursively — parents are created as needed). Use absolute paths; out-of-workspace folders prompt for write access.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path to create" } },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        try {
          const real = await assertRealpathAllowed(args.path, "write", scope());
          await fs.mkdir(real, { recursive: true });
          return JSON.stringify({ success: true, path: real });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: TOOL.moveLocalPath,
      description:
        "Move or rename a file/directory from source to destination. Both must be within the workspace or an already-granted folder — an ungranted out-of-workspace source is denied without a prompt, so have the user grant it first. Use absolute paths.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Absolute source path" },
          destination: { type: "string", description: "Absolute destination path" },
        },
        required: ["source", "destination"],
      },
      handler: async (args: { source: string; destination: string }) => {
        try {
          // Source gated as a read (a move can exfiltrate from an ungranted
          // folder); destination gated as a write. Only the destination passes
          // through the pre-hook sensitive-path gate (it is the normalized
          // write), so re-check the source here — otherwise a move out of a
          // sensitive path inside a granted folder (e.g. ~/.ssh under a broad
          // grant) would skip that gate.
          const srcReal = await assertRealpathAllowed(args.source, "read", scope());
          const sensitive = checkSensitivePath(
            // checkSensitivePath reads only kind + path; id/sessionId are
            // required by ApprovalRequest but unused for this synthetic check.
            { kind: "read", toolCallId: undefined, path: srcReal, id: "", sessionId: "" },
            deps.settingsManager.get().permissions?.allowedSensitivePaths ?? [],
          );
          if (sensitive) {
            return err(`Access denied — source is a sensitive path: ${sensitive.resolvedPath}`);
          }
          const dstReal = await assertRealpathAllowed(args.destination, "write", scope());
          try {
            await fs.rename(srcReal, dstReal);
          } catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "EXDEV")) throw e;
            // Cross-device: copy then remove the source. If the copy lands but the
            // source removal fails, the destination is already written — report the
            // real state so the model doesn't retry into a "destination exists" error
            // and strand a second full copy.
            await fs.cp(srcReal, dstReal, { recursive: true });
            try {
              await fs.rm(srcReal, { recursive: true, force: true });
            } catch (rmErr) {
              return err(
                `copied to ${dstReal} but source removal failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
              );
            }
          }
          return JSON.stringify({ success: true, source: srcReal, destination: dstReal });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
