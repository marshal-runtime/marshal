import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import { EncryptedSessionGroupStore } from "./managed-message-state";
import type { WhatsAppAuthStoreValue } from "./protocol";
import type { WhatsAppSocketAdapterEvent } from "./socket-controller";

interface MockSocket {
  ev: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  user?: {
    id: string;
    phoneNumber?: string;
    name?: string;
  };
  end: ReturnType<typeof vi.fn>;
  groupMetadata?: ReturnType<typeof vi.fn>;
  communityUnlinkGroup?: ReturnType<typeof vi.fn>;
  groupLeave?: ReturnType<typeof vi.fn>;
}

interface MockCacheStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): boolean;
  flushAll(): void;
}

const mockState = vi.hoisted(() => ({
  initAuthCreds: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn<
    (store: unknown, logger: unknown, cache: MockCacheStore) => unknown
  >((store) => store),
  makeWASocket: vi.fn(),
}));

vi.mock("baileys", () => ({
  Browsers: {
    appropriate: (name: string) => ["Desktop", name, "1.0.0"],
  },
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411,
    forbidden: 403,
    unavailableService: 503,
  },
  initAuthCreds: mockState.initAuthCreds,
  makeCacheableSignalKeyStore: mockState.makeCacheableSignalKeyStore,
  makeWASocket: mockState.makeWASocket,
  normalizeMessageContent: (message: unknown) => message,
}));

import { createBaileysSocketAdapter } from "./baileys-adapter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Baileys socket adapter", () => {
  it("persists initial credentials, credential updates, and Signal keys transactionally", async () => {
    const credentials = {
      noiseKey: { public: new Uint8Array([1]), private: new Uint8Array([2]) },
      signedIdentityKey: { public: new Uint8Array([3]), private: new Uint8Array([4]) },
      signedPreKey: {
        keyPair: { public: new Uint8Array([5]), private: new Uint8Array([6]) },
        signature: new Uint8Array([7]),
        keyId: 1,
      },
      registrationId: 7,
      pairingEphemeralKeyPair: {
        public: new Uint8Array([8]),
        private: new Uint8Array([9]),
      },
      advSecretKey: "adv-secret",
      firstUnuploadedPreKeyId: 1,
      nextPreKeyId: 2,
      processedHistoryMessages: [],
      accountSyncCounter: 0,
      accountSettings: { unarchiveChats: false },
      registered: false,
      pairingCode: undefined,
      lastPropHash: undefined,
      routingInfo: undefined,
    };
    mockState.initAuthCreds.mockReturnValue(credentials);
    const socket = createMockSocket();
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore();
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    expect(authStore.applyTransaction).toHaveBeenCalledWith({ credentials });

    const config = mockState.makeWASocket.mock.calls[0][0];
    await config.auth.keys.set({
      session: {
        device: new Uint8Array([10, 11]),
        removed: null,
      },
    });
    expect(authStore.applyTransaction).toHaveBeenCalledWith({
      signalKeys: {
        session: {
          device: new Uint8Array([10, 11]),
          removed: null,
        },
      },
    });

    emit(socket, "creds.update", { registered: true, advSecretKey: "rotated-secret" });
    await flush();
    expect(authStore.applyTransaction).toHaveBeenCalledWith({
      credentials: expect.objectContaining({
        registered: true,
        advSecretKey: "rotated-secret",
      }),
    });
    expect(events).toEqual([]);
    const signalCache = mockState.makeCacheableSignalKeyStore.mock.calls[0][2];
    signalCache.set("session.device", Buffer.from("secret"));
    await adapter.close();
    expect(signalCache.get("session.device")).toBeUndefined();
  });

  it("classifies terminal disconnects and emits connected identity without exposing Baileys types", async () => {
    const credentials = compatibleCredentials();
    const socket = createMockSocket();
    socket.user = {
      id: "15551234567@s.whatsapp.net",
      phoneNumber: "15551234567",
      name: "Linked account",
    };
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(credentials);
    const events: WhatsAppSocketAdapterEvent[] = [];

    await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    emit(socket, "connection.update", { connection: "open" });
    await flush();
    emit(socket, "connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: 401 } },
        date: new Date(),
      },
    });

    expect(events).toEqual([
      {
        type: "connection",
        state: "open",
        identity: {
          id: "15551234567@s.whatsapp.net",
          phoneNumber: "15551234567",
          displayName: "Linked account",
        },
      },
      {
        type: "connection",
        state: "close",
        classification: "terminal",
        reason: "logged-out",
        statusCode: 401,
      },
    ]);
  });

  it("waits for post-open Signal-key persistence scheduled on the next turn", async () => {
    const socket = createMockSocket();
    socket.user = { id: "15551234567@s.whatsapp.net" };
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    const pending = createDeferred<void>();
    authStore.applyTransaction.mockImplementationOnce(() => pending.promise);
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    const config = mockState.makeWASocket.mock.calls[0][0];
    let signalWrite: Promise<void> | undefined;
    emit(socket, "connection.update", { connection: "open" });
    process.nextTick(() => {
      signalWrite = config.auth.keys.set({
        session: { device: new Uint8Array([1, 2, 3]) },
      });
    });
    await flush();
    expect(events).toEqual([]);

    pending.resolve(undefined);
    await signalWrite;
    await flush();
    expect(events).toEqual([
      {
        type: "connection",
        state: "open",
        identity: { id: "15551234567@s.whatsapp.net" },
      },
    ]);
    await adapter.close();
  });

  it("waits for a post-open write that follows an asynchronous Signal-key read", async () => {
    const socket = createMockSocket();
    socket.user = { id: "15551234567@s.whatsapp.net" };
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    const read = createDeferred<Record<string, never>>();
    authStore.readSignalKeys.mockImplementationOnce(() => read.promise);
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    const config = mockState.makeWASocket.mock.calls[0][0];
    let migration: Promise<void> | undefined;
    emit(socket, "connection.update", { connection: "open" });
    process.nextTick(() => {
      migration = (async () => {
        await config.auth.keys.get("lid-mapping", ["self"]);
        await config.auth.keys.set({
          "device-list": { self: ["0"] },
        });
      })();
    });
    await flush();
    expect(events).toEqual([]);

    read.resolve({});
    await migration;
    await flush();
    expect(events).toEqual([
      {
        type: "connection",
        state: "open",
        identity: { id: "15551234567@s.whatsapp.net" },
      },
    ]);
    await adapter.close();
  });

  it("reports Signal-key persistence failures and suppresses connected state", async () => {
    const socket = createMockSocket();
    socket.user = { id: "15551234567@s.whatsapp.net" };
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    authStore.applyTransaction.mockRejectedValueOnce(new Error("encrypted store unavailable"));
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    const config = mockState.makeWASocket.mock.calls[0][0];
    await expect(
      config.auth.keys.set({
        session: { device: new Uint8Array([1, 2, 3]) },
      }),
    ).rejects.toThrow(/encrypted store unavailable/);
    emit(socket, "connection.update", { connection: "open" });
    await flush();

    expect(events).toEqual([{ type: "auth-error" }]);
    await expect(adapter.close()).rejects.toThrow(/authentication persistence failed/);
  });

  it("rejects close when a pending credential update was not persisted", async () => {
    const socket = createMockSocket();
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    authStore.applyTransaction.mockRejectedValueOnce(new Error("encrypted store unavailable"));
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    emit(socket, "creds.update", { registered: true });

    await expect(adapter.close()).rejects.toThrow(/authentication persistence failed/);
    expect(events).toEqual([{ type: "auth-error" }]);
    expect(socket.end).toHaveBeenCalledOnce();
  });

  it("waits for pending Signal-key persistence before closing", async () => {
    const socket = createMockSocket();
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    const pending = createDeferred<void>();
    authStore.applyTransaction.mockImplementationOnce(() => pending.promise);
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    const config = mockState.makeWASocket.mock.calls[0][0];
    const signalWrite = config.auth.keys.set({
      session: { device: new Uint8Array([1, 2, 3]) },
    });
    const close = adapter.close();
    let closeSettled = false;
    void close.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await flush();
    expect(closeSettled).toBe(false);
    expect(socket.end).toHaveBeenCalledOnce();

    pending.reject(new Error("encrypted store unavailable"));
    await expect(signalWrite).rejects.toThrow(/encrypted store unavailable/);
    await expect(close).rejects.toThrow(/authentication persistence failed/);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "auth-error" }]);
  });

  it("drains Signal-key writes started while the socket is ending", async () => {
    const socket = createMockSocket();
    mockState.makeWASocket.mockReturnValue(socket);
    const authStore = createAuthStore(compatibleCredentials());
    const pending = createDeferred<void>();
    authStore.applyTransaction.mockImplementationOnce(() => pending.promise);
    const events: WhatsAppSocketAdapterEvent[] = [];

    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event));
    const config = mockState.makeWASocket.mock.calls[0][0];
    let signalWrite: Promise<void> | undefined;
    socket.end.mockImplementationOnce(async () => {
      signalWrite = config.auth.keys.set({
        session: { teardown: new Uint8Array([4, 5, 6]) },
      });
    });
    const close = adapter.close();
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await flush();
    expect(closeSettled).toBe(false);

    pending.resolve(undefined);
    await signalWrite;
    await close;
    expect(events).toEqual([]);
  });

  it.each(["checkpoint", "unlink", "leave"] as const)(
    "reconciles a session-group retirement after a crash at the %s step",
    async (crashStep) => {
      const authStore = createStatefulAuthStore(compatibleCredentials());
      const sessionGroups = new EncryptedSessionGroupStore(authStore);
      await sessionGroups.set({
        idempotencyKey: "session-a",
        conversationId: "session@g.us",
        communityConversationId: "community@g.us",
        displayName: "Session",
        createdAt: "2026-08-08T12:00:00.000Z",
      });
      const remote = { exists: true, linked: true };
      const firstSocket = createRetirementSocket(remote, crashStep);
      const secondSocket = createRetirementSocket(remote);
      mockState.makeWASocket
        .mockReturnValueOnce(firstSocket)
        .mockReturnValueOnce(secondSocket);
      const first = await createBaileysSocketAdapter(authStore, () => undefined, {
        provisionOnOpen: false,
      });
      if (!first.retireSessionGroup) throw new Error("Session-group retirement is unavailable");

      await expect(
        first.retireSessionGroup({
          type: "retire-session-group",
          conversationId: "session@g.us",
          communityConversationId: "community@g.us",
        }),
      ).rejects.toThrow(`crash after ${crashStep}`);
      expect(await sessionGroups.getByConversationId("session@g.us")).toBeUndefined();
      expect(await sessionGroups.listPendingRetirements()).toHaveLength(1);
      await first.close();

      const events: WhatsAppSocketAdapterEvent[] = [];
      const restarted = await createBaileysSocketAdapter(authStore, (event) => events.push(event), {
        provisionOnOpen: false,
      });
      secondSocket.user = { id: "15551234567@s.whatsapp.net" };
      emit(secondSocket, "connection.update", { connection: "open" });
      await flush();

      expect(remote).toEqual({ exists: false, linked: false });
      expect(await sessionGroups.listPendingRetirements()).toEqual([]);
      expect(await sessionGroups.getByConversationId("session@g.us")).toBeUndefined();
      expect(events).toContainEqual({
        type: "connection",
        state: "open",
        identity: { id: "15551234567@s.whatsapp.net" },
      });
      await restarted.close();
    },
  );

  it("rejects inbound from a tombstoned session group when remote retirement fails", async () => {
    const authStore = createStatefulAuthStore(compatibleCredentials());
    const sessionGroups = new EncryptedSessionGroupStore(authStore);
    await sessionGroups.set({
      idempotencyKey: "session-a",
      conversationId: "session@g.us",
      communityConversationId: "community@g.us",
      displayName: "Session",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    const remote = { exists: true, linked: true };
    const socket = createRetirementSocket(remote, "checkpoint");
    socket.user = { id: "15551234567@s.whatsapp.net" };
    mockState.makeWASocket.mockReturnValue(socket);
    const events: WhatsAppSocketAdapterEvent[] = [];
    const adapter = await createBaileysSocketAdapter(authStore, (event) => events.push(event), {
      provisionOnOpen: false,
    });
    if (!adapter.retireSessionGroup) throw new Error("Session-group retirement is unavailable");

    emit(socket, "messages.upsert", {
      messages: [
        {
          key: { remoteJid: "session@g.us", id: "before-retirement", fromMe: true },
          message: { conversation: "Before retirement" },
          messageTimestamp: 1,
        },
      ],
    });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "message")).toHaveLength(1),
    );

    await expect(
      adapter.retireSessionGroup({
        type: "retire-session-group",
        conversationId: "session@g.us",
        communityConversationId: "community@g.us",
      }),
    ).rejects.toThrow("crash after checkpoint");

    emit(socket, "messages.upsert", {
      messages: [
        {
          key: { remoteJid: "session@g.us", id: "after-retirement", fromMe: true },
          message: { conversation: "After retirement" },
          messageTimestamp: 2,
        },
      ],
    });
    await adapter.close();

    expect(events.filter((event) => event.type === "message")).toHaveLength(1);
    expect(await sessionGroups.getByConversationId("session@g.us")).toBeUndefined();
    expect(await sessionGroups.listPendingRetirements()).toHaveLength(1);
  });
});

function createMockSocket(): MockSocket {
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    ev: {
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    },
    end: vi.fn(async () => undefined),
    _listeners: listeners,
  } as MockSocket;
}

function createRetirementSocket(
  remote: { exists: boolean; linked: boolean },
  crashStep?: "checkpoint" | "unlink" | "leave",
): MockSocket {
  const socket = createMockSocket();
  socket.groupMetadata = vi.fn(async () => {
    if (crashStep === "checkpoint") throw new Error("crash after checkpoint");
    if (!remote.exists) {
      throw Object.assign(new Error("group not found"), { output: { statusCode: 404 } });
    }
    return {
      id: "session@g.us",
      subject: "Session",
      ...(remote.linked ? { linkedParent: "community@g.us" } : {}),
    };
  });
  socket.communityUnlinkGroup = vi.fn(async () => {
    remote.linked = false;
    if (crashStep === "unlink") throw new Error("crash after unlink");
  });
  socket.groupLeave = vi.fn(async () => {
    remote.exists = false;
    if (crashStep === "leave") throw new Error("crash after leave");
  });
  return socket;
}

function emit(socket: MockSocket, event: string, value: unknown): void {
  const listeners = (
    socket as MockSocket & {
      _listeners: Map<string, (value: unknown) => void>;
    }
  )._listeners;
  const listener = listeners.get(event);
  if (!listener) throw new Error(`Missing mock listener for ${event}`);
  listener(value);
}

function createAuthStore(credentials: object | null = null) {
  return {
    readCredentials: vi.fn<WhatsAppSidecarAuthStorePort["readCredentials"]>(
      async () => credentials,
    ),
    readSignalKeys: vi.fn<WhatsAppSidecarAuthStorePort["readSignalKeys"]>(async () => ({})),
    applyTransaction: vi.fn<WhatsAppSidecarAuthStorePort["applyTransaction"]>(
      async () => undefined,
    ),
    reset: vi.fn<WhatsAppSidecarAuthStorePort["reset"]>(async () => undefined),
  } satisfies WhatsAppSidecarAuthStorePort;
}

function createStatefulAuthStore(
  credentials: WhatsAppAuthStoreValue | null,
): WhatsAppSidecarAuthStorePort {
  const categories = new Map<string, Map<string, WhatsAppAuthStoreValue>>();
  return {
    readCredentials: vi.fn<WhatsAppSidecarAuthStorePort["readCredentials"]>(
      async () => credentials,
    ),
    readSignalKeys: vi.fn<WhatsAppSidecarAuthStorePort["readSignalKeys"]>(
      async (category, ids) => {
        const values = categories.get(category);
        const found: Record<string, WhatsAppAuthStoreValue> = {};
        for (const id of ids) {
          const value = values?.get(id);
          if (value !== undefined) found[id] = value;
        }
        return found;
      },
    ),
    applyTransaction: vi.fn<WhatsAppSidecarAuthStorePort["applyTransaction"]>(
      async (update) => {
        for (const [category, entries] of Object.entries(update.signalKeys ?? {})) {
          const values = categories.get(category) ?? new Map<string, WhatsAppAuthStoreValue>();
          categories.set(category, values);
          for (const [id, value] of Object.entries(entries)) {
            if (value === null) values.delete(id);
            else values.set(id, value);
          }
        }
      },
    ),
    reset: vi.fn(async () => {
      categories.clear();
    }),
  };
}

function compatibleCredentials() {
  return {
    noiseKey: { public: new Uint8Array([1]), private: new Uint8Array([2]) },
    signedIdentityKey: { public: new Uint8Array([3]), private: new Uint8Array([4]) },
    signedPreKey: {
      keyPair: { public: new Uint8Array([5]), private: new Uint8Array([6]) },
      signature: new Uint8Array([7]),
      keyId: 1,
    },
    registrationId: 7,
    pairingEphemeralKeyPair: {
      public: new Uint8Array([8]),
      private: new Uint8Array([9]),
    },
    advSecretKey: "adv-secret",
    registered: false,
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
