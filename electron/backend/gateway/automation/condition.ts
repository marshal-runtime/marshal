import type { AutomationStep } from "../../../../common/marshal-ipc-contract";

// toolsAllow MUST include "cron" to activate selfRemoveOnlyJobId scope; marshal
// filters strictly to named entries so [cron] alone would strip every other tool.
export const WATCHER_TOOLS_ALLOW = [
  "cron",
  "sessions_spawn",
  "web_fetch",
  "web_search",
  "group:plugins",
] as const;

// Replaced with the real cron job id after `cron.add` returns it (two-phase create).
export const WATCHER_PLACEHOLDER_ID = "__M_WATCHER_PLACEHOLDER_ID__";

const VALID_INTERVALS: readonly number[] = [5, 15, 30, 60];

export interface ConditionWatcherPromptInput {
  condition: string;
  steps: AutomationStep[];
  watcherCronId: string;
}

export function buildConditionWatcherPrompt(input: ConditionWatcherPromptInput): string {
  const action = buildActionPrompt(input.steps);
  return [
    "Check whether this condition is currently true:",
    "",
    "CONDITION:",
    input.condition,
    "",
    "Use available tools (web_fetch, web_search, plugin tools, etc.) to inspect the current state of the world.",
    "",
    "If the condition is satisfied:",
    "  1. Call sessions_spawn with task = the ACTION below",
    `  2. Call cron.remove({id: "${input.watcherCronId}"}) to stop polling`,
    '  3. Reply briefly: "Fired."',
    "",
    "If NOT satisfied: reply briefly with what you checked (one short sentence is fine), and stop. Do NOT take action.",
    "",
    "ACTION (only run when condition is met, via sessions_spawn):",
    action,
    "",
    "If similar work has already been completed recently, the action should report no-op rather than duplicate the work.",
  ].join("\n");
}

export function buildActionPrompt(steps: AutomationStep[]): string {
  return steps.map((s) => s.prompt).join("\n\n");
}

// marshal CronScheduleSchema: `every` is `{ kind, everyMs }` — milliseconds, not a duration expression.
export function conditionIntervalToCronSchedule(interval: number | undefined): {
  kind: "every";
  everyMs: number;
} {
  const value = interval ?? 15;
  if (!VALID_INTERVALS.includes(value)) {
    throw new Error(
      `conditionIntervalToCronSchedule: ${value} is not a canonical interval (valid: 5/15/30/60)`,
    );
  }
  return { kind: "every", everyMs: value * 60_000 };
}
