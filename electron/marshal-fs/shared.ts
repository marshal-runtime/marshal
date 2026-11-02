import path from "node:path";

import { FIRST_PARTY_TOOL_NAMES as TOOL } from "../../common/tool-names";
// Single source of truth for tilde expansion — handles `~`, `~/`, and the
// Windows `~\` form. Re-exported so the FS-tool modules have one path facade.
import { expandHome } from "../sensitive-path-permission-guard";

export { expandHome };

/**
 * The five local filesystem tools, mapped to the permission `kind` and
 * the arg holding the path to gate. The normalizer rewrites a matching
 * custom-tool request into a synthetic read/write so the existing path rules
 * (sensitive-path-gate, folder-grant, read-tool-auto-approval-rule) apply unchanged.
 * `move` gates its destination as a write; the handler also gates the source
 * as a read.
 */
export const LOCAL_FILE_TOOL_DEFINITIONS: Record<
  string,
  { kind: "read" | "write"; pathArg: string }
> = {
  [TOOL.listLocalFiles]: { kind: "read", pathArg: "path" },
  [TOOL.getLocalFileTree]: { kind: "read", pathArg: "path" },
  [TOOL.statLocalPath]: { kind: "read", pathArg: "path" },
  [TOOL.createLocalDirectory]: { kind: "write", pathArg: "path" },
  [TOOL.moveLocalPath]: { kind: "write", pathArg: "destination" },
};

/** Lexical resolution only — no symlink follow. Mirrors the pre-hook gate. */
export function resolveLocalFilePath(rawPath: string): string {
  return path.resolve(expandHome(rawPath));
}
