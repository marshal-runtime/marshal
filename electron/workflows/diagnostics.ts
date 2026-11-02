import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import { getAppDataDir } from "../app-paths";
import { secureMkdirSync } from "../platform-security";

const log = createLogger("WorkflowDiagnostics");

export const WORKFLOW_DIAGNOSTICS_FILENAME = "marshal-workflow-diagnostics.jsonl";

/** Roll the diagnostics file to a single .old backup past this size. */
const WORKFLOW_DIAGNOSTICS_MAX_BYTES = 4 * 1024 * 1024;
/** Only stat the file every N appends to avoid a statSync per trace call. */
const WORKFLOW_DIAGNOSTICS_CHECK_EVERY = 200;
let writeCount = 0;

interface WorkflowDiagnosticError {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}

export interface WorkflowDiagnosticHandle {
  readonly handleId: string;
  readonly sessionId: string;
}

export interface ActiveWorkflowDiagnosticRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly runFamilyId?: string;
  readonly hostSessionId?: string;
  readonly startedAt: number;
  updatedAt: number;
  lastOperation?: string;
  currentStepKey?: string;
  inFlightHandles?: ReadonlyArray<WorkflowDiagnosticHandle>;
}

export interface WorkflowDiagnosticEntry {
  readonly timestamp: string;
  readonly pid: number;
  readonly operation: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly runFamilyId?: string;
  readonly hostSessionId?: string;
  readonly stepKey?: string;
  readonly handleId?: string;
  readonly sessionId?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly details?: Record<string, unknown>;
  readonly error?: WorkflowDiagnosticError;
  readonly inFlightHandles?: ReadonlyArray<WorkflowDiagnosticHandle>;
  readonly activeRuns?: ReadonlyArray<ActiveWorkflowDiagnosticRun>;
}

export interface WorkflowDiagnosticInput {
  readonly operation: string;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly runFamilyId?: string;
  readonly hostSessionId?: string;
  readonly stepKey?: string;
  readonly handleId?: string;
  readonly sessionId?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly details?: Record<string, unknown>;
  readonly error?: unknown;
  readonly inFlightHandles?: ReadonlyArray<WorkflowDiagnosticHandle>;
  readonly activeRuns?: ReadonlyArray<ActiveWorkflowDiagnosticRun>;
}

let testSink: ((entry: WorkflowDiagnosticEntry) => void) | undefined;
let processMonitorsInstalled = false;
const activeRuns = new Map<string, ActiveWorkflowDiagnosticRun>();

export function setWorkflowDiagnosticSinkForTests(
  sink: ((entry: WorkflowDiagnosticEntry) => void) | undefined,
): void {
  testSink = sink;
}

export function beginWorkflowDiagnosticRun(info: {
  runId: string;
  workflowId: string;
  runFamilyId?: string;
  hostSessionId?: string;
}): void {
  installProcessMonitorsOnce();
  const now = Date.now();
  activeRuns.set(info.runId, {
    runId: info.runId,
    workflowId: info.workflowId,
    runFamilyId: info.runFamilyId,
    hostSessionId: info.hostSessionId,
    startedAt: now,
    updatedAt: now,
    lastOperation: "workflow.active.begin",
  });
  appendWorkflowDiagnostic({
    operation: "workflow.active.begin",
    runId: info.runId,
    workflowId: info.workflowId,
    runFamilyId: info.runFamilyId,
    hostSessionId: info.hostSessionId,
  });
}

export function endWorkflowDiagnosticRun(args: { runId: string; status: string }): void {
  const active = activeRuns.get(args.runId);
  appendWorkflowDiagnostic({
    operation: "workflow.active.end",
    runId: args.runId,
    workflowId: active?.workflowId,
    runFamilyId: active?.runFamilyId,
    hostSessionId: active?.hostSessionId,
    status: args.status,
    activeRuns: active ? [cloneActiveRun(active)] : undefined,
  });
  activeRuns.delete(args.runId);
}

export function appendWorkflowDiagnostic(input: WorkflowDiagnosticInput): void {
  const entry: WorkflowDiagnosticEntry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    operation: input.operation,
    runId: input.runId,
    workflowId: input.workflowId,
    runFamilyId: input.runFamilyId,
    hostSessionId: input.hostSessionId,
    stepKey: input.stepKey,
    handleId: input.handleId,
    sessionId: input.sessionId,
    status: input.status,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    details: input.details ? sanitizeDetails(input.details) : undefined,
    error: input.error === undefined ? undefined : sanitizeError(input.error),
    inFlightHandles: input.inFlightHandles?.map((handle) => ({ ...handle })),
    activeRuns: input.activeRuns?.map(cloneActiveRun),
  };

  updateActiveRunFromEntry(entry);

  if (testSink) {
    testSink(entry);
    return;
  }
  if (process.env["VITEST_WORKER_ID"]) return;

  try {
    const appDataDir = getAppDataDir();
    secureMkdirSync(appDataDir, 0o700);
    const filePath = path.join(appDataDir, WORKFLOW_DIAGNOSTICS_FILENAME);
    // Cap unbounded growth: a busy/looping workflow run can append thousands of
    // lines. When the file exceeds the cap, roll it to a single .old backup so
    // it never bloats to tens of MB (was seen at 12MB/15k lines pegging writes).
    if (writeCount++ % WORKFLOW_DIAGNOSTICS_CHECK_EVERY === 0) {
      try {
        if (fs.statSync(filePath).size > WORKFLOW_DIAGNOSTICS_MAX_BYTES) {
          fs.renameSync(filePath, `${filePath}.old`);
        }
      } catch {
        /* missing file or rename race — best effort */
      }
    }
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  } catch (err) {
    log.warn("Failed to write workflow diagnostics:", err);
  }
}

function installProcessMonitorsOnce(): void {
  if (processMonitorsInstalled || process.env["VITEST_WORKER_ID"]) return;
  processMonitorsInstalled = true;

  process.on("uncaughtExceptionMonitor", (error) => {
    appendWorkflowDiagnostic({
      operation: "process.uncaught-exception",
      error,
      activeRuns: currentActiveRuns(),
    });
  });

  process.on("unhandledRejection", (reason) => {
    appendWorkflowDiagnostic({
      operation: "process.unhandled-rejection",
      error: reason,
      activeRuns: currentActiveRuns(),
    });
  });

  process.on("exit", (code) => {
    const runs = currentActiveRuns();
    if (runs.length === 0) return;
    appendWorkflowDiagnostic({
      operation: "process.exit-with-active-workflows",
      exitCode: code,
      activeRuns: runs,
    });
  });
}

function currentActiveRuns(): ActiveWorkflowDiagnosticRun[] {
  return Array.from(activeRuns.values()).map(cloneActiveRun);
}

function updateActiveRunFromEntry(entry: WorkflowDiagnosticEntry): void {
  if (!entry.runId) return;
  const active = activeRuns.get(entry.runId);
  if (!active) return;
  active.updatedAt = Date.now();
  active.lastOperation = entry.operation;
  active.currentStepKey = entry.stepKey ?? active.currentStepKey;
  active.inFlightHandles = entry.inFlightHandles ?? active.inFlightHandles;
}

function cloneActiveRun(run: ActiveWorkflowDiagnosticRun): ActiveWorkflowDiagnosticRun {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    runFamilyId: run.runFamilyId,
    hostSessionId: run.hostSessionId,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastOperation: run.lastOperation,
    currentStepKey: run.currentStepKey,
    inFlightHandles: run.inFlightHandles?.map((handle) => ({ ...handle })),
  };
}

function sanitizeError(error: unknown): WorkflowDiagnosticError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateDiagnosticString(error.message, 500),
      stack: error.stack
        ?.split("\n")
        .slice(0, 12)
        .map((line) => truncateDiagnosticString(line, 500))
        .join("\n"),
    };
  }
  return { message: truncateDiagnosticString(String(error), 500) };
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    out[key] = sanitizeDiagnosticValue(value, 0);
  }
  return out;
}

function sanitizeDiagnosticValue(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateDiagnosticString(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return sanitizeError(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "[symbol]";
  if (typeof value === "function") return "[function]";
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 25)) {
      out[key] = sanitizeDiagnosticValue(child, depth + 1);
    }
    return out;
  }
  return "[unknown]";
}

function truncateDiagnosticString(value: string, maxLength: number): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
