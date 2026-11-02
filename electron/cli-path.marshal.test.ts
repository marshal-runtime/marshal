// Marshal-owned test
import * as path from "path";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  default: { existsSync: vi.fn<(path: string) => boolean>(() => false) },
  existsSync: vi.fn<(path: string) => boolean>(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn<(command: string) => string>(),
}));

import { execSync } from "child_process";
import * as fs from "fs";

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBundledCliPath", () => {
  it("returns path when CLI exists at cwd-based path", async () => {
    const { getBundledCliPath } = await import("./cli-path");

    const platform = process.platform;
    const arch = process.arch;
    let packageName: string;
    if (platform === "darwin" && arch === "arm64") packageName = "@github/copilot-darwin-arm64";
    else if (platform === "darwin" && arch === "x64") packageName = "@github/copilot-darwin-x64";
    else if (platform === "win32" && arch === "x64") packageName = "@github/copilot-win32-x64";
    else if (platform === "win32" && arch === "arm64") packageName = "@github/copilot-win32-arm64";
    else if (platform === "linux" && arch === "x64") packageName = "@github/copilot-linux-x64";
    else if (platform === "linux" && arch === "arm64") packageName = "@github/copilot-linux-arm64";
    else throw new Error(`Test unsupported on ${platform}-${arch}`);

    const suffix = platform === "win32" ? ".exe" : "";
    const expectedPath = path.join(process.cwd(), "node_modules", packageName, "copilot") + suffix;

    mockedExistsSync.mockImplementation((p) => p === expectedPath);

    const result = getBundledCliPath();
    expect(result).toBe(expectedPath);
  });

  it("throws when CLI not found", async () => {
    const { getBundledCliPath } = await import("./cli-path");
    mockedExistsSync.mockReturnValue(false);
    expect(() => getBundledCliPath()).toThrow("Copilot CLI not found");
  });

  it("skips .asar paths", async () => {
    const { getBundledCliPath } = await import("./cli-path");

    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      // Only "find" it at an .asar path (which should be skipped)
      return s.includes(".asar/");
    });

    expect(() => getBundledCliPath()).toThrow("Copilot CLI not found");
    // Verify existsSync was never called with an .asar/ path
    for (const call of mockedExistsSync.mock.calls) {
      const arg = String(call[0]);
      expect(arg).not.toMatch(/\.asar[/\\]/);
    }
  });
});

describe("tryGetGhToken", () => {
  it("returns token when gh CLI returns valid gho_ token", async () => {
    const { tryGetGhToken } = await import("./cli-path");
    mockedExecSync.mockReturnValue("gho_abc123\n");
    expect(tryGetGhToken()).toBe("gho_abc123");
  });

  it("returns token for ghp_ prefix", async () => {
    const { tryGetGhToken } = await import("./cli-path");
    mockedExecSync.mockReturnValue("ghp_xyz789\n");
    expect(tryGetGhToken()).toBe("ghp_xyz789");
  });

  it("returns null when gh CLI fails", async () => {
    const { tryGetGhToken } = await import("./cli-path");
    mockedExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(tryGetGhToken()).toBeNull();
  });

  it("returns null when token has wrong prefix", async () => {
    const { tryGetGhToken } = await import("./cli-path");
    mockedExecSync.mockReturnValue("github_pat_sometoken\n");
    expect(tryGetGhToken()).toBeNull();
  });
});
