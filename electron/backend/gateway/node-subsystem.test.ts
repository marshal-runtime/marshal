import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockEncryptString,
  mockDecryptString,
  mockIsEncryptionAvailable,
  mockWriteFile,
  mockWriteFileSync,
  mockMkdir,
  mockExistsSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockEncryptString: vi.fn<(s: string) => Buffer>((s: string) => Buffer.from(`enc:${s}`)),
  mockDecryptString: vi.fn<(b: Buffer) => string>((b: Buffer) => b.toString().replace(/^enc:/, "")),
  mockIsEncryptionAvailable: vi.fn<() => boolean>(() => true),
  mockWriteFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockWriteFileSync: vi.fn<(path: string, data: string) => void>(() => undefined),
  mockMkdir: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockExistsSync: vi.fn<() => boolean>(() => false),
  mockReadFileSync: vi.fn<() => string>(() => ""),
}));

vi.mock("../../platform/extensions/mcp-credential-codec", () => ({
  encryptString: mockEncryptString,
  decryptString: mockDecryptString,
  isEncryptionAvailable: mockIsEncryptionAvailable,
  deserializeServer: (s: unknown) => s,
  serializeServer: (s: unknown) => s,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  };
});

vi.mock("../../platform-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../platform-security")>();
  return {
    ...actual,
    secureMkdir: mockMkdir,
    secureWriteFile: mockWriteFile,
    secureWriteFileSync: mockWriteFileSync,
  };
});

vi.mock("../../app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));

vi.mock("../../telemetry-errors", () => ({
  sendErrorTelemetry: vi.fn<() => void>(),
}));

async function createStore() {
  const { McpStore } = await import("../../mcp-store");
  return new McpStore("/home/user/.marshal/marshal-mcp-servers.json");
}

const TEST_CONFIG = {
  gatewayUrl: "ws://localhost:8001/v1/marshal-gateway",
  hostedGatewayUrl: "wss://example.com/v1/marshal-gateway",
  deviceIdentityPath: "/home/user/.marshal/marshal/device-identity.json",
  gatewayToken: "test-token",
};

async function createSubsystem(store: Awaited<ReturnType<typeof createStore>>) {
  const { GatewayNodeSubsystem } = await import("./node-subsystem");
  return new GatewayNodeSubsystem({
    config: TEST_CONFIG,
    mcpStore: store,
    acquireGatewayToken: async () => undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue("");
});

describe("GatewayNodeSubsystem.getExposedServers", () => {
  it("returns servers with the flag and their last-discovered tools", async () => {
    const store = await createStore();
    store.addServer({
      name: "Node Tool",
      type: "command",
      command: "node-mcp",
      exposeAsGatewayNodeCommand: true,
    });
    store.updateToolDiscovery({
      node_tool: { tools: [{ name: "do_work", description: "Does work" }] },
    });

    const subsystem = await createSubsystem(store);
    const result = subsystem.getExposedServers();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Node Tool");
    expect(result[0].tools).toEqual([{ name: "do_work", description: "Does work" }]);
  });

  it("excludes servers without the flag, even when they have tools", async () => {
    const store = await createStore();
    store.addServer({ name: "Normal Server", type: "command", command: "normal" });
    store.updateToolDiscovery({
      normal_server: { tools: [{ name: "some_tool", description: "A tool" }] },
    });

    const subsystem = await createSubsystem(store);
    const result = subsystem.getExposedServers();

    expect(result.map((r) => r.name)).not.toContain("Normal Server");
  });

  it("returns empty tools list for a flagged server with no discovered tools yet", async () => {
    const store = await createStore();
    store.addServer({
      name: "New Node Server",
      type: "command",
      command: "new-node-mcp",
      exposeAsGatewayNodeCommand: true,
    });

    const subsystem = await createSubsystem(store);
    const result = subsystem.getExposedServers();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("New Node Server");
    expect(result[0].tools).toEqual([]);
  });

  it("flag survives addServer round-trip via getCustomServers", async () => {
    const store = await createStore();
    store.addServer({
      name: "Round Trip",
      type: "command",
      command: "rt-mcp",
      exposeAsGatewayNodeCommand: true,
    });

    const custom = store.getCustomServers();
    const server = custom.find((s) => s.name === "Round Trip");
    expect(server).toBeDefined();
    expect(server!.exposeAsGatewayNodeCommand).toBe(true);
  });
});
