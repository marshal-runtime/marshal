import type {
  SwarmFailedTaskIdentity,
  SwarmJsonValue,
  SwarmRoleDefinition,
  SwarmRunOutcomeSummary,
  SwarmTask,
} from "@marshal/swarm";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import { SwarmRunView } from "@marshal/swarm/ui";
import type { SwarmRun } from "@marshal/swarm/ui";
import { useRef, useState } from "react";

import { useDocumentTheme } from "@/shared/hooks/useTheme";

import type { RuntimeUiApplicationRendererProps } from "./RuntimeUiApplicationRegistry";

const PAUSE_REASON = "Paused from the swarm view.";
const PAUSE_CAPABILITY = "swarm.runs.pause";
const RESUME_CAPABILITY = "swarm.runs.resume";

export function SwarmRunRenderer({ instance, host }: RuntimeUiApplicationRendererProps) {
  const theme = useDocumentTheme();
  const [navigationError, setNavigationError] = useState<string>();
  const SourceEditor = host.editor.SourceEditor;
  const [file, setFile] = useState<{
    taskId: string;
    uri: string;
    text: string;
    offset: number;
    nextOffset?: number;
  }>();
  const [fileError, setFileError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const fileRequest = useRef(0);
  if (
    instance.content.kind !== "application" ||
    instance.content.renderId !== SWARM_RUN_VIEW_RENDER_ID
  ) {
    return null;
  }
  const run = swarmRunFrom(instance.content.state?.run);
  if (!run) return null;
  const openFile = (taskId: string, uri: string, offset = 0) => {
    const request = ++fileRequest.current;
    setLoading(true);
    setFileError(undefined);
    void host
      .invokeCapability({
        capability: "swarm.runs.read-file",
        input: { runId: run.runId, taskId, uri, offset },
        idempotencyKey: `evidence-read:${crypto.randomUUID()}`,
      })
      .then((result) => {
        if (request !== fileRequest.current) return;
        const value = recordValue(result.output);
        if (!value || typeof value.text !== "string")
          throw new Error("File content is unavailable.");
        setFile({
          taskId,
          uri,
          text: value.text,
          offset,
          ...(typeof value.nextOffset === "number" ? { nextOffset: value.nextOffset } : {}),
        });
      })
      .catch((error) => {
        if (request === fileRequest.current) setFileError(String(error));
      })
      .finally(() => {
        if (request === fileRequest.current) setLoading(false);
      });
  };

  return (
    <>
      <div hidden={!!file || loading}>
        <SwarmRunView
          run={run}
          compact={instance.surface === "inline-card"}
          onOpenFile={openFile}
          onOpenSession={(sessionId) => {
            setNavigationError(undefined);
            void (async () => {
              try {
                if (host.openSession) await host.openSession(sessionId);
                else throw new Error("Session navigation is unavailable.");
              } catch (error) {
                setNavigationError(String(error));
              }
            })();
          }}
          onPause={(runId) => {
            setNavigationError(undefined);
            void host
              .invokeCapability({
                capability: PAUSE_CAPABILITY,
                input: { runId, reason: PAUSE_REASON },
                idempotencyKey: `swarm-pause:${runId}:${crypto.randomUUID()}`,
              })
              .catch((error) => setNavigationError(String(error)));
          }}
          onResume={(runId) => {
            setNavigationError(undefined);
            void host
              .invokeCapability({
                capability: RESUME_CAPABILITY,
                input: { runId },
                idempotencyKey: `swarm-resume:${runId}:${crypto.randomUUID()}`,
              })
              .catch((error) => setNavigationError(String(error)));
          }}
        />
      </div>
      {(file || loading) && (
        <button
          type="button"
          className="mb-3 text-left text-sm"
          onClick={() => {
            fileRequest.current++;
            setFile(undefined);
            setLoading(false);
            setFileError(undefined);
          }}
        >
          Back to swarm
        </button>
      )}
      {navigationError && <p role="alert">{navigationError}</p>}
      {loading && <p role="status">Loading evidence file…</p>}
      {fileError && <p role="alert">{fileError}</p>}
      {file && (
        <section aria-label="Evidence file" className="mt-4 grid gap-2">
          <p className="text-xs break-all">{file.uri}</p>
          <p className="text-xs">
            File preview from byte {file.offset}. Each part is at most 1 MB.
          </p>
          {file.offset > 0 && (
            <button
              type="button"
              disabled={loading}
              onClick={() => openFile(file.taskId, file.uri)}
            >
              Back to start
            </button>
          )}
          {file.nextOffset !== undefined && (
            <button
              type="button"
              disabled={loading}
              onClick={() => openFile(file.taskId, file.uri, file.nextOffset)}
            >
              Load next part
            </button>
          )}
          <div className="h-96 min-w-0 overflow-hidden" data-testid="swarm-evidence-editor">
            <SourceEditor
              source={{ path: file.uri, content: file.text, language: fileLanguage(file.uri) }}
              breakpoints={[]}
              theme={theme}
              onToggleBreakpoint={() => undefined}
            />
          </div>
        </section>
      )}
    </>
  );
}

function swarmRunFrom(
  value: unknown,
): (SwarmRun & { readonly outcome?: SwarmRunOutcomeSummary }) | undefined {
  const run = recordValue(value);
  if (!run) return undefined;
  const tasks = Array.isArray(run.tasks) ? run.tasks.map(swarmTaskFrom) : [];
  if (
    typeof run.runId !== "string" ||
    typeof run.objective !== "string" ||
    typeof run.scope !== "string" ||
    !swarmRunState(run.state) ||
    !Array.isArray(run.tasks) ||
    tasks.some((task) => task === undefined)
  ) {
    return undefined;
  }
  const pauseReason = recordValue(run.pauseReason);
  const outcome = swarmOutcomeFrom(run.outcome);
  const roles = Array.isArray(run.roles)
    ? run.roles.map(swarmRoleFrom).filter((role): role is SwarmRoleDefinition => role !== undefined)
    : [];
  return {
    runId: run.runId,
    objective: run.objective,
    scope: run.scope,
    state: run.state === "done" ? "completed" : run.state,
    ...(run.legacyReadOnly === true ? { legacyReadOnly: true } : {}),
    ...(run.protocolVersion === 2 ? { protocolVersion: 2 as const } : {}),
    tasks: tasks.filter((task): task is SwarmTask => task !== undefined),
    ...((pauseReason?.kind === "manual" || pauseReason?.kind === "environmental") &&
    typeof pauseReason.message === "string"
      ? { pauseReason: { kind: "manual", message: pauseReason.message } }
      : {}),
    ...(roles.length > 0 ? { roles } : {}),
    ...(swarmJsonValue(run.result) ? { result: run.result } : {}),
    ...(swarmJsonValue(run.error) ? { error: run.error } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

function swarmRoleFrom(value: unknown): SwarmRoleDefinition | undefined {
  const role = recordValue(value);
  if (
    !role ||
    typeof role.name !== "string" ||
    (role.base !== "worker" && role.base !== "reviewer") ||
    typeof role.model !== "string" ||
    typeof role.whenToUse !== "string" ||
    typeof role.instructions !== "string"
  ) {
    return undefined;
  }
  return {
    name: role.name,
    base: role.base,
    model: role.model,
    whenToUse: role.whenToUse,
    instructions: role.instructions,
    ...(typeof role.reasoningEffort === "string" ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(typeof role.plannerGuidance === "string" ? { plannerGuidance: role.plannerGuidance } : {}),
    ...(swarmJsonValue(role.resultSchema) ? { resultSchema: role.resultSchema } : {}),
  };
}

// Published by the extension's view projection; absent on legacy runs. Validated
// as transport input like every other field here — never recomputed host-side.
function swarmOutcomeFrom(value: unknown): SwarmRunOutcomeSummary | undefined {
  const outcome = recordValue(value);
  if (!outcome) return undefined;
  const rawCounts = recordValue(outcome.taskCounts);
  if (
    !rawCounts ||
    !boundedCount(outcome.totalTasks) ||
    !Array.isArray(outcome.failedTasks) ||
    (outcome.failedTasksOmitted !== undefined && !boundedCount(outcome.failedTasksOmitted)) ||
    (outcome.headline !== undefined && typeof outcome.headline !== "string")
  ) {
    return undefined;
  }
  const taskCounts: Partial<Record<SwarmTask["state"], number>> = {};
  for (const [state, count] of Object.entries(rawCounts)) {
    if (!swarmTaskState(state) || !boundedCount(count)) return undefined;
    const key = state === "done" ? "completed" : state;
    const summed = (taskCounts[key] ?? 0) + count;
    if (!Number.isSafeInteger(summed)) return undefined;
    taskCounts[key] = summed;
  }
  const failedTasks = outcome.failedTasks.map(failedTaskIdentityFrom);
  if (failedTasks.some((failed) => failed === undefined)) return undefined;
  return {
    taskCounts,
    totalTasks: outcome.totalTasks,
    failedTasks: failedTasks.filter(
      (failed): failed is SwarmFailedTaskIdentity => failed !== undefined,
    ),
    ...(outcome.failedTasksOmitted !== undefined
      ? { failedTasksOmitted: outcome.failedTasksOmitted }
      : {}),
    ...(typeof outcome.headline === "string" ? { headline: outcome.headline } : {}),
  };
}

function failedTaskIdentityFrom(value: unknown): SwarmFailedTaskIdentity | undefined {
  const failed = recordValue(value);
  if (
    !failed ||
    typeof failed.taskId !== "string" ||
    typeof failed.objective !== "string" ||
    !swarmTaskRole(failed.role) ||
    (failed.reason !== undefined && typeof failed.reason !== "string")
  ) {
    return undefined;
  }
  return {
    taskId: failed.taskId,
    role: failed.role,
    ...(typeof failed.definedRole === "string" ? { definedRole: failed.definedRole } : {}),
    objective: failed.objective,
    ...(typeof failed.reason === "string" ? { reason: failed.reason } : {}),
  };
}

function boundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function swarmTaskFrom(value: unknown): SwarmTask | undefined {
  const task = recordValue(value);
  if (
    !task ||
    typeof task.taskId !== "string" ||
    typeof task.objective !== "string" ||
    typeof task.scope !== "string" ||
    !swarmTaskRole(task.role) ||
    !swarmTaskState(task.state)
  ) {
    return undefined;
  }
  return {
    taskId: task.taskId,
    objective: task.objective,
    scope: task.scope,
    role: task.role,
    ...(typeof task.definedRole === "string" ? { definedRole: task.definedRole } : {}),
    state: task.state === "done" ? "completed" : task.state,
    ...(typeof task.reason === "string" ? { reason: task.reason } : {}),
    childTaskIds: textArray(task.childTaskIds),
    dependencyTaskIds: textArray(task.dependencyTaskIds),
    artifactRefs: Array.isArray(task.artifactRefs) ? task.artifactRefs.filter(validArtifact) : [],
    executions: Array.isArray(task.executions) ? task.executions.filter(validExecution) : [],
    ...(typeof task.parentTaskId === "string" ? { parentTaskId: task.parentTaskId } : {}),
    ...(typeof task.delegationId === "string" ? { delegationId: task.delegationId } : {}),
    ...(swarmJsonValue(task.result) ? { result: task.result } : {}),
    ...(swarmJsonValue(task.error) ? { error: task.error } : {}),
    ...(Array.isArray(task.changeRefs) && task.changeRefs.every((ref) => typeof ref === "string")
      ? { changeRefs: task.changeRefs }
      : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function swarmRunState(value: unknown): value is SwarmRun["state"] | "done" {
  return (
    value === "running" ||
    value === "completed" ||
    value === "done" ||
    value === "failed" ||
    value === "paused" ||
    value === "blocked"
  );
}

function swarmTaskState(value: unknown): value is SwarmTask["state"] | "done" {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "done" ||
    value === "blocked" ||
    value === "failed"
  );
}

function swarmTaskRole(value: unknown): value is SwarmTask["role"] {
  return (
    value === "planner" || value === "worker" || value === "reconciler" || value === "reviewer"
  );
}

function swarmJsonValue(value: unknown): value is SwarmJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(swarmJsonValue);
  const record = recordValue(value);
  return record !== undefined && Object.values(record).every(swarmJsonValue);
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function validArtifact(value: unknown): value is NonNullable<SwarmTask["artifactRefs"]>[number] {
  const ref = recordValue(value);
  return (
    !!ref &&
    typeof ref.uri === "string" &&
    typeof ref.summary === "string" &&
    ["plan", "decision", "review", "reconciliation", "report"].includes(String(ref.kind))
  );
}
function validExecution(value: unknown): value is NonNullable<SwarmTask["executions"]>[number] {
  const execution = recordValue(value);
  if (!execution || typeof execution.executionId !== "string") return false;
  if (
    !["model", "reasoningEffort", "transcriptRef", "sessionId"].every(
      (key) => execution[key] === undefined || typeof execution[key] === "string",
    )
  )
    return false;
  if (execution.kind !== undefined && execution.kind !== "dispatch" && execution.kind !== "turn")
    return false;
  if (execution.usage !== undefined && !validUsage(execution.usage)) return false;
  if (
    execution.usageByModel !== undefined &&
    (!Array.isArray(execution.usageByModel) ||
      !execution.usageByModel.every((row) => {
        const entry = recordValue(row);
        return (
          !!entry &&
          (entry.model === undefined || typeof entry.model === "string") &&
          validUsage(entry.usage)
        );
      }))
  )
    return false;
  return true;
}

function validUsage(value: unknown): boolean {
  const usage = recordValue(value);
  return (
    !!usage &&
    ["inputTokens", "outputTokens", "cachedInputTokens", "reportedCost"].every(
      (key) =>
        usage[key] === undefined ||
        (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0),
    )
  );
}

function fileLanguage(uri: string): string {
  const extension = uri.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        json: "json",
        jsonl: "json",
        md: "markdown",
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        py: "python",
        yaml: "yaml",
        yml: "yaml",
      } as Record<string, string>
    )[extension ?? ""] ?? "plaintext"
  );
}
