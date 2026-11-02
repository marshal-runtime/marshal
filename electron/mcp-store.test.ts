import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeMcpError, mcpErrors } from "../common/telemetry/errors/marshal-mcp";

const {
  mockEncryptString,
  mockDecryptString,
  mockIsEncryptionAvailable,
  mockWriteFile,
  mockWriteFileSync,
  mockMkdir,
  mockExistsSync,
  mockReadFileSync,
  mockMcpConnect,
  mockMcpListTools,
  mockMcpClose,
  mockSendErrorTelemetry,
} = vi.hoisted(() => ({
  mockEncryptString: vi.fn<(s: string) => Buffer>((s: string) => Buffer.from(`enc:${s}`)),
  mockDecryptString: vi.fn<(b: Buffer) => string>((b: Buffer) => b.toString().replace(/^enc:/, "")),
  mockIsEncryptionAvailable: vi.fn<() => boolean>(() => true),
  mockWriteFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockWriteFileSync: vi.fn<(path: string, data: string) => void>(() => undefined),
  mockMkdir: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockExistsSync: vi.fn<() => boolean>(() => false),
  mockReadFileSync: vi.fn<() => string>(() => ""),
  mockMcpConnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockMcpListTools: vi.fn<() => Promise<{ tools: { name: string; description?: string }[] }>>(() =>
    Promise.resolve({ tools: [] }),
  ),
  mockMcpClose: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockSendErrorTelemetry: vi.fn<(err: unknown, cause?: unknown) => void>(),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: vi.fn<() => void>(),
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    promises: { mkdir: mockMkdir, writeFile: mockWriteFile },
  },
  existsSync: mockExistsSync,
  mkdirSync: vi.fn<() => void>(),
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  promises: { mkdir: mockMkdir, writeFile: mockWriteFile },
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: mockIsEncryptionAvailable,
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
  },
}));
vi.mock("./app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect() {
      return mockMcpConnect();
    }
    listTools() {
      return mockMcpListTools();
    }
    close() {
      return mockMcpClose();
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- mock constructor
  StdioClientTransport: class MockTransport {},
}));
vi.mock("./telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
  hasTelemetryMarker: () => false,
}));

import { mockCallArg } from "./testing/harness";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockIsEncryptionAvailable.mockReturnValue(true);
  mockEncryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  mockDecryptString.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ""));
  mockExistsSync.mockReturnValue(false);
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockMcpConnect.mockResolvedValue(undefined);
  mockMcpListTools.mockResolvedValue({ tools: [] });
  mockMcpClose.mockResolvedValue(undefined);
});

async function createStore() {
  const { McpStore } = await import("./mcp-store");
  const store = new McpStore("/home/user/.marshal/marshal-mcp-servers.json");
  // The disk read is deferred out of the constructor (Electron #45328); reload()
  // is what main.ts calls post-app-ready. Mirror that here so tests load their seed.
  store.reload();
  return store;
}

function lastWrittenJson() {
  return JSON.parse(mockCallArg<string>(mockWriteFile, mockWriteFile.mock.calls.length - 1, 1));
}

describe("McpStore", () => {
  describe("constructor defers disk read (Electron #45328)", () => {
    it("does not decrypt tokens in the constructor — defers to reload()", async () => {
      mockExistsSync.mockReturnValue(true);
      // Matches what serializeServer writes: base64(encryptString("secret-token")),
      // and the mock encryptString prefixes "enc:" / decryptString strips it.
      const accessTokenEncrypted = Buffer.from("enc:secret-token").toString("base64");
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            remote_oauth: {
              builtin: false,
              config: {
                name: "Remote",
                url: "https://remote.example.com",
                oauthAlias: "alice",
                accessTokenEncrypted,
              },
              tools: [],
            },
          },
        }),
      );

      const { McpStore } = await import("./mcp-store");
      const store = new McpStore("/home/user/.marshal/marshal-mcp-servers.json");
      // Constructor must NOT touch safeStorage — a pre-app-ready decrypt locks the
      // macOS keychain item name to "Chromium Safe Storage" (Electron #45328).
      expect(mockDecryptString).not.toHaveBeenCalled();
      expect(store.getAll().servers.remote_oauth).toBeUndefined();

      // reload() (invoked post-app-ready from main.ts) performs the decrypt.
      store.reload();
      expect(mockDecryptString).toHaveBeenCalled();
      const cfg = store.getAll().servers.remote_oauth.config!;
      expect("url" in cfg && cfg.accessToken).toBe("secret-token");
    });

    it("initPostReady runs reload → migrateFromSettings → pruneStaleOAuthTokens in order", async () => {
      const { McpStore } = await import("./mcp-store");
      const store = new McpStore("/home/user/.marshal/marshal-mcp-servers.json");
      const order: string[] = [];
      vi.spyOn(store, "reload").mockImplementation(() => {
        order.push("reload");
      });
      vi.spyOn(store, "migrateFromSettings").mockImplementation(() => {
        order.push("migrate");
      });
      vi.spyOn(store, "pruneStaleOAuthTokens").mockImplementation(() => {
        order.push("prune");
      });

      store.initPostReady();
      // migrate/prune mutate in-memory `this.data`, so they must run after reload().
      expect(order).toEqual(["reload", "migrate", "prune"]);
    });
  });

  describe("loadFromDisk", () => {
    it("returns seeded builtins when file does not exist", async () => {
      const store = await createStore();
      const data = store.getAll();
      expect(data.servers.filesystem).toBeDefined();
      expect(data.servers.filesystem.builtin).toBe(true);
      expect(data.servers.filesystem.tools).toEqual([]);
      expect(data.servers.playwright).toBeDefined();
      expect(data.servers.playwright.builtin).toBe(true);
      expect(data.servers.playwright.tools).toEqual([]);
    });

    it("loads existing data from disk", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            filesystem: { builtin: true, tools: ["read_file"] },
            my_server: {
              builtin: false,
              config: { name: "My Server", type: "command", command: "npx", args: ["serve"] },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();
      const data = store.getAll();
      expect(data.servers.filesystem.tools).toHaveLength(1);
      expect(data.servers.my_server.config!.name).toBe("My Server");
    });

    it("normalizes persisted type 'stdio' to canonical type 'command'", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            my_srv: {
              builtin: false,
              config: { name: "M", type: "stdio", command: "npx", args: [] },
              tools: [],
            },
          },
        }),
      );

      const store = await createStore();
      expect(store.getAll().servers.my_srv.config?.type).toBe("command");
    });

    it("falls back to defaults on invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");
      const store = await createStore();
      // Should have seeded builtins
      expect(store.getAll().servers.filesystem).toBeDefined();
    });

    it("fires CONFIG_PARSE_FAILED on invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not json");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await createStore();

      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        makeMcpError(mcpErrors.CONFIG_PARSE_FAILED),
      );
      errSpy.mockRestore();
    });

    it("falls back to defaults on schema validation failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ servers: "not-an-object" }));
      const store = await createStore();
      expect(store.getAll().servers.filesystem).toBeDefined();
    });

    it("fires CONFIG_INVALID on schema validation failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ servers: "not-an-object" }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await createStore();

      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(makeMcpError(mcpErrors.CONFIG_INVALID));
      warnSpy.mockRestore();
    });

    it("preserves a valid per-server timeout across load → mutate → save", async () => {
      // Seed the on-disk JSON with a custom server that has a `timeout` field —
      // exactly the workaround the bug reporter applied to marshal-mcp-servers.json.
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            slow_server: {
              builtin: false,
              config: {
                name: "Slow Server",
                type: "command",
                command: "slow",
                args: [],
                timeout: 1_800_000,
              },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();

      // Mutate the store to trigger saveToDisk(), then flush the pending write.
      // This is the exact bug reproduction: load JSON containing ``timeout``,
      // perform any mutation, and assert the rewritten file still has the field.
      store.addServer({ name: "Other", type: "command", command: "echo" });
      await store.flush();

      const written = lastWrittenJson();
      expect(written.servers.slow_server.config.timeout).toBe(1_800_000);
    });

    it("preserves timeout on URL-based servers across load → mutate → save", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            remote: {
              builtin: false,
              config: { name: "Remote", url: "https://example.com", timeout: 90_000 },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();
      // Mutate to trigger a rewrite, then flush.
      store.addServer({ name: "Other", type: "command", command: "echo" });
      await store.flush();

      const written = lastWrittenJson();
      expect(written.servers.remote.config.timeout).toBe(90_000);
    });
  });

  describe("addServer", () => {
    it("adds a custom server and persists", async () => {
      const store = await createStore();
      const key = store.addServer({ name: "My DB", type: "command", command: "db-server" });
      await store.flush();

      expect(key).toBe("my_db");
      expect(store.getAll().servers.my_db.config!.name).toBe("My DB");
      expect(store.getAll().servers.my_db.builtin).toBe(false);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("emits changed event", async () => {
      const store = await createStore();
      const listener = vi.fn<() => void>();
      store.on("changed", listener);
      store.addServer({ name: "Test", type: "command", command: "test" });
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe("removeServer", () => {
    it("removes a server by name", async () => {
      const store = await createStore();
      store.addServer({ name: "To Remove", type: "command", command: "rm" });
      expect(store.getAll().servers.to_remove).toBeDefined();

      store.removeServer("To Remove");
      expect(store.getAll().servers.to_remove).toBeUndefined();
    });

    it("removes a server by config name match", async () => {
      const store = await createStore();
      store.addServer({ name: "My Server", type: "command", command: "serve" });
      store.removeServer("My Server");
      expect(store.getCustomServers()).toHaveLength(0);
    });
  });

  describe("updateServerConfig", () => {
    it("merges config update into existing server", async () => {
      const store = await createStore();
      store.addServer({ name: "Config Test", type: "command", command: "old", args: ["--v1"] });
      store.updateServerConfig("Config Test", { args: ["--v2"] } as Partial<CustomMcpServer>);
      await store.flush();

      const server = store.getAll().servers.config_test.config!;
      if (server.type !== "command") throw new Error(`expected command, got ${server.type}`);
      expect(server.args).toEqual(["--v2"]);
    });
  });

  describe("getCustomServers", () => {
    it("returns only non-builtin servers", async () => {
      const store = await createStore();
      store.addServer({ name: "Custom1", type: "command", command: "c1" });
      store.addServer({ name: "Custom2", url: "https://example.com" });

      const custom = store.getCustomServers();
      expect(custom).toHaveLength(2);
      expect(custom.every((s) => s.name !== "filesystem" && s.name !== "playwright")).toBe(true);
    });
  });

  describe("pruneStaleOAuthTokens", () => {
    it("strips legacy access/refresh/expiry on servers with oauthAlias and persists", async () => {
      mockExistsSync.mockReturnValue(true);
      // Pre-existing on-disk shape with both encrypted tokens AND a stale plaintext
      // accessToken is unrealistic — instead simulate the legacy path: plaintext on disk.
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            powerbi: {
              builtin: false,
              config: {
                name: "PowerBI",
                url: "https://powerbi.example.com",
                oauthAlias: "alice",
                accessToken: "stale-access",
                refreshToken: "stale-refresh",
                tokenExpiry: 1234567890,
              },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();

      // Sanity: tokens loaded from disk
      const before = store.getAll().servers.powerbi.config!;
      expect("url" in before && before.accessToken).toBe("stale-access");

      store.pruneStaleOAuthTokens();
      await store.flush();

      const after = store.getAll().servers.powerbi.config!;
      expect("url" in after && after.accessToken).toBeUndefined();
      expect("url" in after && after.refreshToken).toBeUndefined();
      expect("url" in after && after.tokenExpiry).toBeUndefined();
      // alias preserved
      expect("url" in after && after.oauthAlias).toBe("alice");

      // saveToDisk was triggered
      const written = lastWrittenJson();
      expect(written.servers.powerbi.config.accessToken).toBeUndefined();
      expect(written.servers.powerbi.config.refreshToken).toBeUndefined();
      expect(written.servers.powerbi.config.tokenExpiry).toBeUndefined();
    });

    it("leaves servers without oauthAlias untouched (manual bearer-token users)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            manual: {
              builtin: false,
              config: {
                name: "Manual",
                url: "https://example.com",
                // No oauthAlias — caller manages tokens themselves.
                accessToken: "manual-token",
              },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();
      const writesBefore = mockWriteFile.mock.calls.length;

      store.pruneStaleOAuthTokens();

      const after = store.getAll().servers.manual.config!;
      expect("url" in after && after.accessToken).toBe("manual-token");
      // No save when nothing changes
      expect(mockWriteFile.mock.calls.length).toBe(writesBefore);
    });

    it("is a no-op when no servers carry stale tokens (does not save)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            clean: {
              builtin: false,
              config: {
                name: "Clean",
                url: "https://example.com",
                oauthAlias: "alice",
              },
              tools: [],
            },
          },
        }),
      );
      const store = await createStore();
      const writesBefore = mockWriteFile.mock.calls.length;

      store.pruneStaleOAuthTokens();
      // Idempotent — second call still no-ops
      store.pruneStaleOAuthTokens();

      expect(mockWriteFile.mock.calls.length).toBe(writesBefore);
    });

    it("ignores command-type servers (cannot have OAuth tokens)", async () => {
      const store = await createStore();
      store.addServer({ name: "Cmd", type: "command", command: "do-stuff" });
      const writesBefore = mockWriteFile.mock.calls.length;

      store.pruneStaleOAuthTokens();

      // No save triggered for command servers — they don't match the pruning predicate.
      expect(mockWriteFile.mock.calls.length).toBe(writesBefore);
    });
  });

  describe("setCustomServers", () => {
    it("replaces all custom servers while keeping builtins", async () => {
      const store = await createStore();
      store.addServer({ name: "Old", type: "command", command: "old" });

      store.setCustomServers([
        { name: "New1", type: "command", command: "n1" },
        { name: "New2", type: "command", command: "n2" },
      ]);

      const custom = store.getCustomServers();
      expect(custom).toHaveLength(2);
      expect(custom.map((s) => s.name)).toEqual(["New1", "New2"]);
      // Builtins preserved
      expect(store.getAll().servers.filesystem).toBeDefined();
      expect(store.getAll().servers.playwright).toBeDefined();
    });

    it("preserves discovered tools when replacing servers", async () => {
      const store = await createStore();
      store.addServer({ name: "Persistent", type: "command", command: "cmd" });
      store.updateToolDiscovery({
        persistent: { tools: [{ name: "my_tool", description: "A tool" }] },
      });
      expect(store.getAll().servers.persistent.tools).toHaveLength(1);

      // Replace with same server — tools should survive
      store.setCustomServers([{ name: "Persistent", type: "command", command: "cmd" }]);
      expect(store.getAll().servers.persistent.tools).toHaveLength(1);
      expect(store.getAll().servers.persistent.tools![0].name).toBe("my_tool");
    });
  });

  describe("updateToolDiscovery", () => {
    it("updates tool lists for existing servers", async () => {
      const store = await createStore();
      store.updateToolDiscovery({
        filesystem: {
          tools: [{ name: "read_file", description: "Updated description" }],
        },
      });
      await store.flush();

      expect(store.getAll().servers.filesystem.tools).toEqual([
        { name: "read_file", description: "Updated description" },
      ]);
    });

    it("ignores unknown server keys", async () => {
      const store = await createStore();
      const toolsBefore = store.getAll().servers.filesystem.tools;
      store.updateToolDiscovery({
        nonexistent: { tools: [{ name: "foo", description: "bar" }] },
      });
      expect(store.getAll().servers.filesystem.tools).toEqual(toolsBefore);
    });
  });

  describe("recordObservedTool", () => {
    it("adds tools observed in chat for existing servers", async () => {
      const store = await createStore();
      store.addServer({
        name: "Power BI Remote",
        url: "https://mcp.example.com/v1/mcp/powerbi",
      });

      store.recordObservedTool("Power BI Remote", "ExecuteQuery");
      store.recordObservedTool("Power BI Remote", "ExecuteQuery");

      expect(store.getAll().servers["power_bi_remote"].tools).toEqual([
        { name: "ExecuteQuery", description: "Seen in chat" },
      ]);
    });

    it("ignores unknown servers", async () => {
      const store = await createStore();
      const before = store.getAll();

      store.recordObservedTool("missing", "ExecuteQuery");

      expect(store.getAll()).toEqual(before);
    });
  });

  describe("migrateFromSettings", () => {
    it("migrates custom servers from raw settings file when mcp store file does not exist", async () => {
      // First call: mcp store file doesn't exist; second call: settings file exists
      mockExistsSync
        .mockReturnValueOnce(false) // mcp store file (loadFromDisk)
        .mockReturnValueOnce(false) // mcp store file (migrateFromSettings check)
        .mockReturnValueOnce(true); // marshal-settings.json exists
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          customMcpServers: [
            { name: "Migrated", type: "command", command: "migrate" },
            { name: "Also Migrated", url: "https://example.com" },
          ],
        }),
      );
      const store = await createStore();
      store.migrateFromSettings();
      await store.flush();

      const custom = store.getCustomServers();
      expect(custom).toHaveLength(2);
      expect(custom[0].name).toBe("Migrated");
    });

    it("does not migrate when mcp store file already exists", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ servers: {} }));
      const store = await createStore();

      store.migrateFromSettings();

      expect(store.getCustomServers()).toHaveLength(0);
    });

    it("removes customMcpServers key from settings file after migration", async () => {
      mockExistsSync
        .mockReturnValueOnce(false) // mcp store file (loadFromDisk)
        .mockReturnValueOnce(false) // mcp store file (migrateFromSettings check)
        .mockReturnValueOnce(true); // marshal-settings.json exists
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          customMcpServers: [{ name: "Srv", type: "command", command: "cmd" }],
          theme: "dark",
        }),
      );
      const store = await createStore();
      store.migrateFromSettings();

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(written).not.toHaveProperty("customMcpServers");
      expect(written.theme).toBe("dark");
    });

    it("does nothing when settings file has no customMcpServers", async () => {
      mockExistsSync
        .mockReturnValueOnce(false) // mcp store file (loadFromDisk)
        .mockReturnValueOnce(false) // mcp store file (migrateFromSettings check)
        .mockReturnValueOnce(true); // marshal-settings.json exists
      mockReadFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }));
      const store = await createStore();
      const writeCountBefore = mockWriteFile.mock.calls.length;
      store.migrateFromSettings();
      expect(mockWriteFile.mock.calls.length).toBe(writeCountBefore);
    });
  });

  describe("token encryption round-trip", () => {
    it("encrypts tokens on save and decrypts on load", async () => {
      const store = await createStore();
      store.addServer({
        name: "OAuth Server",
        url: "https://example.com/mcp",
        accessToken: "my_access_token",
        refreshToken: "my_refresh_token",
      });
      await store.flush();

      // Verify encrypted on disk
      const written = lastWrittenJson();
      const persisted = written.servers.oauth_server;
      expect(persisted.config.accessToken).toBeUndefined();
      expect(persisted.config.refreshToken).toBeUndefined();
      expect(persisted.config.accessTokenEncrypted).toBeDefined();
      expect(persisted.config.refreshTokenEncrypted).toBeDefined();

      // Now simulate loading from disk
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(written));

      const store2 = await createStore();
      const loaded = store2.getAll().servers.oauth_server.config!;
      expect(loaded).toBeDefined();
      expect("url" in loaded && loaded.accessToken).toBe("my_access_token");
      expect("url" in loaded && loaded.refreshToken).toBe("my_refresh_token");
    });

    it("preserves accessTokenOrigin through save and reload", async () => {
      const store = await createStore();
      store.addServer({
        name: "Origin Server",
        url: "https://example.com/mcp",
        accessToken: "my_access_token",
        accessTokenOrigin: "https://example.com",
      });
      await store.flush();

      const written = lastWrittenJson();
      // accessTokenOrigin is not a token — it must survive serialization as plaintext
      expect(written.servers.origin_server.config.accessTokenOrigin).toBe("https://example.com");

      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(written));

      const store2 = await createStore();
      const loaded = store2.getAll().servers.origin_server.config!;
      expect("url" in loaded && loaded.accessTokenOrigin).toBe("https://example.com");
    });

    it("handles legacy plaintext tokens", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            legacy: {
              builtin: false,
              config: {
                name: "Legacy",
                url: "https://example.com",
                accessToken: "plain_access",
                refreshToken: "plain_refresh",
              },
              tools: [],
            },
          },
        }),
      );

      const store = await createStore();
      const server = store.getAll().servers.legacy.config!;
      expect("url" in server && server.accessToken).toBe("plain_access");
      expect("url" in server && server.refreshToken).toBe("plain_refresh");
    });

    it("drops token silently when encryptString throws", async () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      mockEncryptString.mockImplementation(() => {
        throw new Error("keychain locked");
      });
      const store = await createStore();
      store.addServer({ name: "Throw Test", url: "https://x.com", accessToken: "tok" });
      await store.flush();
      const written = lastWrittenJson();
      expect(written.servers.throw_test.config.accessTokenEncrypted).toBeUndefined();
      expect(written.servers.throw_test.config.accessToken).toBeUndefined();
    });

    it("handles unavailable safeStorage", async () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      const store = await createStore();
      store.addServer({
        name: "No Encrypt",
        url: "https://example.com",
        accessToken: "secret",
      });
      await store.flush();

      const written = lastWrittenJson();
      const persisted = written.servers.no_encrypt.config;
      // Token should not be persisted at all
      expect(persisted.accessTokenEncrypted).toBeUndefined();
      expect(persisted.accessToken).toBeUndefined();
    });
  });

  describe("seedBuiltins", () => {
    it("does not overwrite existing builtin data", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          servers: {
            filesystem: {
              builtin: true,
              tools: ["custom_tool"],
            },
          },
        }),
      );
      const store = await createStore();
      // filesystem should keep its existing tools, not be overwritten by seed
      expect(store.getAll().servers.filesystem.tools).toEqual([
        { name: "custom_tool", description: "" },
      ]);
      // playwright should be seeded since it wasn't in the file (empty tools, populated by discovery)
      expect(store.getAll().servers.playwright).toBeDefined();
      expect(store.getAll().servers.playwright.tools).toEqual([]);
    });
  });

  describe("discoverTools", () => {
    it("discovers tools from stdio servers and persists them", async () => {
      mockMcpListTools.mockResolvedValue({
        tools: [
          { name: "read_file", description: "Read a file" },
          { name: "write_file", description: "Write a file" },
        ],
      });

      const store = await createStore();
      await store.discoverTools({
        filesystem: { command: "node", args: ["server.js"] },
      });

      const fs = store.getAll().servers.filesystem;
      expect(fs.tools).toHaveLength(2);
      expect(fs.tools![0]).toEqual({ name: "read_file", description: "Read a file" });
      expect(fs.tools![1]).toEqual({ name: "write_file", description: "Write a file" });
      expect(mockMcpConnect).toHaveBeenCalledOnce();
      expect(mockMcpClose).toHaveBeenCalledOnce();
    });

    it("skips URL-based servers (no command)", async () => {
      const store = await createStore();
      await store.discoverTools({
        remote: { url: "https://example.com/mcp", type: "http" },
      });

      // No MCP client calls should have been made
      expect(mockMcpConnect).not.toHaveBeenCalled();
    });

    it("skips servers not in the store", async () => {
      const store = await createStore();
      await store.discoverTools({
        unknown_server: { command: "node", args: ["server.js"] },
      });

      expect(mockMcpConnect).not.toHaveBeenCalled();
    });

    it("handles server connection failure gracefully", async () => {
      mockMcpConnect.mockRejectedValue(new Error("ENOENT"));

      const store = await createStore();
      await store.discoverTools({
        filesystem: { command: "nonexistent", args: [] },
      });

      // Tools should remain empty, no crash
      expect(store.getAll().servers.filesystem.tools).toEqual([]);
    });

    it("tracks failed servers in discoveryErrors", async () => {
      mockMcpConnect.mockRejectedValue(new Error("ENOENT"));

      const store = await createStore();
      await store.discoverTools({
        filesystem: { command: "nonexistent", args: [] },
      });

      expect(store.getDiscoveryErrors().has("filesystem")).toBe(true);
    });

    it("clears discoveryErrors at the start of each run", async () => {
      mockMcpConnect.mockRejectedValueOnce(new Error("ENOENT"));

      const store = await createStore();
      // First run: filesystem fails
      await store.discoverTools({ filesystem: { command: "bad", args: [] } });
      expect(store.getDiscoveryErrors().has("filesystem")).toBe(true);

      // Second run: filesystem succeeds
      mockMcpListTools.mockResolvedValueOnce({ tools: [{ name: "t", description: "" }] });
      await store.discoverTools({ filesystem: { command: "node", args: [] } });
      expect(store.getDiscoveryErrors().has("filesystem")).toBe(false);
    });

    it("fires SERVER_CONNECTION_FAILED when client.connect() fails", async () => {
      mockMcpConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = await createStore();
      await store.discoverTools({ filesystem: { command: "bad", args: [] } });

      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        makeMcpError(mcpErrors.SERVER_CONNECTION_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("fires TOOL_DISCOVERY_FAILED when listTools() fails after successful connect", async () => {
      mockMcpConnect.mockResolvedValueOnce(undefined);
      mockMcpListTools.mockRejectedValueOnce(new Error("tool list failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = await createStore();
      await store.discoverTools({ filesystem: { command: "node", args: [] } });

      expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
        makeMcpError(mcpErrors.TOOL_DISCOVERY_FAILED),
      );
      warnSpy.mockRestore();
    });

    it("isDiscoveryInProgress is true during discovery and false after", async () => {
      const store = await createStore();

      // Capture state mid-discovery via the "changed" event
      const statesDuringEmit: boolean[] = [];
      store.on("changed", () => {
        statesDuringEmit.push(store.isDiscoveryInProgress());
      });

      await store.discoverTools({ filesystem: { command: "node", args: [] } });

      // First emit: discovery start (true), last emit: discovery end (false)
      expect(statesDuringEmit[0]).toBe(true);
      expect(statesDuringEmit[statesDuringEmit.length - 1]).toBe(false);
      expect(store.isDiscoveryInProgress()).toBe(false);
    });

    it("emits changed at start and end of discovery", async () => {
      const store = await createStore();
      const listener = vi.fn<() => void>();
      store.on("changed", listener);

      await store.discoverTools({ filesystem: { command: "node", args: [] } });

      // At least 2 changed events: one at start (loading), one at end (via finally)
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("handles timeout gracefully", async () => {
      vi.useFakeTimers();
      mockMcpListTools.mockImplementation(() => new Promise(() => {})); // never resolves

      const store = await createStore();
      const promise = store.discoverTools({
        filesystem: { command: "node", args: ["slow-server.js"] },
      });

      await vi.advanceTimersByTimeAsync(15_001);
      await promise;
      vi.useRealTimers();

      // Should not crash; tools remain empty
      expect(store.getAll().servers.filesystem.tools).toEqual([]);
    });

    it("prevents concurrent discovery runs", async () => {
      let resolveFirst: (() => void) | undefined;
      mockMcpListTools.mockImplementationOnce(
        () =>
          new Promise<{ tools: { name: string; description: string }[] }>((resolve) => {
            resolveFirst = () => resolve({ tools: [{ name: "tool1", description: "T1" }] });
          }),
      );

      const store = await createStore();
      const first = store.discoverTools({ filesystem: { command: "node", args: [] } });
      const second = store.discoverTools({ filesystem: { command: "node", args: [] } });

      // Second call should return immediately without error (guard)
      await expect(second).resolves.toBeUndefined();
      expect(mockMcpConnect).toHaveBeenCalledOnce(); // only first run connected

      // Finish the first run
      resolveFirst!();
      await first;
    });

    it("persists only tool names to disk, not descriptions", async () => {
      mockMcpListTools.mockResolvedValue({
        tools: [{ name: "my_tool", description: "A long description" }],
      });

      const store = await createStore();
      store.addServer({ name: "Test", type: "command", command: "test" });
      await store.discoverTools({
        test: { command: "test", args: [] },
      });
      await store.flush();

      const written = lastWrittenJson();
      expect(written.servers.test.tools).toEqual(["my_tool"]);
    });
  });
});

// Import type for test usage
import type { CustomMcpServer } from "./ipc/types";
