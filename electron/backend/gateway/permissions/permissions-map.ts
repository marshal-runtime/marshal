import type { PermissionsConfig } from "../../../../common/marshal-ipc-contract";
import { migrateToolPermissionKeys } from "../../../migrate-tool-permission-keys";
import {
  buildExecPatchFromAutoApprove,
  buildExecPatchFromShellAllow,
  execToAutoApproveReadOnly,
  execToShellAllow,
  type ToolExecConfig,
} from "./exec-map";
import {
  hasUnrepresentablePatterns,
  mergeBooleansIntoToolPolicy,
  toolPolicyToBooleans,
  type ToolPolicy,
} from "./tools-map";

export const TOOLS_CONFIG_PATH = ["tools"] as const;

interface ToolsSubtree extends ToolPolicy {
  exec?: ToolExecConfig;
}

/**
 * Read-side: pluck `tools` and `tools.exec` from the marshal `config.get`
 * response and project to a `PermissionsConfig` plus metadata
 * (`baseHash` for CAS, `hasUnrepresentablePatterns` for the UI).
 */
export interface ExtractedPermissions {
  permissions: PermissionsConfig;
  baseHash: string;
  hasUnrepresentablePatterns: boolean;
  /**
   * The raw `allow[]` from the marshal tools subtree (strict mode list).
   * Preserved here so the write path can thread it back into the merge helper,
   * ensuring a round-trip through updatePermissions doesn't silently drop it.
   */
  rawAllow: string[] | undefined;
  migrationChanged: boolean;
  migratedToolPolicy: ToolPolicy;
}

function migrateToolPolicyList(
  entries: readonly string[] | undefined,
  enabled: boolean,
): { entries: string[] | undefined; changed: boolean } {
  if (entries === undefined) return { entries: undefined, changed: false };
  const tools = Object.fromEntries(entries.map((entry) => [entry, enabled]));
  const result = migrateToolPermissionKeys({
    autopilotMode: false,
    autoApproveReadOnly: false,
    allow: [],
    tools,
    servers: {},
  });
  return { entries: Object.keys(result.perms.tools), changed: result.changed };
}

function migrateToolPolicy(policy: ToolPolicy): {
  policy: ToolPolicy;
  permissions: Record<string, boolean>;
  changed: boolean;
} {
  const combined = migrateToolPermissionKeys({
    autopilotMode: false,
    autoApproveReadOnly: false,
    allow: [],
    tools: toolPolicyToBooleans(policy),
    servers: {},
  });
  const allow = migrateToolPolicyList(policy.allow, true);
  const alsoAllow = migrateToolPolicyList(policy.alsoAllow, true);
  const deny = migrateToolPolicyList(policy.deny, false);
  const strictNames = new Set(allow.entries ?? []);
  const migratedPolicy: ToolPolicy = {
    ...(policy.allow !== undefined
      ? {
          allow: [...strictNames].filter((name) => combined.perms.tools[name]),
        }
      : {}),
    ...(policy.alsoAllow !== undefined
      ? {
          alsoAllow: (alsoAllow.entries ?? []).filter(
            (name) => combined.perms.tools[name] && !strictNames.has(name),
          ),
        }
      : {}),
    ...(policy.deny !== undefined
      ? {
          deny: (deny.entries ?? []).filter(
            (name) => Object.hasOwn(combined.perms.tools, name) && !combined.perms.tools[name],
          ),
        }
      : {}),
  };
  return {
    policy: migratedPolicy,
    permissions: combined.perms.tools,
    changed: combined.changed || allow.changed || alsoAllow.changed || deny.changed,
  };
}

export function extractPermissionsFromConfig(resp: unknown): ExtractedPermissions {
  const obj = (resp ?? {}) as { config?: { tools?: ToolsSubtree }; hash?: string };
  const tools: ToolsSubtree = obj.config?.tools ?? {};
  const exec = tools.exec;
  const migrated = migrateToolPolicy(tools);

  const permissions: PermissionsConfig = {
    autopilotMode: false,
    autoApproveReadOnly: execToAutoApproveReadOnly(exec),
    allow: execToShellAllow(exec),
    denyPatterns: [],
    tools: migrated.permissions,
    servers: {},
  };

  return {
    permissions,
    baseHash: obj.hash ?? "",
    hasUnrepresentablePatterns: hasUnrepresentablePatterns(migrated.policy),
    rawAllow: migrated.policy.allow,
    migrationChanged: migrated.changed,
    migratedToolPolicy: migrated.policy,
  };
}

/**
 * Write-side: translate a `Partial<PermissionsConfig>` patch into the
 * marshal `tools` subtree shape suitable for `config.patch`. Returns
 * the patch plus any shell patterns that were rejected (non-binary
 * forms) so the UI can surface warning chips.
 *
 * `currentSubtree` is the existing `tools` subtree from a prior
 * `config.get` — needed to compute the merge for `tools.alsoAllow / deny`
 * (we don't blow away unrelated entries on a partial write).
 */
export function mapPermissionsToMarshalPatch(
  patch: Partial<PermissionsConfig>,
  currentSubtree: { tools: ToolPolicy; exec: ToolExecConfig },
): { tools?: ToolsSubtree; rejectedShellPatterns?: string[] } {
  const out: ToolsSubtree = {};
  let rejectedShellPatterns: string[] | undefined;

  if (patch.tools !== undefined) {
    const merged = mergeBooleansIntoToolPolicy(currentSubtree.tools, patch.tools);
    if (merged.allow !== undefined) out.allow = merged.allow;
    out.alsoAllow = merged.alsoAllow;
    out.deny = merged.deny;
  }

  const execPatch: Partial<ToolExecConfig> = {};

  if (patch.autoApproveReadOnly !== undefined) {
    Object.assign(execPatch, buildExecPatchFromAutoApprove(patch.autoApproveReadOnly));
  }

  if (patch.allow !== undefined) {
    const { patch: shellPatch, rejected } = buildExecPatchFromShellAllow(patch.allow);
    Object.assign(execPatch, shellPatch);
    if (rejected.length > 0) rejectedShellPatterns = rejected;
  }

  if (Object.keys(execPatch).length > 0) {
    out.exec = execPatch as ToolExecConfig;
  }

  // `autopilotMode`, `denyPatterns`, and `servers` have no marshal equivalent — silently
  // drop. The UI guarantees the user can't write them in gateway mode
  // (controllable.shellDeny / serverEnabled / serverAutoApprove all false),
  // so this is defense-in-depth, not lossy behavior.

  return Object.keys(out).length > 0
    ? { tools: out, ...(rejectedShellPatterns ? { rejectedShellPatterns } : {}) }
    : rejectedShellPatterns
      ? { rejectedShellPatterns }
      : {};
}

export function wrapPermissionsPatchAtConfigPath(
  toolsSubtreePatch: object,
): Record<string, unknown> {
  return { tools: toolsSubtreePatch };
}
