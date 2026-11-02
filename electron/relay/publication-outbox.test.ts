import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RelayMessageCorrelationStore } from "./message-correlation";
import { RelayPublicationOutbox } from "./publication-outbox";
import { RelayDatabase } from "./relay-database";

describe("RelayPublicationOutbox", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("leases deterministically and keeps a retry ahead of later route work", () => {
    let now = 1000;
    let leaseNumber = 0;
    const database = new RelayDatabase(":memory:");
    const outbox = new RelayPublicationOutbox(database, {
      now: () => now,
      createId: () => `lease-${++leaseNumber}`,
      defaultMaxAttempts: 2,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
    });
    const firstA = outbox.enqueue({
      publicationId: "publication-a1",
      correlationId: "correlation-a1",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      localMessageId: "local-a1",
      payloadJson: '{"text":"a1"}',
      priority: 0,
    });
    const secondA = outbox.enqueue({
      publicationId: "publication-a2",
      correlationId: "correlation-a2",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      localMessageId: "local-a2",
      payloadJson: '{"text":"a2"}',
      priority: 100,
    });
    const firstB = outbox.enqueue({
      publicationId: "publication-b1",
      correlationId: "correlation-b1",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-b",
      localMessageId: "local-b1",
      payloadJson: '{"text":"b1"}',
      priority: 10,
    });

    const leasedB = outbox.leaseNext("worker", 50);
    expect(leasedB).toMatchObject({
      publicationId: firstB.publicationId,
      state: "leased",
      attempts: 1,
    });
    const sendingB = outbox.beginSending(firstB.publicationId, leasedB?.leaseId ?? "");
    expect(sendingB.state).toBe("sending");
    expect(
      outbox.markSent(firstB.publicationId, sendingB.leaseId ?? "", "provider-b1"),
    ).toMatchObject({ state: "sent", providerMessageId: "provider-b1" });
    expect(
      new RelayMessageCorrelationStore(database).getByCorrelationId(firstB.correlationId),
    ).toMatchObject({
      direction: "outbound",
      localMessageId: "local-b1",
      providerMessageId: "provider-b1",
    });

    const leasedA = outbox.leaseNext("worker", 50);
    expect(leasedA?.publicationId).toBe(firstA.publicationId);
    expect(
      outbox.reschedule(firstA.publicationId, leasedA?.leaseId ?? "", "provider unavailable"),
    ).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAtMs: 1100,
    });

    now = 1099;
    expect(outbox.leaseNext("worker", 50)).toBeUndefined();
    now = 1100;
    const retryA = outbox.leaseNext("worker", 50);
    expect(retryA).toMatchObject({
      publicationId: firstA.publicationId,
      attempts: 2,
    });
    expect(
      outbox.reschedule(firstA.publicationId, retryA?.leaseId ?? "", "still unavailable"),
    ).toMatchObject({ state: "failed", attempts: 2 });
    expect(outbox.leaseNext("worker", 50)?.publicationId).toBe(secondA.publicationId);
    database.close();
  });

  it("recovers pre-send leases but makes interrupted sends ambiguous without retry", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-publications-"));
    const databasePath = path.join(tempDir, "relay.db");
    let now = 2000;
    let leaseNumber = 0;
    const firstDatabase = new RelayDatabase(databasePath);
    const first = new RelayPublicationOutbox(firstDatabase, {
      now: () => now,
      createId: () => `lease-${++leaseNumber}`,
    });
    const uncertain = first.enqueue({
      publicationId: "publication-uncertain",
      correlationId: "correlation-uncertain",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-b",
      localMessageId: "local-uncertain",
      payloadJson: '{"text":"uncertain"}',
      priority: 10,
    });
    const preSend = first.enqueue({
      publicationId: "publication-presend",
      correlationId: "correlation-presend",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      localMessageId: "local-presend",
      payloadJson: '{"text":"presend"}',
    });
    const uncertainLease = first.leaseNext("worker-before-crash", 100);
    expect(uncertainLease?.publicationId).toBe(uncertain.publicationId);
    first.beginSending(uncertain.publicationId, uncertainLease?.leaseId ?? "");
    const preSendLease = first.leaseNext("worker-before-crash", 100);
    expect(preSendLease?.publicationId).toBe(preSend.publicationId);
    firstDatabase.close();

    now = 2001;
    const restartedDatabase = new RelayDatabase(databasePath);
    const restarted = new RelayPublicationOutbox(restartedDatabase, {
      now: () => now,
      createId: () => `lease-${++leaseNumber}`,
    });
    expect(restarted.recoverAfterRestart()).toEqual({ requeued: 1, ambiguous: 1 });
    expect(restarted.get(uncertain.publicationId)).toMatchObject({
      state: "ambiguous",
      attempts: 1,
    });
    expect(restarted.get(preSend.publicationId)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(() =>
      restarted.markSent(
        uncertain.publicationId,
        uncertainLease?.leaseId ?? "",
        "late-provider-id",
      ),
    ).toThrow("lease is no longer current");

    const recoveredLease = restarted.leaseNext("worker-after-restart", 100);
    expect(recoveredLease).toMatchObject({
      publicationId: preSend.publicationId,
      attempts: 1,
    });
    const recoveredSending = restarted.beginSending(
      preSend.publicationId,
      recoveredLease?.leaseId ?? "",
    );
    restarted.markSent(preSend.publicationId, recoveredSending.leaseId ?? "", "provider-presend");
    now = 5000;
    expect(restarted.leaseNext("worker-after-restart", 100)).toBeUndefined();
    expect(restarted.get(uncertain.publicationId)?.state).toBe("ambiguous");
    restartedDatabase.close();
  });

  it("supports explicit supersession without reopening terminal work", () => {
    const database = new RelayDatabase(":memory:");
    const outbox = new RelayPublicationOutbox(database);
    const original = outbox.enqueue({
      publicationId: "publication-original",
      correlationId: "correlation-original",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      localMessageId: "local-original",
      payloadJson: '{"text":"old"}',
    });
    const replacement = outbox.enqueue({
      publicationId: "publication-replacement",
      correlationId: "correlation-replacement",
      provider: "whatsapp",
      accountId: "account-a",
      conversationId: "chat-a",
      localMessageId: "local-replacement",
      payloadJson: '{"text":"new"}',
    });

    expect(() => outbox.supersede(replacement.publicationId, original.publicationId)).toThrow(
      "newer publication",
    );
    expect(outbox.supersede(original.publicationId, replacement.publicationId)).toMatchObject({
      state: "superseded",
      supersededBy: replacement.publicationId,
    });
    expect(
      outbox.enqueue({
        publicationId: replacement.publicationId,
        correlationId: replacement.correlationId,
        provider: replacement.provider,
        accountId: replacement.accountId,
        conversationId: replacement.conversationId,
        localMessageId: replacement.localMessageId,
        payloadJson: replacement.payloadJson,
      }),
    ).toEqual(replacement);
    expect(outbox.leaseNext("worker", 100)?.publicationId).toBe(replacement.publicationId);
    database.close();
  });
});
