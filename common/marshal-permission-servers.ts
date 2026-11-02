/**
 * Canonical mapping of permission server config keys to display names.
 * This is the SINGLE SOURCE OF TRUTH — all other files derive from this.
 *
 * `isBuiltinShell` marks servers that are invoked as shell commands via a shim.
 * Criteria for adding an entry:
 *   1. There is an entry in `permissions.servers.<configKey>` so the UI can
 *      expose enable / auto-approve toggles.
 *   2. The capability is invoked as a shell command whose canonical first
 *      token (basename of executable, lowercase, no extension) equals the
 *      configKey. This is what lets the policy evaluator route the shell
 *      request to the right server entry.
 * The generic "shell" server itself is NOT a built-in shell shim — it's the
 * fallback server for arbitrary shell commands, and must stay `false`.
 */
export const PERMISSION_SERVERS = [
  { configKey: "filesystem", displayName: "File System Access", isBuiltinShell: false },
  {
    configKey: "playwright",
    displayName: "Browser Control and Web Browsing",
    isBuiltinShell: false,
  },
  { configKey: "shell", displayName: "Shell", isBuiltinShell: false },
] as const;

export type ServerConfigKey = (typeof PERMISSION_SERVERS)[number]["configKey"];

/** Display name → config key lookup */
export const DISPLAY_NAME_TO_CONFIG_KEY: Record<string, string> = Object.fromEntries(
  PERMISSION_SERVERS.map((s) => [s.displayName, s.configKey]),
);

/** Config key → display name lookup */
export const CONFIG_KEY_TO_DISPLAY_NAME: Record<string, string> = Object.fromEntries(
  PERMISSION_SERVERS.map((s) => [s.configKey, s.displayName]),
);

/**
 * Collapse user-disabled and tenant-disabled servers into a single Set of
 * display names. Used by the system-prompt provider so buildSystemMessage can
 * omit sections for any server the user OR the tenant has disabled. Custom
 * MCP keys without a built-in display mapping are skipped — buildSystemMessage
 * only has prompt sections for the built-in capabilities.
 */
export function buildDisabledDisplayNameSet(opts: {
  servers: Record<string, { enabled: boolean } | undefined> | undefined;
  tenantDisabledServers: string[] | undefined;
}): Set<string> {
  const disabled = new Set<string>();
  for (const [configKey, perm] of Object.entries(opts.servers ?? {})) {
    if (perm && !perm.enabled) {
      const display = CONFIG_KEY_TO_DISPLAY_NAME[configKey];
      if (display) disabled.add(display);
    }
  }
  // Tenant entries are historically a mix of display names and config keys
  // — try both directions to canonicalize.
  for (const entry of opts.tenantDisabledServers ?? []) {
    const display =
      CONFIG_KEY_TO_DISPLAY_NAME[entry] ?? (DISPLAY_NAME_TO_CONFIG_KEY[entry] ? entry : undefined);
    if (display) disabled.add(display);
  }
  return disabled;
}

/**
 * Config keys of servers that are MCP tool providers (have per-tool toggles).
 * `filesystem` is intentionally absent: File System Access is a built-in
 * capability (Marshal self-tools gated as read/write), not an MCP server, so it
 * renders in the Capabilities section like Shell.
 */
export const MCP_SERVER_CONFIG_KEYS: ReadonlySet<string> = new Set(["playwright"]);

/**
 * Config keys of built-in SDK capabilities invoked as shell commands via a
 * shim. Used by the permission evaluator to route shell requests whose first
 * token names the capability back to the corresponding
 * `permissions.servers.<key>` entry.
 */
export const BUILTIN_SHELL_SERVERS: ReadonlySet<string> = new Set(
  PERMISSION_SERVERS.filter((s) => s.isBuiltinShell).map((s) => s.configKey),
);

/**
 * Shell command prefixes considered safe (read-only), grouped for Settings UI.
 * The actual prefix check lives in `electron/permission-policy.ts` (READ_ONLY_PREFIXES).
 * These categories are used to render a collapsible list in the Settings panel.
 */
export const SAFE_COMMAND_CATEGORIES = [
  {
    label: "File & Directory",
    prefixes: ["ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "locate"],
  },
  {
    label: "Search",
    prefixes: ["grep", "rg", "ag", "ack"],
  },
  {
    label: "Text Processing",
    prefixes: ["jq", "xmllint", "json_pp", "diff", "comm", "uniq", "cut", "tr", "fold", "column"],
  },
  {
    label: "Git",
    prefixes: [
      "git status",
      "git log",
      "git diff",
      "git show",
      "git branch",
      "git remote",
      "git tag",
      "git rev-parse",
    ],
  },
  {
    label: "Package Managers",
    prefixes: ["npm list", "npm ls"],
  },
  {
    label: "System Info",
    prefixes: ["echo", "printf", "date", "cal", "uptime", "whoami", "id", "hostname", "pwd"],
  },
] as const;
