import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAccountId,
  type RelayProviderCapabilities,
  type RelayProviderId,
  type RelayPublishRequest,
} from "../../common/relay-contract";
import { testDouble } from "../testing/harness";
import type {
  RelayConnectionStatus,
  RelayInboundMessageEvent,
  RelayProvider,
  RelayProviderEvent,
  RelayProviderEventListener,
  RelayPublishReceipt,
} from "./contracts";
import {
  RelayExperienceCoordinator,
  type RelayAccountExperienceRuntime,
} from "./experience-coordinator";
import type { RelayEnsuredSessionAccessPoint } from "./host-experience/types";
import { InboundAcceptanceJournal } from "./inbound-acceptance";
import { RelayProviderRegistry } from "./registry";
import { RelayDatabase } from "./relay-database";

const PROVIDER_ID = parseRelayProviderId("provider");
const ACCOUNT_ID = parseRelayAccountId("account");
const SECOND_PROVIDER_ID = parseRelayProviderId("example-chat");
const SECOND_ACCOUNT_ID = parseRelayAccountId("default");
const NOW_MS = Date.parse("2026-08-08T12:00:00.000Z");
const CAPABILITIES: RelayProviderCapabilities = {
  inbound: true,
  quotedReplies: true,
  attachments: false,
  voice: false,
  managedGroups: true,
  communities: true,
  renameConversation: false,
  retireConversation: true,
  remotePermissionApproval: true,
};

describe("RelayExperienceCoordinator session access points", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("derives reminders and deliberate fan-out from durable bindings", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-coordinator-context-"));
    const databasePath = path.join(tempDir, "relay.db");
    const provider = new TestProvider(PROVIDER_ID);
    const secondProvider = new TestProvider(SECOND_PROVIDER_ID);
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    registry.register(secondProvider, SECOND_ACCOUNT_ID);
    const firstDatabase = new RelayDatabase(databasePath);
    const first = new RelayExperienceCoordinator({
      registry,
      database: firstDatabase,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    first.bindings.upsert({
      bindingId: "binding-a",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "conversation-a",
      localConversationId: "session-a",
      role: "session",
      updatedAtMs: NOW_MS,
    });
    first.bindings.upsert({
      bindingId: "binding-b",
      provider: SECOND_PROVIDER_ID,
      accountId: SECOND_ACCOUNT_ID,
      externalConversationId: "conversation-b",
      localConversationId: "session-a",
      role: "session",
      updatedAtMs: NOW_MS + 10,
    });

    expect(first.getSessionReminder("session-a")).toContain("publishRelayMessage");
    expect(first.getSessionReminder("session-a")).toContain("bindingId=binding-a");
    await first.start();
    const result = await first.publishFromSession({
      sessionId: "session-a",
      text: "A deliberate relay update",
      idempotencyKey: "tool-call-1",
      requestedAt: "2026-08-08T12:00:00.000Z",
      sourceTurnId: "turn-1",
    });
    expect(result.publications).toHaveLength(2);
    await vi.waitFor(() => {
      expect(provider.publications).toHaveLength(1);
      expect(secondProvider.publications).toHaveLength(1);
    });
    expect(
      [...provider.publications, ...secondProvider.publications].map(
        (request) => request.address.conversationId,
      ),
    ).toEqual(["conversation-a", "conversation-b"]);
    await first.stop();
    firstDatabase.close();

    const secondDatabase = new RelayDatabase(databasePath);
    const restored = new RelayExperienceCoordinator({
      registry,
      database: secondDatabase,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    expect(restored.getSessionReminder("session-a")).toContain("bindingId=binding-b");
    await restored.retireSessionAccessPoint({
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      conversationId: parseRelayConversationId("conversation-a"),
    });
    expect(restored.getSessionContext("session-a")?.accessPoints).toHaveLength(1);
    await restored.retireSessionAccessPoint({
      providerId: SECOND_PROVIDER_ID,
      accountId: SECOND_ACCOUNT_ID,
      conversationId: parseRelayConversationId("conversation-b"),
    });
    expect(restored.getSessionContext("session-a")).toBeUndefined();
    expect(restored.getSessionReminder("session-a")).toBe("");
    secondDatabase.close();
  });

  it("recovers progress cadence and retires stale access points without touching sessions", async () => {
    let now = 0;
    let busy = true;
    const progressRequests: string[] = [];
    const provider = new TestProvider(PROVIDER_ID);
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => now,
      getProgressIntervalMs: () => 15 * 60_000,
      isSessionOrDescendantBusy: () => busy,
      requestProgressUpdate: async (request) => {
        progressRequests.push(request.idempotencyKey);
        return true;
      },
      staleThresholdMs: 7 * 24 * 60 * 60_000,
      maintenanceIntervalMs: 60 * 60_000,
    });
    coordinator.bindings.upsert({
      bindingId: "binding-progress",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "conversation-progress",
      localConversationId: "session-progress",
      role: "session",
      updatedAtMs: 0,
    });

    now = 16 * 60_000;
    await coordinator.runMaintenanceNow();
    await coordinator.runMaintenanceNow();
    expect(progressRequests).toHaveLength(1);

    coordinator.noteSessionActivity("session-progress", 17 * 60_000);
    now = 31 * 60_000;
    await coordinator.runMaintenanceNow();
    expect(progressRequests).toHaveLength(1);
    now = 33 * 60_000;
    await coordinator.runMaintenanceNow();
    expect(progressRequests).toHaveLength(2);
    expect(provider.publications).toEqual([]);

    now = 8 * 24 * 60 * 60_000;
    await coordinator.runMaintenanceNow();
    expect(provider.retired).toEqual([]);
    expect(coordinator.getSessionContext("session-progress")).toBeDefined();

    busy = false;
    await coordinator.runMaintenanceNow();
    expect(provider.retired).toEqual(["conversation-progress"]);
    expect(coordinator.getSessionContext("session-progress")).toBeUndefined();
    database.close();
  });

  it("starts an account runtime registered after the coordinator is already running", async () => {
    const registry = new RelayProviderRegistry();
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({ registry, database });
    const start = vi.fn<RelayAccountExperienceRuntime["start"]>(async () => undefined);
    const stop = vi.fn<RelayAccountExperienceRuntime["stop"]>(async () => undefined);

    await coordinator.start();
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      { start, stop, routeInbound: async () => "unused" },
    );

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await coordinator.stop();
    expect(stop).toHaveBeenCalledOnce();
    database.close();
  });

  it("recovers accepted managed inbound only after the account runtime is ready", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-coordinator-recovery-"));
    const databasePath = path.join(tempDir, "relay.db");
    const event: RelayInboundMessageEvent = {
      type: "message-received",
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: "2026-08-08T12:00:00.000Z",
      message: {
        address: {
          providerId: PROVIDER_ID,
          accountId: ACCOUNT_ID,
          conversationId: parseRelayConversationId("managed-session@g.us"),
        },
        providerMessageId: parseRelayMessageId("managed-message-1"),
        sender: { primaryId: "owner" },
        sentAt: "2026-08-08T12:00:00.000Z",
        receivedAt: "2026-08-08T12:00:00.000Z",
        text: "Resume the managed session",
        attachments: [],
      },
    };
    const firstDatabase = new RelayDatabase(databasePath);
    const accepted = new InboundAcceptanceJournal(firstDatabase, {
      now: () => NOW_MS,
      createId: () => "accepted-managed-1",
    }).accept({
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      conversationId: event.message.address.conversationId,
      providerMessageId: event.message.providerMessageId,
      payloadJson: JSON.stringify(event),
      acceptedAtMs: NOW_MS,
    }).record;
    firstDatabase.close();

    const registry = new RelayProviderRegistry();
    const provider = new TestProvider(PROVIDER_ID);
    registry.register(provider, ACCOUNT_ID);
    const secondDatabase = new RelayDatabase(databasePath);
    const restored = new RelayExperienceCoordinator({
      registry,
      database: secondDatabase,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    const startEntered = deferred<void>();
    const releaseStart = deferred<void>();
    const routed: string[] = [];
    restored.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        start: async () => {
          startEntered.resolve(undefined);
          await releaseStart.promise;
        },
        stop: async () => undefined,
        routeInbound: async (recovered) => {
          routed.push(recovered.message.providerMessageId);
          return "managed-local-message-1";
        },
      },
    );

    const starting = restored.start();
    await startEntered.promise;
    await provider.emit(event);
    expect(routed).toEqual([]);
    releaseStart.resolve(undefined);
    await starting;

    expect(routed).toEqual(["managed-message-1"]);
    expect(
      new InboundAcceptanceJournal(secondDatabase).getByCorrelationId(accepted.correlationId),
    ).toMatchObject({
      state: "enqueued",
      localMessageId: "managed-local-message-1",
    });
    await restored.stop();
    secondDatabase.close();
  });

  it("drains every account-scoped accepted inbound batch without cross-account starvation", async () => {
    const accountA = parseRelayAccountId("account-a");
    const accountB = parseRelayAccountId("account-b");
    const registry = new RelayProviderRegistry();
    const provider = new TestProvider(PROVIDER_ID);
    registry.register(provider, accountA);
    registry.register(provider, accountB);
    const database = new RelayDatabase(":memory:");
    const journal = new InboundAcceptanceJournal(database, {
      now: () => NOW_MS,
      createId: (() => {
        let sequence = 0;
        return () => `accepted-${++sequence}`;
      })(),
    });
    const accept = (accountId: RelayAccountId, index: number) => {
      const event = inboundEvent(accountId, `message-${accountId}-${index}`);
      journal.accept({
        provider: PROVIDER_ID,
        accountId,
        conversationId: event.message.address.conversationId,
        providerMessageId: event.message.providerMessageId,
        payloadJson: JSON.stringify(event),
        acceptedAtMs: NOW_MS + index,
      });
    };
    for (let index = 0; index < 125; index += 1) accept(accountA, index);
    accept(accountB, 999);
    const routedA: string[] = [];
    const routedB: string[] = [];
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: accountA },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async (event) => {
          routedA.push(event.message.providerMessageId);
          return `local-a-${event.message.providerMessageId}`;
        },
      },
    );
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: accountB },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async (event) => {
          routedB.push(event.message.providerMessageId);
          return `local-b-${event.message.providerMessageId}`;
        },
      },
    );

    await coordinator.start();

    expect(routedA).toHaveLength(125);
    expect(routedB).toEqual(["message-account-b-999"]);
    expect(journal.listAccepted(1_000)).toEqual([]);
    await coordinator.stop();
    database.close();
  });

  it("shares publishNow completion across concurrent idempotent callers", async () => {
    const provider = new TestProvider(PROVIDER_ID);
    const release = deferred<void>();
    vi.spyOn(provider, "publish").mockImplementation(async (request) => {
      provider.publications.push(request);
      await release.promise;
      return {
        publicationId: request.publicationId,
        providerMessageId: parseRelayMessageId("published-shared"),
        publishedAt: "2026-08-08T12:00:00.000Z",
      };
    });
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({ registry, database, now: () => NOW_MS });
    const intent = {
      intent: "deliberate" as const,
      idempotencyKey: "shared-publication",
      correlationId: "shared-publication",
      requestedAt: "2026-08-08T12:00:00.000Z",
      request: {
        publicationId: "shared-publication",
        address: {
          providerId: PROVIDER_ID,
          accountId: ACCOUNT_ID,
          conversationId: parseRelayConversationId("shared-publication"),
        },
        kind: "reply" as const,
        text: "One provider send",
      },
    };

    const first = coordinator.publishNow(intent);
    await vi.waitFor(() => expect(provider.publications).toHaveLength(1));
    const second = coordinator.publishNow(intent);
    release.resolve(undefined);
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

    expect(firstReceipt).toEqual(secondReceipt);
    expect(provider.publications).toHaveLength(1);
    await expect(coordinator.publishNow(intent)).resolves.toEqual(firstReceipt);
    database.close();
  });

  it("recovers a shared retirement after provider mutation crashes", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-retirement-recovery-"));
    const databasePath = path.join(tempDir, "relay.db");
    const provider = new TestProvider(PROVIDER_ID);
    let remoteRetired = false;
    vi.spyOn(provider.conversations, "retire").mockImplementation(async (address) => {
      remoteRetired = true;
      provider.retired.push(address.conversationId);
      throw new Error("crash after provider retirement");
    });
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const firstDatabase = new RelayDatabase(databasePath);
    const first = new RelayExperienceCoordinator({
      registry,
      database: firstDatabase,
      now: () => NOW_MS,
    });
    first.bindings.upsert({
      bindingId: "binding-crash",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "retire-crash",
      localConversationId: "session-crash",
      role: "session",
    });

    await expect(
      first.retireSessionAccessPoint({
        providerId: PROVIDER_ID,
        accountId: ACCOUNT_ID,
        conversationId: parseRelayConversationId("retire-crash"),
      }),
    ).rejects.toThrow("crash after provider retirement");
    expect(remoteRetired).toBe(true);
    expect(first.getSessionContext("session-crash")).toBeUndefined();
    expect(first.bindings.listRetirements()).toHaveLength(1);
    firstDatabase.close();

    vi.mocked(provider.conversations.retire).mockImplementation(async (address) => {
      provider.retired.push(address.conversationId);
    });
    const secondDatabase = new RelayDatabase(databasePath);
    const restored = new RelayExperienceCoordinator({
      registry,
      database: secondDatabase,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    await restored.start();

    expect(restored.bindings.listRetirements()).toEqual([]);
    expect(restored.getSessionContext("session-crash")).toBeUndefined();
    expect(provider.retired).toEqual(["retire-crash", "retire-crash"]);
    await restored.stop();
    secondDatabase.close();
  });

  it("keeps deleted-session access points tombstoned across restart until retirement completes", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-delete-"));
    const databasePath = path.join(tempDir, "relay.db");
    const registry = new RelayProviderRegistry();
    const provider = new TestProvider(PROVIDER_ID);
    registry.register(provider, ACCOUNT_ID);
    const firstDatabase = new RelayDatabase(databasePath);
    const first = new RelayExperienceCoordinator({
      registry,
      database: firstDatabase,
      now: () => NOW_MS,
    });
    first.bindings.upsert({
      bindingId: "binding-deleted-session",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "deleted-session-group",
      localConversationId: "deleted-session",
      role: "session",
    });

    expect(first.tombstoneSessionAccessPoints("deleted-session")).toHaveLength(1);
    expect(first.getSessionContext("deleted-session")).toBeUndefined();
    firstDatabase.close();

    const secondDatabase = new RelayDatabase(databasePath);
    const restored = new RelayExperienceCoordinator({
      registry,
      database: secondDatabase,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    await restored.start();

    expect(provider.retired).toContain("deleted-session-group");
    expect(restored.bindings.listRetirements()).toEqual([]);
    expect(restored.getSessionContext("deleted-session")).toBeUndefined();
    await restored.stop();
    secondDatabase.close();
  });

  it("retires old-scope bindings through the current startup account", async () => {
    const provider = new TestProvider(PROVIDER_ID);
    const retiredAccounts: string[] = [];
    vi.spyOn(provider.conversations, "retire").mockImplementation(async (address) => {
      retiredAccounts.push(address.accountId);
      provider.retired.push(address.conversationId);
    });
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    coordinator.bindings.upsert({
      bindingId: "old-account-binding",
      provider: PROVIDER_ID,
      accountId: "old-account",
      externalConversationId: "old-account-group",
      localConversationId: "old-account-session",
      role: "session",
    });

    expect(coordinator.tombstoneBindingsOutsideAccount(PROVIDER_ID, ACCOUNT_ID)).toHaveLength(1);
    await coordinator.start();

    expect(retiredAccounts).toEqual([ACCOUNT_ID]);
    expect(provider.retired).toEqual(["old-account-group"]);
    expect(coordinator.bindings.listRetirements()).toEqual([]);
    await coordinator.stop();
    database.close();
  });

  it("keeps a stale binding when reopen activity queues during remote retirement", async () => {
    let now = 8 * 24 * 60 * 60_000;
    const provider = new TestProvider(PROVIDER_ID);
    const retireStarted = deferred<void>();
    const releaseRetire = deferred<void>();
    vi.spyOn(provider.conversations, "retire").mockImplementation(async (address) => {
      provider.retired.push(address.conversationId);
      retireStarted.resolve(undefined);
      await releaseRetire.promise;
    });
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => now,
      staleThresholdMs: 7 * 24 * 60 * 60_000,
      maintenanceIntervalMs: 60 * 60_000,
    });
    let ensureCalls = 0;
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async () => "unused",
        ensureSessionAccessPoint: async () => {
          ensureCalls += 1;
          return ensuredAccessPoint(
            {
              providerId: PROVIDER_ID,
              accountId: ACCOUNT_ID,
              conversationId: parseRelayConversationId("conversation-race-reopened"),
            },
            "binding-race",
            "session-race",
          );
        },
      },
    );
    coordinator.bindings.upsert({
      bindingId: "binding-race",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "conversation-race",
      localConversationId: "session-race",
      role: "session",
      updatedAtMs: 0,
    });

    const maintenance = coordinator.runMaintenanceNow();
    await retireStarted.promise;
    const reopen = coordinator.ensureSessionAccessPoint(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        sessionId: "session-race",
        displayName: "Session race",
        idempotencyKey: "reopen-race",
        requestedAt: new Date(now).toISOString(),
      },
    );
    releaseRetire.resolve(undefined);
    await maintenance;
    await reopen;

    expect(ensureCalls).toBe(1);
    expect(provider.retired).toEqual(["conversation-race"]);
    expect(coordinator.getSessionContext("session-race")).toBeDefined();
    expect(
      coordinator.getSessionContext("session-race")?.accessPoints[0]?.address.conversationId,
    ).toBe("conversation-race-reopened");
    expect(coordinator.bindings.getActivity("binding-race")?.lastSessionActivityAtMs).toBe(now);
    now += 1;
    await coordinator.runMaintenanceNow();
    expect(provider.retired).toEqual(["conversation-race"]);
    database.close();
  });

  it("retains the retirement tombstone when a queued reopen fails after remote retirement", async () => {
    const provider = new TestProvider(PROVIDER_ID);
    const retireStarted = deferred<void>();
    const releaseRetire = deferred<void>();
    vi.spyOn(provider.conversations, "retire").mockImplementation(async (address) => {
      provider.retired.push(address.conversationId);
      retireStarted.resolve(undefined);
      await releaseRetire.promise;
    });
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => 8 * 24 * 60 * 60_000,
      staleThresholdMs: 7 * 24 * 60 * 60_000,
      maintenanceIntervalMs: 60 * 60_000,
    });
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async () => "unused",
        ensureSessionAccessPoint: async () => {
          throw new Error("remote reopen failed");
        },
      },
    );
    coordinator.bindings.upsert({
      bindingId: "binding-failed-reopen",
      provider: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      externalConversationId: "conversation-failed-reopen",
      localConversationId: "session-failed-reopen",
      role: "session",
      updatedAtMs: 0,
    });

    const maintenance = coordinator.runMaintenanceNow();
    await retireStarted.promise;
    const reopen = coordinator.ensureSessionAccessPoint(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        sessionId: "session-failed-reopen",
        displayName: "Failed reopen",
        idempotencyKey: "failed-reopen",
        requestedAt: "2026-08-09T04:25:00.000Z",
      },
    );
    releaseRetire.resolve(undefined);

    await maintenance;
    await expect(reopen).rejects.toThrow("remote reopen failed");
    expect(provider.retired).toEqual(["conversation-failed-reopen"]);
    expect(coordinator.bindings.getById("binding-failed-reopen")).toBeUndefined();
    expect(coordinator.bindings.getRetirement("binding-failed-reopen")).toBeDefined();
    expect(coordinator.getSessionContext("session-failed-reopen")).toBeUndefined();
    database.close();
  });

  it("allows an inbound runtime to publish a same-address reply without re-entering the queue", async () => {
    const provider = new TestProvider(PROVIDER_ID);
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    const address = {
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      conversationId: parseRelayConversationId("information-control@g.us"),
    };
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async (event) => {
          await coordinator.publishNow({
            intent: "deliberate",
            idempotencyKey: "same-address-reply",
            correlationId: "same-address-reply",
            requestedAt: event.occurredAt,
            request: {
              publicationId: "same-address-reply",
              address,
              kind: "reply",
              text: "Reply from the fixed agent",
            },
          });
          return "same-address-local-message";
        },
      },
    );
    await coordinator.start();

    await provider.emit({
      type: "message-received",
      providerId: PROVIDER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: "2026-08-08T12:00:00.000Z",
      message: {
        address,
        providerMessageId: parseRelayMessageId("same-address-inbound"),
        sender: { primaryId: "owner" },
        sentAt: "2026-08-08T12:00:00.000Z",
        receivedAt: "2026-08-08T12:00:00.000Z",
        text: "Reply now",
        attachments: [],
      },
    });

    expect(provider.publications).toHaveLength(1);
    expect(provider.publications[0]).toMatchObject({
      publicationId: "same-address-reply",
      address,
    });
    await coordinator.stop();
    database.close();
  });

  it("releases address serialization before long-running account dispatch", async () => {
    const provider = new TestProvider(PROVIDER_ID);
    const registry = new RelayProviderRegistry();
    registry.register(provider, ACCOUNT_ID);
    const database = new RelayDatabase(":memory:");
    const coordinator = new RelayExperienceCoordinator({
      registry,
      database,
      now: () => NOW_MS,
      maintenanceIntervalMs: 60 * 60_000,
    });
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const routed: string[] = [];
    coordinator.registerAccountRuntime(
      { providerId: PROVIDER_ID, accountId: ACCOUNT_ID },
      {
        start: async () => undefined,
        stop: async () => undefined,
        routeInbound: async (event) => {
          const text = event.message.text ?? "";
          routed.push(text);
          if (text === "long-running") {
            firstStarted.resolve(undefined);
            await releaseFirst.promise;
          }
          return `local-${event.message.providerMessageId}`;
        },
      },
    );
    await coordinator.start();

    const active = provider.emit(inboundEvent(ACCOUNT_ID, "chat-active", "long-running"));
    await firstStarted.promise;
    const controls = ["/cancel", "/status", "/new follow-up", "ordinary busy message"];
    await Promise.all(
      controls.map((text, index) =>
        provider.emit(inboundEvent(ACCOUNT_ID, `chat-control-${index}`, text)),
      ),
    );

    expect(routed).toEqual(["long-running", ...controls]);
    releaseFirst.resolve(undefined);
    await active;
    await coordinator.stop();
    database.close();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function inboundEvent(
  accountId: RelayAccountId,
  providerMessageId: string,
  text = "Recover me",
): RelayInboundMessageEvent {
  return {
    type: "message-received",
    providerId: PROVIDER_ID,
    accountId,
    occurredAt: "2026-08-08T12:00:00.000Z",
    message: {
      address: {
        providerId: PROVIDER_ID,
        accountId,
        conversationId: parseRelayConversationId(`conversation-${accountId}`),
      },
      providerMessageId: parseRelayMessageId(providerMessageId),
      sender: { primaryId: "owner" },
      sentAt: "2026-08-08T12:00:00.000Z",
      receivedAt: "2026-08-08T12:00:00.000Z",
      text,
      attachments: [],
    },
  };
}

function ensuredAccessPoint(
  address: RelayPublishRequest["address"],
  bindingId: string,
  sessionId: string,
): RelayEnsuredSessionAccessPoint {
  return testDouble<RelayEnsuredSessionAccessPoint>({
    group: testDouble<RelayEnsuredSessionAccessPoint["group"]>({ address }),
    binding: testDouble<RelayEnsuredSessionAccessPoint["binding"]>({
      bindingId,
      group: address,
      role: "session",
      sessionId,
    }),
    disposition: "reopened",
  });
}

class TestProvider implements RelayProvider {
  readonly publications: RelayPublishRequest[] = [];
  readonly retired: string[] = [];
  private readonly listeners = new Set<RelayProviderEventListener>();
  readonly conversations = {
    list: async () => [],
    retire: async (address: RelayPublishRequest["address"]) => {
      this.retired.push(address.conversationId);
    },
  };

  constructor(readonly providerId: RelayProviderId) {}

  capabilities(_accountId: RelayAccountId): RelayProviderCapabilities {
    return CAPABILITIES;
  }

  async connect(_accountId: RelayAccountId): Promise<void> {}

  async disconnect(_accountId: RelayAccountId): Promise<void> {}

  async status(_accountId: RelayAccountId): Promise<RelayConnectionStatus> {
    return { state: "connected", updatedAt: "2026-08-08T12:00:00.000Z" };
  }

  async publish(request: RelayPublishRequest): Promise<RelayPublishReceipt> {
    this.publications.push(request);
    return {
      publicationId: request.publicationId,
      providerMessageId: parseRelayMessageId(`published-${this.publications.length}`),
      publishedAt: "2026-08-08T12:00:00.000Z",
    };
  }

  subscribe(_listener: RelayProviderEventListener): () => void {
    this.listeners.add(_listener);
    return () => {
      this.listeners.delete(_listener);
    };
  }

  async emit(event: RelayProviderEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}
