/**
 * Built-in agent types recognized by `spawnSubagent` and the workflow
 * engine's `ctx.spawn` / `ctx.run`. These names are NOT repo-scoped
 * `.github/agents/<name>.agent.md` files — they're well-known agent type
 * markers documented in the Copilot CLI / Task tool surface.
 *
 * When `agentName` matches one of these, `selectRepositoryAgent` skips the
 * repo-local lookup (so the spawn does not require a `workspaceName`,
 * `repoPath`, or `worktree`) and no `repositoryAgent` system context is
 * injected. The downstream session simply runs as a plain Marshal
 * subagent.
 *
 * Keep this list in sync with the agent types exposed by the Task tool.
 */
export const BUILT_IN_AGENT_TYPES: readonly string[] = [
  "general-purpose",
  "explore",
  "task",
  "rubber-duck",
  "code-review",
  "configure-copilot",
  "research",
] as const;

const BUILT_IN_AGENT_TYPE_SET = new Set(BUILT_IN_AGENT_TYPES.map((name) => name.toLowerCase()));

/**
 * Returns true when `name` is a recognized built-in agent type (case- and
 * whitespace-insensitive). Built-in types bypass the repo-local agent
 * lookup performed by `SessionManager.selectRepositoryAgent`.
 */
export function isBuiltInAgentType(name: string | undefined | null): boolean {
  if (!name) return false;
  return BUILT_IN_AGENT_TYPE_SET.has(name.trim().toLowerCase());
}
