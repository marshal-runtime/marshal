import { randomUUID } from "node:crypto";

import {
  isRelayAccountId,
  normalizeRelaySettings,
  type RelayConnectionIntent,
} from "../../common/provider-config";
import { parseRelayAccountId, parseRelayProviderId } from "../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelaySetupSnapshot,
} from "../../common/relay-experience-contract";
import type {
  RelayProviderActionRequest,
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
} from "../../common/relay-provider-settings";
import { resolveRelayProviderIdentity } from "../../common/relay-provider-settings";
import type { RelayProviderSettingsService } from "../relay/provider-settings-service";
import type { SettingsManager } from "../settings-manager";
import type { IpcDeps } from "./types";

type RelayProviderAction = "connect" | "disconnect" | "reset" | "relink" | "provision";

type RelayProviderSettingsEventChannel =
  | "relay-provider-settings:changed"
  | "relay-provider-settings:setup-changed";

interface RelayProviderSettingsIpcDeps {
  ipcHandle: IpcDeps["ipcHandle"];
  settingsManager: Pick<SettingsManager, "get" | "update">;
  service: RelayProviderSettingsService;
  broadcast: (
    channel: RelayProviderSettingsEventChannel,
    payload: RelayProviderRuntimeSnapshot | RelayProviderSetupEvent,
  ) => void;
}

export function registerRelayProviderSettingsHandlers({
  ipcHandle,
  settingsManager,
  service,
  broadcast,
}: RelayProviderSettingsIpcDeps): () => void {
  ipcHandle("relay-provider-settings:list", async () => {
    try {
      return { success: true, providers: [...(await service.list())] };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  for (const action of ["connect", "disconnect", "reset", "relink", "provision"] as const) {
    ipcHandle(`relay-provider-settings:${action}`, async (_event, request) =>
      runProviderAction(settingsManager, service, action, request),
    );
  }

  const unsubscribeChanged = service.subscribeChanged((snapshot) => {
    broadcast("relay-provider-settings:changed", snapshot);
  });
  const unsubscribeSetup = service.subscribeSetup((snapshot) => {
    broadcast("relay-provider-settings:setup-changed", createSetupEvent(snapshot));
  });

  return () => {
    unsubscribeChanged();
    unsubscribeSetup();
  };
}

async function runProviderAction(
  settingsManager: RelayProviderSettingsIpcDeps["settingsManager"],
  service: RelayProviderSettingsService,
  action: RelayProviderAction,
  request: RelayProviderActionRequest,
): Promise<{ success: boolean; setup?: RelayProviderSetupEvent; error?: string }> {
  try {
    const identity = resolveRelayProviderIdentity(request);
    normalizeAccountId(request.accountId);
    const runtimeAccountId = await resolveRuntimeAccountId(service, identity.providerKey);
    persistActionIntent(settingsManager, identity.providerKey, runtimeAccountId, action);
    const operation = createAccountOperationRequest(identity.runtimeProviderId, runtimeAccountId);
    const result =
      action === "connect"
        ? await service.connectionControl.connect(operation)
        : action === "disconnect"
          ? await service.connectionControl.disconnect(operation)
          : action === "reset"
            ? await service.pairingControl.cancelPairing(operation)
            : action === "relink"
              ? await service.resetAndRelink(operation)
              : await service.provision(operation);
    if (!result.ok) return { success: false, error: result.error.message };
    assertSetupScope(result.value, operation);
    return { success: true, setup: createSetupEvent(result.value) };
  } catch (error) {
    return { success: false, error: String(error) };
  }

  async function resolveRuntimeAccountId(
    providerService: RelayProviderSettingsService,
    providerKey: string,
  ): Promise<string> {
    const snapshot = (await providerService.list()).find(
      (candidate) => candidate.providerKey === providerKey,
    );
    const accountId = normalizeAccountId(snapshot?.accountId);
    if (!accountId) {
      throw new Error(`Relay provider "${providerKey}" has no registered account`);
    }
    return accountId;
  }
}

function createAccountOperationRequest(
  runtimeProviderId: string,
  accountId: string,
): RelayAccountOperationRequest {
  return {
    providerId: parseRelayProviderId(runtimeProviderId),
    accountId: parseRelayAccountId(accountId),
    idempotencyKey: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
}

function createSetupEvent(snapshot: RelaySetupSnapshot): RelayProviderSetupEvent {
  return {
    ...resolveRelayProviderIdentity(snapshot.account.providerId),
    snapshot,
  };
}

function assertSetupScope(
  snapshot: RelaySetupSnapshot,
  request: RelayAccountOperationRequest,
): void {
  if (
    snapshot.account.providerId !== request.providerId ||
    snapshot.account.accountId !== request.accountId
  ) {
    throw new Error("Relay setup snapshot account does not match the requested account scope");
  }
}

function normalizeAccountId(accountId: string | undefined): string | undefined {
  if (accountId === undefined || accountId === "") return undefined;
  if (!isRelayAccountId(accountId)) {
    throw new Error("Relay account ID must be an app-owned alphanumeric identifier");
  }
  return accountId;
}

function persistActionIntent(
  settingsManager: RelayProviderSettingsIpcDeps["settingsManager"],
  providerKey: string,
  accountId: string | undefined,
  action: RelayProviderAction,
): void {
  if (action === "provision") return;
  const connectionIntent: RelayConnectionIntent =
    action === "connect" || action === "relink" ? "connect" : "disconnect";
  persistConnectionIntent(
    settingsManager,
    providerKey,
    connectionIntent === "connect" ? accountId : undefined,
    connectionIntent,
  );
}

function persistConnectionIntent(
  settingsManager: RelayProviderSettingsIpcDeps["settingsManager"],
  providerKey: string,
  accountId: string | undefined,
  connectionIntent: RelayConnectionIntent,
): void {
  const settings = settingsManager.get();
  const relay = normalizeRelaySettings(settings.relay);
  const existing = relay.providers[providerKey] ?? {
    enabled: false,
    connectionIntent: "disconnect",
  };
  const updatedRelay = {
    ...relay,
    providers: {
      ...relay.providers,
      [providerKey]: {
        ...existing,
        enabled: connectionIntent === "connect" ? true : existing.enabled,
        ...(existing.accountId
          ? { accountId: existing.accountId }
          : accountId
            ? { accountId }
            : {}),
        connectionIntent,
      },
    },
  };

  settingsManager.update({ relay: updatedRelay });
}
