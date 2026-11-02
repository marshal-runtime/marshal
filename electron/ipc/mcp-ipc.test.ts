import * as path from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  shell: {
    openPath: vi.fn<() => Promise<string>>().mockResolvedValue(""),
    openExternal: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    showItemInFolder: vi.fn<() => void>(),
  },
}));

vi.mock("node:fs", () => {
  const promises = {
    readFile: vi.fn<() => Promise<string>>().mockResolvedValue(""),
    writeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    chmod: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    mkdir: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unlink: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return {
    default: { existsSync: vi.fn<() => boolean>(() => true), promises },
    existsSync: vi.fn<() => boolean>(() => true),
    promises,
  };
});

vi.mock("../mcp-tools", () => ({
  buildMcpConfig: vi.fn<() => Record<string, unknown>>().mockReturnValue({}),
}));

import * as fs from "node:fs";

import { shell } from "electron";

import type { CustomMcpServer } from "../../common/marshal-ipc-contract";
import { toMcpServerKey } from "../../common/mcp-server-key-normalization";
import { buildMcpConfig } from "../mcp-tools";
import { registerMcpHandlers } from "./mcp-ipc";

function setupHandlers() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  };

  const mcpStore = {
    getAll: vi.fn<() => unknown>().mockReturnValue({
      servers: {
        filesystem: { builtin: true, tools: [{ name: "read_file", description: "Read" }] },
        existing: {
          builtin: false,
          config: { name: "existing", type: "command", command: "echo" },
          tools: [],
        },
        oauth_server: {
          builtin: false,
          config: {
            name: "OAuth Server",
            url: "https://example.com",
            oauthAlias: "someone@example.com",
            accessToken: "secret-token",
            refreshToken: "secret-refresh",
          },
          tools: [],
        },
      },
    }),
    getCustomServers: vi
      .fn<() => CustomMcpServer[]>()
      .mockReturnValue([{ name: "existing", type: "command", command: "echo" }]),
    addServer: vi.fn<(server: CustomMcpServer) => string>().mockReturnValue("new_key"),
    removeServer: vi.fn<(name: string) => void>(),
    updateServerConfig: vi.fn<() => void>(),
    discoverTools: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getRuntimeStatuses: vi.fn<() => Map<string, unknown>>().mockReturnValue(new Map()),
  };
  const sessionManager = {
    mcpStatus: {
      setCustomMcpServers: vi.fn<(servers: CustomMcpServer[]) => void>(),
      clearMcpServerStatus: vi.fn<(serverName: string) => void>(),
      getMcpServerStatuses: vi
        .fn<
          () => Record<
            string,
            { serverName: string; status: "connected" | "failed" | "needs-auth"; error?: string }
          >
        >()
        .mockReturnValue({
          oauth_server: { serverName: "OAuth Server", status: "connected" },
          powerbi_remote: { serverName: "powerbi-remote", status: "needs-auth" },
        }),
    },
    getWorkspaceDir: vi.fn<() => string>().mockReturnValue("/test/workspace"),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial mocks
  registerMcpHandlers({
    mcpStore,
    sessionManager,
    ipcHandle,
  } as unknown as Parameters<typeof registerMcpHandlers>[0]);

  return { handlers, mcpStore, sessionManager };
}

describe("registerMcpHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("mcps:list", () => {
    it("returns all servers from store", () => {
      const { handlers } = setupHandlers();
      const result = handlers.get("mcps:list")!({});

      expect(result).toMatchObject({ success: true });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = result as { servers: unknown[] };
      expect(servers).toHaveLength(4);
      expect(servers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "filesystem", builtin: true }),
          expect.objectContaining({ key: "existing", builtin: false }),
          expect.objectContaining({ key: "oauth_server", builtin: false, status: "connected" }),
          expect.objectContaining({
            key: "powerbi_remote",
            name: "powerbi-remote",
            builtin: false,
            status: "needs-auth",
            requiresOAuth: true,
          }),
        ]),
      );
    });

    it("strips accessToken and refreshToken from URL server configs", () => {
      const { handlers } = setupHandlers();
      const result = handlers.get("mcps:list")!({});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = result as {
        servers: Array<{ key: string; config?: Record<string, unknown> }>;
      };
      const oauthServer = servers.find((s) => s.key === "oauth_server");
      expect(oauthServer).toBeDefined();
      expect(oauthServer!.config).not.toHaveProperty("accessToken");
      expect(oauthServer!.config).not.toHaveProperty("refreshToken");
      expect(oauthServer!.config).toMatchObject({
        name: "OAuth Server",
        url: "https://example.com",
        oauthAlias: "someone@example.com",
      });
      expect(oauthServer).toMatchObject({
        requiresOAuth: false,
        oauthAlias: "someone@example.com",
      });
    });

    it("marks remote URL servers without bearer tokens as OAuth-capable", () => {
      const { handlers, mcpStore } = setupHandlers();
      vi.mocked(mcpStore.getAll).mockReturnValue({
        servers: {
          remote: {
            builtin: false,
            config: { name: "remote", url: "https://mcp.example.com" },
            tools: [],
          },
          local: {
            builtin: false,
            config: { name: "local", url: "http://localhost:3000" },
            tools: [],
          },
        },
      });

      const result = handlers.get("mcps:list")!({});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = result as {
        servers: Array<{ key: string; requiresOAuth?: boolean }>;
      };
      expect(servers.find((server) => server.key === "remote")).toMatchObject({
        requiresOAuth: true,
      });
      expect(servers.find((server) => server.key === "local")).toMatchObject({
        requiresOAuth: false,
      });
    });

    it("joins SDK status by the normalized store key for display names with spaces", () => {
      const { handlers } = setupHandlers();
      const result = handlers.get("mcps:list")!({});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = result as {
        servers: Array<{ key: string; name: string; status?: string }>;
      };

      expect(servers).toContainEqual(
        expect.objectContaining({
          key: "oauth_server",
          name: "OAuth Server",
          status: "connected",
        }),
      );
    });

    it("does not duplicate SDK runtime status for servers already in the store", () => {
      const { handlers } = setupHandlers();
      const result = handlers.get("mcps:list")!({});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = result as {
        servers: Array<{ key: string; name: string; status?: string }>;
      };

      expect(servers.filter((server) => server.key === "oauth_server")).toHaveLength(1);
      expect(servers.filter((server) => server.name === "OAuth Server")).toHaveLength(1);
    });

    it("does not mark a failed server as requiresOAuth when it is command-type", () => {
      const { handlers, sessionManager } = setupHandlers();
      vi.mocked(sessionManager.mcpStatus.getMcpServerStatuses).mockReturnValue({
        broken_server: { serverName: "Broken Server", status: "failed" },
      });

      const result = handlers.get("mcps:list")!({});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only
      const { servers } = result as {
        servers: Array<{ key: string; requiresOAuth: boolean; status?: string }>;
      };
      // The store has "existing" (command) — both store entries and SDK-only entries with
      // status "failed" must not be marked as requiring OAuth.
      const existing = servers.find((s) => s.key === "existing");
      expect(existing?.requiresOAuth).toBe(false);

      // SDK-only "broken_server" with status "failed" must also not require OAuth
      const broken = servers.find((s) => s.key === "broken_server");
      expect(broken).toBeDefined();
      expect(broken?.requiresOAuth).toBe(false);
    });
  });

  describe("mcps:add", () => {
    it("adds a command server via store and syncs to session", () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();

      const result = handlers.get("mcps:add")!(
        {},
        { name: "new-server", mode: "command", command: "npx serve" },
      );

      expect(result).toMatchObject({ success: true, name: "new-server", needsOAuth: false });
      expect(mcpStore.addServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-server", type: "command" }),
      );
      expect(sessionManager.mcpStatus.setCustomMcpServers).toHaveBeenCalled();
    });

    it("returns needsOAuth: true for remote URL without bearer token", () => {
      const { handlers } = setupHandlers();

      const result = handlers.get("mcps:add")!(
        {},
        { name: "remote", mode: "url", url: "https://mcp.example.com" },
      );

      expect(result).toMatchObject({ success: true, name: "remote", needsOAuth: true });
    });

    it("rejects duplicate server names", () => {
      const { handlers } = setupHandlers();

      const result = handlers.get("mcps:add")!(
        {},
        { name: "existing", mode: "command", command: "echo" },
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("already exists"),
      });
    });

    it("rejects duplicate server names with different casing", () => {
      const { handlers } = setupHandlers();

      const result = handlers.get("mcps:add")!(
        {},
        { name: "Existing", mode: "command", command: "echo" },
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("already exists"),
      });
    });
  });

  describe("mcps:install-catalog", () => {
    it("installs a catalog server and syncs", () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();
      const catalog = JSON.stringify({ type: "command", command: "npx", args: ["-y", "@foo/bar"] });

      const result = handlers.get("mcps:install-catalog")!(
        {},
        { name: "catalog-server", catalogContent: catalog },
      );

      expect(result).toEqual({ success: true });
      expect(mcpStore.addServer).toHaveBeenCalled();
      expect(sessionManager.mcpStatus.setCustomMcpServers).toHaveBeenCalled();
    });

    it("returns error for duplicate server name", () => {
      const { handlers } = setupHandlers();

      const result = handlers.get("mcps:install-catalog")!(
        {},
        { name: "existing", catalogContent: JSON.stringify({ type: "command", command: "echo" }) },
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("already installed"),
      });
    });
  });

  describe("mcps:remove", () => {
    it("removes server via store and syncs", async () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();

      const result = await handlers.get("mcps:remove")!({}, "existing");

      expect(result).toEqual({ success: true });
      expect(mcpStore.removeServer).toHaveBeenCalledWith("existing");
      expect(sessionManager.mcpStatus.clearMcpServerStatus).toHaveBeenCalledWith("existing");
      expect(sessionManager.mcpStatus.setCustomMcpServers).toHaveBeenCalled();
    });

    it("sweeps the managed secrets file so removing a server doesn't orphan cleartext", async () => {
      const { handlers } = setupHandlers();

      await handlers.get("mcps:remove")!({}, "Demo Server");

      // Use path.join so the assertion holds on Windows (backslash separator).
      expect(fs.promises.unlink).toHaveBeenCalledWith(
        path.join("/home/user/.marshal/marshal-mcp-env", "demo_server.env"),
      );
    });

    it("does not unlink anything when toMcpServerKey produces a non-allowlisted key (path traversal defence)", async () => {
      const { handlers } = setupHandlers();

      // toMcpServerKey lowercases / collapses whitespace but does NOT strip `.`
      // or `/`. The remove handler re-validates against the same allowlist
      // resolveMcpEnvFilePath uses, so a name like "../marshal-settings" must not
      // unlink anything outside marshal-mcp-env/.
      const result = await handlers.get("mcps:remove")!({}, "../marshal-settings");

      expect(result).toEqual({ success: true });
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it("swallows ENOENT from unlink so removing a server without a managed envFile still succeeds", async () => {
      const { handlers } = setupHandlers();
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.promises.unlink).mockRejectedValueOnce(enoent);

      const result = await handlers.get("mcps:remove")!({}, "Demo Server");
      expect(result).toEqual({ success: true });
    });

    it("does not swallow EPERM — logs a warning but still returns success so settings UI stays usable", async () => {
      const { handlers } = setupHandlers();
      const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
      vi.mocked(fs.promises.unlink).mockRejectedValueOnce(eperm);

      // The .catch handler logs a warning for any non-ENOENT code. We assert
      // the handler still resolves success (removing from the store succeeded;
      // a lingering file is a separate, surfaced issue).
      const result = await handlers.get("mcps:remove")!({}, "Demo Server");
      expect(result).toEqual({ success: true });
    });

    it("does not re-list a removed server from stale SDK runtime status", async () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();
      const statuses: Record<
        string,
        { serverName: string; status: "connected" | "failed" | "needs-auth"; error?: string }
      > = {
        power_bi_mcp: { serverName: "Power BI MCP", status: "needs-auth" },
      };
      vi.mocked(mcpStore.getAll).mockReturnValue({
        servers: {
          power_bi_mcp: {
            builtin: false,
            config: { name: "Power BI MCP", url: "https://mcp.example.com" },
            tools: [],
          },
        },
      });
      vi.mocked(sessionManager.mcpStatus.getMcpServerStatuses).mockReturnValue(statuses);
      vi.mocked(sessionManager.mcpStatus.clearMcpServerStatus).mockImplementation((serverName) => {
        delete statuses[toMcpServerKey(serverName)];
      });

      const removeResult = await handlers.get("mcps:remove")!({}, "Power BI MCP");
      vi.mocked(mcpStore.getAll).mockReturnValue({ servers: {} });

      const listResult = handlers.get("mcps:list")!({});

      expect(removeResult).toEqual({ success: true });
      expect(sessionManager.mcpStatus.clearMcpServerStatus).toHaveBeenCalledWith("Power BI MCP");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: extracting from opaque handler result
      const { servers } = listResult as { servers: Array<{ name: string }> };
      expect(servers).toEqual([]);
    });
  });

  describe("mcps:update-config", () => {
    it("updates args on matching server and syncs", () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();
      const catalog = JSON.stringify({ args: ["--base"] });

      const result = handlers.get("mcps:update-config")!(
        {},
        {
          serverName: "existing",
          catalogContent: catalog,
          configParams: [{ key: "org" }],
          values: { org: "my-org" },
        },
      );

      expect(result).toEqual({ success: true });
      expect(mcpStore.updateServerConfig).toHaveBeenCalledWith(
        "existing",
        expect.objectContaining({ args: ["--base", "my-org"] }),
      );
      expect(sessionManager.mcpStatus.setCustomMcpServers).toHaveBeenCalled();
    });

    it("returns error when server not found", () => {
      const { handlers } = setupHandlers();
      const catalog = JSON.stringify({ args: [] });

      const result = handlers.get("mcps:update-config")!(
        {},
        {
          serverName: "nonexistent",
          catalogContent: catalog,
          configParams: [{ key: "x" }],
          values: { x: "val" },
        },
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("not found") });
    });
  });

  describe("mcps:openFile", () => {
    it("returns success when file exists", async () => {
      const { handlers } = setupHandlers();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(shell.openPath).mockResolvedValue("");

      const result = await handlers.get("mcps:openFile")!({});
      expect(result).toEqual({ success: true });
    });

    it("returns error when file not found", async () => {
      const { handlers } = setupHandlers();
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await handlers.get("mcps:openFile")!({});
      expect(result).toMatchObject({ success: false, error: "MCP servers file not found" });
    });

    it("returns error when shell.openPath fails", async () => {
      const { handlers } = setupHandlers();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(shell.openPath).mockResolvedValue("Permission denied");

      const result = await handlers.get("mcps:openFile")!({});
      expect(result).toMatchObject({ success: false, error: "Permission denied" });
    });
  });

  describe("mcps:rediscover", () => {
    it("calls discoverTools with built config and returns success", () => {
      const { handlers, mcpStore, sessionManager } = setupHandlers();
      const result = handlers.get("mcps:rediscover")!({});
      expect(result).toMatchObject({ success: true });
      expect(vi.mocked(buildMcpConfig)).toHaveBeenCalledWith(
        sessionManager.getWorkspaceDir(),
        expect.any(Array),
        false,
      );
      expect(mcpStore.discoverTools).toHaveBeenCalledTimes(1);
    });
  });

  describe("mcps:openEnvFile — managed-secrets handler", () => {
    // path.join so the expected paths hold on Windows (backslash) as well as POSIX.
    const ENV_DIR = path.join("/home/user/.marshal", "marshal-mcp-env");
    const demoEnvPath = path.join(ENV_DIR, "demo.env");

    // Restore process.platform after any test that mocks it.
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    describe("path validation (defense-in-depth — renderer keys come from toMcpServerKey, but main can't trust that)", () => {
      it.each([
        ["../etc/passwd", "path traversal"],
        ["/absolute/path", "absolute path"],
        ["with space", "whitespace"],
        ["UPPER", "uppercase"],
        ["foo.env", "embedded dot"],
        ["", "empty"],
      ])("rejects %s (%s) before touching disk", async (key) => {
        const { handlers } = setupHandlers();
        const result = await handlers.get("mcps:openEnvFile")!({}, key, "default");
        expect(result).toMatchObject({ success: false, error: "Invalid MCP server key" });
        expect(shell.openPath).not.toHaveBeenCalled();
        expect(shell.openExternal).not.toHaveBeenCalled();
      });
    });

    it("reveal target: calls shell.showItemInFolder and returns revealed=true", async () => {
      const { handlers } = setupHandlers();

      const result = await handlers.get("mcps:openEnvFile")!({}, "demo", "reveal");

      expect(result).toEqual({ success: true, revealed: true });
      expect(shell.showItemInFolder).toHaveBeenCalledWith(demoEnvPath);
    });

    it("default target falls back to reveal when no app is registered for .env", async () => {
      const { handlers } = setupHandlers();
      vi.mocked(shell.openPath).mockResolvedValueOnce("Failed to open path");

      const result = await handlers.get("mcps:openEnvFile")!({}, "demo", "default");

      expect(result).toEqual({ success: true, revealed: true });
      expect(shell.showItemInFolder).toHaveBeenCalledWith(demoEnvPath);
    });
  });
});
