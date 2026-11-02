import type {
  RelayAccountId,
  RelayProviderCapabilities,
  RelayProviderId,
} from "../../common/relay-contract";
import type {
  RelayConnectionStatus,
  RelayProvider,
  RelayProviderEvent,
  RelayProviderEventListener,
} from "./contracts";

interface RelayProviderEntry {
  readonly provider: RelayProvider;
  readonly accountId: RelayAccountId;
  active: boolean;
  unsubscribe: () => void;
}

export interface RelayProviderRegistration {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
}

export class RelayProviderRegistry {
  private readonly providers = new Map<RelayProviderId, Map<RelayAccountId, RelayProviderEntry>>();
  private readonly listeners = new Set<RelayProviderEventListener>();
  private disposed = false;

  register(provider: RelayProvider, accountId: RelayAccountId): () => void {
    this.assertUsable();

    let accounts = this.providers.get(provider.providerId);
    if (!accounts) {
      accounts = new Map();
      this.providers.set(provider.providerId, accounts);
    }
    if (accounts.has(accountId)) {
      throw new Error(
        `Relay provider "${provider.providerId}" account "${accountId}" is already registered`,
      );
    }

    const entry: RelayProviderEntry = {
      provider,
      accountId,
      active: true,
      unsubscribe: () => {},
    };
    accounts.set(accountId, entry);

    try {
      entry.unsubscribe = once(
        provider.subscribe((event) => this.forwardProviderEvent(entry, event)),
      );
    } catch (error) {
      entry.active = false;
      accounts.delete(accountId);
      if (accounts.size === 0) {
        this.providers.delete(provider.providerId);
      }
      throw error;
    }

    return () => {
      this.unregisterEntry(provider.providerId, accountId, entry);
    };
  }

  unregister(providerId: RelayProviderId, accountId: RelayAccountId): boolean {
    return this.unregisterEntry(providerId, accountId);
  }

  has(providerId: RelayProviderId, accountId: RelayAccountId): boolean {
    return this.providers.get(providerId)?.has(accountId) ?? false;
  }

  list(): readonly RelayProviderRegistration[] {
    const registrations: RelayProviderRegistration[] = [];
    for (const [providerId, accounts] of this.providers) {
      for (const accountId of accounts.keys()) {
        registrations.push({ providerId, accountId });
      }
    }
    return registrations;
  }

  getProvider(providerId: RelayProviderId, accountId: RelayAccountId): RelayProvider {
    return this.requireEntry(providerId, accountId).provider;
  }

  getCapabilities(
    providerId: RelayProviderId,
    accountId: RelayAccountId,
  ): RelayProviderCapabilities {
    return this.requireEntry(providerId, accountId).provider.capabilities(accountId);
  }

  getStatus(
    providerId: RelayProviderId,
    accountId: RelayAccountId,
  ): Promise<RelayConnectionStatus> {
    return this.requireEntry(providerId, accountId).provider.status(accountId);
  }

  connect(providerId: RelayProviderId, accountId: RelayAccountId): Promise<void> {
    return this.requireEntry(providerId, accountId).provider.connect(accountId);
  }

  disconnect(providerId: RelayProviderId, accountId: RelayAccountId): Promise<void> {
    return this.requireEntry(providerId, accountId).provider.disconnect(accountId);
  }

  subscribe(listener: RelayProviderEventListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return once(() => {
      this.listeners.delete(listener);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const entries = [...this.providers.values()].flatMap((accounts) => [...accounts.values()]);
    this.providers.clear();
    this.listeners.clear();

    const errors: unknown[] = [];
    for (const entry of entries) {
      entry.active = false;
      try {
        entry.unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to unsubscribe one or more relay providers");
    }
  }

  private requireEntry(providerId: RelayProviderId, accountId: RelayAccountId): RelayProviderEntry {
    const entry = this.providers.get(providerId)?.get(accountId);
    if (!entry) {
      throw new Error(`Relay provider "${providerId}" account "${accountId}" is not registered`);
    }
    return entry;
  }

  private unregisterEntry(
    providerId: RelayProviderId,
    accountId: RelayAccountId,
    expected?: RelayProviderEntry,
  ): boolean {
    const accounts = this.providers.get(providerId);
    const entry = accounts?.get(accountId);
    if (!accounts || !entry || (expected && entry !== expected)) {
      return false;
    }

    entry.active = false;
    accounts.delete(accountId);
    if (accounts.size === 0) {
      this.providers.delete(providerId);
    }
    entry.unsubscribe();
    return true;
  }

  private async forwardProviderEvent(
    entry: RelayProviderEntry,
    event: RelayProviderEvent,
  ): Promise<void> {
    if (!entry.active) return;
    if (event.providerId !== entry.provider.providerId) {
      throw new Error(
        `Relay provider "${entry.provider.providerId}" emitted event for provider "${event.providerId}"`,
      );
    }
    if (event.accountId !== entry.accountId) return;

    await Promise.all(
      [...this.listeners].map(async (listener) => {
        await listener(event);
      }),
    );
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("Relay provider registry is disposed");
    }
  }
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}
