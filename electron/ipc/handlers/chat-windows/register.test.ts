import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatWindowManager } from "../../../chat-window-manager";
import { testDouble } from "../../../testing/harness";
import { registerChatWindowsHandlers } from "./register";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;

type OpenFn = (
  sessionId: string,
  bounds?: { x: number; y: number },
) => { success: true; alreadyOpen: boolean };

function registerHandlers(manager: Pick<ChatWindowManager, "open">) {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    },
  );

  registerChatWindowsHandlers({
    ipcHandle: testDouble<import("../../types").IpcDeps["ipcHandle"]>(ipcHandle),
    chatWindowManager: testDouble<ChatWindowManager>(manager),
  });

  return handlers;
}

describe("registerChatWindowsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers chat-windows:open", () => {
    const manager = { open: vi.fn<OpenFn>(() => ({ success: true as const, alreadyOpen: false })) };
    const handlers = registerHandlers(manager);

    expect([...handlers.keys()]).toEqual(["chat-windows:open"]);
  });

  it("delegates to ChatWindowManager.open and returns alreadyOpen=false for new windows", () => {
    const manager = { open: vi.fn<OpenFn>(() => ({ success: true as const, alreadyOpen: false })) };
    const handlers = registerHandlers(manager);

    const result = handlers.get("chat-windows:open")?.({}, "session-1");

    expect(manager.open).toHaveBeenCalledWith("session-1", undefined);
    expect(result).toEqual({ success: true, alreadyOpen: false });
  });

  it("forwards drop-location bounds to ChatWindowManager.open", () => {
    const manager = { open: vi.fn<OpenFn>(() => ({ success: true as const, alreadyOpen: false })) };
    const handlers = registerHandlers(manager);

    handlers.get("chat-windows:open")?.({}, "session-1", { x: 1234, y: 567 });

    expect(manager.open).toHaveBeenCalledWith("session-1", { x: 1234, y: 567 });
  });

  it("returns alreadyOpen=true when the manager reports a duplicate", () => {
    const manager = { open: vi.fn<OpenFn>(() => ({ success: true as const, alreadyOpen: true })) };
    const handlers = registerHandlers(manager);

    const result = handlers.get("chat-windows:open")?.({}, "session-1");

    expect(result).toEqual({ success: true, alreadyOpen: true });
  });

  it("rejects an empty sessionId without invoking the manager", () => {
    const manager = { open: vi.fn<OpenFn>() };
    const handlers = registerHandlers(manager);

    const result = handlers.get("chat-windows:open")?.({}, "");

    expect(manager.open).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "sessionId is required" });
  });

  it("rejects a non-string sessionId without invoking the manager", () => {
    const manager = { open: vi.fn<OpenFn>() };
    const handlers = registerHandlers(manager);

    const result = handlers.get("chat-windows:open")?.({}, 42 as unknown);

    expect(manager.open).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "sessionId is required" });
  });

  // The handler accepts `bounds?: { x: number; y: number }` at the TS layer,
  // but the IPC payload is JSON — a malicious or buggy renderer could pass
  // `null` or NaN. Validate at the runtime boundary.
  it.each([
    ["null", null],
    ["NaN x", { x: NaN, y: 0 }],
    ["NaN y", { x: 0, y: NaN }],
    ["non-object", "1200,600"],
  ])("rejects malformed bounds (%s) without invoking the manager", (_label, bounds) => {
    const manager = { open: vi.fn<OpenFn>() };
    const handlers = registerHandlers(manager);

    const result = handlers.get("chat-windows:open")?.({}, "session-1", bounds as unknown);

    expect(manager.open).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "bounds.x and bounds.y must be finite numbers",
    });
  });
});
