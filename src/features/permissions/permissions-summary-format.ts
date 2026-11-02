// Ownership: permissions summary formatting.
import type { PermissionsConfig } from "@/types/electron";

/** One-line summary of a permissions config — usable as a row label. */
export function describePermissions(permissions: PermissionsConfig): string {
  const servers = permissions.servers ?? {};
  const enabledServers = Object.values(servers).filter((s) => s.enabled).length;
  const totalServers = Object.keys(servers).length;
  const approvedTools = Object.values(permissions.tools ?? {}).filter(Boolean).length;
  const shellPatterns = permissions.allow?.length ?? 0;

  const parts = [`${enabledServers}/${totalServers} servers enabled`];
  if (approvedTools > 0) {
    parts.push(`${approvedTools} tool rule${approvedTools !== 1 ? "s" : ""}`);
  }
  if (shellPatterns > 0) {
    parts.push(`${shellPatterns} shell pattern${shellPatterns !== 1 ? "s" : ""}`);
  }
  return parts.join(" · ");
}
