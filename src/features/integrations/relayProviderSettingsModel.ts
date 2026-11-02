import type { MSettings } from "@common/marshal-ipc-contract";
import {
  normalizeRelayProgressIntervalMinutes,
  normalizeProviderSelectionSettings,
  normalizeRelaySettings,
  type RelayProviderConfig,
} from "@common/provider-config";
import type { RelayProviderKey } from "@common/relay-provider-settings";

type RelayDestinationKind = "defaultNotificationDestinations" | "progressDestinations";

export function getRelayProviderConfig(
  settings: MSettings,
  providerKey: RelayProviderKey,
): RelayProviderConfig {
  return (
    getNormalizedRelay(settings).providers[providerKey] ?? {
      enabled: false,
      connectionIntent: "disconnect",
    }
  );
}

export function setRelayProviderEnabled(
  settings: MSettings,
  providerKey: RelayProviderKey,
  enabled: boolean,
): MSettings {
  return updateRelaySettings(settings, (relay) => ({
    ...relay,
    providers: {
      ...relay.providers,
      [providerKey]: {
        ...(relay.providers[providerKey] ?? {
          connectionIntent: "disconnect",
        }),
        enabled,
        connectionIntent: enabled
          ? (relay.providers[providerKey]?.connectionIntent ?? "disconnect")
          : "disconnect",
      },
    },
    defaultNotificationDestinations: enabled
      ? relay.defaultNotificationDestinations
      : relay.defaultNotificationDestinations.filter((candidate) => candidate !== providerKey),
    progressDestinations: enabled
      ? relay.progressDestinations
      : relay.progressDestinations.filter((candidate) => candidate !== providerKey),
  }));
}

export function setRelayProviderAccountId(
  settings: MSettings,
  providerKey: RelayProviderKey,
  accountId: string | undefined,
): MSettings {
  return updateRelaySettings(settings, (relay) => {
    const existing = relay.providers[providerKey] ?? {
      enabled: false,
      connectionIntent: "disconnect",
    };
    const { accountId: _existingAccountId, ...providerWithoutAccountId } = existing;
    return {
      ...relay,
      providers: {
        ...relay.providers,
        [providerKey]: {
          ...providerWithoutAccountId,
          ...(accountId ? { accountId } : {}),
        },
      },
    };
  });
}

export function setRelayProviderDestination(
  settings: MSettings,
  providerKey: RelayProviderKey,
  destinationKind: RelayDestinationKind,
  selected: boolean,
): MSettings {
  return updateRelaySettings(settings, (relay) => {
    const destinations = relay[destinationKind];
    return {
      ...relay,
      [destinationKind]: selected
        ? [...new Set([...destinations, providerKey])]
        : destinations.filter((candidate) => candidate !== providerKey),
    };
  });
}

export function getRelayProgressIntervalMinutes(settings: MSettings): number {
  return getNormalizedRelay(settings).progressIntervalMinutes;
}

export function setRelayProgressIntervalMinutes(
  settings: MSettings,
  progressIntervalMinutes: number,
): MSettings {
  return updateRelaySettings(settings, (relay) => ({
    ...relay,
    progressIntervalMinutes: normalizeRelayProgressIntervalMinutes(progressIntervalMinutes),
  }));
}

export function isRelayNotificationDestinationConfigured(settings: MSettings): boolean {
  const relay = getNormalizedRelay(settings);
  return Object.values(relay.providers).some((provider) => provider.enabled);
}

function getNormalizedRelay(settings: MSettings) {
  return normalizeRelaySettings(settings.relay);
}

function updateRelaySettings(
  settings: MSettings,
  update: (relay: ReturnType<typeof getNormalizedRelay>) => ReturnType<typeof getNormalizedRelay>,
): MSettings {
  return normalizeProviderSelectionSettings({
    ...settings,
    relay: update(getNormalizedRelay(settings)),
  });
}
