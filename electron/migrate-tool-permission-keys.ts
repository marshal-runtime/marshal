import type { PermissionsConfig } from "../common/marshal-ipc-contract";
import {
  canonicalizeFirstPartyPermissionKey,
  expandLegacyFirstPartyPermissionPattern,
} from "../common/tool-names";

function booleanRecordEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => right[key] === left[key])
  );
}

function stringArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function previousToolsEqual(
  left: PermissionsConfig["previousTools"],
  right: PermissionsConfig["previousTools"],
): boolean {
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => right[key] !== undefined && booleanRecordEqual(left[key], right[key]))
  );
}

function migrationRank(key: string): number {
  if (!key.startsWith("tool:")) return 0;
  const name = key.slice("tool:".length);
  const legacyRank = name.startsWith("marshal_") ? 1 : name.startsWith("m_") ? 2 : 0;
  if (expandLegacyFirstPartyPermissionPattern(key) !== null) return 10 + legacyRank;
  const canonical = canonicalizeFirstPartyPermissionKey(key);
  if (canonical === key) return 0;
  return legacyRank || 4;
}

/**
 * Migrates persisted first-party permission keys to the canonical public tool
 * API. Canonical entries always win collisions; without one, repo-era keys win
 * over host aliases. Retired model surfaces are
 * removed. The same rules apply to tools, allow entries, and previousTools
 * snapshots so global and per-entity permissions stay aligned.
 */
export function migrateToolPermissionKeys(perms: PermissionsConfig): {
  perms: PermissionsConfig;
  changed: boolean;
} {
  const rewriteTargets = (key: string): string[] => {
    const expanded = expandLegacyFirstPartyPermissionPattern(key);
    if (expanded !== null) {
      if (expanded.length === 0) return [];
      return [...expanded, key];
    }
    const canonical = canonicalizeFirstPartyPermissionKey(key);
    if (canonical === null) return [];
    return [canonical];
  };

  const rewriteMap = (input: Record<string, boolean>): Record<string, boolean> => {
    const output: Record<string, boolean> = {};
    const entries = Object.entries(input).sort(
      ([left], [right]) => migrationRank(left) - migrationRank(right) || left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      for (const canonical of rewriteTargets(key)) {
        if (!(canonical in output)) output[canonical] = value;
      }
    }
    return output;
  };

  const tools = rewriteMap(perms.tools);

  const allow: string[] = [];
  const seenAllow = new Set<string>();
  for (const entry of perms.allow) {
    for (const canonical of rewriteTargets(entry)) {
      if (seenAllow.has(canonical)) {
        continue;
      }
      seenAllow.add(canonical);
      allow.push(canonical);
    }
  }

  let previousTools = perms.previousTools;
  if (previousTools) {
    const migrated: Record<string, Record<string, boolean>> = {};
    const groups = Object.entries(previousTools).sort(
      ([left], [right]) => migrationRank(left) - migrationRank(right) || left.localeCompare(right),
    );
    for (const [groupKey, snapshot] of groups) {
      for (const canonicalGroup of rewriteTargets(groupKey)) {
        if (!(canonicalGroup in migrated)) migrated[canonicalGroup] = rewriteMap(snapshot);
      }
    }
    previousTools = migrated;
  }

  const migrated: PermissionsConfig = {
    ...perms,
    tools,
    allow,
    ...(previousTools ? { previousTools } : {}),
  };
  const outputChanged =
    !booleanRecordEqual(perms.tools, tools) ||
    !stringArrayEqual(perms.allow, allow) ||
    !previousToolsEqual(perms.previousTools, previousTools);
  return outputChanged ? { perms: migrated, changed: true } : { perms, changed: false };
}
