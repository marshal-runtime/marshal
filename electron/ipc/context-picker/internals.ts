/** Internal helpers for the Context Picker IPC layer. Imported by `ipc.ts` and tests. */

import type { ContextEntityType } from "../../../common/marshal-ipc-contract";

const DEFAULT_TYPES: ReadonlySet<ContextEntityType> = new Set(["People", "File"]);

function isContextEntityType(value: unknown): value is ContextEntityType {
  return value === "People" || value === "File";
}

/** Falls back to defaults when no valid types are requested. */
export function resolveEntityTypes(
  entityTypes: unknown[] | undefined,
): ReadonlySet<ContextEntityType> {
  if (!entityTypes || entityTypes.length === 0) return DEFAULT_TYPES;
  const safeTypes = entityTypes.filter(isContextEntityType);
  return safeTypes.length > 0 ? new Set(safeTypes) : DEFAULT_TYPES;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
