/**
 * Compact model-facing result for the TypeScript execution tools. The raw
 * runtime envelope repeats the execution output twice plus receipts,
 * provenance, and environment metadata (~10x the payload); agents only need
 * the returned value, captured output, and actionable failure details.
 * Callers that need the full envelope pass `verbose: true`.
 */
import type { MarshalRuntimeApiResult, MarshalRuntimeInvocationValue } from "./contracts";

interface CompactDiagnostic {
  readonly line?: number;
  readonly column?: number;
  readonly code?: string;
  readonly message: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactDiagnostics(value: unknown): CompactDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const compact: CompactDiagnostic[] = [];
  for (const entry of value) {
    const diagnostic = asRecord(entry);
    const message = nonEmptyText(diagnostic?.message);
    if (!diagnostic || !message) continue;
    // Execute-stage locations point into the compiled bundle, not the agent's
    // source, so only compile-stage positions are reported.
    const location = diagnostic.stage === "compile" ? asRecord(diagnostic.location) : undefined;
    compact.push({
      ...(typeof location?.line === "number" ? { line: location.line } : {}),
      ...(typeof location?.column === "number" ? { column: location.column } : {}),
      ...(typeof diagnostic.code === "string" ? { code: diagnostic.code } : {}),
      message,
    });
  }
  return compact;
}

export function compactTypeScriptExecutionResult(
  result: MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>,
): Record<string, unknown> {
  if (!result.ok) return { ok: false, error: result.error };

  const execution = asRecord(result.value.output);
  if (!execution || typeof execution.status !== "string") {
    return { ok: true, value: result.value.output };
  }

  const streams = {
    ...(nonEmptyText(execution.stdout) ? { stdout: execution.stdout } : {}),
    ...(nonEmptyText(execution.stderr) ? { stderr: execution.stderr } : {}),
  };
  if (execution.status === "succeeded") {
    return { ok: true, value: execution.value ?? null, ...streams };
  }

  const error = asRecord(execution.error);
  const diagnostics = compactDiagnostics(execution.diagnostics);
  return {
    ok: false,
    status: execution.status,
    ...(error
      ? {
          error: {
            ...(typeof error.code === "string" ? { code: error.code } : {}),
            message: nonEmptyText(error.message) ?? "TypeScript execution failed.",
          },
        }
      : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...streams,
  };
}
