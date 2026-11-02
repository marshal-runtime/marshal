import { describe, expect, it, vi } from "vitest";

import type { UserIdentity } from "../../common/marshal-ipc-contract";
import { testDouble } from "../testing/harness";
import type { IdentityController } from "./identity-ipc";
import { registerIdentityHandlers } from "./identity-ipc";
import type { IpcDeps } from "./types";

describe("registerIdentityHandlers", () => {
  it("registers identity:get and returns the composed identity", async () => {
    const identity: UserIdentity = {
      isAuthenticated: true,
      displayName: "Jane Smith",
      subtitle: "janesmith",
      accountName: "jane@example.com",
      avatarUrl: null,
      statusColor: "success",
      statusText: "Connected",
      integrations: [],
      signOut: { title: "Sign out?", description: "", confirmLabel: "Sign out" },
    };
    const controller = testDouble<IdentityController>({
      get: vi.fn<() => Promise<UserIdentity>>().mockResolvedValue(identity),
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => handlers.set(channel, handler),
    );

    registerIdentityHandlers(
      testDouble<Pick<IpcDeps, "ipcHandle">>({
        ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      }),
      controller,
    );

    const handler = handlers.get("identity:get")!;
    await expect(handler({})).resolves.toEqual({ success: true, identity });
  });
});
