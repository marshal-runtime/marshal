import type { PermissionsConfig } from "../common/marshal-ipc-contract";

/**
 * Promote structured tool/MCP entries from allow[] into the tools map.
 * Shell patterns remain in allow[]. Existing explicit tool values win.
 */
export function migrateToolsFromAllow(perms: PermissionsConfig): PermissionsConfig {
  const shellPatterns: string[] = [];
  const tools: Record<string, boolean> = { ...perms.tools };

  for (const pattern of perms.allow) {
    if (pattern.startsWith("tool:") || pattern.startsWith("mcp:")) {
      const key = pattern.endsWith(":*") ? pattern.slice(0, -2) : pattern;
      if (!(key in tools)) tools[key] = true;
    } else {
      shellPatterns.push(pattern);
    }
  }

  return {
    ...perms,
    allow: shellPatterns,
    tools,
  };
}
