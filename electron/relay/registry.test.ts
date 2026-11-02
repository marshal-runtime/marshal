import { describe, expect, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../common/relay-contract";
import type {
  RelayAccountId,
  RelayProviderCapabilities,
  RelayProviderId,
  RelayPublishRequest,
} from "../../common/relay-contract";
import type {
  RelayConnectionStatus,
  RelayProvider,
  RelayProviderEvent,
  RelayProviderEventListener,
  RelayPublishReceipt,
} from "./contracts";
import { RelayProviderRegistry } from "./registry";

const ACCOUNT_ONE = parseRelayAccountId("account-one");
const ACCOUNT_TWO = parseRelayAccountId("account-two");
const CAPABILITIES: RelayProviderCapabilities = {
  inbound: true,
  quotedReplies: true,
  attachments: true,
  voice: true,
  managedGroups: false,
  communities: false,
  renameConversation: false,
  retireConversation: false,
  remotePermissionApproval: false,
};

class TestRelayProvider implements RelayProvider {
  readonly listeners = new Set<RelayProviderEventListener>();
  readonly connectedAccounts: RelayAccountId[] = [];
  readonly disconnectedAccounts: RelayAccountId[] = [];
  readonly statuses = new Map<RelayAccountId, RelayConnectionStatus>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  throwOnUnsubscribe = false;

  constructor(
    readonly providerId: RelayProviderId,
    private readonly providerCapabilities: RelayProviderCapabilities = CAPABILITIES,
  ) {}

  capabilities(): RelayProviderCapabilities {
    return this.providerCapabilities;
  }

  async connect(accountId: RelayAccountId): Promise<void> {
    this.connectedAccounts.push(accountId);
  }

  async disconnect(accountId: RelayAccountId): Promise<void> {
    this.disconnectedAccounts.push(accountId);
  }

  async status(accountId: RelayAccountId): Promise<RelayConnectionStatus> {
    return (
      this.statuses.get(accountId) ?? {
        state: "disconnected",
        updatedAt: "2026-08-06T15:00:00.000Z",
      }
    );
  }

  async publish(request: RelayPublishRequest): Promise<RelayPublishReceipt> {
    return {
      publicationId: request.publicationId,
      providerMessageId: parseRelayMessageId(`published:${request.publicationId}`),
      publishedAt: "2026-08-06T15:00:00.000Z",
    };
  }

  subscribe(listener: RelayProviderEventListener): () => void {
    this.subscribeCalls += 1;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
      if (this.throwOnUnsubscribe) {
        throw new Error(`unsubscribe failed for ${this.providerId}`);
      }
    };
  }

  async emit(event: RelayProviderEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

describe("RelayProviderRegistry", () => {
  it("registers concurrent providers and accounts and exposes lifecycle lookups", async () => {
    const registry = new RelayProviderRegistry();
    const providerOne = new TestRelayProvider(parseRelayProviderId("provider-one"));
    const providerTwo = new TestRelayProvider(parseRelayProviderId("provider-two"), {
      ...CAPABILITIES,
      communities: true,
    });
    providerOne.statuses.set(ACCOUNT_TWO, {
      state: "connected",
      updatedAt: "2026-08-06T15:30:00.000Z",
    });

    registry.register(providerOne, ACCOUNT_ONE);
    registry.register(providerOne, ACCOUNT_TWO);
    registry.register(providerTwo, ACCOUNT_ONE);

    expect(registry.list()).toEqual([
      { providerId: providerOne.providerId, accountId: ACCOUNT_ONE },
      { providerId: providerOne.providerId, accountId: ACCOUNT_TWO },
      { providerId: providerTwo.providerId, accountId: ACCOUNT_ONE },
    ]);
    expect(registry.getProvider(providerOne.providerId, ACCOUNT_ONE)).toBe(providerOne);
    expect(registry.getCapabilities(providerTwo.providerId, ACCOUNT_ONE).communities).toBe(true);
    await expect(registry.getStatus(providerOne.providerId, ACCOUNT_TWO)).resolves.toEqual({
      state: "connected",
      updatedAt: "2026-08-06T15:30:00.000Z",
    });

    await registry.connect(providerOne.providerId, ACCOUNT_ONE);
    await registry.disconnect(providerOne.providerId, ACCOUNT_TWO);
    expect(providerOne.connectedAccounts).toEqual([ACCOUNT_ONE]);
    expect(providerOne.disconnectedAccounts).toEqual([ACCOUNT_TWO]);
  });

  it("rejects duplicate provider and account registrations", () => {
    const registry = new RelayProviderRegistry();
    const providerId = parseRelayProviderId("provider");
    const first = new TestRelayProvider(providerId);
    const duplicate = new TestRelayProvider(providerId);

    registry.register(first, ACCOUNT_ONE);

    expect(() => registry.register(duplicate, ACCOUNT_ONE)).toThrow(
      'Relay provider "provider" account "account-one" is already registered',
    );
    expect(duplicate.subscribeCalls).toBe(0);
    expect(() => registry.getStatus(providerId, ACCOUNT_TWO)).toThrow(
      'Relay provider "provider" account "account-two" is not registered',
    );
  });

  it("forwards only matching account events and unsubscribes registrations safely", async () => {
    const registry = new RelayProviderRegistry();
    const provider = new TestRelayProvider(parseRelayProviderId("provider"));
    const received: RelayProviderEvent[] = [];
    const releaseListener = registry.subscribe(async (event) => {
      received.push(event);
    });
    const releaseOne = registry.register(provider, ACCOUNT_ONE);
    registry.register(provider, ACCOUNT_TWO);

    const accountOneEvent = statusEvent(provider.providerId, ACCOUNT_ONE);
    const accountTwoEvent = statusEvent(provider.providerId, ACCOUNT_TWO);
    await provider.emit(accountOneEvent);
    expect(received).toEqual([accountOneEvent]);

    releaseOne();
    releaseOne();
    await provider.emit(accountOneEvent);
    await provider.emit(accountTwoEvent);
    expect(received).toEqual([accountOneEvent, accountTwoEvent]);
    expect(provider.unsubscribeCalls).toBe(1);

    releaseListener();
    releaseListener();
    await provider.emit(accountTwoEvent);
    expect(received).toEqual([accountOneEvent, accountTwoEvent]);
  });

  it("does not let a stale release remove a replacement registration", () => {
    const registry = new RelayProviderRegistry();
    const providerId = parseRelayProviderId("provider");
    const first = new TestRelayProvider(providerId);
    const replacement = new TestRelayProvider(providerId);

    const releaseFirst = registry.register(first, ACCOUNT_ONE);
    releaseFirst();
    const releaseReplacement = registry.register(replacement, ACCOUNT_ONE);

    releaseFirst();
    expect(registry.getProvider(providerId, ACCOUNT_ONE)).toBe(replacement);

    releaseReplacement();
    expect(registry.has(providerId, ACCOUNT_ONE)).toBe(false);
    expect(first.unsubscribeCalls).toBe(1);
    expect(replacement.unsubscribeCalls).toBe(1);
  });

  it("disposes every subscription once and rejects later registrations", () => {
    const registry = new RelayProviderRegistry();
    const providerOne = new TestRelayProvider(parseRelayProviderId("provider-one"));
    const providerTwo = new TestRelayProvider(parseRelayProviderId("provider-two"));

    registry.register(providerOne, ACCOUNT_ONE);
    registry.register(providerTwo, ACCOUNT_TWO);
    registry.dispose();
    registry.dispose();

    expect(providerOne.unsubscribeCalls).toBe(1);
    expect(providerTwo.unsubscribeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
    expect(() => registry.register(providerOne, ACCOUNT_ONE)).toThrow(
      "Relay provider registry is disposed",
    );
    expect(() => registry.subscribe(async () => {})).toThrow("Relay provider registry is disposed");
  });

  it("continues disposal when one provider unsubscribe fails", () => {
    const registry = new RelayProviderRegistry();
    const providerOne = new TestRelayProvider(parseRelayProviderId("provider-one"));
    const providerTwo = new TestRelayProvider(parseRelayProviderId("provider-two"));
    providerOne.throwOnUnsubscribe = true;

    registry.register(providerOne, ACCOUNT_ONE);
    registry.register(providerTwo, ACCOUNT_TWO);

    expect(() => registry.dispose()).toThrow(AggregateError);
    expect(providerOne.unsubscribeCalls).toBe(1);
    expect(providerTwo.unsubscribeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});

function statusEvent(providerId: RelayProviderId, accountId: RelayAccountId): RelayProviderEvent {
  return {
    type: "status-changed",
    providerId,
    accountId,
    occurredAt: "2026-08-06T15:30:00.000Z",
    status: {
      state: "connected",
      updatedAt: "2026-08-06T15:30:00.000Z",
    },
  };
}
