import type { RelayProviderKey, RelayProviderSetupEvent } from "@common/relay-provider-settings";

export const RELAY_PROVIDER_SETTINGS_QUERY_KEY = ["relay-provider-settings"] as const;
export const RELAY_PROVIDER_SETUP_QUERY_KEY = ["relay-provider-setup-events"] as const;

export type RelayProviderSetupEvents = Record<string, RelayProviderSetupEvent>;

export function getRelayProviderSetupEventKey(
  providerKey: RelayProviderKey,
  accountId: string,
): string {
  return JSON.stringify([providerKey, accountId]);
}

export function findRelayProviderSetupEvent(
  events: RelayProviderSetupEvents,
  providerKey: RelayProviderKey,
  accountId?: string,
): RelayProviderSetupEvent | undefined {
  if (accountId) {
    return events[getRelayProviderSetupEventKey(providerKey, accountId)];
  }
  return Object.values(events)
    .filter((event) => event.providerKey === providerKey)
    .sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt))[0];
}

export function addRelayProviderSetupEvent(
  events: RelayProviderSetupEvents,
  event: RelayProviderSetupEvent,
): RelayProviderSetupEvents {
  const key = getRelayProviderSetupEventKey(event.providerKey, event.snapshot.account.accountId);
  const current = events[key];
  if (current && isEarlier(event.snapshot.updatedAt, current.snapshot.updatedAt)) return events;
  return { ...events, [key]: event };
}

export function removeRelayProviderSetupEvent(
  events: RelayProviderSetupEvents,
  providerKey: RelayProviderKey,
  accountId: string | undefined,
): RelayProviderSetupEvents {
  if (!accountId) return events;
  const key = getRelayProviderSetupEventKey(providerKey, accountId);
  if (!events[key]) return events;
  const updated = { ...events };
  delete updated[key];
  return updated;
}

function isEarlier(candidate: string, current: string): boolean {
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) {
    return candidateTime < currentTime;
  }
  return candidate < current;
}
