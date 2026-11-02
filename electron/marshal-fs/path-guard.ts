// Marshal ownership: relocated module identity.
import fs from "node:fs/promises";
import path from "node:path";

import { isPathUnderAnyDir } from "../permission-path-scope";
import { expandHome } from "./shared";

export interface FsAccessScope {
  workspaceDir: string;
  readGrants: readonly string[];
  writeGrants: readonly string[];
}

/** realpath, returning null when the path does not exist (ENOENT). Other
 *  errors (EACCES, ELOOP, …) propagate so a real failure is never masked. */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Handler-entry security re-check. The pre-hook gate is LEXICAL (no symlink
 * follow); this closes the TOCTOU residual — a symlink under a granted folder
 * pointing outside it (e.g. ~/.ssh) passes the lexical gate but is caught
 * here. For not-yet-existing targets (a recursive mkdir, a move destination)
 * realpath returns null (ENOENT), so we resolve the nearest EXISTING ancestor's
 * real path and re-append the not-yet-created segments before validating — the
 * pattern from @modelcontextprotocol/server-filesystem validatePath, extended
 * to deep targets (`a/b/c` where only `a` exists). Returns the canonical real
 * path for the operation to use, or throws.
 */
export async function assertRealpathAllowed(
  rawPath: string,
  kind: "read" | "write",
  scope: FsAccessScope,
): Promise<string> {
  if (!rawPath) throw new Error("path is required");
  const absolute = path.resolve(expandHome(rawPath));
  const roots =
    kind === "read"
      ? [scope.workspaceDir, ...scope.readGrants]
      : [scope.workspaceDir, ...scope.writeGrants];

  const real = await realpathOrNull(absolute);
  if (real !== null) {
    if (!isPathUnderAnyDir(real, roots)) {
      throw new Error(`Access denied — symlink target outside allowed folders: ${real}`);
    }
    return real;
  }

  // New target: walk up to the nearest existing ancestor, realpath it (so any
  // symlink in the existing chain is resolved), then re-append the missing leaf
  // segments. The missing segments cannot themselves be symlinks (they do not
  // exist yet), so the candidate is safe to validate lexically.
  let existing = path.dirname(absolute);
  const trailing = [path.basename(absolute)];
  let existingReal = await realpathOrNull(existing);
  while (existingReal === null) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`No existing ancestor directory for: ${absolute}`);
    }
    trailing.unshift(path.basename(existing));
    existing = parent;
    // eslint-disable-next-line no-await-in-loop -- sequential ancestor walk; each step depends on the prior
    existingReal = await realpathOrNull(existing);
  }
  const candidate = path.join(existingReal, ...trailing);
  if (!isPathUnderAnyDir(candidate, roots)) {
    throw new Error(`Access denied — path outside allowed folders: ${absolute}`);
  }
  return candidate;
}
