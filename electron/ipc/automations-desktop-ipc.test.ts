import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
  dialog: {
    showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(() =>
      Promise.resolve({ canceled: true, filePaths: [] }),
    ),
    showMessageBox: vi.fn<() => Promise<{ response: number }>>(() =>
      Promise.resolve({ response: 2 }),
    ),
  },
}));

import type { IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { callIpc, testDouble } from "../testing/harness";
import { registerAutomationsDesktopHandlers } from "./automations-desktop-ipc";
import type { IpcDeps } from "./types";

describe("registerAutomationsDesktopHandlers — tenant policy IPC guards", () => {
  let ipcHandle: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let automationManager: {
    list: ReturnType<typeof vi.fn>;
    importAutomations: ReturnType<typeof vi.fn>;
  };
  const getWindow = () => null;

  beforeEach(() => {
    handlers = new Map();
    ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );
    automationManager = {
      list: vi.fn<() => unknown[]>(() => []),
      importAutomations: vi.fn<() => unknown[]>(() => []),
    };
  });

  function callHandler<K extends keyof IpcInvokeMap>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
    return callIpc(handlers, channel, ...args);
  }

  function register(opts?: { tenantPolicyProvider?: { get: () => Record<string, unknown> } }) {
    registerAutomationsDesktopHandlers({
      automationManager: testDouble(automationManager),
      getWindow: testDouble(getWindow),
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      ...opts,
    });
  }

  it("automations:importBundle rejects when disableAutomations is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableAutomations: true }) } });
    const result = await callHandler("automations:importBundle");
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("automations:importFromGithub rejects when disableAutomations is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableAutomations: true }) } });
    const result = await callHandler(
      "automations:importFromGithub",
      "https://github.com/owner/repo/tree/main/automations",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
  });
});
