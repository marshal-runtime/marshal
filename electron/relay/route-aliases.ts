export const RELAY_ROUTE_ALIAS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RelayRouteAliasSession {
  id: string;
  updatedAt?: string;
}

interface RelayRouteAliasEntry {
  sessionId: string;
  alias: string;
  lastSeenAt: number;
  updatedAtMs: number | null;
}

const aliasesBySessionId = new Map<string, RelayRouteAliasEntry>();
const aliasesByRouteId = new Map<string, RelayRouteAliasEntry>();

function parseUpdatedAt(updatedAt: string | undefined): number | null {
  if (!updatedAt) return null;
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : null;
}

function removeEntry(entry: RelayRouteAliasEntry): void {
  aliasesBySessionId.delete(entry.sessionId);
  aliasesByRouteId.delete(entry.alias);
}

function shouldPruneEntry(entry: RelayRouteAliasEntry, now: number): boolean {
  const referenceTime = entry.updatedAtMs ?? entry.lastSeenAt;
  return now - referenceTime > RELAY_ROUTE_ALIAS_TTL_MS;
}

export function pruneRelayRouteAliases(options?: {
  now?: number;
  keepSessionIds?: Iterable<string | null | undefined>;
  knownSessionIds?: Iterable<string>;
}): void {
  const now = options?.now ?? Date.now();
  const keepSessionIds = new Set(Array.from(options?.keepSessionIds ?? []).filter(Boolean));
  const knownSessionIds = options?.knownSessionIds ? new Set(options.knownSessionIds) : null;

  for (const entry of aliasesBySessionId.values()) {
    if (keepSessionIds.has(entry.sessionId)) continue;
    if (knownSessionIds && !knownSessionIds.has(entry.sessionId)) {
      removeEntry(entry);
      continue;
    }
    if (shouldPruneEntry(entry, now)) {
      removeEntry(entry);
    }
  }
}

function allocateAlias(): string {
  for (let routeNumber = 1; ; routeNumber++) {
    const alias = `t${routeNumber}`;
    if (!aliasesByRouteId.has(alias)) return alias;
  }
}

export function getRelayRouteAlias(
  session: RelayRouteAliasSession | string,
  now = Date.now(),
): string {
  const sessionInfo = typeof session === "string" ? { id: session } : session;
  pruneRelayRouteAliases({ now, keepSessionIds: [sessionInfo.id] });

  const updatedAtMs = parseUpdatedAt(sessionInfo.updatedAt);
  const existing = aliasesBySessionId.get(sessionInfo.id);
  if (existing) {
    existing.lastSeenAt = now;
    if (updatedAtMs !== null) existing.updatedAtMs = updatedAtMs;
    return existing.alias;
  }

  const entry: RelayRouteAliasEntry = {
    sessionId: sessionInfo.id,
    alias: allocateAlias(),
    lastSeenAt: now,
    updatedAtMs,
  };
  aliasesBySessionId.set(sessionInfo.id, entry);
  aliasesByRouteId.set(entry.alias, entry);
  return entry.alias;
}

export function resolveRelayRouteAlias(routeId: string, now = Date.now()): string | null {
  pruneRelayRouteAliases({ now });
  return aliasesByRouteId.get(routeId.trim())?.sessionId ?? null;
}

export function isRelayRouteSessionRecent(
  session: Pick<RelayRouteAliasSession, "updatedAt">,
  now = Date.now(),
): boolean {
  const updatedAtMs = parseUpdatedAt(session.updatedAt);
  return updatedAtMs === null || now - updatedAtMs <= RELAY_ROUTE_ALIAS_TTL_MS;
}

export function resetRelayRouteAliasesForTests(): void {
  aliasesBySessionId.clear();
  aliasesByRouteId.clear();
}
