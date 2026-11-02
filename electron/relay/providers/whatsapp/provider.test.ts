import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../../../common/relay-contract";
import type {
  RelayAddress,
  RelayProviderCapabilities,
  RelayPublishRequest,
} from "../../../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelayAccountScope,
  RelayAuthorizationErrorCode,
  RelayCommunityProvisionRequest,
  RelayExperienceFailure,
  RelayExperienceResult,
  RelayInboundAuthorizationDecision,
  RelayInboundAuthorizationRequest,
  RelayIngestedAttachment,
  RelayManagedCommunityTopology,
  RelayManagedGroupCreateRequest,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRenameRequest,
  RelayManagedGroupRetireRequest,
  RelayProvisioningErrorCode,
  RelaySetupErrorCode,
  RelaySetupSnapshot,
  RelayVoiceTranscript,
} from "../../../../common/relay-experience-contract";
import type { RelayProviderEvent } from "../../contracts";
import type {
  RelayCommunityProvisioningPort,
  RelayConnectionControlPort,
  RelayInboundAuthorizationPort,
  RelayManagedGroupAdministrationPort,
  RelayPairingControlPort,
  RelaySetupStatusListener,
  RelaySetupStatusPort,
} from "../../experience-ports";
import {
  createWhatsAppProviderComposition,
  type WhatsAppAuthorizationLanePort,
  type WhatsAppConnectionLanePort,
  type WhatsAppGroupLanePort,
  type WhatsAppMediaLanePort,
} from "./composition";
import type { WhatsAppProtocolContent, WhatsAppProtocolMessageEnvelope } from "./envelope";
import {
  WHATSAPP_BAILEYS_PROVIDER_ID,
  WHATSAPP_MEDIA_PROVIDER_ID,
  WhatsAppRelayProviderError,
  type WhatsAppMediaDownloadAuthorization,
  type WhatsAppMediaPipelineRequest,
  type WhatsAppMediaPipelineResult,
  type WhatsAppProtocolEvent,
  type WhatsAppProtocolEventListener,
  type WhatsAppTextPublicationRequest,
  type WhatsAppTextPublicationReceipt,
} from "./provider";
import type { WhatsAppProtocolConversationDescriptor } from "./translation";

const ACCOUNT_ID = parseRelayAccountId("primary");
const OTHER_ACCOUNT_ID = parseRelayAccountId("secondary");
const COMMUNITY_ID = parseRelayConversationId("community");
const GROUP_ID = parseRelayConversationId("group");
const MESSAGE_ID = parseRelayMessageId("message-1");
const QUOTED_MESSAGE_ID = parseRelayMessageId("message-0");
const NOW = "2026-08-07T00:30:00.000Z";

const ACCOUNT: RelayAccountScope = {
  providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
  accountId: ACCOUNT_ID,
};
const COMMUNITY_ADDRESS: RelayAddress = {
  ...ACCOUNT,
  conversationId: COMMUNITY_ID,
};
const GROUP_ADDRESS: RelayAddress = {
  ...ACCOUNT,
  conversationId: GROUP_ID,
};

describe("WhatsApp relay provider composition", () => {
  it("matches canonical lane ports, reports capabilities, and remains inert at construction", () => {
    expectTypeOf<WhatsAppConnectionLanePort>().toMatchTypeOf<RelaySetupStatusPort>();
    expectTypeOf<WhatsAppConnectionLanePort>().toMatchTypeOf<RelayPairingControlPort>();
    expectTypeOf<WhatsAppConnectionLanePort>().toMatchTypeOf<RelayConnectionControlPort>();
    expectTypeOf<WhatsAppGroupLanePort>().toMatchTypeOf<RelayCommunityProvisioningPort>();
    expectTypeOf<WhatsAppGroupLanePort>().toMatchTypeOf<RelayManagedGroupAdministrationPort>();
    expectTypeOf<WhatsAppAuthorizationLanePort>().toMatchTypeOf<RelayInboundAuthorizationPort>();
    expectTypeOf<keyof WhatsAppAuthorizationLanePort>().toEqualTypeOf<
      "authorize" | "createMediaDownloadAuthorization"
    >();
    expectTypeOf<keyof WhatsAppMediaLanePort>().toEqualTypeOf<"processInbound" | "release">();

    const harness = createHarness();

    expect(harness.provider.providerId).toBe(parseRelayProviderId("whatsapp-baileys"));
    expect(harness.connection.totalCalls()).toBe(0);
    expect(harness.connection.socketCreations).toBe(0);
    expect(harness.groups.totalCalls()).toBe(0);
    expect(harness.authorization.requests).toEqual([]);
    expect(harness.media.totalCalls()).toBe(0);
    expect(harness.composition.setupStatus).toBe(harness.connection);
    expect(harness.composition.pairingControl).toBe(harness.connection);
    expect(harness.composition.connectionControl).toBe(harness.connection);
    expect(harness.composition.communityProvisioning).toBe(harness.groups);
    expect(harness.composition.managedGroupAdministration).toBe(harness.groups);
    expect(harness.provider.capabilities(ACCOUNT_ID)).toEqual({
      inbound: true,
      quotedReplies: true,
      attachments: true,
      voice: true,
      managedGroups: true,
      communities: true,
      renameConversation: true,
      retireConversation: true,
      remotePermissionApproval: false,
      interactiveChoices: "unsupported",
    } satisfies RelayProviderCapabilities);
    expect(() => harness.provider.capabilities(OTHER_ACCOUNT_ID)).toThrow(
      WhatsAppRelayProviderError,
    );
  });

  it("maps account lifecycle and protocol events into RelayProvider events", async () => {
    const harness = createHarness();
    const events: RelayProviderEvent[] = [];
    const unsubscribe = harness.provider.subscribe(async (event) => {
      events.push(event);
    });

    harness.connection.setupSnapshot = setupSnapshot("qr", {
      code: "pairing-expired",
      message: "Scan a fresh QR code",
      retryable: false,
    });
    await expect(harness.provider.status(ACCOUNT_ID)).resolves.toEqual({
      state: "connecting",
      updatedAt: NOW,
      failure: {
        code: "pairing-expired",
        message: "Scan a fresh QR code",
        retryable: false,
      },
    });
    await harness.provider.connect(ACCOUNT_ID);
    await harness.provider.disconnect(ACCOUNT_ID);

    expect(harness.connection.connectRequests).toEqual([
      {
        ...ACCOUNT,
        idempotencyKey: "whatsapp-baileys:primary:connect:operation-1",
        requestedAt: NOW,
      },
    ]);
    expect(harness.connection.disconnectRequests).toEqual([
      {
        ...ACCOUNT,
        idempotencyKey: "whatsapp-baileys:primary:disconnect:operation-2",
        requestedAt: NOW,
      },
    ]);

    await harness.connection.emitSetup(setupSnapshot("connected"));
    await harness.connection.emitProtocol({
      type: "delivery",
      occurredAt: NOW,
      providerMessageId: MESSAGE_ID,
      state: "read",
    });
    await harness.connection.emitProtocol({
      type: "conversation",
      occurredAt: NOW,
      change: "updated",
      conversation: {
        conversationId: GROUP_ID,
        kind: "group",
        displayName: "Progress",
        parentConversationId: COMMUNITY_ID,
      },
    });

    expect(events).toEqual([
      {
        type: "status-changed",
        providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
        accountId: ACCOUNT_ID,
        occurredAt: NOW,
        status: { state: "connected", updatedAt: NOW },
      },
      {
        type: "delivery-updated",
        providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
        accountId: ACCOUNT_ID,
        occurredAt: NOW,
        providerMessageId: MESSAGE_ID,
        state: "read",
      },
      {
        type: "conversation-changed",
        providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
        accountId: ACCOUNT_ID,
        occurredAt: NOW,
        change: "updated",
        conversation: {
          address: GROUP_ADDRESS,
          kind: "group",
          displayName: "Progress",
          parentConversationId: COMMUNITY_ID,
        },
      },
    ]);

    unsubscribe();
    expect(harness.connection.setupUnsubscribeCalls).toBe(1);
    expect(harness.connection.protocolUnsubscribeCalls).toBe(1);
  });

  it("authorizes metadata before lazy content and drops denied messages without loading them", async () => {
    const order: string[] = [];
    const harness = createHarness(order);
    const events: RelayProviderEvent[] = [];
    harness.provider.subscribe(async (event) => {
      order.push("event");
      events.push(event);
    });
    const content = {
      text: "hello",
      attachments: [],
      providerMessage: "provider-type-must-not-escape",
    };
    const envelope = {
      ...inboundEnvelope(async () => {
        order.push("load-content");
        return content;
      }),
      credentialSecret: "credential-must-not-escape",
    };

    await harness.connection.emitProtocol({ type: "message", envelope });

    expect(order).toEqual(["authorize", "issue-media-authorization", "load-content", "event"]);
    expect(harness.authorization.requests).toEqual([
      {
        address: GROUP_ADDRESS,
        providerMessageId: MESSAGE_ID,
        sender: {
          primaryId: "sender@example",
          alternateIds: ["15551234567"],
          displayName: "Sender",
        },
        receivedAt: NOW,
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message-received",
      message: {
        address: GROUP_ADDRESS,
        providerMessageId: MESSAGE_ID,
        text: "hello",
        replyTo: {
          providerMessageId: QUOTED_MESSAGE_ID,
          sender: { primaryId: "quoted@example" },
        },
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("credential-must-not-escape");
    expect(JSON.stringify(events[0])).not.toContain("provider-type-must-not-escape");
    expect(JSON.stringify(events[0])).not.toContain("acceptance-message-1");

    const deniedOrder: string[] = [];
    const denied = createHarness(deniedOrder);
    denied.authorization.decision = "deny";
    const deniedEvents: RelayProviderEvent[] = [];
    denied.provider.subscribe(async (event) => {
      deniedEvents.push(event);
    });
    await denied.connection.emitProtocol({
      type: "message",
      envelope: inboundEnvelope(async () => {
        deniedOrder.push("load-content");
        return { text: "blocked", attachments: [] };
      }),
    });

    expect(deniedOrder).toEqual(["authorize"]);
    expect(deniedEvents).toEqual([]);
  });

  it("hands authorized media to the pipeline and emits attachments and voice transcripts", async () => {
    const order: string[] = [];
    const harness = createHarness(order);
    const events: RelayProviderEvent[] = [];
    harness.provider.subscribe(async (event) => {
      order.push("event");
      events.push(event);
    });

    await harness.connection.emitProtocol({
      type: "message",
      envelope: inboundEnvelope(async () => {
        order.push("load-content");
        return {
          text: "caption",
          attachments: [
            {
              attachmentId: "image-1",
              kind: "image",
              mimeType: "image/png",
              fileName: "status.png",
              sizeBytes: 10,
              source: {
                kind: "local-file",
                sourceId: "image-source-1",
                path: "/relay-media/image-1",
              },
            },
            {
              attachmentId: "voice-1",
              kind: "audio",
              mimeType: "audio/ogg",
              sizeBytes: 20,
              voice: { durationMs: 1200, languageHint: "en" },
              source: {
                kind: "local-file",
                sourceId: "voice-source-1",
                path: "/relay-media/voice-1",
              },
            },
          ],
        };
      }),
    });

    expect(order).toEqual([
      "authorize",
      "issue-media-authorization",
      "load-content",
      "media:image-1",
      "media:voice-1",
      "event",
    ]);
    expect(harness.media.requests).toHaveLength(2);
    expect(harness.media.requests[0]).toMatchObject({
      authorization: {
        acceptanceToken: "acceptance-message-1",
        expiresAt: "2026-08-07T01:30:00.000Z",
      },
      message: {
        account: ACCOUNT,
        address: GROUP_ADDRESS,
        providerMessageId: MESSAGE_ID,
        senderId: "sender@example",
        sentAt: NOW,
        caption: "caption",
        quotedProviderMessageId: QUOTED_MESSAGE_ID,
      },
      media: {
        attachment: {
          address: GROUP_ADDRESS,
          providerMessageId: MESSAGE_ID,
          attachmentId: "image-1",
          kind: "image",
          mimeType: "image/png",
          fileName: "status.png",
          sizeBytes: 10,
        },
        source: {
          kind: "local-file",
          sourceId: "image-source-1",
          path: "/relay-media/image-1",
        },
      },
    });
    expect(harness.media.requests[0]?.authorization?.decision).toBe(
      harness.authorization.lastDecision,
    );
    expect(harness.authorization.lastDecision).not.toHaveProperty("acceptanceToken");
    expect(harness.media.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.media.requests[1]).toMatchObject({
      authorization: { acceptanceToken: "acceptance-message-1" },
      media: {
        attachment: {
          attachmentId: "voice-1",
          kind: "audio",
          mimeType: "audio/ogg",
          sizeBytes: 20,
          voice: { durationMs: 1200, languageHint: "en" },
        },
        source: {
          kind: "local-file",
          sourceId: "voice-source-1",
          path: "/relay-media/voice-1",
        },
        voiceMemo: true,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message-received",
      message: {
        text: "caption\n\nspoken status",
        attachments: [
          {
            id: "image-1",
            kind: "image",
            mimeType: "image/png",
            fileName: "status.png",
            sizeBytes: 10,
            localPath: "C:\\relay\\image-1",
          },
          {
            id: "voice-1",
            kind: "audio",
            mimeType: "audio/ogg",
            sizeBytes: 20,
            localPath: "C:\\relay\\voice-1",
            voiceMemo: true,
          },
        ],
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("providerLocal");
    expect(JSON.stringify(events[0])).not.toContain("download-secret");
  });

  it("publishes explicit text with quoted replies without forwarding host metadata", async () => {
    const harness = createHarness();
    const addressWithSecret = {
      ...GROUP_ADDRESS,
      credentialSecret: "address-secret",
    };
    const request: RelayPublishRequest = {
      publicationId: "publication-1",
      address: addressWithSecret,
      kind: "reply",
      text: "Done",
      replyToProviderMessageId: QUOTED_MESSAGE_ID,
      sourceSessionId: "session-secret",
      sourceTurnId: "turn-secret",
    };

    await expect(harness.provider.publish(request)).resolves.toEqual({
      publicationId: "publication-1",
      providerMessageId: parseRelayMessageId("published-1"),
      publishedAt: NOW,
    });
    expect(harness.connection.publishRequests).toEqual([
      {
        account: ACCOUNT,
        conversationId: GROUP_ID,
        publicationId: "publication-1",
        kind: "reply",
        text: "Done",
        quotedProviderMessageId: QUOTED_MESSAGE_ID,
      },
    ]);
    const serialized = JSON.stringify(harness.connection.publishRequests[0]);
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("turn-secret");
    expect(serialized).not.toContain("address-secret");

    await expect(
      harness.provider.publish({ ...request, publicationId: "blank", text: "   " }),
    ).rejects.toThrow(TypeError);
    await expect(
      harness.provider.publish({
        ...request,
        publicationId: "wrong-provider",
        address: {
          ...GROUP_ADDRESS,
          providerId: parseRelayProviderId("other-provider"),
        },
      }),
    ).rejects.toThrow(WhatsAppRelayProviderError);
    expect(harness.connection.publishRequests).toHaveLength(1);
  });

  it("maps conversation administration to catalog, community, and managed-group ports", async () => {
    const harness = createHarness();
    const addressWithSecret = {
      ...GROUP_ADDRESS,
      credentialSecret: "group-address-secret",
    };

    await expect(harness.provider.conversations.list(ACCOUNT_ID)).resolves.toEqual([
      {
        address: COMMUNITY_ADDRESS,
        kind: "community",
        displayName: "Marshal",
      },
      {
        address: GROUP_ADDRESS,
        kind: "group",
        displayName: "Progress",
        parentConversationId: COMMUNITY_ID,
      },
    ]);
    await expect(
      harness.provider.conversations.create?.(ACCOUNT_ID, {
        kind: "community",
        displayName: "Marshal",
      }),
    ).resolves.toEqual({
      address: COMMUNITY_ADDRESS,
      kind: "community",
      displayName: "Marshal",
    });
    await expect(
      harness.provider.conversations.create?.(ACCOUNT_ID, {
        kind: "group",
        displayName: "New session",
        parentConversationId: COMMUNITY_ID,
      }),
    ).resolves.toMatchObject({
      address: GROUP_ADDRESS,
      kind: "group",
      displayName: "New session",
      parentConversationId: COMMUNITY_ID,
    });
    await expect(
      harness.provider.conversations.rename?.(addressWithSecret, "Renamed"),
    ).resolves.toMatchObject({
      address: GROUP_ADDRESS,
      displayName: "Renamed",
    });
    await expect(
      harness.provider.conversations.retire?.(addressWithSecret),
    ).resolves.toBeUndefined();

    expect(harness.groups.provisionRequests).toEqual([
      expect.objectContaining({
        ...ACCOUNT,
        displayName: "Marshal",
        groups: [],
      }),
    ]);
    expect(harness.groups.createRequests).toEqual([
      expect.objectContaining({
        communityAddress: COMMUNITY_ADDRESS,
        role: "session",
        displayName: "New session",
      }),
    ]);
    expect(harness.groups.renameRequests).toEqual([
      expect.objectContaining({
        address: GROUP_ADDRESS,
        displayName: "Renamed",
      }),
    ]);
    expect(harness.groups.retireRequests).toEqual([
      expect.objectContaining({ address: GROUP_ADDRESS }),
    ]);
    expect(JSON.stringify(harness.groups.renameRequests)).not.toContain("group-address-secret");
    expect(JSON.stringify(harness.groups.retireRequests)).not.toContain("group-address-secret");
    await expect(
      harness.provider.conversations.create?.(ACCOUNT_ID, {
        kind: "direct",
        displayName: "Unsupported",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("rejects forged, cross-message, and mutated media authorizations before content", async () => {
    await Promise.all(
      [
        (harness: Harness) => {
          harness.authorization.forgeCanonicalDecision = true;
        },
        (harness: Harness) => {
          harness.authorization.crossMessageDecision = true;
        },
        (harness: Harness) => {
          harness.authorization.mutateCanonicalDecision = true;
        },
      ].map(async (configure) => {
        const harness = createHarness();
        configure(harness);
        let contentLoaded = false;
        const events: RelayProviderEvent[] = [];
        harness.provider.subscribe(async (event) => {
          events.push(event);
        });

        await expect(
          harness.connection.emitProtocol({
            type: "message",
            envelope: inboundEnvelope(async () => {
              contentLoaded = true;
              return { text: "blocked", attachments: [] };
            }),
          }),
        ).rejects.toMatchObject({ code: "provider-failure" });
        expect(contentLoaded).toBe(false);
        expect(harness.media.requests).toEqual([]);
        expect(events).toEqual([]);
      }),
    );
  });

  it("fails closed when authorization, acceptance, content, or media processing fails", async () => {
    const malformedAuthorization = createHarness();
    malformedAuthorization.authorization.malformedDecision = true;
    let malformedContentLoaded = false;
    const malformedEvents: RelayProviderEvent[] = [];
    malformedAuthorization.provider.subscribe(async (event) => {
      malformedEvents.push(event);
    });
    await expect(
      malformedAuthorization.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => {
          malformedContentLoaded = true;
          return { text: "blocked", attachments: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: "provider-failure" });
    expect(malformedContentLoaded).toBe(false);
    expect(malformedEvents).toEqual([]);

    const missingAcceptance = createHarness();
    missingAcceptance.authorization.omitMediaAuthorization = true;
    let missingAcceptanceContentLoaded = false;
    const missingAcceptanceEvents: RelayProviderEvent[] = [];
    missingAcceptance.provider.subscribe(async (event) => {
      missingAcceptanceEvents.push(event);
    });
    await expect(
      missingAcceptance.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => {
          missingAcceptanceContentLoaded = true;
          return { text: "blocked", attachments: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: "provider-failure" });
    expect(missingAcceptanceContentLoaded).toBe(false);
    expect(missingAcceptance.media.requests).toEqual([]);
    expect(missingAcceptanceEvents).toEqual([]);

    const authorizationFailure = createHarness();
    authorizationFailure.authorization.failure = {
      code: "unavailable",
      message: "policy unavailable",
      retryable: true,
    };
    let authorizationContentLoaded = false;
    const authorizationEvents: RelayProviderEvent[] = [];
    authorizationFailure.provider.subscribe(async (event) => {
      authorizationEvents.push(event);
    });
    await expect(
      authorizationFailure.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => {
          authorizationContentLoaded = true;
          return { text: "blocked", attachments: [] };
        }),
      }),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(authorizationContentLoaded).toBe(false);
    expect(authorizationEvents).toEqual([]);

    const contentFailure = createHarness();
    const contentEvents: RelayProviderEvent[] = [];
    contentFailure.provider.subscribe(async (event) => {
      contentEvents.push(event);
    });
    await expect(
      contentFailure.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => {
          throw new Error("content unavailable");
        }),
      }),
    ).rejects.toThrow("content unavailable");
    expect(contentEvents).toEqual([]);

    const attachmentFailure = createHarness();
    attachmentFailure.media.failure = mediaFailure("ATTACHMENT_INGESTION_FAILED", true);
    const attachmentEvents: RelayProviderEvent[] = [];
    attachmentFailure.provider.subscribe(async (event) => {
      attachmentEvents.push(event);
    });
    await expect(
      attachmentFailure.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => ({
          attachments: [
            {
              attachmentId: "image-1",
              kind: "image",
              mimeType: "image/png",
              source: {
                kind: "local-file",
                sourceId: "image-source-1",
                path: "/relay-media/image-1",
              },
            },
          ],
        })),
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_INGESTION_FAILED" });
    expect(attachmentEvents).toEqual([]);

    const voiceFailure = createHarness();
    voiceFailure.media.failure = mediaFailure("TRANSCRIPTION_FAILED", false);
    const voiceEvents: RelayProviderEvent[] = [];
    voiceFailure.provider.subscribe(async (event) => {
      voiceEvents.push(event);
    });
    await expect(
      voiceFailure.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => ({
          attachments: [
            {
              attachmentId: "voice-1",
              kind: "audio",
              mimeType: "audio/ogg",
              voice: {},
              source: {
                kind: "local-file",
                sourceId: "voice-source-1",
                path: "/relay-media/voice-1",
              },
            },
          ],
        })),
      }),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" });
    expect(voiceEvents).toEqual([]);

    const activeCancellation = createHarness();
    activeCancellation.media.failure = mediaFailure("CANCELLED", false);
    activeCancellation.provider.subscribe(async () => {});
    await expect(
      activeCancellation.connection.emitProtocol({
        type: "message",
        envelope: inboundEnvelope(async () => ({
          attachments: [
            {
              attachmentId: "image-1",
              kind: "image",
              mimeType: "image/png",
              source: {
                kind: "local-file",
                sourceId: "image-source-1",
                path: "/relay-media/image-1",
              },
            },
          ],
        })),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("does not invoke media after teardown during lazy content loading", async () => {
    const harness = createHarness();
    const events: RelayProviderEvent[] = [];
    harness.provider.subscribe(async (event) => {
      events.push(event);
    });

    await harness.connection.emitProtocol({
      type: "message",
      envelope: inboundEnvelope(async () => {
        harness.composition.dispose();
        return {
          attachments: [
            {
              attachmentId: "image-1",
              kind: "image",
              mimeType: "image/png",
              source: {
                kind: "local-file",
                sourceId: "image-source-1",
                path: "/relay-media/image-1",
              },
            },
          ],
        };
      }),
    });

    expect(harness.media.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it("tears down event sources, ignores stale callbacks, and rejects use after disposal", async () => {
    const harness = createHarness();
    const events: RelayProviderEvent[] = [];
    const unsubscribe = harness.provider.subscribe(async (event) => {
      events.push(event);
    });
    const staleProtocolListener = harness.connection.lastProtocolListener;
    expect(staleProtocolListener).toBeDefined();

    unsubscribe();
    await staleProtocolListener?.({
      type: "delivery",
      occurredAt: NOW,
      providerMessageId: MESSAGE_ID,
      state: "sent",
    });
    expect(events).toEqual([]);

    harness.provider.subscribe(async (event) => {
      events.push(event);
    });
    harness.composition.dispose();
    harness.composition.dispose();
    expect(harness.connection.setupUnsubscribeCalls).toBe(2);
    expect(harness.connection.protocolUnsubscribeCalls).toBe(2);
    await expect(harness.provider.status(ACCOUNT_ID)).rejects.toMatchObject({
      code: "unavailable",
    });

    const inFlight = createHarness();
    let releaseMedia = () => {};
    let markMediaStarted = () => {};
    const mediaStarted = new Promise<void>((resolve) => {
      markMediaStarted = resolve;
    });
    inFlight.media.processBarrier = new Promise<void>((resolve) => {
      releaseMedia = resolve;
    });
    inFlight.media.onProcess = markMediaStarted;
    const inFlightEvents: RelayProviderEvent[] = [];
    inFlight.provider.subscribe(async (event) => {
      inFlightEvents.push(event);
    });
    const processing = inFlight.connection.emitProtocol({
      type: "message",
      envelope: inboundEnvelope(async () => ({
        attachments: [
          {
            attachmentId: "voice-1",
            kind: "audio",
            mimeType: "audio/ogg",
            voice: {},
            source: {
              kind: "local-file",
              sourceId: "voice-source-1",
              path: "/relay-media/voice-1",
            },
          },
        ],
      })),
    });
    await mediaStarted;
    inFlight.composition.dispose();
    releaseMedia();
    await processing;
    expect(inFlight.media.requests).toHaveLength(1);
    expect(inFlight.media.requests[0]?.signal?.aborted).toBe(true);
    expect(inFlightEvents).toEqual([]);
  });

  it("keeps credentials, socket creation, and Baileys types outside composition sources", () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const source = ["composition.ts", "envelope.ts", "provider.ts", "translation.ts"]
      .map((fileName) => readFileSync(path.join(directory, fileName), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/from\s+["']baileys(?:\/[^"']*)?["']/);
    expect(source).not.toMatch(
      /\b(?:WAMessage|AuthenticationState|makeWASocket|useMultiFileAuthState)\b/,
    );
    expect(source).not.toContain("./auth-store");
    expect(source).not.toContain("./media-pipeline");
    expect(source).not.toMatch(/\b(?:providerLocal|downloaded)\b/);
    expect(source).not.toMatch(/\b(?:credential|socketFactory|createSocket)\b/i);
  });
});

interface Harness {
  readonly connection: FakeConnectionLane;
  readonly groups: FakeGroupLane;
  readonly authorization: FakeAuthorizationLane;
  readonly media: FakeMediaLane;
  readonly composition: ReturnType<typeof createWhatsAppProviderComposition>;
  readonly provider: ReturnType<typeof createWhatsAppProviderComposition>["provider"];
}

function createHarness(order: string[] = []): Harness {
  const connection = new FakeConnectionLane();
  const groups = new FakeGroupLane();
  const authorization = new FakeAuthorizationLane(order);
  const media = new FakeMediaLane(order);
  let operationSequence = 0;
  const composition = createWhatsAppProviderComposition({
    accountId: ACCOUNT_ID,
    connection,
    groups,
    authorization,
    media,
    now: () => NOW,
    createOperationId: () => {
      operationSequence += 1;
      return `operation-${String(operationSequence)}`;
    },
  });
  return {
    connection,
    groups,
    authorization,
    media,
    composition,
    provider: composition.provider,
  };
}

class FakeConnectionLane implements WhatsAppConnectionLanePort {
  readonly getStatusRequests: RelayAccountScope[] = [];
  readonly connectRequests: RelayAccountOperationRequest[] = [];
  readonly disconnectRequests: RelayAccountOperationRequest[] = [];
  readonly pairingRequests: RelayAccountOperationRequest[] = [];
  readonly cancelPairingRequests: RelayAccountOperationRequest[] = [];
  readonly publishRequests: WhatsAppTextPublicationRequest[] = [];
  readonly conversationRequests: RelayAccountScope[] = [];
  readonly setupListeners = new Set<RelaySetupStatusListener>();
  readonly protocolListeners = new Set<WhatsAppProtocolEventListener>();
  setupSubscribeCalls = 0;
  setupUnsubscribeCalls = 0;
  protocolSubscribeCalls = 0;
  protocolUnsubscribeCalls = 0;
  socketCreations = 0;
  setupSnapshot = setupSnapshot("disconnected");
  publishReceipt: WhatsAppTextPublicationReceipt = {
    providerMessageId: parseRelayMessageId("published-1"),
    publishedAt: NOW,
  };
  conversations: readonly WhatsAppProtocolConversationDescriptor[] = [
    {
      conversationId: COMMUNITY_ID,
      kind: "community",
      displayName: "Marshal",
    },
    {
      conversationId: GROUP_ID,
      kind: "group",
      displayName: "Progress",
      parentConversationId: COMMUNITY_ID,
    },
  ];
  lastProtocolListener: WhatsAppProtocolEventListener | undefined;

  async getStatus(
    account: RelayAccountScope,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>> {
    this.getStatusRequests.push(account);
    return ok(this.setupSnapshot);
  }

  subscribe(account: RelayAccountScope, listener: RelaySetupStatusListener): () => void {
    this.setupSubscribeCalls += 1;
    this.getStatusRequests.push(account);
    this.setupListeners.add(listener);
    return () => {
      this.setupUnsubscribeCalls += 1;
      this.setupListeners.delete(listener);
    };
  }

  async beginPairing(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>> {
    this.pairingRequests.push(request);
    return ok(this.setupSnapshot);
  }

  async cancelPairing(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>> {
    this.cancelPairingRequests.push(request);
    return ok(this.setupSnapshot);
  }

  async connect(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>> {
    this.connectRequests.push(request);
    return ok(setupSnapshot("connected"));
  }

  async disconnect(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>> {
    this.disconnectRequests.push(request);
    return ok(setupSnapshot("disconnected"));
  }

  subscribeProtocol(
    account: RelayAccountScope,
    listener: WhatsAppProtocolEventListener,
  ): () => void {
    this.protocolSubscribeCalls += 1;
    this.conversationRequests.push(account);
    this.protocolListeners.add(listener);
    this.lastProtocolListener = listener;
    return () => {
      this.protocolUnsubscribeCalls += 1;
      this.protocolListeners.delete(listener);
    };
  }

  async publishText(
    request: WhatsAppTextPublicationRequest,
  ): Promise<WhatsAppTextPublicationReceipt> {
    this.publishRequests.push(request);
    return this.publishReceipt;
  }

  async listConversations(
    account: RelayAccountScope,
  ): Promise<readonly WhatsAppProtocolConversationDescriptor[]> {
    this.conversationRequests.push(account);
    return this.conversations;
  }

  async emitSetup(snapshot: RelaySetupSnapshot): Promise<void> {
    await Promise.all(
      [...this.setupListeners].map((listener) => Promise.resolve(listener(snapshot))),
    );
  }

  async emitProtocol(event: WhatsAppProtocolEvent): Promise<void> {
    await Promise.all([...this.protocolListeners].map((listener) => listener(event)));
  }

  totalCalls(): number {
    return (
      this.getStatusRequests.length +
      this.connectRequests.length +
      this.disconnectRequests.length +
      this.pairingRequests.length +
      this.cancelPairingRequests.length +
      this.publishRequests.length +
      this.conversationRequests.length +
      this.setupSubscribeCalls +
      this.protocolSubscribeCalls
    );
  }
}

class FakeGroupLane implements WhatsAppGroupLanePort {
  readonly provisionRequests: RelayCommunityProvisionRequest[] = [];
  readonly createRequests: RelayManagedGroupCreateRequest[] = [];
  readonly renameRequests: RelayManagedGroupRenameRequest[] = [];
  readonly retireRequests: RelayManagedGroupRetireRequest[] = [];

  async provision(
    request: RelayCommunityProvisionRequest,
  ): Promise<RelayExperienceResult<RelayManagedCommunityTopology, RelayProvisioningErrorCode>> {
    this.provisionRequests.push(request);
    return ok(topology("Marshal"));
  }

  async createGroup(
    request: RelayManagedGroupCreateRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>> {
    this.createRequests.push(request);
    return ok(groupDescriptor(request.displayName));
  }

  async renameGroup(
    request: RelayManagedGroupRenameRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>> {
    this.renameRequests.push(request);
    return ok(groupDescriptor(request.displayName));
  }

  async retireGroup(
    request: RelayManagedGroupRetireRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>> {
    this.retireRequests.push(request);
    return ok({
      ...groupDescriptor("Progress"),
      state: "retired",
      updatedAt: NOW,
    });
  }

  totalCalls(): number {
    return (
      this.provisionRequests.length +
      this.createRequests.length +
      this.renameRequests.length +
      this.retireRequests.length
    );
  }
}

class FakeAuthorizationLane implements WhatsAppAuthorizationLanePort {
  readonly requests: RelayInboundAuthorizationRequest[] = [];
  readonly mediaAuthorizationRequests: Array<{
    readonly request: RelayInboundAuthorizationRequest;
    readonly decision: RelayInboundAuthorizationDecision;
  }> = [];
  decision: RelayInboundAuthorizationDecision["decision"] = "allow";
  malformedDecision = false;
  omitMediaAuthorization = false;
  forgeCanonicalDecision = false;
  crossMessageDecision = false;
  mutateCanonicalDecision = false;
  acceptanceToken = "acceptance-message-1";
  failure: RelayExperienceFailure<RelayAuthorizationErrorCode> | undefined;
  lastDecision: RelayInboundAuthorizationDecision | undefined;

  constructor(private readonly order: string[]) {}

  async authorize(
    request: RelayInboundAuthorizationRequest,
  ): Promise<
    RelayExperienceResult<RelayInboundAuthorizationDecision, RelayAuthorizationErrorCode>
  > {
    this.order.push("authorize");
    this.requests.push(request);
    if (this.failure) return failed(this.failure);
    if (this.decision === "deny") {
      const decision: RelayInboundAuthorizationDecision = {
        address: request.address,
        providerMessageId: request.providerMessageId,
        senderPrimaryId: request.sender.primaryId,
        policyId: "managed-groups-v1",
        decidedAt: NOW,
        decision: "deny",
        reason: "sender-not-authorized",
      };
      this.lastDecision = decision;
      return ok(decision);
    }
    const decision: RelayInboundAuthorizationDecision = {
      address: request.address,
      providerMessageId: request.providerMessageId,
      senderPrimaryId: request.sender.primaryId,
      policyId: "managed-groups-v1",
      decidedAt: NOW,
      decision: "allow",
      reason: "managed-group",
    };
    if (this.malformedDecision) Reflect.set(decision, "decision", "unexpected");
    this.lastDecision = decision;
    return ok(decision);
  }

  async createMediaDownloadAuthorization(
    request: RelayInboundAuthorizationRequest,
    decision: Extract<RelayInboundAuthorizationDecision, { readonly decision: "allow" }>,
  ): Promise<WhatsAppMediaDownloadAuthorization> {
    this.order.push("issue-media-authorization");
    this.mediaAuthorizationRequests.push({ request, decision });
    if (this.mutateCanonicalDecision) {
      Reflect.set(decision, "providerMessageId", parseRelayMessageId("mutated-message"));
    }
    let canonicalDecision: RelayInboundAuthorizationDecision = decision;
    if (this.forgeCanonicalDecision) {
      canonicalDecision = { ...decision };
    } else if (this.crossMessageDecision) {
      canonicalDecision = {
        ...decision,
        providerMessageId: parseRelayMessageId("different-message"),
      };
    }
    const authorization: WhatsAppMediaDownloadAuthorization = {
      acceptanceToken: this.acceptanceToken,
      decision: canonicalDecision,
      expiresAt: "2026-08-07T01:30:00.000Z",
    };
    if (this.omitMediaAuthorization) {
      Reflect.deleteProperty(authorization, "acceptanceToken");
    }
    return authorization;
  }
}

class FakeMediaLane implements WhatsAppMediaLanePort {
  readonly requests: WhatsAppMediaPipelineRequest[] = [];
  failure: (Error & { readonly code: string; readonly retryable: boolean }) | undefined;
  processBarrier: Promise<void> | undefined;
  onProcess: (() => void) | undefined;

  constructor(private readonly order: string[]) {}

  async processInbound(
    request: WhatsAppMediaPipelineRequest,
  ): Promise<WhatsAppMediaPipelineResult> {
    this.order.push(`media:${request.media.attachment.attachmentId}`);
    this.requests.push(request);
    this.onProcess?.();
    if (this.processBarrier) await this.processBarrier;
    if (request.signal?.aborted) throw mediaFailure("CANCELLED", false);
    if (this.failure) throw this.failure;
    const authorization = request.authorization;
    if (!authorization) throw mediaFailure("UNAUTHORIZED", false);
    const originalMessage = {
      account: request.message.account,
      address: request.message.address,
      providerMessageId: request.message.providerMessageId,
      ...(request.message.senderId === undefined ? {} : { senderId: request.message.senderId }),
      ...(request.message.sentAt === undefined ? {} : { sentAt: request.message.sentAt }),
      ...(request.message.text === undefined ? {} : { text: request.message.text }),
      ...(request.message.caption === undefined ? {} : { caption: request.message.caption }),
      ...(request.message.quotedProviderMessageId === undefined
        ? {}
        : { quotedProviderMessageId: request.message.quotedProviderMessageId }),
      ...(request.message.quotedText === undefined
        ? {}
        : { quotedText: request.message.quotedText }),
    };
    const idempotencyKey = [
      request.message.account.providerId,
      request.message.account.accountId,
      request.message.address.conversationId,
      request.message.providerMessageId,
      request.media.attachment.attachmentId,
    ].join(":");
    const attachmentId = request.media.attachment.attachmentId;
    const signal = request.signal ?? new AbortController().signal;
    const providerLocalMetadata = {
      ...request.media.attachment,
      providerLocal: {
        providerId: WHATSAPP_MEDIA_PROVIDER_ID,
        downloaded: {
          tempPath: "C:\\temp\\whatsapp-media",
          bytes: new TextEncoder().encode("download-secret"),
          fileName: "download-secret.bin",
          signal,
        },
      },
    };
    const ingested: RelayIngestedAttachment = {
      metadata: providerLocalMetadata,
      localPath: `C:\\relay\\${attachmentId}`,
      sizeBytes: request.media.attachment.sizeBytes ?? 1,
      sha256: request.media.attachment.sha256 ?? `sha256-${attachmentId}`,
      ingestedAt: NOW,
    };

    if (request.media.voiceMemo) {
      const transcript: RelayVoiceTranscript = {
        address: request.message.address,
        providerMessageId: request.message.providerMessageId,
        attachmentId,
        text: "spoken status",
        durationMs: request.media.attachment.voice?.durationMs,
        transcribedAt: NOW,
      };
      return {
        kind: "voice-transcript",
        providerId: WHATSAPP_MEDIA_PROVIDER_ID,
        idempotencyKey,
        contentSha256: ingested.sha256,
        processedAt: NOW,
        originalMessage,
        transcript,
        audio: ingested,
      };
    }

    return {
      kind: "attachment",
      providerId: WHATSAPP_MEDIA_PROVIDER_ID,
      idempotencyKey,
      contentSha256: ingested.sha256,
      processedAt: NOW,
      originalMessage,
      attachment: ingested,
    };
  }

  totalCalls(): number {
    return this.requests.length;
  }
}

function inboundEnvelope(
  loadContent: () => Promise<WhatsAppProtocolContent>,
): WhatsAppProtocolMessageEnvelope {
  return {
    accountId: ACCOUNT_ID,
    conversationId: GROUP_ID,
    providerMessageId: MESSAGE_ID,
    sender: {
      primaryId: "sender@example",
      alternateIds: ["15551234567"],
      displayName: "Sender",
    },
    sentAt: NOW,
    receivedAt: NOW,
    replyTo: {
      providerMessageId: QUOTED_MESSAGE_ID,
      sender: { primaryId: "quoted@example" },
    },
    loadContent,
  };
}

function setupSnapshot(
  state: RelaySetupSnapshot["state"],
  failure?: RelayExperienceFailure<RelaySetupErrorCode>,
): RelaySetupSnapshot {
  return {
    account: ACCOUNT,
    state,
    updatedAt: NOW,
    ...(failure === undefined ? {} : { failure }),
  };
}

function topology(displayName: string): RelayManagedCommunityTopology {
  return {
    community: {
      address: COMMUNITY_ADDRESS,
      displayName,
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    },
    groups: [groupDescriptor("Progress")],
    revision: 1,
  };
}

function groupDescriptor(displayName: string): RelayManagedGroupDescriptor {
  return {
    address: GROUP_ADDRESS,
    communityAddress: COMMUNITY_ADDRESS,
    role: "session",
    displayName,
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mediaFailure(
  code: string,
  retryable: boolean,
): Error & { readonly code: string; readonly retryable: boolean } {
  return Object.assign(new Error(`WhatsApp media failure: ${code}`), {
    code,
    retryable,
  });
}

function ok<Value>(value: Value): { readonly ok: true; readonly value: Value } {
  return { ok: true, value };
}

function failed<Code extends RelayExperienceFailure["code"]>(
  error: RelayExperienceFailure<Code>,
): { readonly ok: false; readonly error: RelayExperienceFailure<Code> } {
  return { ok: false, error };
}
