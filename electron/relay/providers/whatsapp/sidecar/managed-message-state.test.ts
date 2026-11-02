import { describe, expect, it } from "vitest";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import {
  EncryptedSessionGroupStore,
  getPersistedSessionGroupConversationLookup,
  getPersistedSessionGroupForwardLookup,
} from "./managed-message-state";
import type { WhatsAppAuthStoreValue } from "./protocol";

describe("EncryptedSessionGroupStore", () => {
  it("rebinds reverse indexes without letting retirement delete the live group", async () => {
    const authStore = new MemoryAuthStore();
    const store = new EncryptedSessionGroupStore(authStore);

    await store.set({
      idempotencyKey: "initial-session-a",
      conversationId: "old@g.us",
      communityConversationId: "community@g.us",
      displayName: "Old",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    await store.set({
      idempotencyKey: "restored-session-a",
      conversationId: "old@g.us",
      communityConversationId: "community@g.us",
      displayName: "Old",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    await store.set({
      idempotencyKey: "restored-session-a",
      conversationId: "current@g.us",
      communityConversationId: "community@g.us",
      displayName: "Current",
      createdAt: "2026-08-08T12:01:00.000Z",
    });

    expect(await store.getByConversationId("old@g.us")).toBeUndefined();
    expect(await store.get("initial-session-a")).toBeUndefined();
    expect(await store.get("restored-session-a")).toMatchObject({
      conversationId: "current@g.us",
    });

    await store.removeByConversationId("old@g.us");

    expect(await store.get("initial-session-a")).toBeUndefined();
    expect(await store.get("restored-session-a")).toMatchObject({
      conversationId: "current@g.us",
    });
    expect(await store.getByConversationId("current@g.us")).toMatchObject({
      displayName: "Current",
    });
  });

  it("checkpoints retirement before removing active mappings and clears it on reopen", async () => {
    const authStore = new MemoryAuthStore();
    const store = new EncryptedSessionGroupStore(authStore);
    await store.set({
      idempotencyKey: "session-a",
      conversationId: "retiring@g.us",
      communityConversationId: "community@g.us",
      displayName: "Retiring",
      createdAt: "2026-08-08T12:00:00.000Z",
    });

    await expect(
      store.prepareRetirement("retiring@g.us", "2026-08-08T12:05:00.000Z"),
    ).resolves.toMatchObject({
      conversationId: "retiring@g.us",
      retirementStartedAt: "2026-08-08T12:05:00.000Z",
    });
    expect(await store.get("session-a")).toBeUndefined();
    expect(await store.getByConversationId("retiring@g.us")).toBeUndefined();
    expect(await store.listPendingRetirements()).toHaveLength(1);

    await store.set({
      idempotencyKey: "session-a",
      conversationId: "retiring@g.us",
      communityConversationId: "community@g.us",
      displayName: "Reopened",
      createdAt: "2026-08-08T12:00:00.000Z",
    });

    expect(await store.listPendingRetirements()).toEqual([]);
    expect(await store.getByConversationId("retiring@g.us")).toMatchObject({
      displayName: "Reopened",
    });
  });

  it("prunes a stale reverse mapping when the forward owner points elsewhere", async () => {
    const authStore = new MemoryAuthStore();
    const store = new EncryptedSessionGroupStore(authStore);
    const reverse = getPersistedSessionGroupConversationLookup("old@g.us");
    const forward = getPersistedSessionGroupForwardLookup("session-digest");
    authStore.seed(reverse.category, reverse.id, {
      schemaVersion: 1,
      idempotencyDigest: "session-digest",
      conversationId: "old@g.us",
      communityConversationId: "community@g.us",
      displayName: "Old",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    authStore.seed(forward.category, forward.id, {
      schemaVersion: 1,
      idempotencyDigest: "session-digest",
      conversationId: "current@g.us",
      communityConversationId: "community@g.us",
      displayName: "Current",
      createdAt: "2026-08-08T12:00:00.000Z",
    });

    expect(await store.getByConversationId("old@g.us")).toBeUndefined();
    expect(authStore.has(reverse.category, reverse.id)).toBe(false);
    expect(authStore.has(forward.category, forward.id)).toBe(true);
  });

  it("serializes reverse-index read repair with a concurrent replacement", async () => {
    const authStore = new MemoryAuthStore();
    const store = new EncryptedSessionGroupStore(authStore);
    const original = await store.set({
      idempotencyKey: "original-session",
      conversationId: "shared@g.us",
      communityConversationId: "community@g.us",
      displayName: "Original",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    const forward = getPersistedSessionGroupForwardLookup(original.idempotencyDigest);
    const pause = authStore.pauseNextRead(forward.category);
    const reading = store.getByConversationId("shared@g.us");
    await pause.entered;
    let replacementSettled = false;
    const replacement = store
      .set({
        idempotencyKey: "replacement-session",
        conversationId: "shared@g.us",
        communityConversationId: "community@g.us",
        displayName: "Replacement",
        createdAt: "2026-08-08T12:01:00.000Z",
      })
      .finally(() => {
        replacementSettled = true;
      });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    pause.release();
    await reading;
    const current = await replacement;

    expect(await store.get("original-session")).toBeUndefined();
    expect(await store.get("replacement-session")).toEqual(current);
    expect(await store.getByConversationId("shared@g.us")).toEqual(current);
  });
});

class MemoryAuthStore implements WhatsAppSidecarAuthStorePort {
  private readonly categories = new Map<string, Map<string, WhatsAppAuthStoreValue>>();
  private pausedRead:
    | {
        category: string;
        entered: () => void;
        release: Promise<void>;
      }
    | undefined;

  async readCredentials() {
    return null;
  }

  async readSignalKeys(
    category: string,
    ids: readonly string[],
  ): Promise<Record<string, WhatsAppAuthStoreValue>> {
    if (this.pausedRead?.category === category) {
      const paused = this.pausedRead;
      this.pausedRead = undefined;
      paused.entered();
      await paused.release;
    }
    const values = this.categories.get(category);
    const result: Record<string, WhatsAppAuthStoreValue> = {};
    for (const id of ids) {
      const value = values?.get(id);
      if (value !== undefined) result[id] = value;
    }
    return result;
  }

  async applyTransaction(update: {
    credentials?: WhatsAppAuthStoreValue | null;
    signalKeys?: Readonly<
      Record<string, Readonly<Record<string, WhatsAppAuthStoreValue | null>>>
    >;
  }): Promise<void> {
    for (const [category, entries] of Object.entries(update.signalKeys ?? {})) {
      const values =
        this.categories.get(category) ?? new Map<string, WhatsAppAuthStoreValue>();
      this.categories.set(category, values);
      for (const [id, value] of Object.entries(entries)) {
        if (value === null) values.delete(id);
        else values.set(id, value);
      }
    }
  }

  async reset(): Promise<void> {
    this.categories.clear();
  }

  seed(category: string, id: string, value: WhatsAppAuthStoreValue): void {
    const values = this.categories.get(category) ?? new Map<string, WhatsAppAuthStoreValue>();
    this.categories.set(category, values);
    values.set(id, value);
  }

  has(category: string, id: string): boolean {
    return this.categories.get(category)?.has(id) ?? false;
  }

  pauseNextRead(category: string): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.pausedRead = {
      category,
      entered: () => entered.resolve(undefined),
      release: release.promise,
    };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }
}

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
