// electron/workflows/errors.ts
//
// Engine-side error classes. Re-exports from `@marshal/workflow-sdk` are
// preferred for errors thrown across the SDK boundary; classes defined
// here are internal-only (the workflow author should never see them).

export {
  BackendUnsupportedError,
  CancelledError,
  CompileError,
  FanOutItemDriftError,
  MemoMismatchError,
  MissingDefaultExportError,
  PermissionDeniedError,
  RendererSlotConflict,
  SpawnTimeoutError,
  StepFailedError,
  UnitFailureBudgetExceededError,
  WorkflowError,
} from "@marshal/workflow-sdk";

/** Raised when local workflow import rejects a workflow folder. */
export class WorkflowInstallError extends Error {
  constructor(
    public readonly code:
      | "MISSING_MANIFEST"
      | "INVALID_MANIFEST"
      | "MISSING_WORKFLOW_TS"
      | "COMPILE_FAILED"
      | "ID_CONFLICT"
      | "RENDERER_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowInstallError";
  }
}

/** Raised when a workflow id is requested but no install record matches. */
export class WorkflowNotFoundError extends Error {
  constructor(
    public readonly workflowId: string,
    message = `Workflow not found: ${workflowId}`,
  ) {
    super(message);
    this.name = "WorkflowNotFoundError";
  }
}

/** Raised when a runId is requested but no record matches. */
export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}
