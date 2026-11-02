import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-mcp");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
export enum mcpErrors {
  SERVER_CONNECTION_FAILED,
  TOOL_DISCOVERY_FAILED,
  /** OAuth token refresh failed (HTTP error or network error). Initial OAuth setup happens in the CLI and is not observable. */
  OAUTH_FAILED,
  CONFIG_INVALID,
  /**
   * MCP tool returned success: false. Fires only for MCP server tools, not
   * built-in tools.
   *
   * KNOWN SIGNAL-QUALITY LIMITATION: the BackendEvent `tool-result` shape
   * has no `cancelled` discriminator, so this code conflates server-side
   * failures (the high-value signal) with user-initiated cancellations and
   * permission denials (which also surface as `success: false`). Local logs
   * therefore contain an expected cancellation baseline. Splitting these is
   * blocked on an SDK-side discriminator or a robust message-pattern heuristic.
   */
  TOOL_EXECUTION_FAILED,
  /** Reading or decrypting the MCP config file failed (JSON parse, decrypt, file I/O).
   * Distinct from CONFIG_INVALID, which is schema-validation failure of successfully-read JSON. */
  CONFIG_PARSE_FAILED,
}

export function makeMcpError(code: mcpErrors): MidgardError {
  return { family, code };
}

export function registerMcpErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, mcpErrors);
}
