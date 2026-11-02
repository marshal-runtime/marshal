import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveClaudeExecutablePath, resolvePackagedClaudeExecutable } from "./executable-path";

const RESOURCES = String.raw`C:\Program Files\Marshal\resources`;

function flatPath(platform: NodeJS.Platform, arch: string): string {
  return path.join(
    RESOURCES,
    "app.asar.unpacked",
    "node_modules",
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    platform === "win32" ? "claude.exe" : "claude",
  );
}

describe("resolvePackagedClaudeExecutable", () => {
  it("returns undefined in development without probing the filesystem", () => {
    const existsSync = vi.fn<(candidate: string) => boolean>(() => true);

    expect(
      resolvePackagedClaudeExecutable({
        isPackaged: false,
        resourcesPath: RESOURCES,
        platform: "win32",
        arch: "x64",
        existsSync,
      }),
    ).toBeUndefined();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it.each([
    ["win32" as const, "x64"],
    ["win32" as const, "arm64"],
    ["linux" as const, "x64"],
    ["linux" as const, "arm64"],
  ])("resolves the unpacked %s-%s executable", (platform, arch) => {
    const expected = flatPath(platform, arch);

    expect(
      resolvePackagedClaudeExecutable({
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform,
        arch,
        existsSync: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("prefers the packaged macOS app wrapper required by Tahoe AMFI", () => {
    const flat = flatPath("darwin", "arm64");
    const wrapped = path.join(
      RESOURCES,
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
    const probes: string[] = [];

    expect(
      resolvePackagedClaudeExecutable({
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform: "darwin",
        arch: "arm64",
        existsSync: (candidate) => {
          probes.push(candidate);
          return candidate === wrapped || candidate === flat;
        },
      }),
    ).toBe(wrapped);
    expect(probes).toEqual([wrapped]);
  });

  it("falls back to the flat macOS executable before afterPack wrapping", () => {
    const flat = flatPath("darwin", "x64");

    expect(
      resolvePackagedClaudeExecutable({
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform: "darwin",
        arch: "x64",
        existsSync: (candidate) => candidate === flat,
      }),
    ).toBe(flat);
  });

  it("fails with every searched path when a packaged executable is missing", () => {
    expect(() =>
      resolvePackagedClaudeExecutable({
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform: "darwin",
        arch: "arm64",
        existsSync: () => false,
      }),
    ).toThrow(
      /claude-agent-sdk-darwin-arm64.*claude\.app.*Contents.*MacOS.*claude[\s\S]*claude-agent-sdk-darwin-arm64.*claude/,
    );
  });

  it("rejects packaged platforms without a bundled SDK executable", () => {
    expect(() =>
      resolvePackagedClaudeExecutable({
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform: "aix",
        arch: "ppc64",
      }),
    ).toThrow("Unsupported Claude Agent SDK platform: aix-ppc64");
  });
});

describe("resolveClaudeExecutablePath", () => {
  it("preserves an explicit factory override without probing the packaged default", () => {
    const existsSync = vi.fn<(candidate: string) => boolean>(() => false);

    expect(
      resolveClaudeExecutablePath(String.raw`D:\custom\claude.exe`, {
        isPackaged: true,
        resourcesPath: RESOURCES,
        platform: "win32",
        arch: "x64",
        existsSync,
      }),
    ).toBe(String.raw`D:\custom\claude.exe`);
    expect(existsSync).not.toHaveBeenCalled();
  });
});
