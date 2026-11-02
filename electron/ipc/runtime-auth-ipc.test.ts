import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginResult } from "../backend/types";
import { testDouble } from "../testing/harness";
import { registerRuntimeAuthHandlers } from "./runtime-auth-ipc";

type RegisteredHandler = (...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel, handler) => {
      handlers.set(channel, handler);
    },
  );
  const sessionManager = {
    checkAuthStatus: vi
      .fn<
        () => Promise<{
          isAuthenticated: boolean;
          login?: string;
          statusMessage?: string;
        }>
      >()
      .mockResolvedValue({
        isAuthenticated: false,
        statusMessage: "Configure credentials",
      }),
    login: vi.fn<(credentials?: unknown) => Promise<LoginResult>>().mockResolvedValue({}),
    signOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  registerRuntimeAuthHandlers(
    testDouble<Parameters<typeof registerRuntimeAuthHandlers>[0]>({ sessionManager, ipcHandle }),
  );
  return { handlers, sessionManager };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runtime auth IPC", () => {
  it("returns the active backend auth status", async () => {
    const { handlers } = setup();

    await expect(handlers.get("runtimeAuth:getStatus")!()).resolves.toEqual({
      success: true,
      status: {
        isAuthenticated: false,
        login: undefined,
        statusMessage: "Configure credentials",
      },
    });
  });

  it("forwards typed login requests and serializes pending device flow state", async () => {
    const { handlers, sessionManager } = setup();
    sessionManager.login.mockResolvedValue({
      method: "device-code",
      deviceCode: "ABCD-EFGH",
      verificationUri: "https://example.test/device",
    });

    await expect(
      handlers.get("runtimeAuth:login")!(undefined, { type: "device-code" }),
    ).resolves.toEqual({
      success: true,
      state: {
        status: "pending",
        method: "device-code",
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
      },
    });
    expect(sessionManager.login).toHaveBeenCalledWith({ type: "device-code" });
  });

  it("rejects malformed secret requests before calling the backend", async () => {
    const { handlers, sessionManager } = setup();

    await expect(
      handlers.get("runtimeAuth:login")!(undefined, { type: "api-key", apiKey: "" }),
    ).resolves.toEqual({
      success: false,
      error: "Invalid runtime authentication request",
    });
    expect(sessionManager.login).not.toHaveBeenCalled();
  });

  it("delegates sign-out to the active backend", async () => {
    const { handlers, sessionManager } = setup();

    await expect(handlers.get("runtimeAuth:signOut")!()).resolves.toEqual({ success: true });
    expect(sessionManager.signOut).toHaveBeenCalledTimes(1);
  });

  it("reports backend sign-out failures", async () => {
    const { handlers, sessionManager } = setup();
    sessionManager.signOut.mockRejectedValue(new Error("Credentials could not be cleared"));

    await expect(handlers.get("runtimeAuth:signOut")!()).resolves.toEqual({
      success: false,
      error: "Error: Credentials could not be cleared",
    });
  });
});
