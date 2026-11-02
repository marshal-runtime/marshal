/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Unit test captures a single known registration and supplies an unused desktop event. */
import { describe, it, expect, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { sharedIpcHandle, invokeSharedHandler } from "./shared-handlers";

describe("explicitly shared handlers", () => {
  it("runs the same application operation for desktop and remote without a fake sender", async () => {
    let desktop: IpcHandler<"sessions:mark-read"> | undefined;
    const register = <C extends keyof IpcInvokeMap>(_channel: C, handler: IpcHandler<C>) => {
      desktop = handler as IpcHandler<"sessions:mark-read">;
    };
    const handler = vi.fn<(id: string) => Promise<{ success: boolean }>>(async () => ({
      success: true,
    }));
    sharedIpcHandle(register)("sessions:mark-read", handler);
    // The operation has no dependency on the Electron event. Desktop auth remains in createIpcHandle.
    await desktop!(undefined as never, "session-a");
    await invokeSharedHandler("sessions:mark-read", ["session-b"]);
    expect(handler.mock.calls).toEqual([["session-a"], ["session-b"]]);
  });
  it("does not expose arbitrary handlers", async () => {
    await expect(invokeSharedHandler("not-registered", [])).rejects.toThrow(
      "Unavailable remote operation",
    );
  });
});
