import { describe, expect, it } from "vitest";

import { InboundAcceptanceJournal } from "./inbound-acceptance";
import { RelayMessageCorrelationStore } from "./message-correlation";
import { RelayDatabase } from "./relay-database";

describe("RelayMessageCorrelationStore", () => {
  it("records an immutable idempotent provider-to-local message mapping", () => {
    const database = new RelayDatabase(":memory:");
    const journal = new InboundAcceptanceJournal(database);
    const accepted = journal.accept({
      inboundId: "inbound-1",
      correlationId: "correlation-1",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      providerMessageId: "provider-message-1",
      payloadJson: '{"text":"hello"}',
      acceptedAtMs: 10,
    }).record;
    const store = new RelayMessageCorrelationStore(database);
    const input = {
      direction: "inbound" as const,
      correlationId: accepted.correlationId,
      provider: accepted.provider,
      accountId: accepted.accountId,
      conversationId: accepted.conversationId,
      providerMessageId: accepted.providerMessageId,
      localMessageId: "local-message-1",
      inboundId: accepted.inboundId,
      createdAtMs: 20,
    };

    expect(store.record(input)).toEqual({
      ...input,
      direction: "inbound",
    });
    expect(store.record({ ...input, createdAtMs: 30 })).toEqual({
      ...input,
      direction: "inbound",
    });
    expect(
      store.getByProviderMessage(
        "inbound",
        "whatsapp",
        "account-a",
        "chat-a",
        "provider-message-1",
      ),
    ).toMatchObject({
      correlationId: "correlation-1",
      localMessageId: "local-message-1",
    });

    expect(() => store.record({ ...input, localMessageId: "local-message-2" })).toThrow(
      "already mapped to another message",
    );
    database.close();
  });
});
