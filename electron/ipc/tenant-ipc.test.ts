import { describe, it, expect, vi, beforeEach } from "vitest";

import type { TenantPolicy } from "../tenant-policy";
import { testDouble } from "../testing/harness";
import { registerTenantHandlers } from "./tenant-ipc";
import type { IpcDeps } from "./types";

describe("registerTenantHandlers", () => {
  let ipcHandle: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    handlers = new Map();
    ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );
  });

  function callHandler(channel: string) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({} as unknown);
  }

  function makeProvider(policy: TenantPolicy, managed: boolean) {
    return { get: () => policy, isTenantManaged: () => managed };
  }

  it("registers the tenant:getStatus channel", () => {
    registerTenantHandlers({
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      tenantPolicyProvider: makeProvider({}, false),
    });
    expect(ipcHandle).toHaveBeenCalledWith("tenant:getStatus", expect.any(Function));
  });

  it("returns unmanaged status when no policy is active", () => {
    registerTenantHandlers({
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      tenantPolicyProvider: makeProvider({}, false),
    });
    const result = callHandler("tenant:getStatus");
    expect(result).toEqual({
      success: true,
      managed: false,
      disabledServers: [],
      disabledPermissionKinds: [],
      forcePrompt: false,
      disabledModels: [],
      disableHeartbeat: false,
      disableAutomations: false,
      disabledProviders: [],
      restrictToWorkspace: false,
      browserEgressBlockedOrigins: [],
    });
  });

  it("returns managed status with policy fields", () => {
    registerTenantHandlers({
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      tenantPolicyProvider: makeProvider(
        { disabledServers: ["ExampleMcp"], disabledPermissionKinds: ["shell"], forcePrompt: true },
        true,
      ),
    });
    const result = callHandler("tenant:getStatus");
    expect(result).toEqual({
      success: true,
      managed: true,
      disabledServers: ["ExampleMcp"],
      disabledPermissionKinds: ["shell"],
      forcePrompt: true,
      disabledModels: [],
      disableHeartbeat: false,
      disableAutomations: false,
      disabledProviders: [],
      restrictToWorkspace: false,
      browserEgressBlockedOrigins: [],
    });
  });

  it("defaults arrays and boolean when fields are undefined", () => {
    registerTenantHandlers({
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      tenantPolicyProvider: makeProvider({ version: 1 }, true),
    });
    const result = callHandler("tenant:getStatus");
    expect(result).toEqual({
      success: true,
      managed: true,
      disabledServers: [],
      disabledPermissionKinds: [],
      forcePrompt: false,
      disabledModels: [],
      disableHeartbeat: false,
      disableAutomations: false,
      disabledProviders: [],
      restrictToWorkspace: false,
      browserEgressBlockedOrigins: [],
    });
  });

  it("returns Phase 3 fields when present in policy", () => {
    registerTenantHandlers({
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      tenantPolicyProvider: makeProvider(
        {
          disabledModels: ["o3-mini"],
          disableHeartbeat: true,
          disableAutomations: true,
        },
        true,
      ),
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing IPC result for assertion
    const result = callHandler("tenant:getStatus") as Record<string, unknown>;
    expect(result.disabledModels).toEqual(["o3-mini"]);
    expect(result.disableHeartbeat).toBe(true);
    expect(result.disableAutomations).toBe(true);
  });
});
