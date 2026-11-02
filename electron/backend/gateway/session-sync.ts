/**
 * Pure module functions that translate raw gateway events into RemoteSessionEvent
 * objects for SessionManager.applyRemoteEvent. State (sessionKeys + reverse) is
 * passed in explicitly — no module-level globals. GatewaySessionBackend owns
 * the state and calls these functions from subscribeToRemoteEvents.
 */

import type { RemoteSessionEvent, SessionMetadata } from "../types";
import { parseGatewayRow } from "./row";

export interface GatewaySyncState {
  /** Local Marshal sessionId → gateway sessionKey (routing token used in
   *  sessions.send / sessions.delete / sessions.patch / chat.send RPCs).
   *  Locally-created sessions: `Map<local-uuid, sessionKey>`. Remote-only
   *  sessions seeded from sessions.list: `Map<cloudSessionId, sessionKey>`
   *  (id on the local row is the cloud UUID). */
  sessionKeys: Map<string, string>;
  /** sessionKey → local session id. Reverse of sessionKeys, for delete-event
   *  fallback when the server omits the session payload. */
  localIdBySessionKey: Map<string, string>;
  /** Local Marshal sessionId → backendId (cloud sessionId). Needed because
   *  `backendId` is the stable server-side identity (persisted and used for
   *  writer reconcile matching), distinct from the sessionKey routing token.
   *  For remote-only sessions, local id == cloud sessionId, so the entry is
   *  self-referential; the map still needs it so fast-path idempotent create
   *  and handle reconstruction work uniformly. */
  backendIds: Map<string, string>;
}

function applyRowToState(row: SessionMetadata, key: string, state: GatewaySyncState): void {
  const backendId = row.backendId;
  if (!backendId) return;
  // For remote-seeded rows the local id equals the cloud sessionId (==
  // backendId); sessionKeys is keyed by local id so this is correct.
  state.sessionKeys.set(backendId, key);
  state.localIdBySessionKey.set(key, backendId);
  state.backendIds.set(backendId, backendId);
}

/** Translate a sessions.list response into an index-snapshot event. Seeds state
 *  for every row with both a sessionId and a key. Rows missing either are skipped. */
export function makeSnapshotEvent(
  listResponse: { sessions: Array<Record<string, unknown>> },
  state: GatewaySyncState,
): RemoteSessionEvent | null {
  const sessions: SessionMetadata[] = [];
  const filteredKeys: string[] = [];
  const kept: string[] = [];
  for (const raw of listResponse.sessions) {
    const key = typeof raw.key === "string" ? raw.key : "";
    if (!key) continue;
    if (isInternalSessionKey(key)) {
      filteredKeys.push(key);
      continue;
    }
    const row = parseGatewayRow(raw);
    if (!row?.backendId) continue;
    applyRowToState(row, key, state);
    sessions.push(row);
    kept.push(key);
  }
  // Diagnostic: emit the keys we kept vs filtered so we can tell why a session
  // appeared (or didn't). Gated on DEBUG_GATEWAY_SYNC to keep release builds
  // quiet; flip the env var when debugging the filter denylist.
  if (process.env.DEBUG_GATEWAY_SYNC === "1") {
    // eslint-disable-next-line no-console -- opt-in diagnostic channel
    console.info(
      `[gateway-session-sync] snapshot kept ${kept.length} / filtered ${filteredKeys.length}. ` +
        `Filtered keys: ${filteredKeys.slice(0, 5).join(", ")}${filteredKeys.length > 5 ? "…" : ""}. ` +
        `Kept keys: ${kept.slice(0, 10).join(", ")}${kept.length > 10 ? "…" : ""}`,
    );
  }
  return { type: "index-snapshot", sessions };
}

/**
 * Client-side denylist for marshal session keys that are internal to the
 * gateway (heartbeat runner, cron parent sessions, etc.) and not meaningful as
 * chat entries to surface in the sidebar.
 *
 * marshal already filters ephemeral cron-run sessions server-side
 * (`:cron:<id>:run:<uuid>`, session-utils.ts:1433) — we filter them here too
 * as belt-and-braces in case any leak through (e.g., during a server-side
 * filter regression). Without this, a single condition automation polling
 * every 5 min would emit 288 noise sessions/day into the sidebar.
 * Anything obviously-internal we want excluded joins this list.
 */
function isInternalSessionKey(key: string): boolean {
  // Heartbeat runner's isolated session — `agent:<id>:<base>:heartbeat`.
  if (/(?:^|:)heartbeat(?:$|:)/.test(key)) return true;
  // Cron parent session (`agent:<id>:cron:<jobId>`) AND ephemeral cron-run
  // sessions (`agent:<id>:cron:<jobId>:run:<runId>`). marshal filters the
  // run sessions server-side; this is belt-and-braces in case any leak
  // through (e.g., during a server-side filter regression).
  if (/:cron:[^:]+(?::run:[^:]+)?$/.test(key)) return true;
  // Dashboard sessions (`agent:<id>:dashboard:<uuid>`) — internal marshal
  // telemetry / control surface, not user-facing chat.
  if (/(?:^|:)dashboard(?:$|:)/.test(key)) return true;
  // Marshal's base agent session (`agent:<agent-id>:main`). It's the default
  // chat target for the agent on the server but has no meaning as a
  // Marshal-side session — our user-initiated chats carry UUID keys, never
  // the literal `main` suffix. Filter to keep the sidebar honest.
  if (/^agent:[^:]+:main$/.test(key)) return true;
  return false;
}

/** Translate a sessions.changed create/patch/compact/reset event into a
 *  session-upsert. Returns null if the event's session payload is missing or
 *  malformed. */
export function makeUpsertEvent(
  rawEvent: { reason: string; sessionKey: string; session?: Record<string, unknown> },
  state: GatewaySyncState,
): RemoteSessionEvent | null {
  if (isInternalSessionKey(rawEvent.sessionKey)) return null;
  if (!rawEvent.session) return null;
  const row = parseGatewayRow(rawEvent.session);
  if (!row?.backendId) return null;
  applyRowToState(row, rawEvent.sessionKey, state);
  return { type: "session-upsert", session: row };
}

/** Translate a sessions.changed delete event into session-delete. Resolves
 *  backendId from the payload first, falls back to reverse lookup by
 *  sessionKey. Returns null if neither resolves (caller should warn). */
export function makeDeleteEvent(
  rawEvent: { reason: string; sessionKey: string; session?: Record<string, unknown> },
  state: GatewaySyncState,
): RemoteSessionEvent | null {
  // Filtered-out internal sessions are never in state, so their delete events
  // legitimately lack a resolvable backendId. Return null silently; the caller
  // would otherwise log a "delete without resolvable backendId" warning that
  // fires every time the heartbeat / dashboard / cron-parent sessions cycle.
  if (isInternalSessionKey(rawEvent.sessionKey)) return null;

  // backendId is the cloud sessionId. Prefer the payload's `sessionId`;
  // fall back to reverse lookup via the sessionKey (always present on the
  // event). Returns null only if the session is unknown and the payload
  // lacks a sessionId — the caller warns in that case.
  const fromPayload =
    rawEvent.session && typeof rawEvent.session.sessionId === "string"
      ? rawEvent.session.sessionId
      : undefined;
  const backendId = fromPayload ?? state.localIdBySessionKey.get(rawEvent.sessionKey);
  if (!backendId) return null;
  state.sessionKeys.delete(backendId);
  state.localIdBySessionKey.delete(rawEvent.sessionKey);
  state.backendIds.delete(backendId);
  return { type: "session-delete", backendId };
}
