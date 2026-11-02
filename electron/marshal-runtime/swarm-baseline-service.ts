import { swarmRunTargets, type SwarmRun, type SwarmRunTarget } from "@marshal/swarm";

/**
 * The declared target for one scope. A run recorded before `targets` existed
 * degrades to the single scope named by `scope`/`targetRef`/`targetHead`; any
 * other scope is foreign and refused.
 */
export function requireDeclaredTarget(run: SwarmRun, scope: string): SwarmRunTarget {
  const targets = swarmRunTargets(run);
  if (targets.length === 0) {
    throw new Error(`Swarm run "${run.runId}" declares no repository targets.`);
  }
  const target = targets.find((candidate) => candidate.scope === scope);
  if (!target) {
    throw new Error(`Task scope "${scope}" is not one of the run's declared repository targets.`);
  }
  return target;
}
