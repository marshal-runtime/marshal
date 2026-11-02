import { normalizeRelaySettings, type RelaySettingsCarrier } from "./provider-config";
import type { RelayProviderCapabilities } from "./relay-contract";
import type { RelayExperienceFailure, RelaySetupSnapshot } from "./relay-experience-contract";

export type { RelaySetupSnapshot } from "./relay-experience-contract";

export const RELAY_RUNTIME_PROVIDER_IDS = {
  whatsapp: "whatsapp-baileys",
} as const;

export type RelayProviderKey = keyof typeof RELAY_RUNTIME_PROVIDER_IDS;
export type RelayRuntimeProviderId = (typeof RELAY_RUNTIME_PROVIDER_IDS)[RelayProviderKey];

export interface RelayProviderIdentity {
  readonly providerKey: RelayProviderKey;
  readonly runtimeProviderId: RelayRuntimeProviderId;
}

export interface RelayProviderReference {
  readonly providerKey?: string;
  readonly runtimeProviderId?: string;
}

export interface RelayProviderActionRequest extends RelayProviderReference {
  readonly accountId?: string;
}

export type RelayProviderConnectionState =
  | "unavailable"
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "error";

export type RelayProviderFailureSnapshot = RelayExperienceFailure;

export interface RelayProviderConnectionSnapshot {
  readonly state: RelayProviderConnectionState;
  readonly detail?: string;
  readonly updatedAt?: string;
  readonly failure?: RelayProviderFailureSnapshot;
}

export interface RelayProviderRuntimeSnapshot extends RelayProviderIdentity {
  readonly available: boolean;
  readonly accountId?: string;
  readonly connection: RelayProviderConnectionSnapshot;
  readonly capabilities: RelayProviderCapabilities;
}

export interface RelayProviderSetupEvent extends RelayProviderIdentity {
  readonly snapshot: RelaySetupSnapshot;
}

const RELAY_PROVIDER_KEYS = ["whatsapp"] as const;

export function isRelayProviderKey(value: unknown): value is RelayProviderKey {
  return typeof value === "string" && RELAY_PROVIDER_KEYS.some((candidate) => candidate === value);
}

export function isRelayRuntimeProviderId(value: unknown): value is RelayRuntimeProviderId {
  return (
    typeof value === "string" &&
    RELAY_PROVIDER_KEYS.some((providerKey) => RELAY_RUNTIME_PROVIDER_IDS[providerKey] === value)
  );
}

export function getRelayProviderIdentity(providerKey: RelayProviderKey): RelayProviderIdentity {
  return {
    providerKey,
    runtimeProviderId: RELAY_RUNTIME_PROVIDER_IDS[providerKey],
  };
}

export function resolveRelayProviderIdentity(
  reference: RelayProviderReference | string,
): RelayProviderIdentity {
  const providerKey =
    typeof reference === "string"
      ? isRelayProviderKey(reference)
        ? reference
        : undefined
      : isRelayProviderKey(reference.providerKey)
        ? reference.providerKey
        : undefined;
  const runtimeProviderId =
    typeof reference === "string"
      ? isRelayRuntimeProviderId(reference)
        ? reference
        : undefined
      : isRelayRuntimeProviderId(reference.runtimeProviderId)
        ? reference.runtimeProviderId
        : undefined;

  const runtimeProviderKey = runtimeProviderId
    ? RELAY_PROVIDER_KEYS.find(
        (candidate) => RELAY_RUNTIME_PROVIDER_IDS[candidate] === runtimeProviderId,
      )
    : undefined;
  if (providerKey && runtimeProviderKey && providerKey !== runtimeProviderKey) {
    throw new Error(
      `Relay provider key "${String(providerKey)}" does not match runtime provider "${runtimeProviderId}"`,
    );
  }

  const resolvedProviderKey = providerKey ?? runtimeProviderKey;
  if (!resolvedProviderKey) {
    throw new Error("A supported relay provider key or runtime provider ID is required");
  }
  return getRelayProviderIdentity(resolvedProviderKey);
}

export function listRelayProviderIdentities(): readonly RelayProviderIdentity[] {
  return RELAY_PROVIDER_KEYS.map(getRelayProviderIdentity);
}

export function isRelayProviderConnectionRequested(
  settings: RelaySettingsCarrier,
  providerKey: RelayProviderKey,
): boolean {
  const relay = normalizeRelaySettings(settings.relay);
  const provider = relay.providers[providerKey];
  return provider?.enabled ? provider.connectionIntent === "connect" : false;
}
