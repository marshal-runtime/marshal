import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "./relay-contract";
import {
  RELAY_EXPERIENCE_ERROR_CODES,
  RELAY_MANAGED_GROUP_ROLES,
  RELAY_SESSION_PRIORITIES,
  RELAY_SETUP_STATES,
} from "./relay-experience-contract";
import type {
  RelayAccountScope,
  RelayAttachmentMetadata,
  RelayExperienceResult,
  RelayFixedAgentSpecification,
  RelayInboundAuthorizationDecision,
  RelayManagedCommunityTopology,
  RelayPublicationIntent,
  RelaySessionDescriptor,
  RelaySetupSnapshot,
  RelayVoiceTranscript,
} from "./relay-experience-contract";

describe("relay experience contract", () => {
  it("locks lifecycle, managed-role, and priority literals", () => {
    expect(RELAY_SETUP_STATES).toEqual([
      "idle",
      "pairing",
      "qr",
      "connected",
      "reconnecting",
      "disconnected",
      "error",
    ]);
    expect(RELAY_MANAGED_GROUP_ROLES).toEqual([
      "new-chats",
      "progress",
      "information-control",
      "session",
    ]);
    expect(RELAY_SESSION_PRIORITIES).toEqual(["foreground", "control", "background"]);
    expect(RELAY_EXPERIENCE_ERROR_CODES).toContain("idempotency-conflict");
  });

  it("keeps representative cross-phase DTOs JSON serializable", () => {
    const providerId = parseRelayProviderId("whatsapp");
    const accountId = parseRelayAccountId("primary");
    const communityId = parseRelayConversationId("community");
    const groupId = parseRelayConversationId("progress");
    const providerMessageId = parseRelayMessageId("message-1");
    const now = "2026-08-07T00:00:00.000Z";
    const account = { providerId, accountId } satisfies RelayAccountScope;
    const communityAddress = { ...account, conversationId: communityId };
    const groupAddress = { ...account, conversationId: groupId };

    const topology = {
      community: {
        address: communityAddress,
        displayName: "Marshal",
        state: "active",
        createdAt: now,
        updatedAt: now,
      },
      groups: [
        {
          address: groupAddress,
          communityAddress,
          role: "progress",
          displayName: "Progress",
          state: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
      revision: 1,
    } satisfies RelayManagedCommunityTopology;

    const fixedAgent = {
      agentId: "progress-agent",
      specVersion: 1,
      role: "progress",
      displayName: "Progress",
      description: "Reports deliberate session progress.",
      instructions: "Publish only correlated progress updates.",
      sessionPriority: "control",
      toolPolicy: {
        mode: "default-deny",
        allowedTools: [{ toolId: "relay.publish-progress" }],
      },
    } satisfies RelayFixedAgentSpecification;

    const attachment = {
      address: groupAddress,
      providerMessageId,
      attachmentId: "voice-1",
      kind: "audio",
      mimeType: "audio/ogg",
      sizeBytes: 42,
      voice: { durationMs: 1200, languageHint: "en" },
    } satisfies RelayAttachmentMetadata;

    const transcript = {
      address: groupAddress,
      providerMessageId,
      attachmentId: attachment.attachmentId,
      text: "Status update",
      language: "en",
      durationMs: 1200,
      transcribedAt: now,
    } satisfies RelayVoiceTranscript;

    const session = {
      account,
      sessionId: "session-1",
      kind: "fixed-agent",
      status: "ready",
      priority: "control",
      group: groupAddress,
      fixedAgentId: fixedAgent.agentId,
      createdAt: now,
      updatedAt: now,
    } satisfies RelaySessionDescriptor;

    const publication = {
      intent: "deliberate",
      idempotencyKey: "publish:session-1:turn-1:progress-1",
      requestedAt: now,
      correlationId: "correlation-1",
      request: {
        publicationId: "publication-1",
        address: groupAddress,
        kind: "progress",
        text: "Still working",
        sourceSessionId: session.sessionId,
        sourceTurnId: "turn-1",
      },
      progress: {
        progressId: "progress-1",
        sequence: 1,
        state: "update",
      },
    } satisfies RelayPublicationIntent;

    const authorization = {
      address: groupAddress,
      providerMessageId,
      senderPrimaryId: "sender-1",
      policyId: "managed-groups-v1",
      decidedAt: now,
      decision: "allow",
      reason: "managed-group",
    } satisfies RelayInboundAuthorizationDecision;

    const setup = {
      account,
      state: "qr",
      updatedAt: now,
      pairingAttemptId: "pairing-1",
      qr: { payload: "opaque-pairing-payload" },
    } satisfies RelaySetupSnapshot;

    const contractSample = {
      setup,
      topology,
      fixedAgent,
      attachment,
      transcript,
      session,
      publication,
      authorization,
    };

    expect(JSON.parse(JSON.stringify(contractSample))).toEqual(contractSample);
  });

  it("uses a discriminated typed failure result", () => {
    const result: RelayExperienceResult<RelaySetupSnapshot, "provider-failure"> = {
      ok: false,
      error: {
        code: "provider-failure",
        message: "Connection failed",
        retryable: true,
      },
    };

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expectTypeOf(result.error.code).toEqualTypeOf<"provider-failure">();
    }
  });
});
