import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcceptedInboundPump,
  InboundAcceptanceJournal,
  type AcceptedInboundEnqueueRequest,
} from "./inbound-acceptance";
import { RelayMessageCorrelationStore } from "./message-correlation";
import { RelayDatabase } from "./relay-database";

describe("InboundAcceptanceJournal", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("deduplicates provider/account/conversation/message as the accepted journal commit", () => {
    const database = new RelayDatabase(":memory:");
    const ids = [
      "inbound-1",
      "correlation-1",
      "inbound-2",
      "correlation-2",
      "inbound-3",
      "correlation-3",
      "inbound-4",
      "correlation-4",
      "inbound-5",
      "correlation-5",
    ];
    const journal = new InboundAcceptanceJournal(database, {
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => 10,
    });
    const input = {
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      providerMessageId: "message-a",
      payloadJson: '{"text":"hello"}',
    };

    const first = journal.accept(input);
    const duplicate = journal.accept({ ...input, payloadJson: '{"text":"changed"}' });
    const otherProvider = journal.accept({ ...input, provider: "signal" });
    const otherAccount = journal.accept({ ...input, accountId: "account-b" });
    const otherConversation = journal.accept({ ...input, conversationId: "chat-b" });
    const otherMessage = journal.accept({ ...input, providerMessageId: "message-b" });

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ inserted: false, record: first.record });
    expect(otherProvider.inserted).toBe(true);
    expect(otherAccount.inserted).toBe(true);
    expect(otherConversation.inserted).toBe(true);
    expect(otherMessage.inserted).toBe(true);
    expect(journal.listAccepted().map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5]);
    database.close();
  });

  it("replays accepted-but-not-enqueued work with the same correlation id after restart", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-inbound-"));
    const databasePath = path.join(tempDir, "relay.db");
    const firstDatabase = new RelayDatabase(databasePath);
    const firstJournal = new InboundAcceptanceJournal(firstDatabase);
    const accepted = firstJournal.accept({
      inboundId: "inbound-1",
      correlationId: "correlation-1",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      providerMessageId: "provider-message-1",
      payloadJson: '{"text":"hello"}',
      acceptedAtMs: 10,
    }).record;
    const downstream = new Map<string, string>();
    const attempts: AcceptedInboundEnqueueRequest[] = [];
    let crashAfterDownstreamAcceptance = true;
    const enqueue = async (
      request: AcceptedInboundEnqueueRequest,
    ): Promise<{ localMessageId: string }> => {
      attempts.push(request);
      const localMessageId = downstream.get(request.idempotencyKey) ?? "local-message-1";
      downstream.set(request.idempotencyKey, localMessageId);
      if (crashAfterDownstreamAcceptance) {
        crashAfterDownstreamAcceptance = false;
        throw new Error("simulated crash after downstream acceptance");
      }
      return { localMessageId };
    };

    const interrupted = await new AcceptedInboundPump(firstDatabase, enqueue, {
      now: () => 20,
    }).pump();
    expect(interrupted).toMatchObject({
      scanned: 1,
      enqueued: 0,
      blocked: { correlationId: accepted.correlationId },
    });
    expect(firstJournal.getByCorrelationId(accepted.correlationId)?.state).toBe("accepted");
    firstDatabase.close();

    const restartedDatabase = new RelayDatabase(databasePath);
    const restarted = await new AcceptedInboundPump(restartedDatabase, enqueue, {
      now: () => 30,
    }).pump();
    expect(restarted).toEqual({ scanned: 1, enqueued: 1 });
    expect(attempts.map((request) => request.idempotencyKey)).toEqual([
      accepted.correlationId,
      accepted.correlationId,
    ]);
    expect(downstream).toEqual(new Map([[accepted.correlationId, "local-message-1"]]));
    expect(
      new InboundAcceptanceJournal(restartedDatabase).getByCorrelationId(accepted.correlationId),
    ).toMatchObject({
      state: "enqueued",
      localMessageId: "local-message-1",
      enqueuedAtMs: 30,
    });
    expect(
      new RelayMessageCorrelationStore(restartedDatabase).getByCorrelationId(
        accepted.correlationId,
      ),
    ).toMatchObject({
      inboundId: accepted.inboundId,
      localMessageId: "local-message-1",
    });
    restartedDatabase.close();
  });

  it("rolls back journal completion when correlation mapping cannot commit", async () => {
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
    new RelayMessageCorrelationStore(database).record({
      direction: "inbound",
      correlationId: accepted.correlationId,
      provider: accepted.provider,
      accountId: accepted.accountId,
      conversationId: accepted.conversationId,
      providerMessageId: accepted.providerMessageId,
      localMessageId: "local-message-existing",
      inboundId: accepted.inboundId,
      createdAtMs: 15,
    });

    const result = await new AcceptedInboundPump(
      database,
      async () => ({ localMessageId: "local-message-conflict" }),
      { now: () => 20 },
    ).pump();

    expect(result).toMatchObject({
      enqueued: 0,
      blocked: { correlationId: accepted.correlationId },
    });
    const persisted = journal.getByCorrelationId(accepted.correlationId);
    expect(persisted?.state).toBe("accepted");
    expect(persisted).not.toHaveProperty("localMessageId");
    database.close();
  });
});
