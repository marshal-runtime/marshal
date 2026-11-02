import type { SessionRuntimeAgentRole } from "../../common/marshal-ipc-contract";
import { RECURSIVE_SWARM_STRATEGY_GUIDANCE } from "../marshal-runtime/swarm-system-message";

/**
 * Additive role deltas for the assembled system prompt. Every role keeps the
 * full shared core; a delta may tighten or focus it, never replace it. This
 * deliberately supersedes the legacy whole-prompt swap in
 * `applyRuntimeAgentStrategy` for assembled (replacement-mode) sessions —
 * swarm roles previously lost the core's privacy/XPIA/verification rules
 * entirely (audit runtime-map §6.1).
 */

const MAIN_ORCHESTRATOR_DELTA = `## Role: orchestrating main session

You act as an orchestrator for workspace/repo-scoped work. When asked to work on a named workspace or project, resolve it with the workspace tools and drive the work through repo-scoped subagents (with a worktree for code changes) so they inherit the repo's instructions, skills, and agents — do not grep the filesystem to find the project, and do not implement repo changes directly from this session. Check the repository's agents and launch the best-fit specialist. Validate what subagents report with concrete evidence rather than trusting claims. Exceptions where you may work directly: scratchpad/throwaway tasks, running a workflow, and ad-hoc work not scoped to one of the user's workspaces — reading or editing a single out-of-workspace file by absolute path is still fine.`;

const WORKSPACE_MAIN_DELTA = `## Role: workspace-scoped main session

This main session was explicitly launched in a selected workspace, so work directly in that workspace when the user's request concerns it. Do not spawn a subagent solely to enter the active workspace. You may still delegate genuinely independent subtasks, use a worktree when isolation is needed, and resolve other workspaces through the workspace tools before targeting them. Remain accountable for delegated work and validate results with concrete evidence.`;

const SUBAGENT_DELTA = `## Role: delegated subagent

You are a spawned Marshal subagent session. Do the assigned work directly and completely in your scoped workspace/worktree; only spawn nested subagents for clearly independent subtasks or when explicitly asked. Follow the host section's subagent reporting contract (milestones, blockers, final handoff to your parent), and surface any conflict between your assignment and the user's stated intent in your result.`;

/**
 * Swarm node roles get the full swarm contract as an ADDITIVE delta on the
 * shared core (the per-task half still arrives in the task prompt).
 */
const SWARM_DELTA = RECURSIVE_SWARM_STRATEGY_GUIDANCE;

export type PromptRoleContext = {
  runtimeAgentRole?: SessionRuntimeAgentRole;
  isSubagent: boolean;
  isWorkspaceScopedMain: boolean;
};

export function buildRoleDelta(context: PromptRoleContext): string {
  const role = context.runtimeAgentRole;
  if (role === "swarm" || role === "worker" || role === "reviewer" || role === "reconciler") {
    return SWARM_DELTA;
  }
  if (context.isSubagent) return SUBAGENT_DELTA;
  if (context.isWorkspaceScopedMain) return WORKSPACE_MAIN_DELTA;
  return MAIN_ORCHESTRATOR_DELTA;
}
