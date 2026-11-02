import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceInstanceIdentity } from "../../common/marshal-ipc-contract";
import { captureWorkspaceBinding } from "../workspace-role-identity";

const MAX_GIT_METADATA_BYTES = 4 * 1024;
const MAX_REPOSITORY_ANCESTORS = 256;

export function runtimeWorkspaceScopeId(
  kind: "workspace" | "project",
  workspacePath: string,
  identity: WorkspaceInstanceIdentity,
): string {
  const normalized = process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath;
  return `${kind}-${createHash("sha256")
    .update(
      JSON.stringify([
        normalized,
        identity.version,
        identity.device,
        identity.inode,
        identity.birthtimeNs,
      ]),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

export async function resolveRuntimeWorkspaceIds(
  workspacePath: string,
  identity: WorkspaceInstanceIdentity,
): Promise<{ readonly workspaceId: string; readonly projectId: string }> {
  const workspaceId = runtimeWorkspaceScopeId("workspace", workspacePath, identity);
  const fallbackProjectId = runtimeWorkspaceScopeId("project", workspacePath, identity);
  const commonDirectory = await resolveCanonicalGitCommonDirectory(workspacePath);
  if (!commonDirectory) return { workspaceId, projectId: fallbackProjectId };

  try {
    const repository = captureWorkspaceBinding("Git common directory", commonDirectory);
    return {
      workspaceId,
      projectId: runtimeWorkspaceScopeId(
        "project",
        repository.canonicalPath,
        repository.binding.identity,
      ),
    };
  } catch {
    return { workspaceId, projectId: fallbackProjectId };
  }
}

async function resolveCanonicalGitCommonDirectory(workspacePath: string): Promise<string | null> {
  return resolveCanonicalGitCommonDirectoryAt(workspacePath, 0);
}

async function resolveCanonicalGitCommonDirectoryAt(
  directory: string,
  depth: number,
): Promise<string | null> {
  if (depth >= MAX_REPOSITORY_ANCESTORS) return null;
  const marker = path.join(directory, ".git");
  const markerStat = await lstatOrNull(marker);
  if (markerStat === false) return null;
  if (!markerStat) {
    const parent = path.dirname(directory);
    return parent === directory ? null : resolveCanonicalGitCommonDirectoryAt(parent, depth + 1);
  }
  if (markerStat.isSymbolicLink()) return null;

  let gitDirectory: string | null;
  if (markerStat.isDirectory()) {
    gitDirectory = await canonicalDirectory(marker);
  } else if (markerStat.isFile()) {
    const markerText = await readBoundedText(marker);
    const gitDirectoryPath = markerText && parseGitDirectory(markerText);
    gitDirectory = gitDirectoryPath
      ? await canonicalDirectory(path.resolve(path.dirname(marker), gitDirectoryPath))
      : null;
  } else {
    gitDirectory = null;
  }
  if (!gitDirectory) return null;

  const commonDirectoryMarker = path.join(gitDirectory, "commondir");
  const commonDirectoryStat = await lstatOrNull(commonDirectoryMarker);
  if (commonDirectoryStat === false) return null;
  if (!commonDirectoryStat) return gitDirectory;
  if (!commonDirectoryStat.isFile() || commonDirectoryStat.isSymbolicLink()) return null;

  const commonDirectoryText = await readBoundedText(commonDirectoryMarker);
  const commonDirectoryPath = commonDirectoryText && parseSingleLine(commonDirectoryText);
  return commonDirectoryPath
    ? canonicalDirectory(path.resolve(gitDirectory, commonDirectoryPath))
    : null;
}

async function lstatOrNull(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null | false> {
  try {
    return await lstat(filePath);
  } catch (error) {
    return isMissingPathError(error) ? null : false;
  }
}

async function canonicalDirectory(directory: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(directory);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : null;
  } catch {
    return null;
  }
}

async function readBoundedText(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(MAX_GIT_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= MAX_GIT_METADATA_BYTES ? buffer.toString("utf8", 0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function parseGitDirectory(value: string): string | null {
  const line = parseSingleLine(value);
  return line?.startsWith("gitdir: ") ? line.slice("gitdir: ".length) || null : null;
}

function parseSingleLine(value: string): string | null {
  const line = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  return line && !line.includes("\0") && !/[\r\n]/.test(line) ? line : null;
}

function isMissingPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
