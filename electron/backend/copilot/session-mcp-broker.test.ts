import type { MCPServerConfig } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  default: { existsSync: vi.fn<() => boolean>(() => false), constants: { X_OK: 1 } },
  existsSync: vi.fn<() => boolean>(() => false),
  constants: { X_OK: 1 },
}));
vi.mock("child_process", () => ({ spawn: vi.fn<() => void>(), execFile: vi.fn<() => void>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0-test", getPath: () => "/tmp" },
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn<() => void>(),
  CopilotSession: vi.fn<() => void>(),
}));
vi.mock("../../marshal-fs/tools", () => ({ getSelfFsTools: vi.fn<() => unknown[]>(() => []) }));
vi.mock("../../self-tools", () => ({ getSelfTools: vi.fn<() => unknown[]>(() => []) }));

import { testDouble } from "../../testing/harness";
import type { RuntimeSessionConfig } from "../runtime-contract";
import type { CopilotClientSubset, CopilotSessionSubset } from "./internal";
import type { ICopilotProviderForSession } from "./internal";
import { CopilotSessionBackend } from "./session";

const facadeConfig: Record<string, MCPServerConfig> = {
  example: {
    type: "http",
    url: "http://127.0.0.1:43123/mcp/capability",
    headers: { Authorization: "Bearer token" },
  },
};

function createHarness(options: { config: Record<string, MCPServerConfig>; createError?: Error }) {
  const listMcp = vi.fn<() => Promise<unknown>>(async () => ({}));
  const unsubscribe = vi.fn<() => void>();
  const sdkSession = testDouble<CopilotSessionSubset>({
    sessionId: "sdk-1",
    rpc: testDouble<CopilotSessionSubset["rpc"]>({
      mcp: testDouble<NonNullable<CopilotSessionSubset["rpc"]>["mcp"]>({ list: listMcp }),
    }),
    on: vi.fn<CopilotSessionSubset["on"]>(() => unsubscribe),
    destroy: vi.fn<CopilotSessionSubset["destroy"]>(async () => undefined),
    disconnect: vi.fn<CopilotSessionSubset["disconnect"]>(async () => undefined),
  });
  const createSession = vi.fn<CopilotClientSubset["createSession"]>(async () => {
    if (options.createError) throw options.createError;
    return sdkSession;
  });
  const deleteSession = vi.fn<NonNullable<CopilotClientSubset["deleteSession"]>>(
    async () => undefined,
  );
  const client = testDouble<CopilotClientSubset>({ createSession, deleteSession });
  const prepareMcpConfig = vi.fn<NonNullable<ICopilotProviderForSession["prepareMcpConfig"]>>(
    async () => options.config,
  );
  const releaseMcpSession = vi.fn<NonNullable<ICopilotProviderForSession["releaseMcpSession"]>>(
    async () => undefined,
  );
  let activeSession: CopilotSessionSubset | undefined;
  const provider = testDouble<ICopilotProviderForSession>({
    getClient: () => client,
    initClient: async () => undefined,
    getWorkspaceDir: () => "C:/workspace",
    getMcpConfig: () => options.config,
    prepareMcpConfig,
    releaseMcpSession,
    getActiveSession: () => activeSession,
    setActiveSession: (_sessionId: string, session: CopilotSessionSubset) => {
      activeSession = session;
    },
    deleteActiveSession: () => {
      activeSession = undefined;
    },
    getSessionSubscribers: () => undefined,
    ensureSessionSubscribers: () => new Set(),
    deleteSessionSubscribers: () => undefined,
    getApprovalCallback: () => null,
    getPermissionPolicy: () => null,
    getSelfToolDeps: () => null,
    getInterceptFileChooser: () => false,
    getTimezone: () => "UTC",
  });
  return {
    backend: new CopilotSessionBackend(provider),
    createSession,
    deleteSession,
    getActiveSession: () => activeSession,
    listMcp,
    prepareMcpConfig,
    releaseMcpSession,
    sdkSession,
  };
}

function createdConfig(
  createSession: ReturnType<typeof vi.fn<CopilotClientSubset["createSession"]>>,
): RuntimeSessionConfig {
  const config = createSession.mock.calls[0]?.[0];
  if (!config) throw new Error("SDK createSession was not called");
  return config;
}

describe("CopilotSessionBackend MCP broker boundary", () => {
  it("omits mcpServers and does not initialize the SDK MCP host for an empty scope", async () => {
    const harness = createHarness({ config: {} });
    await harness.backend.create({ sessionId: "empty" });

    expect(createdConfig(harness.createSession)).not.toHaveProperty("mcpServers");
    expect(harness.listMcp).not.toHaveBeenCalled();
  });

  it("preserves MCP keys without prewarming an interactive session", async () => {
    const harness = createHarness({ config: facadeConfig });
    await harness.backend.create({ sessionId: "interactive" });

    expect(createdConfig(harness.createSession).mcpServers).toBe(facadeConfig);
    expect(harness.listMcp).not.toHaveBeenCalled();
  });

  it("does not eagerly initialize MCP for automated sessions", async () => {
    const harness = createHarness({ config: facadeConfig });
    await harness.backend.create({ sessionId: "automation", isAutomatedSession: true });

    expect(createdConfig(harness.createSession).mcpServers).toBe(facadeConfig);
    expect(harness.listMcp).not.toHaveBeenCalled();
  });

  it("releases facade capabilities when SDK session creation fails", async () => {
    const harness = createHarness({
      config: facadeConfig,
      createError: new Error("create failed"),
    });

    await expect(harness.backend.create({ sessionId: "failed" })).rejects.toThrow("create failed");
    expect(harness.releaseMcpSession).toHaveBeenCalledWith("failed");
  });

  it("releases facade capabilities on disconnect and destroy", async () => {
    const disconnectHarness = createHarness({ config: facadeConfig });
    await disconnectHarness.backend.create({ sessionId: "disconnect" });
    await disconnectHarness.backend.disconnect("disconnect");
    expect(disconnectHarness.releaseMcpSession).toHaveBeenCalledWith("disconnect");

    const destroyHarness = createHarness({ config: facadeConfig });
    await destroyHarness.backend.create({ sessionId: "destroy" });
    await destroyHarness.backend.destroy("destroy");
    expect(destroyHarness.releaseMcpSession).toHaveBeenCalledWith("destroy");
    expect(destroyHarness.deleteSession).toHaveBeenCalledWith("sdk-1");
  });

  it("does not retain an active session when SDK destruction fails", async () => {
    const harness = createHarness({ config: facadeConfig });
    await harness.backend.create({ sessionId: "destroy-failure" });
    vi.mocked(harness.sdkSession.destroy).mockRejectedValueOnce(new Error("destroy failed"));

    await expect(harness.backend.destroy("destroy-failure")).rejects.toThrow("destroy failed");

    expect(harness.getActiveSession()).toBeUndefined();
  });
});
