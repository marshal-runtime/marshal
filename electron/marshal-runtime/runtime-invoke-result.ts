/**
 * Compact model-facing result for runtimeInvoke. The raw envelope carries the
 * capability output twice (`value.output` and `value.result.output`) plus
 * host receipts the agent never acts on; the agent needs only the output or
 * the actionable error (including any approval handle). `verbose: true`
 * returns the raw envelope.
 */
import type { MarshalRuntimeApiResult, MarshalRuntimeInvocationValue } from "./contracts";

export function compactInvocationResult(
  result: MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>,
): Record<string, unknown> {
  return result.ok ? { ok: true, value: result.value.output } : { ok: false, error: result.error };
}
