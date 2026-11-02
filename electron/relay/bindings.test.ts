import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RelayBindingStore } from "./bindings";
import { RelayDatabase } from "./relay-database";

describe("RelayBindingStore", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("persists and atomically rebinds an external conversation", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-bindings-"));
    const databasePath = path.join(tempDir, "relay.db");
    const database = new RelayDatabase(databasePath);
    const store = new RelayBindingStore(database, {
      now: () => 10,
      createId: () => "binding-1",
    });

    const created = store.upsert({
      provider: "whatsapp",
      accountId: "account-a",
      externalConversationId: "chat-a",
      localConversationId: "session-a",
    });
    expect(created).toEqual({
      bindingId: "binding-1",
      provider: "whatsapp",
      accountId: "account-a",
      externalConversationId: "chat-a",
      localConversationId: "session-a",
      role: "session",
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    const rebound = store.upsert({
      bindingId: "binding-1",
      provider: "whatsapp",
      accountId: "account-a",
      externalConversationId: "chat-a",
      localConversationId: "session-b",
      updatedAtMs: 20,
    });
    expect(rebound).toMatchObject({
      bindingId: "binding-1",
      localConversationId: "session-b",
      createdAtMs: 10,
      updatedAtMs: 20,
    });
    store.recordActivity(rebound.bindingId, "inbound", 25);
    const moved = store.upsert({
      bindingId: "binding-1",
      provider: "whatsapp",
      accountId: "account-a",
      externalConversationId: "chat-b",
      localConversationId: "session-b",
      updatedAtMs: 30,
    });
    expect(store.getByExternalConversation("whatsapp", "account-a", "chat-a")).toBeUndefined();
    expect(moved).toMatchObject({
      bindingId: "binding-1",
      externalConversationId: "chat-b",
      createdAtMs: 10,
      updatedAtMs: 30,
    });
    expect(store.getActivity(moved.bindingId)).toMatchObject({ lastInboundAtMs: 25 });
    const movedAccount = store.upsert({
      bindingId: "binding-1",
      provider: "whatsapp",
      accountId: "account-b",
      externalConversationId: "chat-b",
      localConversationId: "session-b",
      updatedAtMs: 40,
    });
    expect(store.getByExternalConversation("whatsapp", "account-a", "chat-b")).toBeUndefined();
    expect(movedAccount).toMatchObject({
      bindingId: "binding-1",
      accountId: "account-b",
      createdAtMs: 10,
      updatedAtMs: 40,
    });
    expect(store.getActivity(movedAccount.bindingId)).toMatchObject({ lastInboundAtMs: 25 });
    database.close();

    const reopened = new RelayDatabase(databasePath);
    const persisted = new RelayBindingStore(reopened).getByExternalConversation(
      "whatsapp",
      "account-b",
      "chat-b",
    );
    expect(persisted).toEqual(movedAccount);
    reopened.close();
  });

  it("persists activity, preferred origin, progress cadence, and stale cleanup state", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-activity-"));
    const databasePath = path.join(tempDir, "relay.db");
    const database = new RelayDatabase(databasePath);
    const store = new RelayBindingStore(database, {
      now: () => 100,
      createId: (() => {
        let sequence = 0;
        return () => `binding-${++sequence}`;
      })(),
    });

    const first = store.upsert({
      provider: "whatsapp-baileys",
      accountId: "primary",
      externalConversationId: "group-a",
      localConversationId: "session-a",
      role: "session",
      updatedAtMs: 100,
    });
    const second = store.upsert({
      provider: "example-chat",
      accountId: "default",
      externalConversationId: "chat-b",
      localConversationId: "session-a",
      role: "session",
      updatedAtMs: 110,
    });
    store.recordActivity(first.bindingId, "inbound", 120);
    store.recordActivity(second.bindingId, "publication", 130);
    store.recordSessionActivity("session-a", "session", 140);
    store.recordSessionActivity("session-a", "progress", 150);

    expect(store.getPreferredSessionAccessPoint("session-a")).toEqual(second);
    expect(store.listSessionAccessPoints("session-a")).toEqual([
      {
        binding: first,
        activity: {
          bindingId: first.bindingId,
          lastInboundAtMs: 120,
          lastSessionActivityAtMs: 140,
          lastProgressPromptAtMs: 150,
          updatedAtMs: 150,
        },
      },
      {
        binding: second,
        activity: {
          bindingId: second.bindingId,
          lastPublicationAtMs: 130,
          lastSessionActivityAtMs: 140,
          lastProgressPromptAtMs: 150,
          updatedAtMs: 150,
        },
      },
    ]);
    expect(store.listStaleSessionAccessPoints(140)).toEqual([]);
    expect(store.listStaleSessionAccessPoints(141).map(({ binding }) => binding.bindingId)).toEqual(
      [first.bindingId, second.bindingId],
    );
    database.close();

    const reopened = new RelayDatabase(databasePath);
    const restored = new RelayBindingStore(reopened);
    expect(restored.getActivity(first.bindingId)).toMatchObject({
      lastInboundAtMs: 120,
      lastProgressPromptAtMs: 150,
    });
    expect(restored.remove(first.bindingId)).toBe(true);
    expect(restored.getActivity(first.bindingId)).toBeUndefined();
    reopened.close();
  });

  it("hides a binding behind a durable retirement until provider convergence", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-relay-retirement-"));
    const databasePath = path.join(tempDir, "relay.db");
    const database = new RelayDatabase(databasePath);
    const store = new RelayBindingStore(database, { now: () => 100 });
    const binding = store.upsert({
      bindingId: "binding-retiring",
      provider: "whatsapp-baileys",
      accountId: "primary",
      externalConversationId: "group@g.us",
      localConversationId: "session-a",
      role: "session",
    });

    const retirement = store.prepareRetirement(binding.bindingId, 200);
    expect(retirement).toMatchObject({
      bindingId: binding.bindingId,
      requestedAtMs: 200,
    });
    expect(store.getById(binding.bindingId)).toBeUndefined();
    expect(
      store.getByExternalConversation(
        binding.provider,
        binding.accountId,
        binding.externalConversationId,
      ),
    ).toBeUndefined();
    expect(store.listSessionAccessPoints(binding.localConversationId)).toEqual([]);
    expect(() =>
      store.upsert({
        ...binding,
        updatedAtMs: 300,
      }),
    ).toThrow("is retiring");
    database.close();

    const reopened = new RelayDatabase(databasePath);
    const restored = new RelayBindingStore(reopened);
    expect(restored.listRetirements()).toHaveLength(1);
    expect(restored.cancelRetirement(binding.bindingId)).toBe(true);
    expect(restored.getById(binding.bindingId)).toEqual(binding);
    restored.prepareRetirement(binding.bindingId, 400);
    expect(restored.completeRetirement(binding.bindingId)).toBe(true);
    expect(restored.listRetirements()).toEqual([]);
    reopened.close();
  });

  it("atomically reactivates a retiring binding at its reopened provider conversation", () => {
    const database = new RelayDatabase(":memory:");
    const store = new RelayBindingStore(database, { now: () => 100 });
    store.upsert({
      bindingId: "binding-reopened",
      provider: "whatsapp-baileys",
      accountId: "primary",
      externalConversationId: "retired@g.us",
      localConversationId: "session-a",
      role: "session",
    });
    store.prepareRetirement("binding-reopened", 200);

    const reopened = store.reactivateRetirement({
      bindingId: "binding-reopened",
      provider: "whatsapp-baileys",
      accountId: "primary",
      externalConversationId: "reopened@g.us",
      localConversationId: "session-a",
      role: "session",
      updatedAtMs: 300,
    });

    expect(reopened.externalConversationId).toBe("reopened@g.us");
    expect(store.getRetirement("binding-reopened")).toBeUndefined();
    expect(
      store.getByExternalConversation("whatsapp-baileys", "primary", "retired@g.us"),
    ).toBeUndefined();
    expect(
      store.getByExternalConversation("whatsapp-baileys", "primary", "reopened@g.us"),
    ).toMatchObject({ bindingId: "binding-reopened" });
    database.close();
  });
});
