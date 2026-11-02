import type { WhatsAppStatus } from "../../common/marshal-ipc-contract";
import { parseRelayAccountId, parseRelayProviderId } from "../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelayAccountScope,
  RelayExperienceResult,
  RelaySetupErrorCode,
  RelaySetupSnapshot,
} from "../../common/relay-experience-contract";
import type {
  RelayProviderKey,
  RelayProviderRuntimeSnapshot,
} from "../../common/relay-provider-settings";
import {
  getRelayProviderIdentity,
  listRelayProviderIdentities,
} from "../../common/relay-provider-settings";
import type { RelayConnectionStatus } from "./contracts";
import type {
  RelayConnectionControlPort,
  RelayPairingControlPort,
  RelaySetupStatusPort,
} from "./experience-ports";
import { RelayProviderRegistry } from "./registry";

type SetupResult = RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>;

export interface RelayProviderSettingsBinding {
  readonly providerKey: RelayProviderKey;
  readonly account: RelayAccountScope;
  readonly setupStatus: RelaySetupStatusPort;
  readonly connectionControl: RelayConnectionControlPort;
  readonly pairingControl?: RelayPairingControlPort;
  resetAndRelink?(request: RelayAccountOperationRequest): Promise<SetupResult>;
  provision?(request: RelayAccountOperationRequest): Promise<SetupResult>;
}

export interface RelayProviderSettingsService {
  list(): Promise<readonly RelayProviderRuntimeSnapshot[]>;
  readonly setupStatus: RelaySetupStatusPort;
  readonly pairingControl: RelayPairingControlPort;
  readonly connectionControl: RelayConnectionControlPort;
  resetAndRelink(request: RelayAccountOperationRequest): Promise<SetupResult>;
  provision(request: RelayAccountOperationRequest): Promise<SetupResult>;
  subscribeChanged(listener: (snapshot: RelayProviderRuntimeSnapshot) => void): () => void;
  subscribeSetup(listener: (snapshot: RelaySetupSnapshot) => void): () => void;
}

const NO_CAPABILITIES = {
  inbound: false,
  quotedReplies: false,
  attachments: false,
  voice: false,
  managedGroups: false,
  communities: false,
  renameConversation: false,
  retireConversation: false,
  remotePermissionApproval: false,
} as const;

export interface RelayProviderSettingsServiceOptions {
  readonly registry: RelayProviderRegistry;
  readonly getBindings: () => readonly RelayProviderSettingsBinding[];
}

interface LegacyWhatsAppSettingsPort {
  getStatus(): WhatsAppStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  cancelPairing(): Promise<void>;
  reset(): Promise<void>;
  retryProvisioning(): Promise<void>;
  subscribeStatus(listener: (status: WhatsAppStatus) => void): () => void;
}

export interface LegacyRelayProviderSettingsServiceOptions {
  readonly whatsapp: LegacyWhatsAppSettingsPort;
  readonly getWhatsAppAccountId?: () => string | undefined;
}

export function createRelayProviderSettingsService(
  options: RelayProviderSettingsServiceOptions | LegacyRelayProviderSettingsServiceOptions,
): RelayProviderSettingsService {
  if ("whatsapp" in options) return createLegacyWhatsAppService(options);
  const findBinding = (account: RelayAccountScope) =>
    options
      .getBindings()
      .find(
        (binding) =>
          binding.account.providerId === account.providerId &&
          binding.account.accountId === account.accountId,
      );
  const invoke = async (
    request: RelayAccountOperationRequest,
    select: (
      binding: RelayProviderSettingsBinding,
    ) => ((request: RelayAccountOperationRequest) => Promise<SetupResult>) | undefined,
    unsupported: string,
  ): Promise<SetupResult> => {
    const binding = findBinding(request);
    if (!binding) return unavailable(request);
    const operation = select(binding);
    return operation ? operation(request) : unsupportedResult(unsupported);
  };
  const invokeConnection = async (
    request: RelayAccountOperationRequest,
    operation: "connect" | "disconnect",
  ): Promise<SetupResult> => {
    const binding = findBinding(request);
    if (!binding) return unavailable(request);
    try {
      if (operation === "connect") {
        await options.registry.connect(request.providerId, request.accountId);
      } else {
        await options.registry.disconnect(request.providerId, request.accountId);
      }
      return binding.setupStatus.getStatus(binding.account);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "provider-failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  };

  return {
    list: () => listSnapshots(options),
    setupStatus: {
      getStatus: async (account) => {
        const binding = findBinding(account);
        return binding ? binding.setupStatus.getStatus(account) : unavailable(account);
      },
      subscribe: (account, listener) => {
        const binding = findBinding(account);
        return binding ? binding.setupStatus.subscribe(account, listener) : () => undefined;
      },
    },
    pairingControl: {
      beginPairing: (request) =>
        invoke(
          request,
          (binding) => binding.pairingControl?.beginPairing.bind(binding.pairingControl),
          "This relay provider does not require pairing",
        ),
      cancelPairing: (request) =>
        invoke(
          request,
          (binding) => binding.pairingControl?.cancelPairing.bind(binding.pairingControl),
          "This relay provider does not expose pairing cancellation",
        ),
    },
    connectionControl: {
      connect: (request) => invokeConnection(request, "connect"),
      disconnect: (request) => invokeConnection(request, "disconnect"),
    },
    resetAndRelink: (request) =>
      invoke(
        request,
        (binding) => binding.resetAndRelink?.bind(binding),
        "This relay provider does not support reset and relink",
      ),
    provision: (request) =>
      invoke(
        request,
        (binding) => binding.provision?.bind(binding),
        "This relay provider does not expose managed provisioning",
      ),
    subscribeChanged: (listener) => {
      let active = true;
      const emit = (providerId: string, accountId: string) => {
        void runtimeSnapshot(options, providerId, accountId).then((snapshot) => {
          if (active && snapshot) listener(snapshot);
        });
      };
      const removeRegistry = options.registry.subscribe(async (event) => {
        if (event.type === "status-changed") emit(event.providerId, event.accountId);
      });
      const removeSetup = options.getBindings().map((binding) =>
        binding.setupStatus.subscribe(binding.account, () => {
          emit(binding.account.providerId, binding.account.accountId);
        }),
      );
      return () => {
        active = false;
        removeRegistry();
        for (const remove of removeSetup) remove();
      };
    },
    subscribeSetup: (listener) => {
      const removers = options
        .getBindings()
        .map((binding) => binding.setupStatus.subscribe(binding.account, listener));
      return () => {
        for (const remove of removers) remove();
      };
    },
  };
}

function createLegacyWhatsAppService(
  options: LegacyRelayProviderSettingsServiceOptions,
): RelayProviderSettingsService {
  const account: RelayAccountScope = {
    providerId: parseRelayProviderId("whatsapp-baileys"),
    accountId: parseRelayAccountId(options.getWhatsAppAccountId?.() ?? "primary"),
  };
  const run = async (
    request: RelayAccountOperationRequest,
    operation: () => Promise<void>,
  ): Promise<SetupResult> => {
    if (!sameAccount(request, account)) return unavailable(request);
    try {
      await operation();
      return { ok: true, value: legacyWhatsAppSnapshot(options.whatsapp.getStatus(), account) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "provider-failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  };
  return {
    list: async () =>
      listRelayProviderIdentities().map((identity) =>
        identity.providerKey === "whatsapp"
          ? {
              ...identity,
              available: options.whatsapp.getStatus().initialized,
              accountId: account.accountId,
              connection: {
                state: legacyConnectionState(options.whatsapp.getStatus()),
              },
              capabilities: {
                ...NO_CAPABILITIES,
                inbound: true,
                quotedReplies: true,
                managedGroups: true,
                communities: true,
              },
            }
          : unavailableSnapshot(identity.providerKey),
      ),
    setupStatus: {
      getStatus: async (requested) =>
        sameAccount(requested, account)
          ? { ok: true, value: legacyWhatsAppSnapshot(options.whatsapp.getStatus(), account) }
          : unavailable(requested),
      subscribe: (requested, listener) =>
        sameAccount(requested, account)
          ? options.whatsapp.subscribeStatus((status) => {
              void listener(legacyWhatsAppSnapshot(status, account));
            })
          : () => undefined,
    },
    pairingControl: {
      beginPairing: (request) => run(request, () => options.whatsapp.connect()),
      cancelPairing: (request) => run(request, () => options.whatsapp.cancelPairing()),
    },
    connectionControl: {
      connect: (request) => run(request, () => options.whatsapp.connect()),
      disconnect: (request) => run(request, () => options.whatsapp.disconnect()),
    },
    resetAndRelink: (request) => run(request, () => options.whatsapp.reset()),
    provision: (request) => run(request, () => options.whatsapp.retryProvisioning()),
    subscribeChanged: () => () => undefined,
    subscribeSetup: (listener) =>
      options.whatsapp.subscribeStatus((status) => {
        listener(legacyWhatsAppSnapshot(status, account));
      }),
  };
}

export function createRelayProviderSettingsServiceSkeleton(): RelayProviderSettingsService {
  const registry = new RelayProviderRegistry();
  return createRelayProviderSettingsService({ registry, getBindings: () => [] });
}

async function listSnapshots(
  options: RelayProviderSettingsServiceOptions,
): Promise<readonly RelayProviderRuntimeSnapshot[]> {
  const byKey = new Map(options.getBindings().map((binding) => [binding.providerKey, binding]));
  return Promise.all(
    listRelayProviderIdentities().map(async (identity) => {
      const binding = byKey.get(identity.providerKey);
      if (!binding) return unavailableSnapshot(identity.providerKey);
      return (
        (await runtimeSnapshot(options, binding.account.providerId, binding.account.accountId)) ??
        unavailableSnapshot(identity.providerKey)
      );
    }),
  );
}

async function runtimeSnapshot(
  options: RelayProviderSettingsServiceOptions,
  providerId: string,
  accountId: string,
): Promise<RelayProviderRuntimeSnapshot | undefined> {
  const binding = options
    .getBindings()
    .find(
      (candidate) =>
        candidate.account.providerId === providerId && candidate.account.accountId === accountId,
    );
  if (!binding) return undefined;
  if (!options.registry.has(binding.account.providerId, binding.account.accountId)) {
    return unavailableSnapshot(binding.providerKey);
  }
  try {
    const [status, setup] = await Promise.all([
      options.registry.getStatus(binding.account.providerId, binding.account.accountId),
      binding.setupStatus.getStatus(binding.account),
    ]);
    const connection = connectionSnapshot(status);
    return {
      ...getRelayProviderIdentity(binding.providerKey),
      available: true,
      accountId: binding.account.accountId,
      connection:
        setup.ok && setup.value.failure
          ? { ...connection, failure: setup.value.failure }
          : connection,
      capabilities: options.registry.getCapabilities(
        binding.account.providerId,
        binding.account.accountId,
      ),
    };
  } catch (error) {
    return {
      ...getRelayProviderIdentity(binding.providerKey),
      available: true,
      accountId: binding.account.accountId,
      connection: {
        state: "error",
        failure: {
          code: "provider-failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      },
      capabilities: options.registry.getCapabilities(
        binding.account.providerId,
        binding.account.accountId,
      ),
    };
  }
}

function unavailableSnapshot(providerKey: RelayProviderKey): RelayProviderRuntimeSnapshot {
  return {
    ...getRelayProviderIdentity(providerKey),
    available: false,
    connection: {
      state: "unavailable",
      detail: "Runtime provider integration is not registered yet.",
    },
    capabilities: NO_CAPABILITIES,
  };
}

function connectionSnapshot(
  status: RelayConnectionStatus,
): RelayProviderRuntimeSnapshot["connection"] {
  return {
    state: status.state,
    updatedAt: status.updatedAt,
    ...(status.failure
      ? {
          failure: {
            code: "provider-failure" as const,
            message: status.failure.message,
            retryable: status.failure.retryable,
          },
        }
      : {}),
  };
}

function legacyWhatsAppSnapshot(
  status: WhatsAppStatus,
  account: RelayAccountScope,
): RelaySetupSnapshot {
  return {
    account,
    state:
      status.error || status.connection === "requires-reset"
        ? "error"
        : status.connection === "connected"
          ? "connected"
          : status.connection === "reconnecting"
            ? "reconnecting"
            : status.connection === "awaiting-qr"
              ? status.qr
                ? "qr"
                : "pairing"
              : status.connection === "starting" || status.connection === "connecting"
                ? "pairing"
                : status.initialized
                  ? "disconnected"
                  : "idle",
    updatedAt: new Date().toISOString(),
    ...(status.qr ? { qr: { payload: status.qr } } : {}),
    ...(status.error
      ? {
          failure: {
            code:
              status.connection === "requires-reset" ? ("conflict" as const) : "provider-failure",
            message: status.error,
            retryable: status.connection !== "requires-reset",
          },
        }
      : {}),
  };
}

function legacyConnectionState(
  status: WhatsAppStatus,
): RelayProviderRuntimeSnapshot["connection"]["state"] {
  if (!status.initialized) return "unavailable";
  if (status.error || status.connection === "requires-reset") return "error";
  if (status.connection === "connected") return "connected";
  if (status.connection === "reconnecting") return "reconnecting";
  if (
    status.connection === "starting" ||
    status.connection === "connecting" ||
    status.connection === "awaiting-qr"
  ) {
    return "connecting";
  }
  return "disconnected";
}

function unavailable(account: RelayAccountScope): SetupResult {
  return {
    ok: false,
    error: {
      code: "unavailable",
      message: `Relay runtime provider "${account.providerId}" account "${account.accountId}" is unavailable`,
      retryable: false,
    },
  };
}

function unsupportedResult(message: string): SetupResult {
  return {
    ok: false,
    error: {
      code: "unsupported",
      message,
      retryable: false,
    },
  };
}

export function relayAccount(providerId: string, accountId: string): RelayAccountScope {
  return {
    providerId: parseRelayProviderId(providerId),
    accountId: parseRelayAccountId(accountId),
  };
}

function sameAccount(left: RelayAccountScope, right: RelayAccountScope): boolean {
  return left.providerId === right.providerId && left.accountId === right.accountId;
}
