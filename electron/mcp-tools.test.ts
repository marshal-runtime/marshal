/* eslint-disable @typescript-eslint/no-explicit-any */
import * as nodeFs from "node:fs";
import path from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type {
  RuntimeMcpHttpServerConfig as MCPHTTPServerConfig,
  RuntimeMcpStdioServerConfig as MCPStdioServerConfig,
} from "./backend/runtime-contract";
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn<() => boolean>(() => false),
    mkdirSync: vi.fn<() => void>(),
    readFileSync: vi.fn<() => string>(),
    writeFileSync: vi.fn<() => void>(),
    unlinkSync: vi.fn<() => void>(),
    readdirSync: vi.fn<() => string[]>(() => []),
    statSync: vi.fn<() => { size: number }>(() => ({ size: 100 })),
  },
  existsSync: vi.fn<() => boolean>(() => false),
  mkdirSync: vi.fn<() => void>(),
  readFileSync: vi.fn<() => string>(),
  writeFileSync: vi.fn<() => void>(),
  unlinkSync: vi.fn<() => void>(),
  readdirSync: vi.fn<() => string[]>(() => []),
  statSync: vi.fn<() => { size: number }>(() => ({ size: 100 })),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn<() => void>(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn<(name: string) => string>((name: string) => {
      if (name === "temp") return "/tmp";
      if (name === "home") return "/home/user";
      return "/mock";
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodeFs.existsSync).mockReturnValue(false);
});

describe("buildMcpCommand", () => {
  it("resolves the repository-pinned Node binary for Runtime workers in development", async () => {
    const { developmentNodePath } = await import("./mcp-tools");
    expect(developmentNodePath("/repo", "darwin", "arm64")).toBe(
      "/repo/node-bin/darwin-arm64/node",
    );
    expect(developmentNodePath("C:\\repo", "win32", "x64")).toMatch(
      /node-bin[\\/]win32-x64[\\/]node\.exe$/,
    );
  });

  it("uses bundled node on macOS packaged", async () => {
    const { buildMcpCommand } = await import("./mcp-tools");
    const result = buildMcpCommand({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/App/Marshal.app/Contents/Resources",
    });
    expect(result.command).toBe("/App/Marshal.app/Contents/Resources/node/node");
    expect(result.prefix).toEqual([]);
  });

  it("uses bundled node on Linux packaged", async () => {
    const { buildMcpCommand } = await import("./mcp-tools");
    const result = buildMcpCommand({
      isPackaged: true,
      platform: "linux",
      resourcesPath: "/opt/m/resources",
    });
    expect(result.command).toBe("/opt/m/resources/node/node");
    expect(result.prefix).toEqual([]);
  });

  it("uses node-runner.exe on Windows packaged", async () => {
    const { buildMcpCommand } = await import("./mcp-tools");
    const result = buildMcpCommand({
      isPackaged: true,
      platform: "win32",
      resourcesPath: "C:\\App\\resources",
    });
    // node-runner.exe ships via win.extraFiles (electron-builder.json5), which
    // lands it next to Marshal.exe in the application directory — the
    // PARENT of resourcesPath, NOT inside resources/. If a future change moves the runner into
    // resources/, update electron-builder.json5 (extraFiles → extraResources)
    // AND the installer signing check before touching this expectation.
    expect(result.command).toBe("C:\\App\\node-runner.exe");
    expect(result.prefix).toEqual(["C:\\App\\resources\\node\\node.exe"]);
  });

  it("uses system node in dev (any platform)", async () => {
    const { buildMcpCommand } = await import("./mcp-tools");
    const result = buildMcpCommand({
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/unused/in/dev",
    });
    expect(result.command).toBe("node");
    expect(result.prefix).toEqual([]);
  });
});

describe("buildMcpConfig", () => {
  it("uses Playwright-managed Chromium when no branded browser is installed", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/my/workspace", [], false);
    const playwright = config.playwright;
    if (!("args" in playwright)) throw new Error("Expected a stdio Playwright configuration");
    const args = playwright.args;
    expect(args).not.toContain("--browser");
    expect(args).not.toContain("--executable-path");
  });

  it("does not include a filesystem server (File System Access is a capability now)", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/my/workspace", [], false);
    expect(config).not.toHaveProperty("filesystem");
    expect(config).toHaveProperty("playwright");
  });

  it("adds custom command-based server", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [{ name: "My Tool", type: "command", command: "my-tool-bin", args: ["--flag"] }],
      false,
    );
    expect(config).toHaveProperty("my_tool");
    expect(config.my_tool).toMatchObject({
      type: "local",
      command: "my-tool-bin",
      args: ["--flag"],
    });
  });

  it("leaves unrelated npx MCP servers unchanged", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [{ name: "other", type: "command", command: "npx", args: ["-y", "other-mcp"] }],
      false,
    );
    expect(config.other).toMatchObject({ command: "npx", args: ["-y", "other-mcp"] });
  });

  it("adds custom HTTP server with Bearer token", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [
        {
          name: "Remote API",
          type: "http",
          url: "https://api.example.com/mcp",
          accessToken: "tok123",
        },
      ],
      false,
    );
    expect(config).toHaveProperty("remote_api");
    expect(config.remote_api).toMatchObject({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer tok123" },
    });
  });

  it("skips custom server that conflicts with built-in key", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [{ name: "Playwright", type: "command", command: "bad" }],
      false,
    );
    // Should not override the built-in playwright entry
    expect((config.playwright as any).command).not.toBe("bad"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing dynamic MCP config shape
  });

  it("omits HTTP server without URL", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [{ name: "No URL", type: "http", url: "" }], false);
    expect(config).not.toHaveProperty("no_url");
  });

  it("forwards per-server timeout to a command server", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [
        {
          name: "Slow Tool",
          type: "command",
          command: "slow",
          args: [],
          timeout: 1_800_000,
        },
      ],
      false,
    );
    expect(config.slow_tool).toMatchObject({ type: "local", timeout: 1_800_000 });
  });

  it("forwards per-server timeout to a URL server", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [{ name: "Remote Slow", type: "http", url: "https://x.example.com", timeout: 90_000 }],
      false,
    );
    expect(config.remote_slow).toMatchObject({ type: "http", timeout: 90_000 });
  });

  it("omits the timeout key when not set on a custom server", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [{ name: "No To", type: "command", command: "x" }], false);
    expect(config.no_to).not.toHaveProperty("timeout");
  });

  it("includes --handle-file-chooser when interceptFileChooser is true", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false, true);
    expect((config.playwright as any).args).toContain("--handle-file-chooser"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing dynamic MCP config shape
  });

  it("omits --handle-file-chooser when interceptFileChooser is false", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false, false);
    expect((config.playwright as any).args).not.toContain("--handle-file-chooser"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing dynamic MCP config shape
  });

  it("omits --handle-file-chooser by default", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false);
    expect((config.playwright as any).args).not.toContain("--handle-file-chooser"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing dynamic MCP config shape
  });

  it("appends --headless to playwright args when playwrightHeadless=true", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false, false, true);
    const playwrightArgs = (config.playwright as MCPStdioServerConfig).args; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    expect(playwrightArgs).toContain("--headless");
  });

  it("omits --headless when playwrightHeadless=false (default)", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false);
    const playwrightArgs = (config.playwright as MCPStdioServerConfig).args; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    expect(playwrightArgs).not.toContain("--headless");
  });

  it("composes with --handle-file-chooser when both flags are set", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/ws", [], false, true, true);
    const playwrightArgs = (config.playwright as MCPStdioServerConfig).args; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    expect(playwrightArgs).toContain("--handle-file-chooser");
    expect(playwrightArgs).toContain("--headless");
  });

  describe("URL validation", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => logSpy.mockRestore());

    it("skips remote server with file:// URL", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig("/ws", [{ name: "Bad", url: "file:///etc/passwd" }], false);
      expect(config).not.toHaveProperty("bad");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("invalid URL"),
      );
      spy.mockRestore();
    });

    it("skips remote server with ftp:// URL", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig(
        "/ws",
        [{ name: "Bad", url: "ftp://files.example.com" }],
        false,
      );
      expect(config).not.toHaveProperty("bad");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("invalid URL"),
      );
      spy.mockRestore();
    });

    it("skips remote server with http:// for external host", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig("/ws", [{ name: "Bad", url: "http://evil.com" }], false);
      expect(config).not.toHaveProperty("bad");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("invalid URL"),
      );
      spy.mockRestore();
    });

    it("skips remote server with malformed URL", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig("/ws", [{ name: "Bad", url: "not-a-url" }], false);
      expect(config).not.toHaveProperty("bad");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("invalid URL"),
      );
      spy.mockRestore();
    });

    it("includes http://localhost server and logs warning", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig(
        "/ws",
        [{ name: "Local", url: "http://localhost:8080" }],
        false,
      );
      expect(config).toHaveProperty("local");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("localhost"),
      );
      spy.mockRestore();
    });

    it("includes https:// remote server without warning", async () => {
      const { buildMcpConfig } = await import("./mcp-tools");
      const spy = vi.spyOn<typeof console, "warn">(console, "warn").mockImplementation(() => {});
      const config = buildMcpConfig(
        "/ws",
        [{ name: "Safe", url: "https://api.example.com/mcp" }],
        false,
      );
      expect(config).toHaveProperty("safe");
      expect(spy).not.toHaveBeenCalledWith(
        expect.stringContaining("[McpTools]"),
        expect.stringContaining("invalid URL"),
      );
      spy.mockRestore();
    });
  });

  it("drops the bearer token when accessTokenOrigin does not match the server URL origin", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [
        {
          name: "Retargeted",
          type: "http",
          url: "https://attacker.example.com/mcp",
          accessToken: "legit-token",
          accessTokenOrigin: "https://legitimate.example.com",
        },
      ],
      false,
    );
    // Token must NOT be forwarded to the attacker's endpoint
    expect(config.retargeted).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fixture is an HTTP server
    expect((config.retargeted as MCPHTTPServerConfig).headers).toBeUndefined();
  });

  it("includes the bearer token when accessTokenOrigin matches the server URL origin", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [
        {
          name: "Safe Server",
          type: "http",
          url: "https://safe.example.com/mcp",
          accessToken: "legit-token",
          accessTokenOrigin: "https://safe.example.com",
        },
      ],
      false,
    );
    expect(config.safe_server).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fixture is an HTTP server
    expect((config.safe_server as MCPHTTPServerConfig).headers).toEqual({
      Authorization: "Bearer legit-token",
    });
  });

  it("includes the bearer token when accessTokenOrigin is absent (backward compat)", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/ws",
      [
        {
          name: "Legacy Server",
          type: "http",
          url: "https://api.example.com/mcp",
          accessToken: "tok123",
          // No accessTokenOrigin — pre-fix server record
        },
      ],
      false,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fixture is an HTTP server
    expect((config.legacy_server as MCPHTTPServerConfig).headers).toEqual({
      Authorization: "Bearer tok123",
    });
  });

  it("substitutes ${workspaceFolder} in envFile against activeWorkspaceFolder (not workspaceDir)", async () => {
    const fs = await import("fs");
    const captured: string[] = [];
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      captured.push(String(p));
      return "FOO=bar\n";
    });

    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/parent",
      [{ name: "Env Tool", type: "command", command: "x", envFile: "${workspaceFolder}/.env" }],
      false,
      false,
      false,
      "/parent/Scratchpad",
    );

    // mcp-env.ts runs the substituted path through path.resolve, so on Windows
    // `/parent/Scratchpad/.env` becomes `C:\parent\Scratchpad\.env`. Compare
    // against path.resolve()'d expectations so the assertion holds on both
    // POSIX and Windows agents.
    const expectedActive = path.resolve("/parent/Scratchpad/.env");
    const unexpectedParent = path.resolve("/parent/.env");
    expect((config.env_tool as any).env).toEqual({ FOO: "bar" }); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing dynamic MCP config shape
    expect(captured.some((p) => p === expectedActive)).toBe(true);
    expect(captured.some((p) => p === unexpectedParent)).toBe(false);
  });

  it("includes --output-dir when playwrightOutputDir is provided", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/workspace",
      [],
      false,
      false,
      false,
      undefined,
      "/home/user/.marshal/browser-output/sess1",
      undefined,
    );
    const args = (config.playwright as MCPStdioServerConfig).args ?? []; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    const idx = args.indexOf("--output-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/home/user/.marshal/browser-output/sess1");
  });

  it("includes --config when playwrightConfigPath is provided", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig(
      "/workspace",
      [],
      false,
      false,
      false,
      undefined,
      undefined,
      "/path/to/playwright-mcp-config.json",
    );
    const args = (config.playwright as MCPStdioServerConfig).args ?? []; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    const idx = args.indexOf("--config");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/path/to/playwright-mcp-config.json");
  });

  it("omits --output-dir when playwrightOutputDir is not provided", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/workspace", [], false);
    const args = (config.playwright as MCPStdioServerConfig).args; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    expect(args).not.toContain("--output-dir");
  });

  it("omits --config when playwrightConfigPath is not provided", async () => {
    const { buildMcpConfig } = await import("./mcp-tools");
    const config = buildMcpConfig("/workspace", [], false);
    const args = (config.playwright as MCPStdioServerConfig).args; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- playwright config is always stdio
    expect(args).not.toContain("--config");
  });
});
