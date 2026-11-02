import { describe, expect, it, vi } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../common/relay-contract";
import type { RelayProvider } from "../relay/contracts";
import type { RelayAccountExperienceRuntime } from "../relay/experience-coordinator";
import { createMarshalRelayRegistrationService } from "./runtime-relay-registration";

type RelayRegistrationOptions = Parameters<typeof createMarshalRelayRegistrationService>[0];

function provider(): RelayProvider {
  return {
    providerId: parseRelayProviderId("slack"),
    capabilities: () => ({
      inbound: true,
      quotedReplies: true,
      attachments: false,
      voice: false,
      managedGroups: false,
      communities: false,
      renameConversation: false,
      retireConversation: false,
      remotePermissionApproval: false,
    }),
    connect: vi.fn<RelayProvider["connect"]>(async () => undefined),
    disconnect: vi.fn<RelayProvider["disconnect"]>(async () => undefined),
    status: vi.fn<RelayProvider["status"]>(async () => ({
      state: "connected" as const,
      updatedAt: new Date().toISOString(),
    })),
    publish: vi.fn<RelayProvider["publish"]>(async (request) => ({
      publicationId: request.publicationId,
      providerMessageId: parseRelayMessageId("2.0"),
      publishedAt: new Date().toISOString(),
    })),
    subscribe: vi.fn<RelayProvider["subscribe"]>(() => () => undefined),
  };
}

describe("Runtime relay registration", () => {
  it("registers a provider and routes each external conversation into a durable chat", async () => {
    const bindings = new Map<string, string>();
    const sendMessage = vi.fn<RelayRegistrationOptions["sessions"]["sendMessage"]>(
      async () => undefined,
    );
    let accountRuntime: RelayAccountExperienceRuntime | undefined;
    const service = createMarshalRelayRegistrationService({
      registry: {
        register: vi.fn<RelayRegistrationOptions["registry"]["register"]>(() => () => undefined),
      },
      coordinator: {
        bindings: {
          getByExternalConversation: (_provider, _account, conversation) => {
            const localConversationId = bindings.get(conversation);
            return localConversationId ? { localConversationId } : undefined;
          },
          upsert: (input) => bindings.set(input.externalConversationId, input.localConversationId),
        },
        registerAccountRuntime: (_account, registered) => {
          accountRuntime = registered;
          return () => undefined;
        },
      },
      sessions: {
        createSession: vi.fn<RelayRegistrationOptions["sessions"]["createSession"]>(async () => ({
          id: "session-1",
        })),
        isSessionBusy: () => false,
        sendMessage,
        steerMessage: vi.fn<RelayRegistrationOptions["sessions"]["steerMessage"]>(
          async () => undefined,
        ),
      },
    });
    const slack = provider();
    service.register({ provider: slack, accountId: "acme" });

    const address = {
      providerId: parseRelayProviderId("slack"),
      accountId: parseRelayAccountId("acme"),
      conversationId: parseRelayConversationId("C1"),
    };
    const event = {
      type: "message-received" as const,
      providerId: address.providerId,
      accountId: address.accountId,
      occurredAt: "2026-09-03T10:00:00.000Z",
      message: {
        address,
        providerMessageId: parseRelayMessageId("1.0"),
        sender: { primaryId: "U1" },
        sentAt: "2026-09-03T10:00:00.000Z",
        receivedAt: "2026-09-03T10:00:00.000Z",
        text: "hello from Slack",
        attachments: [],
      },
    };
    await accountRuntime!.routeInbound(event, {
      correlationId: "corr-1",
      idempotencyKey: "inbound-1",
      acceptedAt: event.occurredAt,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "session-1",
      "hello from Slack",
      undefined,
      expect.objectContaining({ clientMessageId: "inbound-1", relayOrigin: address }),
    );
    expect(bindings.get("C1")).toBe("session-1");
  });
});
