/**
 * Discriminated union for operation results.
 *
 * Tool handlers return Result<T, E> instead of throwing exceptions,
 * enabling predictable error handling throughout the system.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Creates a successful Result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Creates a failed Result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Parameter definition for an MCP tool. */
export interface ToolParameterDefinition {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly required: boolean;
}

/** Metadata describing an MCP tool. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly ToolParameterDefinition[];
}

/** Result returned by an MCP tool invocation. */
export interface ToolResult<T = unknown> {
  readonly toolName: string;
  readonly success: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
