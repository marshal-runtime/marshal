// Marshal-owned test
import { describe, it, expect, vi } from "vitest";

vi.mock("../app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));

import type { AddMcpServerInput, CustomMcpServer } from "../../common/marshal-ipc-contract";
import { validateAddMcpServer, buildCatalogMcpServer, buildMcpConfigArgs } from "./extensions-ipc";

// ── validateAddMcpServer ──────────────────────────────────────────────────────

describe("validateAddMcpServer", () => {
  const noExisting: CustomMcpServer[] = [];

  it("rejects empty name", () => {
    const input: AddMcpServerInput = { name: "  ", mode: "command", command: "echo hi" };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({ error: "Name is required" });
  });

  it('rejects reserved name "filesystem" (case-insensitive)', () => {
    const lower: AddMcpServerInput = { name: "filesystem", mode: "command", command: "echo" };
    expect(validateAddMcpServer(lower, noExisting)).toEqual(
      expect.objectContaining({ error: expect.stringContaining("built-in") }),
    );

    const mixed: AddMcpServerInput = { name: "FileSystem", mode: "command", command: "echo" };
    expect(validateAddMcpServer(mixed, noExisting)).toEqual(
      expect.objectContaining({ error: expect.stringContaining("built-in") }),
    );
  });

  it('rejects reserved name "playwright"', () => {
    const input: AddMcpServerInput = { name: "playwright", mode: "command", command: "echo" };
    expect(validateAddMcpServer(input, noExisting)).toEqual(
      expect.objectContaining({ error: expect.stringContaining("built-in") }),
    );
  });

  it("rejects duplicate server names", () => {
    const existing: CustomMcpServer[] = [{ name: "my-server", type: "command", command: "echo" }];
    const input: AddMcpServerInput = { name: "my-server", mode: "command", command: "echo" };
    const result = validateAddMcpServer(input, existing);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("already exists") }),
    );
  });

  it("command mode: splits command string into command + args", () => {
    const input: AddMcpServerInput = {
      name: "foo",
      mode: "command",
      command: "npx -y @foo/bar --port 3000",
    };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({
      server: {
        name: "foo",
        type: "command",
        command: "npx",
        args: ["-y", "@foo/bar", "--port", "3000"],
      },
      needsOAuth: false,
    });
  });

  it("command mode: rejects empty command", () => {
    const input: AddMcpServerInput = { name: "foo", mode: "command", command: "  " };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({ error: "Command is required" });
  });

  it("command mode: preserves envFile and trims surrounding whitespace", () => {
    const input: AddMcpServerInput = {
      name: "foo",
      mode: "command",
      command: "npx -y @foo/bar",
      envFile: "  ${workspaceFolder}/.env  ",
    };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({
      server: {
        name: "foo",
        type: "command",
        command: "npx",
        args: ["-y", "@foo/bar"],
        envFile: "${workspaceFolder}/.env",
      },
      needsOAuth: false,
    });
  });

  it("URL mode: rejects invalid URL", () => {
    const input: AddMcpServerInput = { name: "foo", mode: "url", url: "not-a-url" };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it("URL mode: accepts https://example.com with needsOAuth: true", () => {
    const input: AddMcpServerInput = { name: "remote", mode: "url", url: "https://example.com" };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({
      server: { name: "remote", url: "https://example.com" },
      needsOAuth: true,
    });
  });

  it("URL mode: accepts http://localhost:3000 with needsOAuth: false", () => {
    const input: AddMcpServerInput = { name: "local", mode: "url", url: "http://localhost:3000" };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({
      server: { name: "local", url: "http://localhost:3000" },
      needsOAuth: false,
    });
  });

  it("adds custom HTTP server with Bearer token and records origin", () => {
    const input: AddMcpServerInput = {
      name: "authed",
      mode: "url",
      url: "https://example.com/mcp",
      bearerToken: "tok_abc123",
    };
    const result = validateAddMcpServer(input, noExisting);
    expect(result).toEqual({
      server: {
        name: "authed",
        url: "https://example.com/mcp",
        accessToken: "tok_abc123",
        accessTokenOrigin: "https://example.com",
      },
      needsOAuth: false,
    });
  });

  describe("transport", () => {
    it("URL mode: omits the type field when transport is unset (defaults to streamable HTTP)", () => {
      const input: AddMcpServerInput = {
        name: "default-http",
        mode: "url",
        url: "https://example.com",
      };
      const result = validateAddMcpServer(input, noExisting);
      // No ``type`` key on the persisted server — every consumer treats
      // missing as streamable HTTP, and omitting keeps existing on-disk
      // records byte-identical for users who never touched the toggle.
      expect(result).toEqual({
        server: { name: "default-http", url: "https://example.com" },
        needsOAuth: true,
      });
    });

    it("URL mode: omits the type field when transport is explicitly http", () => {
      const input: AddMcpServerInput = {
        name: "explicit-http",
        mode: "url",
        url: "https://example.com",
        transport: "http",
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: { name: "explicit-http", url: "https://example.com" },
        needsOAuth: true,
      });
    });

    it("URL mode: persists type='sse' when transport is sse", () => {
      const input: AddMcpServerInput = {
        name: "legacy-sse",
        mode: "url",
        url: "https://example.com/sse",
        transport: "sse",
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: { name: "legacy-sse", url: "https://example.com/sse", type: "sse" },
        needsOAuth: true,
      });
    });

    it("URL mode: persists type='sse' alongside bearer token", () => {
      const input: AddMcpServerInput = {
        name: "legacy-authed",
        mode: "url",
        url: "https://example.com/sse",
        bearerToken: "tok_xyz",
        transport: "sse",
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: {
          name: "legacy-authed",
          url: "https://example.com/sse",
          accessToken: "tok_xyz",
          accessTokenOrigin: "https://example.com",
          type: "sse",
        },
        needsOAuth: false,
      });
    });

    it("command mode: ignores transport (command servers don't have a wire transport)", () => {
      const input: AddMcpServerInput = {
        name: "cmd",
        mode: "command",
        command: "npx -y @foo/bar",
        transport: "sse",
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: {
          name: "cmd",
          type: "command",
          command: "npx",
          args: ["-y", "@foo/bar"],
        },
        needsOAuth: false,
      });
    });
  });

  describe("timeout", () => {
    it("command mode: persists a positive integer timeout (ms)", () => {
      const input: AddMcpServerInput = {
        name: "long-running",
        mode: "command",
        command: "slow-server",
        timeout: 1_800_000,
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: {
          name: "long-running",
          type: "command",
          command: "slow-server",
          args: undefined,
          timeout: 1_800_000,
        },
        needsOAuth: false,
      });
    });

    it("URL mode: persists timeout alongside bearer token", () => {
      const input: AddMcpServerInput = {
        name: "remote-slow",
        mode: "url",
        url: "https://example.com",
        bearerToken: "tok",
        timeout: 120_000,
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: {
          name: "remote-slow",
          url: "https://example.com",
          accessToken: "tok",
          accessTokenOrigin: "https://example.com",
          timeout: 120_000,
        },
        needsOAuth: false,
      });
    });

    it("URL mode: persists timeout without bearer token", () => {
      const input: AddMcpServerInput = {
        name: "remote-anon",
        mode: "url",
        url: "http://localhost:3000",
        timeout: 90_000,
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: { name: "remote-anon", url: "http://localhost:3000", timeout: 90_000 },
        needsOAuth: false,
      });
    });

    it("omits timeout when not provided", () => {
      const input: AddMcpServerInput = { name: "no-to", mode: "command", command: "echo" };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual({
        server: { name: "no-to", type: "command", command: "echo", args: undefined },
        needsOAuth: false,
      });
      // Confirm the field is absent (not just undefined)
      if (!("server" in result)) throw new Error("expected server, got error");
      expect(Object.prototype.hasOwnProperty.call(result.server, "timeout")).toBe(false);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
      ["non-integer", 1.5],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("rejects %s timeout", (_label, badValue) => {
      const input: AddMcpServerInput = {
        name: "bad-to",
        mode: "command",
        command: "echo",
        timeout: badValue,
      };
      const result = validateAddMcpServer(input, noExisting);
      expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    });
  });

  describe("exposeAsGatewayNodeCommand", () => {
    /** Narrow the validateAddMcpServer return tagged-union to its success
     *  branch so the test body can read `result.server.*` unconditionally
     *  (matches the linter's no-conditional-expect rule). */
    function expectServer(result: ReturnType<typeof validateAddMcpServer>): {
      server: CustomMcpServer;
      needsOAuth: boolean;
    } {
      expect(result).not.toHaveProperty("error");
      if (!("server" in result)) throw new Error("expected success branch");
      return result;
    }

    it("forwards the flag onto the constructed command server when input opts in", () => {
      const result = expectServer(
        validateAddMcpServer(
          {
            name: "fs",
            mode: "command",
            command: "npx -y mcp-fs",
            exposeAsGatewayNodeCommand: true,
          },
          [],
        ),
      );
      expect(result.server.exposeAsGatewayNodeCommand).toBe(true);
    });

    it("forwards the flag onto the constructed url server when input opts in", () => {
      const result = expectServer(
        validateAddMcpServer(
          {
            name: "remote",
            mode: "url",
            url: "http://localhost:3000",
            exposeAsGatewayNodeCommand: true,
          },
          [],
        ),
      );
      expect(result.server.exposeAsGatewayNodeCommand).toBe(true);
    });

    it("omits the flag entirely when input doesn't opt in (so on-disk creds stay minimal)", () => {
      const result = expectServer(
        validateAddMcpServer({ name: "fs", mode: "command", command: "npx -y mcp-fs" }, []),
      );
      expect("exposeAsGatewayNodeCommand" in result.server).toBe(false);
    });
  });
});

// ── buildCatalogMcpServer ─────────────────────────────────────────────────────

describe("buildCatalogMcpServer", () => {
  const noExisting: CustomMcpServer[] = [];

  it("parses command-type JSON into a command server", () => {
    const catalog = JSON.stringify({
      type: "command",
      command: "npx",
      args: ["serve", "--port", "4000"],
    });
    const result = buildCatalogMcpServer("my-cmd", catalog, noExisting);
    expect(result).toEqual({
      server: {
        name: "my-cmd",
        type: "command",
        command: "npx",
        args: ["serve", "--port", "4000"],
      },
    });
  });

  it('parses URL-type JSON into a URL server with type "http"', () => {
    const catalog = JSON.stringify({ type: "url", url: "https://api.example.com/mcp" });
    const result = buildCatalogMcpServer("my-url", catalog, noExisting);
    expect(result).toEqual({
      server: { name: "my-url", url: "https://api.example.com/mcp", type: "http" },
    });
  });

  it('parses SSE-type JSON into a URL server with type "sse"', () => {
    const catalog = JSON.stringify({
      type: "url",
      serverType: "sse",
      url: "https://sse.example.com",
    });
    const result = buildCatalogMcpServer("my-sse", catalog, noExisting);
    expect(result).toEqual({
      server: { name: "my-sse", url: "https://sse.example.com", type: "sse" },
    });
  });

  it("rejects duplicate server name", () => {
    const existing: CustomMcpServer[] = [{ name: "dupe", type: "command", command: "echo" }];
    const catalog = JSON.stringify({ type: "command", command: "echo" });
    const result = buildCatalogMcpServer("dupe", catalog, existing);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("already installed") }),
    );
  });

  it("returns error on malformed JSON", () => {
    const result = buildCatalogMcpServer("bad", "not json {{", noExisting);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining("Invalid catalog content") }),
    );
  });

  it("preserves a valid catalog timeout (ms)", () => {
    const catalog = JSON.stringify({
      type: "command",
      command: "slow",
      args: [],
      timeout: 600_000,
    });
    const result = buildCatalogMcpServer("with-to", catalog, noExisting);
    expect(result).toEqual({
      server: { name: "with-to", type: "command", command: "slow", args: [], timeout: 600_000 },
    });
  });

  it("silently drops an invalid catalog timeout (negative)", () => {
    const catalog = JSON.stringify({ type: "command", command: "x", args: [], timeout: -5 });
    const result = buildCatalogMcpServer("bad-to", catalog, noExisting);
    expect(result).toEqual({
      server: { name: "bad-to", type: "command", command: "x", args: [] },
    });
    if (!("server" in result)) throw new Error("expected server, got error");
    expect(Object.prototype.hasOwnProperty.call(result.server, "timeout")).toBe(false);
  });

  it.each([
    ["zero", `0`],
    ["non-integer", `1.5`],
    ["string", `"60000"`],
    ["object", `{}`],
  ])("silently drops an invalid catalog timeout (%s)", (_label, badValueJson) => {
    const catalog = `{"type":"command","command":"x","args":[],"timeout":${badValueJson}}`;
    const result = buildCatalogMcpServer("bad-to", catalog, noExisting);
    if (!("server" in result)) throw new Error("expected server, got error");
    expect(Object.prototype.hasOwnProperty.call(result.server, "timeout")).toBe(false);
  });

  it("silently drops a null catalog timeout (regression: prior NaN sentinel leak)", () => {
    // Previously, ``serverDef.timeout = null`` passed the ``!== undefined`` guard,
    // and ``validateTimeout(null)`` returned a NaN sentinel that then survived
    // the secondary check, leaking ``timeout: NaN`` into the SDK config. Note:
    // ``JSON.stringify({timeout: NaN})`` also encodes NaN as ``null``, so this
    // test exercises both the original NaN scenario and the literal-null case.
    const catalog = `{"type":"command","command":"x","args":[],"timeout":null}`;
    const result = buildCatalogMcpServer("null-to", catalog, noExisting);
    expect(result).toEqual({
      server: { name: "null-to", type: "command", command: "x", args: [] },
    });
    if (!("server" in result)) throw new Error("expected server, got error");
    expect(Object.prototype.hasOwnProperty.call(result.server, "timeout")).toBe(false);
  });

  it("strips any envFile supplied by catalog content (supply-chain hardening)", () => {
    // resolveMcpEnv reads whatever path envFile points at and injects KEY=VALUE
    // pairs into the child env, so honoring a catalog-supplied envFile would
    // let a malicious catalog entry exfiltrate file contents.
    const catalog = JSON.stringify({
      type: "command",
      command: "x",
      args: [],
      envFile: "/etc/passwd",
    });
    const result = buildCatalogMcpServer("evil", catalog, noExisting);
    if (!("server" in result)) throw new Error("expected server, got error");
    expect(Object.prototype.hasOwnProperty.call(result.server, "envFile")).toBe(false);
  });
});

// ── buildMcpConfigArgs ────────────────────────────────────────────────────────

describe("buildMcpConfigArgs", () => {
  it("builds args from base args + config values", () => {
    const catalog = JSON.stringify({ args: ["--base", "flag"] });
    const params = [{ key: "apiKey" }, { key: "region" }];
    const values = { apiKey: "sk-123", region: "us-east-1" };
    const result = buildMcpConfigArgs(catalog, params, values);
    expect(result).toEqual(["--base", "flag", "sk-123", "us-east-1"]);
  });

  it("skips empty/whitespace-only config values", () => {
    const catalog = JSON.stringify({ args: ["--base"] });
    const params = [{ key: "filled" }, { key: "empty" }, { key: "spaces" }];
    const values = { filled: "val", empty: "", spaces: "   " };
    const result = buildMcpConfigArgs(catalog, params, values);
    expect(result).toEqual(["--base", "val"]);
  });

  it("returns only base args when all config values are empty", () => {
    const catalog = JSON.stringify({ args: ["--default"] });
    const params = [{ key: "a" }, { key: "b" }];
    const values = { a: "", b: "  " };
    const result = buildMcpConfigArgs(catalog, params, values);
    expect(result).toEqual(["--default"]);
  });
});
