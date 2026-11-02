import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { MainSessionWorkspaceBinding, RepositoryAgentIdentity } from "../common/marshal-ipc-contract";
import {
  normalizeRepositoryAgentName,
  normalizeRepositoryAgentPath,
} from "../common/workspace-role-identity";

export function captureWorkspaceBinding(
  name: string,
  workspacePath: string,
): { binding: MainSessionWorkspaceBinding; canonicalPath: string } {
  let canonicalPath: string;
  let stat: fs.BigIntStats;
  try {
    canonicalPath = fs.realpathSync(path.resolve(workspacePath));
    stat = fs.statSync(canonicalPath, { bigint: true });
  } catch {
    throw new Error(`Workspace "${name}" is unavailable. Restore it or choose another workspace.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace "${name}" is unavailable. Restore it or choose another workspace.`);
  }

  const inode = stat.ino.toString();
  const birthtimeNs = stat.birthtimeNs.toString();
  if (inode === "0" && birthtimeNs === "0") {
    throw new Error(
      `Workspace "${name}" is on a filesystem that does not expose a stable directory identity.`,
    );
  }

  return {
    canonicalPath,
    binding: {
      name,
      identity: {
        version: 1,
        device: stat.dev.toString(),
        inode,
        birthtimeNs,
      },
    },
  };
}

export function createRepositoryAgentIdentity(input: {
  path: string;
  name: string;
  canonicalContent: string;
}): RepositoryAgentIdentity {
  return {
    version: 1,
    normalizedPath: normalizeRepositoryAgentPath(input.path),
    declaredName: normalizeRepositoryAgentName(input.name),
    contentDigest: createHash("sha256").update(input.canonicalContent, "utf8").digest("hex"),
  };
}
