import { describe, expect, it, vi } from "vitest";

import {
  WhatsAppConnectionController,
  type WhatsAppConnectionControllerOptions,
} from "./connection-controller";
import type {
  WhatsAppConnectionEvent,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./sidecar/protocol";

describe("WhatsAppConnectionController", () => {
  it("launches the sidecar lazily and forwards explicit lifecycle commands", async () => {
    const listeners = new Set<(event: WhatsAppConnectionEvent) => void>();
    const events: WhatsAppConnectionEvent[] = [];
    const client = {
      subscribe: vi.fn<(listener: (event: WhatsAppConnectionEvent) => void) => () => void>(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      ),
      start: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => Promise<void>>(async () => undefined),
      resetAndStart: vi.fn<() => Promise<void>>(async () => undefined),
      provisionManagedGroups: vi.fn<() => Promise<void>>(async () => undefined),
      sendText: vi.fn<
        (
          request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
        ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>>
      >(async () => ({
        type: "send-text",
        providerMessageId: "message-1",
        sentAt: "2026-08-08T12:00:00.000Z",
      })),
      ensureSessionGroup: vi.fn<
        (
          request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
        ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>>
      >(async () => ({
        type: "ensure-session-group",
        conversationId: "session@g.us",
        displayName: "Session",
        communityConversationId: "community@g.us",
        disposition: "existing",
      })),
      retireSessionGroup: vi.fn<
        (
          request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
        ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>>
      >(async () => ({
        type: "retire-session-group",
        conversationId: "session@g.us",
        unlinked: true,
        left: true,
      })),
      shutdown: vi.fn<() => Promise<void>>(async () => undefined),
    };
    const launchSidecar = vi.fn<NonNullable<WhatsAppConnectionControllerOptions["launchSidecar"]>>(
      async () => client,
    );
    const controller = new WhatsAppConnectionController({
      launch: {
        mode: "development",
        sidecarPath: "C:\\absolute\\whatsapp-sidecar.mjs",
        nodeExecutable: "C:\\absolute\\node.exe",
      },
      authStore: {
        readCredentials: () => null,
        readSignalKeys: () => ({}),
        applyTransaction: () => undefined,
        resetAfterTerminalDisconnect: () => undefined,
      },
      launchSidecar,
    });
    controller.subscribe((event) => events.push(event));

    expect(launchSidecar).not.toHaveBeenCalled();
    await controller.stop();
    expect(launchSidecar).not.toHaveBeenCalled();

    await controller.startPairing();
    expect(launchSidecar).toHaveBeenCalledOnce();
    expect(client.start).toHaveBeenCalledOnce();

    for (const listener of listeners) {
      listener({
        type: "error",
        code: "SIDECAR_FAILED",
        message: "WhatsApp sidecar process failed.",
      });
    }
    for (const listener of [...listeners]) {
      listener({ type: "status", status: "stopped", attempt: 0 });
    }
    expect(events.slice(-2)).toEqual([
      {
        type: "error",
        code: "SIDECAR_FAILED",
        message: "WhatsApp sidecar process failed.",
      },
      { type: "status", status: "stopped", attempt: 0 },
    ]);
    await controller.startPairing();
    expect(launchSidecar).toHaveBeenCalledTimes(2);
    expect(client.start).toHaveBeenCalledTimes(2);

    await controller.resetAndPair();
    expect(launchSidecar).toHaveBeenCalledTimes(2);
    expect(client.resetAndStart).toHaveBeenCalledOnce();

    await expect(
      controller.retireSessionGroup({
        type: "retire-session-group",
        conversationId: "session@g.us",
        communityConversationId: "community@g.us",
      }),
    ).resolves.toMatchObject({ unlinked: true, left: true });

    await controller.shutdown();
    expect(client.shutdown).toHaveBeenCalledOnce();
  });
});
