/**
 * SDK-native tools built into the agent backend, not exposed via MCP.
 * Maintained by hand because the Copilot SDK does not export its tool roster.
 * Gateway enforces its tool policy server-side; this metadata is for local
 * Copilot SDK tool discovery and permission gating.
 */
export const SDK_BUILTIN_TOOLS = {
  web_fetch: { gatedByServer: "playwright" },
  view: { gatedByServer: "filesystem" },
  grep: { gatedByServer: "filesystem" },
  glob: { gatedByServer: "filesystem" },
  edit: { gatedByServer: "filesystem" },
  create: { gatedByServer: "filesystem" },
} as const;

export const SDK_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SDK_BUILTIN_TOOLS),
  "bash",
  "powershell",
  "pwsh",
  "run_in_terminal",
  "runinterminal",
  "shell",
  "skill",
  "task",
  "web_search",
  "report_intent",
]);

/** SDK write tools that must go through HITL — they bypass onPermissionRequest by default. */
const SDK_HITL_REQUIRED: ReadonlySet<SdkBuiltinToolName> = new Set(["edit", "create"]);

export type SdkBuiltinToolName = keyof typeof SDK_BUILTIN_TOOLS;

function hasSdkBuiltinTool(name: string): name is SdkBuiltinToolName {
  return Object.prototype.hasOwnProperty.call(SDK_BUILTIN_TOOLS, name);
}

export function normalizeSdkToolName(name: string): SdkBuiltinToolName | undefined {
  const normalized = name.toLowerCase();
  return hasSdkBuiltinTool(normalized) ? normalized : undefined;
}

export function isSdkBuiltinTool(name: string): boolean {
  return normalizeSdkToolName(name) !== undefined;
}

export function getServerForSdkTool(name: string): string | undefined {
  const normalized = normalizeSdkToolName(name);
  if (!normalized) return undefined;
  return SDK_BUILTIN_TOOLS[normalized].gatedByServer;
}

export function isSdkHitlRequired(name: string): boolean {
  const normalized = normalizeSdkToolName(name);
  return normalized !== undefined && SDK_HITL_REQUIRED.has(normalized);
}

export function isSdkFilesystemReadTool(name: string): boolean {
  const normalized = normalizeSdkToolName(name);
  return (
    normalized !== undefined &&
    SDK_BUILTIN_TOOLS[normalized].gatedByServer === "filesystem" &&
    !SDK_HITL_REQUIRED.has(normalized)
  );
}
