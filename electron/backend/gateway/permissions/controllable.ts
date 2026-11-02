import type {
  PermissionsControllableField,
  PermissionsControllableMap,
} from "../../../../common/marshal-ipc-contract";

/**
 * Per-field controllable flags for the gateway permissions UI. Disabled
 * fields carry a `disabledReason` string so the renderer can surface it
 * verbatim without importing any backend-specific strings file.
 *
 * Reset a field to `enabled` once the gateway exposes the necessary
 * RPCs/schema fields.
 */

const enabled: PermissionsControllableField = { enabled: true };
const disabled = (disabledReason: string): PermissionsControllableField => ({
  enabled: false,
  disabledReason,
});

export const GATEWAY_PERMISSIONS_CONTROLLABLE: PermissionsControllableMap = {
  tools: enabled,
  autopilotMode: enabled,
  autoApproveReadOnly: enabled,
  shellAllow: enabled, // partial — non-binary patterns surface a warning chip
  shellDeny: disabled("Shell command deny patterns are not supported in gateway mode yet."),
  serverEnabled: disabled("MCP server enable/disable is not supported in gateway mode yet."),
  serverAutoApprove: disabled("Per-server auto-approve is not supported in gateway mode yet."),
  perHeartbeatScope: disabled("Per-heartbeat overrides are not supported in gateway mode yet."),
};
