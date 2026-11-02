import type { PermissionsConfig } from "../common/marshal-ipc-contract";
import { CONFIG_KEY_TO_DISPLAY_NAME } from "../common/marshal-permission-servers";
import { getServerForSdkTool } from "../common/marshal-sdk-builtin-tools";
import type { AuditDecisionSource } from "./audit-log";
import { LOCAL_FILE_TOOL_DEFINITIONS } from "./marshal-fs/shared";
import {
  getBarePlaywrightToolName,
  PLAYWRIGHT_EXPLICIT_WRITE_TOOLS,
} from "./platform/security/browser-tools/names";
import type { TenantPolicyProvider } from "./tenant-policy";

/**
 * Capability gating a tool — the SDK builtins (view/grep/glob/edit/create) plus
 * the local filesystem tools that replaced the filesystem MCP, both on
 * "filesystem". Wider than getServerForSdkTool, which is SDK-builtins only.
 */
function getGatingServerForTool(toolName: string): string | undefined {
  if (Object.hasOwn(LOCAL_FILE_TOOL_DEFINITIONS, toolName)) return "filesystem";
  const sdkServer = getServerForSdkTool(toolName.toLowerCase());
  if (sdkServer) return sdkServer;
  return undefined;
}

/** Result returned when a pre-hook policy rule denies a tool invocation. */
export interface PreHookDeny {
  permissionDecision: "deny";
  permissionDecisionReason: string;
}

export type PolicyContext = {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  /** Raw SDK tool args (string in the pre-hook). */
  toolArgs?: unknown;
  fileUploadEnabled: boolean;
  permissions: PermissionsConfig;
  tenantPolicy?: Pick<TenantPolicyProvider, "get">;
};

export type PolicyRuleDeny = PreHookDeny & {
  serverName?: string;
  kind?: "mcp" | "custom-tool" | "shell";
};

type DisabledToolMatch = {
  serverName: string;
  kind?: "mcp" | "custom-tool" | "shell";
};

export type PolicyRule = {
  id: string;
  source: AuditDecisionSource;
  serverName?: string;
  kind?: "mcp" | "custom-tool" | "shell";
  preHook: (ctx: PolicyContext) => PolicyRuleDeny | null;
};

function isPlaywrightTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower === "playwright" || lower.startsWith("playwright-") || lower.startsWith("playwright__")
  );
}

const PLAYWRIGHT_CODE_EXECUTION_BARE_TOOLS = new Set<string>([
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_evaluate",
]);

function isPlaywrightCodeExecutionTool(toolName: string): boolean {
  const bare = getBarePlaywrightToolName(toolName);
  return isPlaywrightTool(toolName) && PLAYWRIGHT_CODE_EXECUTION_BARE_TOOLS.has(bare);
}

function checkTenantDisabledTool(ctx: PolicyContext): DisabledToolMatch | null {
  const policy = ctx.tenantPolicy?.get();
  if (!policy?.disabledServers?.length) return null;
  const tl = ctx.toolName.toLowerCase();
  const mappedServer = getGatingServerForTool(ctx.toolName);
  if (mappedServer) {
    const mappedDisplayName = CONFIG_KEY_TO_DISPLAY_NAME[mappedServer] ?? mappedServer;
    for (const serverName of policy.disabledServers) {
      const lowerServerName = serverName.toLowerCase();
      if (
        lowerServerName === mappedServer.toLowerCase() ||
        lowerServerName === mappedDisplayName.toLowerCase()
      ) {
        return { serverName, kind: "custom-tool" };
      }
    }
  }
  /**
   * NOTE: unlike user-disabled tool matching (which is strict:
   * `<configKey>__<toolName>` boundary match), this uses `includes()` to
   * preserve the existing permissive matching for tenant admin policies.
   * Tenant-disabledServers entries have historically accepted a loose mix
   * of display names, config keys, and tool-name prefixes. Tightening it
   * requires a separate audit of tenant deployments; until then, admins
   * should avoid short names like `sh` or `ql` that could false-match.
   */
  for (const serverName of policy.disabledServers) {
    if (tl.includes(serverName.toLowerCase())) return { serverName };
  }
  return null;
}

function checkUserDisabledTool(ctx: PolicyContext): DisabledToolMatch | null {
  const servers = ctx.permissions.servers;
  if (!servers) return null;
  const tl = ctx.toolName.toLowerCase();
  const mappedServer = getGatingServerForTool(ctx.toolName);
  if (mappedServer && !(servers[mappedServer]?.enabled ?? true)) {
    return {
      serverName: CONFIG_KEY_TO_DISPLAY_NAME[mappedServer] ?? mappedServer,
      kind: "custom-tool",
    };
  }
  const entries = Object.entries(servers).sort(([a], [b]) => b.length - a.length);
  for (const [configKey, perm] of entries) {
    if (!configKey || !perm || perm.enabled) continue;
    const k = configKey.toLowerCase();
    if (tl === k || tl.startsWith(`${k}__`) || tl.startsWith(`${k}-`)) {
      return { serverName: CONFIG_KEY_TO_DISPLAY_NAME[configKey] ?? configKey };
    }
  }
  return null;
}

export const TENANT_DISABLED_SERVER: PolicyRule = {
  id: "tenant-disabled-server",
  source: "pre-hook-tenant-policy",
  preHook: (ctx) => {
    const match = checkTenantDisabledTool(ctx);
    if (!match) return null;
    return {
      permissionDecision: "deny",
      permissionDecisionReason: `${match.serverName} is disabled by your organization's policy.`,
      serverName: match.serverName,
      kind: match.kind,
    };
  },
};

export const USER_DISABLED_SERVER: PolicyRule = {
  id: "user-disabled-server",
  source: "pre-hook-disabled-server",
  preHook: (ctx) => {
    const match = checkUserDisabledTool(ctx);
    if (!match) return null;
    return {
      permissionDecision: "deny",
      permissionDecisionReason: `${match.serverName} is currently disabled by the user.`,
      serverName: match.serverName,
      kind: match.kind,
    };
  },
};

export const PLAYWRIGHT_FILE_WRITE_FS_GATE: PolicyRule = {
  id: "playwright-file-write-fs-gate",
  source: "pre-hook-blocked-tool",
  serverName: "playwright",
  kind: "mcp",
  preHook: (ctx) => {
    const bare = getBarePlaywrightToolName(ctx.toolName);
    if (!Object.hasOwn(PLAYWRIGHT_EXPLICIT_WRITE_TOOLS, bare)) return null;
    const fsEnabled = ctx.permissions.servers?.["filesystem"]?.enabled ?? true;
    if (fsEnabled) return null;
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        "Browser file writes require File System Access. Enable it in Settings → Extensions to use these tools.",
    };
  },
};

// Closes the download.saveAs(arbitraryPath) path from an AIRT finding when filesystem is
// disabled. When filesystem is enabled, the remaining write-path gap is addressed by the
// browser file-write permission pipeline.
export const PLAYWRIGHT_CODE_EXECUTION_FS_GATE: PolicyRule = {
  id: "playwright-code-execution-fs-gate",
  source: "pre-hook-blocked-tool",
  serverName: "playwright",
  kind: "mcp",
  preHook: (ctx) => {
    if (!isPlaywrightCodeExecutionTool(ctx.toolName)) return null;
    const fsEnabled = ctx.permissions.servers?.["filesystem"]?.enabled ?? true;
    if (fsEnabled) return null;
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        "browser_run_code, browser_run_code_unsafe, and browser_evaluate can write files via the Playwright download API. Enable File System Access in Settings → Extensions to use these tools.",
    };
  },
};

export const FILE_UPLOAD_DISABLED: PolicyRule = {
  id: "file-upload-disabled",
  source: "pre-hook-file-upload-disabled",
  serverName: "playwright",
  kind: "mcp",
  preHook: (ctx) => {
    if (ctx.toolName !== "playwright-browser_file_upload" || ctx.fileUploadEnabled) return null;
    return {
      permissionDecision: "deny",
      permissionDecisionReason:
        'File uploads are disabled. Enable "Allow agent file uploads" in Settings → Permissions to use this tool.',
    };
  },
};

export const POLICY_PRE_HOOK_RULES: readonly PolicyRule[] = [
  TENANT_DISABLED_SERVER,
  USER_DISABLED_SERVER,
  PLAYWRIGHT_FILE_WRITE_FS_GATE,
  PLAYWRIGHT_CODE_EXECUTION_FS_GATE,
  FILE_UPLOAD_DISABLED,
];
