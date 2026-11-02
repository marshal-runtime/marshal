/**
 * Shared parser for gateway session rows.
 *
 * Gateway `sessions.list` responses and `sessions.changed` event payloads
 * carry near-identical row shapes; both need to be flattened into the
 * renderer-facing `SessionMetadata` with the same title-priority chain and
 * timestamp handling. Prior to extraction this lived duplicated between
 * `electron/backend/gateway-backend.ts` (for list()) and
 * `electron/sessions.ts` (for onGatewaySessionsChanged) — which meant any
 * change to name priority had to happen twice. A single source of truth
 * avoids drift.
 *
 * Lives under `electron/backend/` because it's gateway-scoped; shared code
 * in `electron/sessions.ts` must not depend on gateway specifics (boundary
 * Rule 1).
 */

import type { SessionMetadata } from "../../../common/marshal-ipc-contract";
import { GATEWAY_RUNTIME_ID } from "../../../common/runtime-config";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse a gateway session row (from `sessions.list` or a `sessions.changed`
 * event payload) into a `SessionMetadata` object.
 *
 * Returns null if the row lacks a usable `sessionId`. Callers that also
 * require a `key` (sessionKey) — e.g. the list() path that seeds the
 * sessionKeys map — should check `row.key` separately before invoking this.
 *
 * Name priority: `label → derivedTitle → displayName → lastMessagePreview
 * (truncated) → "Untitled"`. `updatedAt` is normalized to an ISO string
 * whether the server sent a number (epoch ms) or a string.
 *
 * `id` and `backendId` both default to the cloud sessionId. When the writer
 * reconciles this row against the index, rows that match an existing local
 * row by `(origin, backendId)` keep their original (locally-assigned) id;
 * fully remote sessions retain the cloud id as the stable local id.
 */
export function parseGatewayRow(row: Record<string, unknown>): SessionMetadata | null {
  // `backendId` is the gateway's stable server-side identity (cloud UUID),
  // i.e. `row.sessionId` — NOT `row.key`. The two are distinct fields on
  // every `sessions.list` / `sessions.changed` row (spec §GatewaySessionRow).
  // `row.key` is a routing address used in RPC calls (`sessions.delete`,
  // `chat.send`, etc.) and lives in `GatewaySyncState.sessionKeys` as
  // private per-session routing. Using the sessionKey here would mean
  // `backendId` carries a token (which may rotate) rather than a stable
  // identifier — breaking legacy disk rows and any cross-restart matching.
  const cloudSessionId = typeof row.sessionId === "string" ? row.sessionId : null;
  if (!cloudSessionId) return null;
  const key = typeof row.key === "string" ? row.key : "";
  const nameFromRow =
    str(row.label) ||
    str(row.derivedTitle) ||
    str(row.displayName) ||
    str(row.lastMessagePreview).slice(0, 60);
  const automationId = extractAutomationIdFromKey(key);
  const name =
    nameFromRow || (automationId ? `Automation · ${automationId.slice(0, 8)}` : "") || "Untitled";
  const updatedAt =
    typeof row.updatedAt === "number"
      ? new Date(row.updatedAt).toISOString()
      : typeof row.updatedAt === "string"
        ? row.updatedAt
        : "";
  return {
    id: cloudSessionId,
    name,
    createdAt: updatedAt,
    updatedAt,
    hasUnread: false,
    isActive: false,
    model: typeof row.model === "string" ? row.model : undefined,
    runtimeId: GATEWAY_RUNTIME_ID,
    backendOrigin: "gateway",
    backendId: cloudSessionId,
    ...(automationId ? { automationId, source: "automation" as const } : {}),
  };
}

/**
 * Marshal's sessionKey for our automation sessions follows the pattern
 * `agent:<agentId>:auto-<automation-id>` — the `auto-<id>` suffix is what we
 * set via `sessionTarget: "session:auto-${automation.id}"` in
 * gateway-automation-map.ts. Pull the automation id back out so the renderer
 * can render the human-readable automation name (via useAutomations()).
 *
 * Returns null if the key doesn't match our auto-session shape.
 */
function extractAutomationIdFromKey(key: string): string | null {
  const m = /(?:^|:)auto-([A-Za-z0-9-]+)$/.exec(key);
  return m ? m[1] : null;
}
