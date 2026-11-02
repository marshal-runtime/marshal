import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomMcpServer } from "./ipc/types";

// Module-level — the mock factory closes over it, so getAppDataDir() always
// returns whatever value is current at call time. Reset in resolveMcpEnv's
// beforeEach so one test setting mockAppDataDir = tmpDir can't leak into the
// next test in the file (or any future suite added later).
let mockAppDataDir = "/tmp/mcp-env-test-app-data";
vi.mock("./app-paths", () => ({
  getAppDataDir: () => mockAppDataDir,
}));

const { parseEnvFile, resolveMcpEnv } = await import("./mcp-env");

type CommandServer = Extract<CustomMcpServer, { type: "command" }>;

function makeServer(extra: Partial<CommandServer> = {}): CommandServer {
  return {
    name: "test",
    type: "command",
    command: "/bin/true",
    ...extra,
  };
}

describe("parseEnvFile", () => {
  it("parses KEY=VALUE per line, ignoring blanks and # comments", () => {
    const text = ["# header comment", "", "FOO=bar", "BAZ=qux", "  ", "# trailing"].join("\n");
    expect(parseEnvFile(text)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching single or double quotes from values", () => {
    const text = ['DOUBLE="value with spaces"', "SINGLE='another value'", "MIXED=\"unquoted'"].join(
      "\n",
    );
    expect(parseEnvFile(text)).toEqual({
      DOUBLE: "value with spaces",
      SINGLE: "another value",
      MIXED: "\"unquoted'",
    });
  });

  it("ignores lines without an `=` and lines starting with `=`", () => {
    const text = ["NOEQUALS", "=novalue", "OK=yes"].join("\n");
    expect(parseEnvFile(text)).toEqual({ OK: "yes" });
  });
});

describe("resolveMcpEnv", () => {
  let tmpDir: string;

  beforeEach(() => {
    mockAppDataDir = "/tmp/mcp-env-test-app-data";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no envFile is set", () => {
    expect(resolveMcpEnv(makeServer())).toBeUndefined();
  });

  it("returns parsed envFile entries", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "FROM_FILE=file\nSHARED=file-value\n");
    const merged = resolveMcpEnv(makeServer({ envFile: envPath }));
    expect(merged).toEqual({ FROM_FILE: "file", SHARED: "file-value" });
  });

  it("substitutes ${workspaceFolder} in envFile when workspaceDir is provided", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "KEY=value\n");
    const merged = resolveMcpEnv(makeServer({ envFile: "${workspaceFolder}/.env" }), tmpDir);
    expect(merged).toEqual({ KEY: "value" });
  });

  it("substitutes ${mcpEnvDir} in envFile to ~/.marshal/marshal-mcp-env", () => {
    mockAppDataDir = tmpDir;
    const envDir = path.join(tmpDir, "marshal-mcp-env");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, "demo.env"), "TOKEN=secret\n");
    const merged = resolveMcpEnv(makeServer({ envFile: "${mcpEnvDir}/demo.env" }));
    expect(merged).toEqual({ TOKEN: "secret" });
  });

  it("returns undefined when envFile cannot be read", () => {
    const merged = resolveMcpEnv(makeServer({ envFile: path.join(tmpDir, "does-not-exist") }));
    expect(merged).toBeUndefined();
  });

  it("returns undefined when envFile exceeds the 64 KiB size cap", () => {
    const envPath = path.join(tmpDir, "huge.env");
    // 64 KiB + 1 byte — one byte past the cap so the size check trips before parse.
    fs.writeFileSync(envPath, "X=" + "a".repeat(64 * 1024));
    const merged = resolveMcpEnv(makeServer({ envFile: envPath }));
    expect(merged).toBeUndefined();
  });
});
