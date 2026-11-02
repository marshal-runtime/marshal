import { describe, expect, it, vi } from "vitest";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import type { WhatsAppConnectionEvent } from "./protocol";
import {
  type CreateWhatsAppSocketAdapter,
  type WhatsAppSocketAdapterEvent,
  WhatsAppSidecarStateError,
  WhatsAppSocketController,
} from "./socket-controller";

describe("WhatsAppSocketController", () => {
  it("does not create a socket until start is explicitly requested", async () => {
    const harness = createHarness();

    expect(harness.createSocket).not.toHaveBeenCalled();
    await harness.controller.shutdown();
    expect(harness.createSocket).not.toHaveBeenCalled();
  });

  it("emits the QR lifecycle and connected identity", async () => {
    const harness = createHarness();
    await harness.controller.start();

    harness.emit(0, { type: "connection", state: "connecting" });
    await flush();
    harness.emit(0, { type: "connection", state: "qr", qr: "qr-secret" });
    await flush();
    harness.emit(0, {
      type: "connection",
      state: "open",
      identity: {
        id: "15551234567@s.whatsapp.net",
        phoneNumber: "15551234567",
        displayName: "Linked account",
      },
    });
    await flush();

    expect(harness.events).toEqual([
      { type: "status", status: "starting", attempt: 0 },
      { type: "status", status: "connecting", attempt: 0 },
      { type: "status", status: "awaiting-qr", attempt: 0 },
      { type: "setup", phase: "qr", qr: "qr-secret", sequence: 1 },
      { type: "status", status: "connected", attempt: 0 },
      { type: "setup", phase: "complete" },
      {
        type: "connected",
        identity: {
          id: "15551234567@s.whatsapp.net",
          phoneNumber: "15551234567",
          displayName: "Linked account",
        },
      },
    ]);
  });

  it("reconnects retryable disconnects with capped exponential backoff", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      reconnectPolicy: { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0 },
    });
    await harness.controller.start();

    harness.emit(0, {
      type: "connection",
      state: "close",
      classification: "retryable",
      reason: "connection-lost",
      statusCode: 408,
    });
    await flush();
    expect(harness.events).toContainEqual({
      type: "disconnected",
      classification: "retryable",
      reason: "connection-lost",
      statusCode: 408,
      retryInMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
    harness.emit(1, {
      type: "connection",
      state: "close",
      classification: "retryable",
      reason: "connection-closed",
      statusCode: 428,
    });
    await flush();
    expect(harness.events).toContainEqual({
      type: "disconnected",
      classification: "retryable",
      reason: "connection-closed",
      statusCode: 428,
      retryInMs: 200,
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(harness.createSocket).toHaveBeenCalledTimes(3);
    harness.emit(2, {
      type: "connection",
      state: "close",
      classification: "retryable",
      reason: "unavailable-service",
      statusCode: 503,
    });
    await flush();
    expect(harness.events).toContainEqual({
      type: "disconnected",
      classification: "retryable",
      reason: "unavailable-service",
      statusCode: 503,
      retryInMs: 250,
    });
    vi.useRealTimers();
  });

  it("blocks terminal reconnects until reset clears encrypted auth state", async () => {
    const harness = createHarness();
    await harness.controller.start();
    harness.emit(0, {
      type: "connection",
      state: "close",
      classification: "terminal",
      reason: "logged-out",
      statusCode: 401,
    });
    await flush();

    expect(harness.events).toContainEqual({
      type: "status",
      status: "requires-reset",
      attempt: 0,
    });
    await expect(harness.controller.start()).rejects.toBeInstanceOf(WhatsAppSidecarStateError);
    expect(harness.authStore.reset).not.toHaveBeenCalled();

    await harness.controller.resetAndStart();
    expect(harness.authStore.reset).toHaveBeenCalledOnce();
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly and cancels a pending reconnect", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      reconnectPolicy: { baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 },
    });
    await harness.controller.start();
    harness.emit(0, {
      type: "connection",
      state: "close",
      classification: "retryable",
      reason: "connection-lost",
    });
    await flush();

    await harness.controller.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.createSocket).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not acknowledge a clean stop when pending auth persistence failed", async () => {
    const harness = createHarness({ closeError: new Error("auth write failed") });
    await harness.controller.start();

    await expect(harness.controller.stop()).rejects.toThrow(/auth write failed/);
    expect(harness.events).toContainEqual({
      type: "status",
      status: "stopped",
      attempt: 0,
    });
  });

  it("serializes session-group retirement through the active adapter", async () => {
    const harness = createHarness();
    await harness.controller.start();

    await expect(
      harness.controller.retireSessionGroup({
        type: "retire-session-group",
        conversationId: "session@g.us",
        communityConversationId: "community@g.us",
      }),
    ).resolves.toMatchObject({ unlinked: true, left: true });
    expect(harness.retireSessionGroup).toHaveBeenCalledOnce();
  });
});

function createHarness(options?: {
  reconnectPolicy?: { baseDelayMs: number; maxDelayMs: number; jitterRatio: number };
  closeError?: Error;
}) {
  const events: WhatsAppConnectionEvent[] = [];
  const callbacks: Array<(event: WhatsAppSocketAdapterEvent) => void> = [];
  const close = vi.fn<() => Promise<void>>(async () => {
    if (options?.closeError) throw options.closeError;
  });
  const retireSessionGroup = vi.fn(async (request: {
    type: "retire-session-group";
    conversationId: string;
    communityConversationId: string;
  }) => ({
    type: "retire-session-group" as const,
    conversationId: request.conversationId,
    unlinked: true,
    left: true,
  }));
  const createSocket = vi.fn<CreateWhatsAppSocketAdapter>(async (_authStore, onEvent) => {
    callbacks.push(onEvent);
    return { close, retireSessionGroup };
  });
  const authStore = {
    readCredentials: vi.fn(async () => null),
    readSignalKeys: vi.fn(async () => ({})),
    applyTransaction: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  } satisfies WhatsAppSidecarAuthStorePort;
  const controller = new WhatsAppSocketController({
    authStore,
    createSocket,
    emitEvent: (event) => events.push(event),
    reconnectPolicy: options?.reconnectPolicy,
    random: () => 0.5,
  });
  return {
    authStore,
    close,
    controller,
    createSocket,
    emit(index: number, event: WhatsAppSocketAdapterEvent) {
      callbacks[index](event);
    },
    events,
    retireSessionGroup,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
