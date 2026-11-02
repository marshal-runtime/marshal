import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionMetadata } from "../../../../common/marshal-ipc-contract";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAddress,
  type RelayAttachment,
} from "../../../../common/relay-contract";
import type { RelayPublicationIntent } from "../../../../common/relay-experience-contract";
import type { PermissionPolicy } from "../../../permission-policy";
import type { SessionManager } from "../../../sessions";
import { testDouble } from "../../../testing/harness";
import { RelayBindingStore } from "../../bindings";
import type { RelayInboundMessageEvent, RelayPublishReceipt } from "../../contracts";
import type { RelayHostExperiencePorts } from "../../host-experience/types";
import type { RelayHostMediaAdapter } from "../../host-media-adapter";
import { RelayDatabase } from "../../relay-database";
import { WhatsAppFixedAgentRuntime } from "./fixed-agent-runtime";
import { WhatsAppFixedAgentStore } from "./fixed-agent-store";
import { createLiveWhatsAppProviderComposition } from "./live-composition";
import type { WhatsAppManagedGroupIds, WhatsAppService } from "./service";

type RelayTopologyPort = RelayHostExperiencePorts["topology"];
type RuntimeOptions = ConstructorParameters<typeof WhatsAppFixedAgentRuntime>[0];

const ACCOUNT = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: parseRelayAccountId("primary"),
};
const NOW = "2026-08-08T12:00:00.000Z";
const TARGET_SESSION_ID = "session-cursor-swarm";
const TARGET_TITLE = "Cursor swarm setup";
const SECOND_SESSION_ID = "session-unrelated";
const INBOUND_MESSAGE_ID = parseRelayMessageId("whatsapp-user-message");
const MANAGED_GROUPS: WhatsAppManagedGroupIds = {
  community: "community@g.us",
  fixed: {
    "new-chats": "new-chats@g.us",
    progress: "progress@g.us",
    "information-control": "information@g.us",
  },
};

interface RuntimeHarness {
  readonly runtime: WhatsAppFixedAgentRuntime;
  readonly relayDatabase: RelayDatabase;
  readonly bindings: RelayBindingStore;
  readonly ensureSessionGroup: EnsureSessionGroupMock;
  readonly publications: RelayPublicationIntent[];
  readonly publicationAttempts: RelayPublicationIntent[];
  readonly relayDeliveries: Array<Parameters<SessionManager["sendRelayMessageToSession"]>[0]>;
  readonly deliveryOrder: string[];
  readonly deliveredAttachments: Array<
    Array<{ type: "file" | "directory"; path: string; displayName?: string }> | undefined
  >;
  readonly releaseMedia: RuntimeOptions["media"]["release"];
  readonly getSession: ReturnType<typeof vi.fn<SessionManager["getSession"]>>;
  readonly getSessionAsync: ReturnType<typeof vi.fn<SessionManager["getSessionAsync"]>>;
  readonly persistedSessionGroups: Set<string>;
  setTargetCold(): void;
}

interface CreateHarnessOptions {
  readonly account?: RuntimeOptions["account"];
  readonly targetBusy?: boolean;
  readonly relayDatabasePath?: string;
  readonly runtimeDatabasePath?: string;
  readonly persistedSessionGroups?: Set<string>;
  readonly sessions?: Map<string, SessionMetadata>;
  readonly relayAcceptanceError?: Error;
  readonly targetSend?: (
    attachments: Parameters<SessionManager["sendAndCollect"]>[4],
  ) => ReturnType<SessionManager["sendAndCollect"]>;
  readonly fixedAgentSend?: () => ReturnType<SessionManager["sendAndCollect"]>;
  readonly publicationState?: PublicationState;
}

interface PublicationState {
  readonly publications: RelayPublicationIntent[];
  readonly attempts: RelayPublicationIntent[];
  readonly receipts: Map<string, RelayPublishReceipt>;
}

type EnsureSessionGroupMock = ReturnType<typeof createEnsureSessionGroupMock>;

let tempDirectory: string;
let harness: RuntimeHarness | undefined;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-fixed-agent-runtime-"));
});

afterEach(async () => {
  if (harness) {
    await harness.runtime.dispose();
    harness.relayDatabase.close();
    harness = undefined;
  }
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("WhatsAppFixedAgentRuntime session-group inbound routing", () => {
  it("durably interrupts the busy owning session after dynamic group binding", async () => {
    harness = createHarness();
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm",
      requestedAt: NOW,
    });

    expect(
      harness.bindings.getByExternalConversation(
        ACCOUNT.providerId,
        ACCOUNT.accountId,
        accessPoint.group.address.conversationId,
      )?.localConversationId,
    ).toBe(TARGET_SESSION_ID);

    await expect(
      harness.runtime.routeInbound(inboundEvent(accessPoint.group.address), {
        correlationId: "inbound-correlation",
        idempotencyKey: "inbound-idempotency",
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({
      sessionId: TARGET_SESSION_ID,
    });
    expect(harness.relayDeliveries).toHaveLength(1);
    expect(harness.relayDeliveries[0]).toMatchObject({
      sessionId: TARGET_SESSION_ID,
      deliveryMode: "interrupt",
      idempotencyKey: expect.any(String),
      source: {
        providerId: ACCOUNT.providerId,
        accountId: ACCOUNT.accountId,
        conversationId: accessPoint.group.address.conversationId,
        providerMessageId: INBOUND_MESSAGE_ID,
      },
    });
    expect(harness.relayDeliveries[0]?.message).toContain("publishRelayMessage");
    expect(harness.relayDeliveries[0]?.message).toContain("Please adjust the running task.");
    expect(harness.deliveryOrder).toEqual([]);
    expect(harness.publications).toEqual([]);
  });

  it("reopens provider state without cancelling the shared retirement tombstone", async () => {
    harness = createHarness();
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-before-retirement",
      requestedAt: NOW,
    });
    harness.bindings.prepareRetirement(accessPoint.binding.bindingId, Date.parse(NOW));
    harness.persistedSessionGroups.delete(accessPoint.group.address.conversationId);

    await expect(
      harness.runtime.ensureSessionAccessPoint({
        sessionId: TARGET_SESSION_ID,
        displayName: TARGET_TITLE,
        idempotencyKey: "reopen-after-retirement",
        requestedAt: NOW,
      }),
    ).resolves.toMatchObject({
      binding: { bindingId: accessPoint.binding.bindingId },
    });
    expect(harness.bindings.getRetirement(accessPoint.binding.bindingId)).toBeDefined();
    expect(harness.bindings.getById(accessPoint.binding.bindingId)).toBeUndefined();
  });

  it("preserves media delivery and cleanup while interrupting the owning session", async () => {
    harness = createHarness();
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm-media",
      requestedAt: NOW,
    });
    const attachment: RelayAttachment = {
      id: "image-1",
      kind: "image",
      mimeType: "image/png",
      fileName: "screenshot.png",
      sizeBytes: 128,
      storageKey: "stored-image-1",
      sha256: "image-sha256",
    };

    const routed = await harness.runtime.routeInbound(
      inboundEvent(accessPoint.group.address, [attachment]),
      {
        correlationId: "media-inbound-correlation",
        idempotencyKey: "media-inbound-idempotency",
        acceptedAt: NOW,
      },
    );
    await routed.afterCommit?.();

    expect(harness.deliveryOrder).toEqual([`interrupt:${TARGET_SESSION_ID}`, "send:idle"]);
    expect(harness.deliveredAttachments).toEqual([
      [
        {
          type: "file",
          path: path.join(tempDirectory, "restored", "screenshot.png"),
          displayName: "screenshot.png",
        },
      ],
    ]);
    expect(harness.releaseMedia).toHaveBeenCalledOnce();
    expect(harness.publications).toEqual([]);
  });

  it("retains attachment media without blocking unrelated host operations", async () => {
    const pendingTurn = deferred<Awaited<ReturnType<SessionManager["sendAndCollect"]>>>();
    harness = createHarness({
      targetSend: () => pendingTurn.promise,
    });
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm-pending-media",
      requestedAt: NOW,
    });
    const attachment: RelayAttachment = {
      id: "image-pending",
      kind: "image",
      mimeType: "image/png",
      fileName: "pending.png",
      sizeBytes: 256,
      storageKey: "stored-image-pending",
      sha256: "pending-image-sha256",
    };

    let routingSettled = false;
    const routing = harness.runtime
      .routeInbound(inboundEvent(accessPoint.group.address, [attachment]), {
        correlationId: "pending-media-correlation",
        idempotencyKey: "pending-media-idempotency",
        acceptedAt: NOW,
      })
      .finally(() => {
        routingSettled = true;
      });
    await vi.waitFor(() => expect(harness?.deliveryOrder).toContain("send:idle"));

    const unrelatedAccessPoint = harness.runtime.ensureSessionAccessPoint({
      sessionId: SECOND_SESSION_ID,
      displayName: "Unrelated session",
      idempotencyKey: "open-unrelated-session",
      requestedAt: NOW,
    });
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    const unrelatedOutcome = await Promise.race([
      unrelatedAccessPoint.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => {
        blockedTimer = setTimeout(() => resolve("blocked"), 1_000);
      }),
    ]);
    if (blockedTimer) clearTimeout(blockedTimer);
    const routingWasPending = !routingSettled;
    const releaseCountWhilePending = vi.mocked(harness.releaseMedia).mock.calls.length;

    pendingTurn.resolve({ kind: "ok", text: "Attachment turn response" });
    const [routed] = await Promise.all([routing, unrelatedAccessPoint]);

    expect(unrelatedOutcome).toBe("completed");
    expect(routingWasPending).toBe(true);
    expect(releaseCountWhilePending).toBe(0);
    expect(harness.deliveredAttachments).toEqual([
      [
        {
          type: "file",
          path: path.join(tempDirectory, "restored", "pending.png"),
          displayName: "pending.png",
        },
      ],
    ]);
    expect(harness.releaseMedia).not.toHaveBeenCalled();
    await routed.afterCommit?.();
    expect(harness.releaseMedia).toHaveBeenCalledOnce();
  });

  it("hydrates a cold durable session before routing its bound inbound message", async () => {
    harness = createHarness({ targetBusy: false });
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm-cold",
      requestedAt: NOW,
    });
    harness.setTargetCold();

    await expect(
      harness.runtime.routeInbound(inboundEvent(accessPoint.group.address), {
        correlationId: "cold-inbound-correlation",
        idempotencyKey: "cold-inbound-idempotency",
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({
      sessionId: TARGET_SESSION_ID,
    });
    expect(harness.getSessionAsync).toHaveBeenCalledWith(TARGET_SESSION_ID);
    expect(harness.relayDeliveries).toHaveLength(1);
    expect(harness.deliveryOrder).toEqual([]);
  });

  it("does not publish a generic failure before durable delivery reaches a terminal state", async () => {
    const steeringError = new Error("Owning session rejected interrupt steering");
    harness = createHarness({ relayAcceptanceError: steeringError });
    await harness.runtime.initialize();
    const accessPoint = await harness.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm-rejected",
      requestedAt: NOW,
    });

    await expect(
      harness.runtime.routeInbound(inboundEvent(accessPoint.group.address), {
        correlationId: "rejected-inbound-correlation",
        idempotencyKey: "rejected-inbound-idempotency",
        acceptedAt: NOW,
      }),
    ).rejects.toThrow(steeringError.message);

    expect(harness.publications).toEqual([]);
  });

  it("replays a pending claimed message after failure and releases media only after commit", async () => {
    const relayDatabasePath = path.join(tempDirectory, "relay-claimed-retry.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime-claimed-retry.db");
    const persistedSessionGroups = new Set<string>();
    const first = createHarness({
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
      targetSend: async () => {
        throw new Error("downstream dispatch failed");
      },
    });
    harness = first;
    await first.runtime.initialize();
    const accessPoint = await first.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-claimed-retry",
      requestedAt: NOW,
    });
    const attachment: RelayAttachment = {
      id: "claimed-retry-image",
      kind: "image",
      mimeType: "image/png",
      fileName: "retry.png",
      sizeBytes: 128,
      storageKey: "claimed-retry-storage",
      sha256: "claimed-retry-sha256",
    };
    const event = inboundEvent(accessPoint.group.address, [attachment]);

    await expect(
      first.runtime.routeInbound(event, {
        correlationId: "claimed-retry-first",
        idempotencyKey: "claimed-retry",
        acceptedAt: NOW,
      }),
    ).rejects.toThrow("downstream dispatch failed");
    expect(first.deliveredAttachments).toHaveLength(1);
    expect(first.releaseMedia).not.toHaveBeenCalled();
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const restored = createHarness({
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
    });
    harness = restored;
    await restored.runtime.initialize();
    const recovered = await restored.runtime.routeInbound(event, {
      correlationId: "claimed-retry-recovered",
      idempotencyKey: "claimed-retry",
      acceptedAt: NOW,
    });

    expect(restored.deliveredAttachments).toHaveLength(1);
    expect(restored.releaseMedia).not.toHaveBeenCalled();
    await recovered.afterCommit?.();
    expect(restored.releaseMedia).toHaveBeenCalledOnce();

    const duplicate = await restored.runtime.routeInbound(event, {
      correlationId: "claimed-retry-duplicate",
      idempotencyKey: "claimed-retry",
      acceptedAt: NOW,
    });
    expect(restored.deliveredAttachments).toHaveLength(1);
    await duplicate.afterCommit?.();
    expect(restored.releaseMedia).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a successful fixed-agent reply across crash replay before claim completion", async () => {
    const publicationState = createPublicationState();
    const event = inboundEvent({
      ...ACCOUNT,
      conversationId: parseRelayConversationId(MANAGED_GROUPS.fixed["information-control"]),
    });
    const first = createHarness({
      runtimeDatabasePath: path.join(tempDirectory, "success-claim-before-crash.db"),
      publicationState,
    });
    harness = first;
    await first.runtime.initialize();
    await first.runtime.routeInbound(event, {
      correlationId: "success-before-crash",
      idempotencyKey: "success-before-crash",
      acceptedAt: NOW,
    });
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const replayed = createHarness({
      runtimeDatabasePath: path.join(tempDirectory, "success-claim-after-crash.db"),
      publicationState,
    });
    harness = replayed;
    await replayed.runtime.initialize();
    await replayed.runtime.routeInbound(event, {
      correlationId: "success-after-crash",
      idempotencyKey: "success-after-crash",
      acceptedAt: NOW,
    });

    expect(publicationState.attempts).toHaveLength(2);
    expect(publicationState.publications).toHaveLength(1);
    expect(publicationState.attempts[0]?.request.publicationId).toBe(
      publicationState.attempts[1]?.request.publicationId,
    );
    expect(publicationState.publications[0]?.request.publicationId).toContain(
      "whatsapp-fixed-agent:success:",
    );
  });

  it("deduplicates a fixed-agent error reply across restart replay", async () => {
    const publicationState = createPublicationState();
    const event = inboundEvent({
      ...ACCOUNT,
      conversationId: parseRelayConversationId(MANAGED_GROUPS.fixed.progress),
    });
    const failTurn = async () => {
      throw new Error("fixed agent failed");
    };
    const first = createHarness({
      runtimeDatabasePath: path.join(tempDirectory, "error-claim-before-crash.db"),
      publicationState,
      fixedAgentSend: failTurn,
    });
    harness = first;
    await first.runtime.initialize();
    await expect(
      first.runtime.routeInbound(event, {
        correlationId: "error-before-crash",
        idempotencyKey: "error-before-crash",
        acceptedAt: NOW,
      }),
    ).rejects.toThrow("fixed agent failed");
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const replayed = createHarness({
      runtimeDatabasePath: path.join(tempDirectory, "error-claim-after-crash.db"),
      publicationState,
      fixedAgentSend: failTurn,
    });
    harness = replayed;
    await replayed.runtime.initialize();
    await expect(
      replayed.runtime.routeInbound(event, {
        correlationId: "error-after-crash",
        idempotencyKey: "error-after-crash",
        acceptedAt: NOW,
      }),
    ).rejects.toThrow("fixed agent failed");

    expect(publicationState.attempts).toHaveLength(2);
    expect(publicationState.publications).toHaveLength(1);
    expect(publicationState.attempts[0]?.request.publicationId).toBe(
      publicationState.attempts[1]?.request.publicationId,
    );
    expect(publicationState.publications[0]?.request.publicationId).toContain(
      "whatsapp-fixed-agent:error:",
    );
  });

  it("re-registers a persisted session group through topology before restored inbound routing", async () => {
    const relayDatabasePath = path.join(tempDirectory, "relay.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime.db");
    const first = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
    });
    harness = first;
    await first.runtime.initialize();
    const accessPoint = await first.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-cursor-swarm-persisted",
      requestedAt: NOW,
    });
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const restored = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
    });
    harness = restored;
    await restored.runtime.initialize();

    expect(restored.ensureSessionGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        existingConversationId: accessPoint.group.address.conversationId,
      }),
    );
    await expect(
      restored.runtime.routeInbound(inboundEvent(accessPoint.group.address), {
        correlationId: "restored-inbound-correlation",
        idempotencyKey: "restored-inbound-idempotency",
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({
      sessionId: TARGET_SESSION_ID,
    });
    expect(restored.relayDeliveries).toHaveLength(1);
    expect(restored.deliveryOrder).toEqual([]);
  });

  it("uses the configured startup account throughout the fixed-agent runtime", async () => {
    const account = {
      providerId: ACCOUNT.providerId,
      accountId: parseRelayAccountId("restart-applied"),
    };
    const relayDatabasePath = path.join(tempDirectory, "relay-account-change.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime-account-change.db");
    const persistedSessionGroups = new Set<string>();
    const sessions = new Map<string, SessionMetadata>();
    const first = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
      sessions,
    });
    harness = first;
    await first.runtime.initialize();
    const accessPoint = await first.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "custom-account-access-point",
      requestedAt: NOW,
    });
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const restored = createHarness({
      account,
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
      sessions,
    });
    harness = restored;
    await restored.runtime.initialize();
    const restoredAddress = {
      ...account,
      conversationId: accessPoint.group.address.conversationId,
    };

    expect(sessions.size).toBe(5);
    expect(
      restored.bindings.getByExternalConversation(
        account.providerId,
        account.accountId,
        restoredAddress.conversationId,
      )?.bindingId,
    ).toBe(accessPoint.binding.bindingId);
    expect(
      restored.bindings.getByExternalConversation(
        ACCOUNT.providerId,
        ACCOUNT.accountId,
        restoredAddress.conversationId,
      ),
    ).toBeUndefined();
    await expect(
      restored.runtime.routeInbound(inboundEvent(restoredAddress), {
        correlationId: "custom-account-inbound",
        idempotencyKey: "custom-account-inbound",
        acceptedAt: NOW,
      }),
    ).resolves.toMatchObject({ sessionId: TARGET_SESSION_ID });
    expect(restored.relayDeliveries[0]?.source).toMatchObject(account);
  });

  it("moves the authoritative shared binding when reconnect replaces a missing group", async () => {
    const relayDatabasePath = path.join(tempDirectory, "relay-replaced.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime-replaced.db");
    const persistedSessionGroups = new Set<string>();
    const first = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
    });
    harness = first;
    await first.runtime.initialize();
    const accessPoint = await first.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-replaced-access-point",
      requestedAt: NOW,
    });
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const restored = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
    });
    harness = restored;
    restored.ensureSessionGroup.mockImplementationOnce(async (request) => {
      const replacementId = "replacement-session@g.us";
      if (request.existingConversationId) {
        persistedSessionGroups.delete(request.existingConversationId);
      }
      persistedSessionGroups.add(replacementId);
      return {
        type: "ensure-session-group",
        conversationId: replacementId,
        displayName: request.displayName,
        communityConversationId: request.communityConversationId,
        disposition: "reopened",
      };
    });
    await restored.runtime.initialize();

    expect(restored.bindings.getById(accessPoint.binding.bindingId)?.externalConversationId).toBe(
      "replacement-session@g.us",
    );
    expect(
      restored.bindings.getByExternalConversation(
        ACCOUNT.providerId,
        ACCOUNT.accountId,
        accessPoint.group.address.conversationId,
      ),
    ).toBeUndefined();
  });

  it("does not migrate a legacy access point after its sidecar mapping was retired", async () => {
    const relayDatabasePath = path.join(tempDirectory, "relay-upgrade-retired.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime-upgrade-retired.db");
    const legacyStore = new WhatsAppFixedAgentStore(runtimeDatabasePath);
    legacyStore.upsertSession({
      idempotencyKey: "legacy-retired-session",
      sessionId: TARGET_SESSION_ID,
      kind: "conversation",
      groupId: "retired-before-upgrade@g.us",
      title: TARGET_TITLE,
      priority: "foreground",
      createdAt: NOW,
      updatedAt: NOW,
    });
    legacyStore.upsertBinding({
      bindingId: "legacy-retired-binding",
      groupId: "retired-before-upgrade@g.us",
      role: "session",
      sessionId: TARGET_SESSION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    legacyStore.close();

    harness = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups: new Set(),
    });
    await harness.runtime.initialize();

    expect(harness.ensureSessionGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({ existingConversationId: "retired-before-upgrade@g.us" }),
    );
    expect(
      harness.bindings.getByExternalConversation(
        ACCOUNT.providerId,
        ACCOUNT.accountId,
        "retired-before-upgrade@g.us",
      ),
    ).toBeUndefined();
    expect(harness.getSession(TARGET_SESSION_ID)).not.toBeNull();
  });

  it("does not recreate a retired access point after restart", async () => {
    const relayDatabasePath = path.join(tempDirectory, "relay-retired.db");
    const runtimeDatabasePath = path.join(tempDirectory, "runtime-retired.db");
    const persistedSessionGroups = new Set<string>();
    const first = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
    });
    harness = first;
    await first.runtime.initialize();
    const accessPoint = await first.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "open-retired-access-point",
      requestedAt: NOW,
    });
    persistedSessionGroups.delete(accessPoint.group.address.conversationId);
    first.bindings.remove(accessPoint.binding.bindingId);
    await first.runtime.dispose();
    first.relayDatabase.close();
    harness = undefined;

    const restored = createHarness({
      targetBusy: false,
      relayDatabasePath,
      runtimeDatabasePath,
      persistedSessionGroups,
    });
    harness = restored;
    await restored.runtime.initialize();

    expect(restored.ensureSessionGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({
        existingConversationId: accessPoint.group.address.conversationId,
      }),
    );
    expect(restored.getSession(TARGET_SESSION_ID)).not.toBeNull();

    restored.ensureSessionGroup.mockClear();
    await restored.runtime.ensureSessionAccessPoint({
      sessionId: TARGET_SESSION_ID,
      displayName: TARGET_TITLE,
      idempotencyKey: "reopen-retired-access-point",
      requestedAt: NOW,
    });
    expect(restored.ensureSessionGroup).toHaveBeenCalledWith(
      expect.not.objectContaining({
        existingConversationId: accessPoint.group.address.conversationId,
      }),
    );
  });
});

function createHarness(options: CreateHarnessOptions = {}): RuntimeHarness {
  const account = options.account ?? ACCOUNT;
  const relayDatabase = new RelayDatabase(options.relayDatabasePath ?? ":memory:");
  const bindings = new RelayBindingStore(relayDatabase);
  const persistedSessionGroups = options.persistedSessionGroups ?? new Set<string>();
  const publicationState = options.publicationState ?? createPublicationState();
  const publications = publicationState.publications;
  const relayDeliveries: RuntimeHarness["relayDeliveries"] = [];
  const deliveryOrder: string[] = [];
  const deliveredAttachments: RuntimeHarness["deliveredAttachments"] = [];
  const sessions = options.sessions ?? new Map<string, SessionMetadata>();
  let targetBusy = options.targetBusy ?? true;
  let targetCold = false;
  const targetSession = sessionMetadata(TARGET_SESSION_ID, TARGET_TITLE, targetBusy);
  sessions.set(targetSession.id, targetSession);
  sessions.set(SECOND_SESSION_ID, sessionMetadata(SECOND_SESSION_ID, "Unrelated session", false));
  let fixedSessionSequence = 0;

  const getSession = vi.fn<SessionManager["getSession"]>((sessionId) => {
    if (sessionId === TARGET_SESSION_ID && targetCold) return null;
    const session = sessions.get(sessionId);
    return session
      ? {
          ...session,
          messages: [],
        }
      : null;
  });
  const getSessionAsync = vi.fn<SessionManager["getSessionAsync"]>(async (sessionId) => {
    if (sessionId === TARGET_SESSION_ID) targetCold = false;
    const session = sessions.get(sessionId);
    return session
      ? {
          ...session,
          messages: [],
        }
      : null;
  });
  const sessionManager = testDouble<SessionManager>({
    createSession: vi.fn<SessionManager["createSession"]>(
      async (_model, _soul, creationOptions) => {
        const session = sessionMetadata(
          `fixed-session-${++fixedSessionSequence}`,
          creationOptions?.name ?? "Relay",
          false,
        );
        sessions.set(session.id, session);
        return session;
      },
    ),
    getSession,
    getSessionAsync,
    listSessions: vi.fn<SessionManager["listSessions"]>(async () => [...sessions.values()]),
    isSessionBusy: vi.fn<SessionManager["isSessionBusy"]>(
      (sessionId) => sessionId === TARGET_SESSION_ID && targetBusy,
    ),
    sendAndCollect: vi.fn<SessionManager["sendAndCollect"]>(
      async (_text, _timeout, _onEvent, sessionId, attachments, sendOptions) => {
        if (sessionId === TARGET_SESSION_ID) {
          if (sendOptions?.deliveryMode === "interrupt" && targetBusy) {
            deliveryOrder.push(`interrupt:${sessionId}`);
            targetBusy = false;
          }
          deliveryOrder.push(targetBusy ? "send:busy" : "send:idle");
          deliveredAttachments.push(attachments);
          if (targetBusy) throw new Error("Another message or turn is already active");
          if (options.targetSend) return await options.targetSend(attachments);
          return { kind: "ok" as const, text: "Owning session response" };
        }
        if (options.fixedAgentSend) return await options.fixedAgentSend();
        return { kind: "ok" as const, text: "Fixed agent response" };
      },
    ),
    sendRelayMessageToSession: vi.fn<SessionManager["sendRelayMessageToSession"]>(async (input) => {
      relayDeliveries.push(input);
      if (options.relayAcceptanceError) {
        return {
          success: false,
          accepted: false,
          error: options.relayAcceptanceError.message,
        };
      }
      return {
        success: true,
        accepted: true,
        messageId: `relay-message-${relayDeliveries.length}`,
        deliveryState: "accepted",
      };
    }),
    configureExclusiveSessionRuntime: vi.fn<SessionManager["configureExclusiveSessionRuntime"]>(
      async () => undefined,
    ),
    clearExclusiveSessionRuntime: vi.fn<SessionManager["clearExclusiveSessionRuntime"]>(),
  });
  const permissionPolicy = testDouble<PermissionPolicy>({
    registerSessionPermissions: vi.fn<PermissionPolicy["registerSessionPermissions"]>(),
    unregisterSessionPermissions: vi.fn<PermissionPolicy["unregisterSessionPermissions"]>(),
    setDenyPrompt: vi.fn<PermissionPolicy["setDenyPrompt"]>(),
    clearDenyPrompt: vi.fn<PermissionPolicy["clearDenyPrompt"]>(),
    markUnattended: vi.fn<PermissionPolicy["markUnattended"]>(),
  });
  const ensureSessionGroup = createEnsureSessionGroupMock(persistedSessionGroups);
  const service = testDouble<WhatsAppService>({
    getManagedGroupIds: () => MANAGED_GROUPS,
    getStatus: () => testDouble({ connection: "connected" }),
    subscribeStatus: () => () => undefined,
    getConnectedIdentityId: () => "15551234567@s.whatsapp.net",
    hasPersistedSessionGroup: (conversationId: string) =>
      persistedSessionGroups.has(conversationId),
    ensureSessionGroup,
  });
  const composition = createLiveWhatsAppProviderComposition({
    service,
    hostMedia: testDouble<RelayHostMediaAdapter>({}),
    accountId: account.accountId,
    now: () => NOW,
  });
  const topology: RelayTopologyPort = {
    provision: (request) => composition.communityProvisioning.provision(request),
    getTopology: (requestedAccount) => composition.topology.getTopology(requestedAccount),
    getGroup: (address) => composition.topology.getGroup(address),
    createGroup: (request) => composition.managedGroupAdministration.createGroup(request),
    renameGroup: (request) => composition.managedGroupAdministration.renameGroup(request),
    retireGroup: (request) => composition.managedGroupAdministration.retireGroup(request),
  };
  const restoreMedia = vi.fn<RuntimeOptions["media"]["restore"]>(async (attachment) => ({
    ...attachment,
    localPath: path.join(
      tempDirectory,
      "restored",
      attachment.metadata.fileName ?? attachment.metadata.attachmentId,
    ),
  }));
  const releaseMedia = vi.fn<RuntimeOptions["media"]["release"]>(async () => undefined);
  const runtime = new WhatsAppFixedAgentRuntime({
    databasePath: options.runtimeDatabasePath ?? path.join(tempDirectory, "runtime.db"),
    account,
    service,
    sessionManager,
    permissionPolicy,
    bindings,
    topology,
    media: {
      restore: restoreMedia,
      release: releaseMedia,
    },
    publication: {
      enqueue: vi.fn<RuntimeOptions["publication"]["enqueue"]>(async (intent) => ({
        ok: true,
        value: {
          publicationId: intent.request.publicationId,
          correlationId: intent.correlationId,
          disposition: "queued",
          acceptedAt: intent.requestedAt,
        },
      })),
      publishNow: vi.fn<RuntimeOptions["publication"]["publishNow"]>(async (intent) => {
        publicationState.attempts.push(intent);
        const existing = publicationState.receipts.get(intent.request.publicationId);
        if (existing) return existing;
        const receipt = {
          publicationId: intent.request.publicationId,
          providerMessageId: parseRelayMessageId(`published-${String(publications.length + 1)}`),
          publishedAt: NOW,
        } satisfies RelayPublishReceipt;
        publications.push(intent);
        publicationState.receipts.set(intent.request.publicationId, receipt);
        return receipt;
      }),
    },
  });

  return {
    runtime,
    relayDatabase,
    bindings,
    ensureSessionGroup,
    publications,
    publicationAttempts: publicationState.attempts,
    relayDeliveries,
    deliveryOrder,
    deliveredAttachments,
    releaseMedia,
    getSession,
    getSessionAsync,
    persistedSessionGroups,
    setTargetCold: () => {
      targetCold = true;
    },
  };
}

function createPublicationState(): PublicationState {
  return {
    publications: [],
    attempts: [],
    receipts: new Map(),
  };
}

function createEnsureSessionGroupMock(persistedSessionGroups: Set<string>) {
  let sessionGroupSequence = 0;
  return vi.fn<WhatsAppService["ensureSessionGroup"]>(async (request) => {
    const conversationId =
      request.existingConversationId ?? `session-${++sessionGroupSequence}@g.us`;
    persistedSessionGroups.add(conversationId);
    return {
      type: "ensure-session-group",
      conversationId,
      displayName: request.displayName,
      communityConversationId: request.communityConversationId,
      disposition: request.existingConversationId ? "existing" : "created",
    };
  });
}

function inboundEvent(
  address: RelayAddress,
  attachments: readonly RelayAttachment[] = [],
): RelayInboundMessageEvent {
  return {
    type: "message-received",
    providerId: address.providerId,
    accountId: address.accountId,
    occurredAt: NOW,
    message: {
      address,
      providerMessageId: INBOUND_MESSAGE_ID,
      sender: { primaryId: "15551234567@s.whatsapp.net" },
      sentAt: NOW,
      receivedAt: NOW,
      text: "Please adjust the running task.",
      attachments,
    },
  };
}

function sessionMetadata(id: string, name: string, isBusy: boolean): SessionMetadata {
  return {
    id,
    name,
    createdAt: NOW,
    updatedAt: NOW,
    hasUnread: false,
    isActive: true,
    isBusy,
    source: "user",
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
