import type { PersistedSession } from "./session-store";

export function resolveSessionMcpScope(
  session: Pick<PersistedSession, "source" | "scopedMcp"> | null | undefined,
): readonly string[] | null {
  if (session?.scopedMcp !== undefined) return session.scopedMcp;
  return session?.source === "subagent" || session?.source === "workflow-agent" ? [] : null;
}