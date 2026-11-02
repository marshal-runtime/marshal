import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../open-external", () => ({ openExternalSafe: vi.fn<() => void>() }));

import { openExternalSafe } from "../../../open-external";
import { testDouble } from "../../../testing/harness";
import type { IpcDeps } from "../../types";
import { registerShellHandlers } from "./register";

type RegisteredHandler = (...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel, handler) => handlers.set(channel, handler),
  );
  registerShellHandlers({
    ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
  });
  return { handlers };
}

beforeEach(() => vi.clearAllMocks());

describe("shell:openExternal handler", () => {
  it("opens valid URLs and preserves success/error results", () => {
    const { handlers } = setup();
    expect(handlers.get("shell:openExternal")!({}, "https://example.com")).toEqual({
      success: true,
    });
    expect(openExternalSafe).toHaveBeenCalledWith("https://example.com");
  });

  it("does not open an empty URL or non-string value", () => {
    const { handlers } = setup();
    expect(handlers.get("shell:openExternal")!({}, "")).toEqual({ success: true });
    expect(handlers.get("shell:openExternal")!({}, null)).toEqual({ success: true });
    expect(openExternalSafe).not.toHaveBeenCalled();
  });

  it("returns the thrown error when opening fails", () => {
    vi.mocked(openExternalSafe).mockImplementation(() => {
      throw new Error("OS error");
    });
    const { handlers } = setup();
    expect(handlers.get("shell:openExternal")!({}, "https://example.com")).toEqual({
      success: false,
      error: "Error: OS error",
    });
  });
});

describe("shell:quitApp handler", () => {
  it("is registered", () => {
    expect(setup().handlers.has("shell:quitApp")).toBe(true);
  });
});
