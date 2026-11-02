import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../testing/harness";
import { registerDefaultWorkspaceHandler } from "./default-workspace";

describe("app:getDefaultWorkspaceDir handler", () => {
  it("returns the resolved workspace directory", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );

    registerDefaultWorkspaceHandler(
      testDouble<Parameters<typeof registerDefaultWorkspaceHandler>[0]>({ ipcHandle }),
      "C:\\workspace",
    );

    await expect(handlers.get("app:getDefaultWorkspaceDir")!()).resolves.toEqual({
      success: true,
      defaultWorkspaceDir: "C:\\workspace",
    });
  });
});
