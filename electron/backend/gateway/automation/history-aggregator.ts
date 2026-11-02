// Pure function aggregating multi-step gateway-mode automation runs into the
// shared AutomationRunData shape consumed by the renderer. Reads parent
// cron run-log entries (one per chain instance) plus tail-cron metadata +
// per-tail run-log entries, and produces one AutomationRunData per chain
// instance, with stepResults[] summarizing each step.
//
// WORKAROUND: marshal has no chained-payload primitive yet. When marshal ships
// agentTurnChain, this aggregator collapses to "one run-log entry per step
// is already grouped server-side; just map the entries through."
//
// Spec authority: docs/specs/gateway-automations-phase-2b-design.md §4.9.

import type { AutomationRunData, AutomationStepResult } from "../../../../common/marshal-ipc-contract";
import { parseTailCronName } from "./map";

type RunLogEntry = {
  runAtMs?: number;
  ts: number;
  durationMs?: number;
  status: "ok" | "error" | "skipped";
  sessionId?: string;
  summary?: string;
  error?: string;
};

export function aggregateMultiStepRuns(args: {
  parentId: string;
  stepCount: number;
  parentRuns: RunLogEntry[];
  tailMeta: Array<{ id: string; name: string }>;
  tailRunsById: Map<string, RunLogEntry[]>;
}): AutomationRunData[] {
  const result: AutomationRunData[] = [];

  // Group tails by runInstanceId, filtering to only this parent's tails.
  // Foreign tails (different parentId) are skipped — see test
  // "ignores tails belonging to a different parent".
  const tailsByRunInstance = new Map<string, Array<{ id: string; stepIndex: number }>>();
  for (const tail of args.tailMeta) {
    const parsed = parseTailCronName(tail.name);
    if (!parsed) continue;
    if (parsed.parentId !== args.parentId) continue;
    const arr = tailsByRunInstance.get(parsed.runInstanceId) ?? [];
    arr.push({ id: tail.id, stepIndex: parsed.stepIndex });
    tailsByRunInstance.set(parsed.runInstanceId, arr);
  }

  for (const parentRun of args.parentRuns) {
    const runInstanceId = String(parentRun.runAtMs ?? parentRun.ts);
    const tails = tailsByRunInstance.get(runInstanceId) ?? [];
    // Sort by stepIndex; for duplicate stepIndex (multi-device race), keep
    // earliest id by lex sort. Matches orchestrator's dedup convention.
    tails.sort((a, b) => {
      if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
      return a.id.localeCompare(b.id);
    });

    const stepResults: AutomationStepResult[] = [];

    // Step 0 (user-chain step 1) from parentRun.
    stepResults.push({
      stepId: "step-0",
      status: mapEntryStatus(parentRun.status),
      output: parentRun.summary,
      error: parentRun.error,
    });

    // Track the latest successful step's completion time across the whole
    // chain so completedAt reflects when the chain *actually* finished, not
    // when step 1 finished. Initialized to parent's completion; tails extend
    // it as we walk later steps.
    let lastCompletedAtMs = (parentRun.runAtMs ?? parentRun.ts) + (parentRun.durationMs ?? 0);

    // Steps 1..N-1 (user-chain steps 2..N) from tails (deduped by stepIndex).
    const seenStepIndices = new Set<number>();
    for (const tail of tails) {
      if (seenStepIndices.has(tail.stepIndex)) continue;
      seenStepIndices.add(tail.stepIndex);
      const runs = args.tailRunsById.get(tail.id) ?? [];
      const latest = runs[runs.length - 1];
      if (!latest) {
        stepResults.push({
          stepId: `step-${tail.stepIndex}`,
          status: "running",
        });
      } else {
        stepResults.push({
          stepId: `step-${tail.stepIndex}`,
          status: mapEntryStatus(latest.status),
          output: latest.summary,
          error: latest.error,
        });
        if (latest.status === "ok") {
          const tailCompletedAt = (latest.runAtMs ?? latest.ts) + (latest.durationMs ?? 0);
          if (tailCompletedAt > lastCompletedAtMs) lastCompletedAtMs = tailCompletedAt;
        }
      }
    }

    // Determine intermediate flags before padding.
    const anyFailed = stepResults.some((s) => s.status === "failed");
    const anyRunning = stepResults.some((s) => s.status === "running");

    // Pad missing steps as "skipped" (failed chain) or "pending"
    // (still in progress / not yet scheduled).
    while (stepResults.length < args.stepCount) {
      stepResults.push({
        stepId: `step-${stepResults.length}`,
        status: anyFailed ? "skipped" : "pending",
      });
    }

    let overallStatus: AutomationRunData["status"];
    if (anyFailed) overallStatus = "failed";
    else if (anyRunning) overallStatus = "running";
    else if (stepResults.every((s) => s.status === "completed")) overallStatus = "completed";
    else overallStatus = "running"; // pending steps remaining → still in progress

    result.push({
      id: `${args.parentId}:${runInstanceId}`,
      automationId: args.parentId,
      sessionId: parentRun.sessionId,
      startedAt: new Date(parentRun.runAtMs ?? parentRun.ts).toISOString(),
      // For multi-step chains, completion time is when the LAST successful
      // step finished, not when step 1 finished. lastCompletedAtMs is
      // computed during the tail walk above.
      completedAt:
        overallStatus === "running" ? undefined : new Date(lastCompletedAtMs).toISOString(),
      status: overallStatus,
      stepResults,
      finalOutput: stepResults[stepResults.length - 1]?.output,
    });
  }

  return result;
}

function mapEntryStatus(s: "ok" | "error" | "skipped"): AutomationStepResult["status"] {
  if (s === "ok") return "completed";
  if (s === "error") return "failed";
  // marshal skipped a run (heartbeat-OK suppression, etc.) — surface it.
  // AutomationStepResult.status now includes "skipped" (Phase 2b-1).
  return "skipped";
}
