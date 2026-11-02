import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApp = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn<(name: string) => string>((name) => `/test/${name}`),
}));
vi.mock("electron", () => ({ app: mockApp }));
vi.mock("./mock-mode", () => ({
  isMockMode: vi.fn<() => boolean>(() => false),
  E2E_DATA_DIR: "/tmp/marshal-e2e-data",
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: { ...actual, randomUUID: () => "test-uuid-1234" },
    randomUUID: () => "test-uuid-1234",
  };
});

const mockMkdirSync = vi.hoisted(() =>
  vi.fn<(p: string, opts?: { recursive?: boolean; mode?: number }) => void>(),
);
const mockWriteFileSync = vi.hoisted(() =>
  vi.fn<(p: string, data: string, opts?: { flag?: string; mode?: number }) => void>(),
);
const mockUnlinkSync = vi.hoisted(() => vi.fn<(p: string) => void>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(p: string, enc?: string) => string>());
const mockExistsSync = vi.hoisted(() => vi.fn<(p: unknown) => boolean>());
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: {
      ...real,
      mkdirSync: mockMkdirSync,
      writeFileSync: mockWriteFileSync,
      unlinkSync: mockUnlinkSync,
      readFileSync: mockReadFileSync,
      existsSync: mockExistsSync,
    },
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
  };
});

import {
  getAppDataDir,
  getDocumentsPathOrNull,
  initializeAppDataDir,
  resolveWorkspaceDir,
  E2E_DATA_DIR,
} from "./app-paths";
import { isMockMode } from "./mock-mode";

// Most tests only care about the resolved directory; this helper unwraps the
// `WorkspaceResolution` struct so legacy assertions stay focused on the dir.
// Tests that need to assert `usedFallback` call `resolveWorkspaceDir` directly.
const dirOf = (documentsPath: string | null, override?: string): string =>
  resolveWorkspaceDir(documentsPath, override).dir;

const mockedIsMockMode = vi.mocked(isMockMode);

const EPERM = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
const EACCES = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const EROFS = () => Object.assign(new Error("EROFS"), { code: "EROFS" });
const ENOSPC = () => Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });

beforeEach(() => {
  vi.clearAllMocks();
  mockedIsMockMode.mockReturnValue(false);
  mockApp.isPackaged = true;
  mockApp.getPath.mockImplementation((name) => `/test/${name}`);
  mockMkdirSync.mockReturnValue(undefined);
  mockWriteFileSync.mockReturnValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
  mockExistsSync.mockReturnValue(false);
  // Default: no preference file on disk
  mockReadFileSync.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  delete process.env.MARSHAL_DEV_DATA_DIR;
});

afterEach(() => {
  delete process.env.MARSHAL_DEV_DATA_DIR;
  vi.restoreAllMocks();
});

/** Assert no filesystem paths or usernames in any console.warn call. */
function assertNoPathPII(warnSpy: ReturnType<typeof vi.spyOn>): void {
  for (const call of warnSpy.mock.calls) {
    const msg = call.map(String).join(" ");
    expect(msg).not.toMatch(/\/Users\/|\/home\/\w|C:\\Users\\/i);
    expect(msg).not.toContain(os.homedir());
  }
}

describe("getAppDataDir", () => {
  it("returns ~/.marshal in packaged mode", () => {
    expect(getAppDataDir()).toBe(path.join(os.homedir(), ".marshal"));
  });

  it("returns ~/.marshal-dev in dev mode", () => {
    mockApp.isPackaged = false;
    expect(getAppDataDir()).toBe(path.join(os.homedir(), ".marshal-dev"));
  });

  it("supports an explicit isolated dev data directory", () => {
    mockApp.isPackaged = false;
    process.env.MARSHAL_DEV_DATA_DIR = path.join(os.tmpdir(), "marshal-whatsapp-vertical");
    expect(getAppDataDir()).toBe(path.join(os.tmpdir(), "marshal-whatsapp-vertical"));
  });

  it("returns E2E_DATA_DIR in mock mode", () => {
    mockedIsMockMode.mockReturnValue(true);
    expect(getAppDataDir()).toBe(E2E_DATA_DIR);
  });
});

describe("initializeAppDataDir", () => {
  it("creates the packaged Marshal state root with owner-only permissions", () => {
    expect(initializeAppDataDir()).toBe(path.join(os.homedir(), ".marshal"));
    expect(mockMkdirSync).toHaveBeenCalledWith(path.join(os.homedir(), ".marshal"), {
      recursive: true,
      mode: 0o700,
    });
  });
});

describe("resolveWorkspaceDir", () => {
  const DOCS = "/test/Documents";
  const PREFERRED = path.join(DOCS, "Marshal");
  const PROBE_NAME = ".marshal-probe-test-uuid-1234";

  it("returns preferred path when probe succeeds", () => {
    const result = dirOf(DOCS);

    expect(result).toBe(PREFERRED);
    expect(mockMkdirSync).toHaveBeenCalledWith(PREFERRED, { recursive: true, mode: 0o700 });
    expect(mockWriteFileSync).toHaveBeenCalledWith(path.join(PREFERRED, PROBE_NAME), "", {
      flag: "wx",
      mode: 0o600,
    });
    expect(mockUnlinkSync).toHaveBeenCalledWith(path.join(PREFERRED, PROBE_NAME));
    // Fallback NOT touched
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
  });

  it("cleans up probe after write (write before unlink, same path)", () => {
    dirOf(DOCS);

    const writePath = mockWriteFileSync.mock.calls[0]?.[0];
    const unlinkPath = mockUnlinkSync.mock.calls[0]?.[0];
    expect(writePath).toBe(unlinkPath);
    expect(mockWriteFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnlinkSync.mock.invocationCallOrder[0],
    );
  });

  it("still accepts dir when unlinkSync fails (cleanup is best-effort)", () => {
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EBUSY: resource busy");
    });

    const result = dirOf(DOCS);

    expect(result).toBe(PREFERRED);
  });

  it("falls back when write probe fails with EPERM", () => {
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EPERM();
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: true });
    expect(warnSpy).toHaveBeenCalled();
    assertNoPathPII(warnSpy);
  });

  it("falls back when mkdirSync throws EPERM on preferred", () => {
    mockMkdirSync.mockImplementation((p: string) => {
      if (p === PREFERRED) throw EPERM();
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: true });
    expect(warnSpy).toHaveBeenCalled();
    assertNoPathPII(warnSpy);
  });

  it("falls back when write probe fails with EACCES", () => {
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EACCES();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: true });
  });

  it("falls back when write probe fails with EROFS", () => {
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EROFS();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: true });
  });

  it("rethrows non-permission errors (ENOSPC) from writeFileSync instead of falling back", () => {
    mockWriteFileSync.mockImplementation(() => {
      throw ENOSPC();
    });

    expect(() => dirOf(DOCS)).toThrow("Workspace probe failed (ENOSPC)");
    // Sanitized error must not contain probe file path
    let caught: unknown;
    try {
      dirOf(DOCS);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).not.toMatch(/marshal-probe-/);
  });

  it("rethrows non-permission errors (ENOSPC) from mkdirSync instead of falling back", () => {
    mockMkdirSync.mockImplementation(() => {
      throw ENOSPC();
    });

    expect(() => dirOf(DOCS)).toThrow("Workspace probe failed (ENOSPC)");
  });

  it("sanitizes probe path from rethrown error stack", () => {
    const probePath = "/Users/alice/Documents/Marshal/.marshal-probe-abc123";
    const fsError = Object.assign(
      new Error(`ENOSPC: no space left on device, write '${probePath}'`),
      { code: "ENOSPC" },
    );
    fsError.stack = `Error: ENOSPC: no space left on device, write '${probePath}'\n    at writeFileSync (node:fs:1)`;
    mockWriteFileSync.mockImplementation(() => {
      throw fsError;
    });

    let caught: unknown;
    try {
      dirOf(DOCS);
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof Error)) throw new Error("expected Error");
    expect(caught.message).toBe("Workspace probe failed (ENOSPC)");
    expect(caught.message).not.toContain(probePath);
    // Stack first line is sanitized, but frames are preserved
    expect(caught.stack).not.toContain(probePath);
    expect(caught.stack).toContain("at writeFileSync");
  });

  it("throws sanitized error when both paths fail with access denied", () => {
    mockWriteFileSync.mockImplementation(() => {
      throw EPERM();
    });

    expect(() => dirOf(DOCS)).toThrow("Cannot access workspace directory");
    let caught: unknown;
    try {
      dirOf(DOCS);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).not.toMatch(/\/test\/|\/Users\/|\/home\/\w|C:\\Users\\/i);
  });

  it("validates fallback with mkdirSync (mode 0o700) and write probe", () => {
    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EPERM();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    dirOf(DOCS);

    expect(mockMkdirSync).toHaveBeenCalledWith(fallback, { recursive: true, mode: 0o700 });
    // 3 writes: preferred probe (fails), fallback probe, preference file
    expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
  });

  it("uses dev-mode fallback path and warns without PII", () => {
    mockApp.isPackaged = false;
    const devFallback = path.join(os.homedir(), ".marshal-dev", "workspace");
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EPERM();
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = dirOf(DOCS);

    expect(result).toBe(devFallback);
    expect(mockMkdirSync).toHaveBeenCalledWith(devFallback, { recursive: true, mode: 0o700 });
    expect(warnSpy).toHaveBeenCalled();
    assertNoPathPII(warnSpy);
  });

  it("throws when both preferred and fallback write probes fail with EPERM", () => {
    // All writes fail with EPERM
    mockWriteFileSync.mockImplementation(() => {
      throw EPERM();
    });

    expect(() => dirOf(DOCS)).toThrow("Cannot access workspace directory");
  });

  it("falls back to app data when documentsPath is null (Documents unresolvable)", () => {
    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = resolveWorkspaceDir(null);

    expect(result).toEqual({ dir: fallback, usedFallback: true });
    // Preferred path never attempted — no mkdir/probe under any Marshal path
    expect(mockMkdirSync).not.toHaveBeenCalledWith(
      expect.stringContaining(path.join("Documents", "Marshal")),
      expect.anything(),
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), ".marshal", ".workspace-preference"),
      "fallback",
      { mode: 0o600 },
    );
    expect(warnSpy).toHaveBeenCalled();
    assertNoPathPII(warnSpy);
  });

  it("throws when documentsPath is null and fallback is also inaccessible", () => {
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.includes("workspace")) throw EPERM();
    });

    expect(() => resolveWorkspaceDir(null)).toThrow("Cannot access workspace directory");
  });

  it("happy path reports usedFallback: false", () => {
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: PREFERRED, usedFallback: false });
  });

  it("steady-state sticky-preference launches report usedFallback: false (no transition)", () => {
    mockReadFileSync.mockReturnValue("fallback");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: false });
    // No warn on the steady-state path — usedFallback: false + warn silence
    // together pin "this is not a new transition" so main.ts skips telemetry.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("first transition when Documents is inaccessible reports usedFallback: true", () => {
    mockWriteFileSync.mockImplementation((p: string) => {
      if (p.startsWith(PREFERRED)) throw EPERM();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    expect(resolveWorkspaceDir(DOCS)).toEqual({ dir: fallback, usedFallback: true });
  });

  it("returns E2E workspace in mock mode without fs checks", () => {
    mockedIsMockMode.mockReturnValue(true);

    const result = dirOf(DOCS);

    expect(result).toBe(path.join(E2E_DATA_DIR, "workspace"));
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("does not leak PII in any warn or error path", () => {
    mockWriteFileSync.mockImplementation(() => {
      throw EPERM();
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      dirOf("/Users/secretuser/Documents");
    } catch {
      // expected
    }

    assertNoPathPII(warnSpy);
  });

  describe("sticky workspace preference", () => {
    const FALLBACK = path.join(os.homedir(), ".marshal", "workspace");
    const PREF_FILE = path.join(os.homedir(), ".marshal", ".workspace-preference");

    it("uses persisted fallback and skips Documents probe", () => {
      mockReadFileSync.mockReturnValue("fallback");

      const result = dirOf(DOCS);

      expect(result).toBe(FALLBACK);
      // mkdirSync called only for fallback, not preferred
      expect(mockMkdirSync).toHaveBeenCalledTimes(1);
      expect(mockMkdirSync).toHaveBeenCalledWith(FALLBACK, { recursive: true, mode: 0o700 });
    });

    it("persists fallback preference when Documents is inaccessible", () => {
      mockWriteFileSync.mockImplementation((p: string) => {
        if (p.startsWith(PREFERRED)) throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      dirOf(DOCS);

      // Preference file written with "fallback"
      expect(mockWriteFileSync).toHaveBeenCalledWith(PREF_FILE, "fallback", { mode: 0o600 });
    });

    it("clears stale preference and re-probes when fallback is broken", () => {
      mockReadFileSync.mockReturnValue("fallback");
      // Fallback now also broken — both dirs fail at write probe
      mockWriteFileSync.mockImplementation((p: string) => {
        if (p.startsWith(FALLBACK)) throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = dirOf(DOCS);

      // Should have cleared the preference
      expect(mockUnlinkSync).toHaveBeenCalledWith(PREF_FILE);
      // Falls through to preferred (Documents) which now works
      expect(result).toBe(PREFERRED);
    });

    it("ignores preference file with invalid content", () => {
      mockReadFileSync.mockReturnValue("bogus-value");

      const result = dirOf(DOCS);

      // Normal probe — preferred should be used
      expect(result).toBe(PREFERRED);
    });

    it("does not persist preference when Documents probe succeeds", () => {
      const result = dirOf(DOCS);

      expect(result).toBe(PREFERRED);
      // No preference file written
      const prefWrites = mockWriteFileSync.mock.calls.filter(
        ([p]) => typeof p === "string" && p === PREF_FILE,
      );
      expect(prefWrites).toHaveLength(0);
    });

    it("does not leak PII in sticky preference logs", () => {
      mockReadFileSync.mockReturnValue("fallback");
      // Fallback broken — triggers warn + re-probe
      mockMkdirSync.mockImplementation((p: string) => {
        if (p === FALLBACK) throw EPERM();
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      dirOf(DOCS);

      assertNoPathPII(warnSpy);
    });

    it("falls through to normal probe when readFileSync fails with EACCES", () => {
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      });

      // Normal probe succeeds — preference read failure is swallowed
      expect(dirOf(DOCS)).toBe(PREFERRED);
    });

    it("still returns fallback when persistWorkspacePreference fails", () => {
      // Preferred fails, fallback probe succeeds, but preference persist fails
      mockWriteFileSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.startsWith(PREFERRED)) throw EPERM();
        if (typeof p === "string" && p === PREF_FILE) throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should still return fallback — persist failure is best-effort
      expect(dirOf(DOCS)).toBe(FALLBACK);
    });

    it("still re-probes when clearWorkspacePreference fails", () => {
      mockReadFileSync.mockReturnValue("fallback");
      // Fallback broken, clear fails too
      mockMkdirSync.mockImplementation((p: string) => {
        if (p === FALLBACK) throw EPERM();
      });
      mockUnlinkSync.mockImplementation((p: string) => {
        if (p === PREF_FILE) throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should still fall through to preferred (Documents works)
      expect(dirOf(DOCS)).toBe(PREFERRED);
    });

    it("does not probe fallback twice when persisted preference is stale", () => {
      mockReadFileSync.mockReturnValue("fallback");
      // Fallback broken at mkdirSync
      mockMkdirSync.mockImplementation((p: string) => {
        if (p === FALLBACK) throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      dirOf(DOCS);

      // Fallback mkdirSync called exactly once (not re-probed after preferred)
      const fallbackMkdirCalls = mockMkdirSync.mock.calls.filter(([p]) => p === FALLBACK);
      expect(fallbackMkdirCalls).toHaveLength(1);
    });

    it("throws without re-probing fallback when both stale fallback and preferred fail", () => {
      mockReadFileSync.mockReturnValue("fallback");
      // Both dirs fail
      mockMkdirSync.mockImplementation(() => {
        throw EPERM();
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => dirOf(DOCS)).toThrow("Cannot access workspace directory");

      // Fallback probed once (stale preference check), not again after preferred fails
      const fallbackMkdirCalls = mockMkdirSync.mock.calls.filter(([p]) => p === FALLBACK);
      expect(fallbackMkdirCalls).toHaveLength(1);
    });
  });

  it("returns resolved override path when provided", () => {
    const override = path.resolve("/custom/workspace");
    expect(dirOf("/home/user/Documents", override)).toBe(override);
  });

  it("ignores override in mock mode", () => {
    mockedIsMockMode.mockReturnValue(true);
    expect(dirOf("/home/user/Documents", "/custom/workspace")).toBe(
      path.join(E2E_DATA_DIR, "workspace"),
    );
  });

  it("falls back to default when override is undefined", () => {
    expect(dirOf("/home/user/Documents", undefined)).toBe(
      path.join("/home/user/Documents", "Marshal"),
    );
  });

  it("rejects relative override and falls back to default", () => {
    expect(dirOf("/home/user/Documents", "relative/path")).toBe(
      path.join("/home/user/Documents", "Marshal"),
    );
  });

  it("non-absolute override with null documentsPath falls back and persists", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const fallback = path.join(os.homedir(), ".marshal", "workspace");
    // usedFallback must be true here: non-absolute override flows through
    // the normal probe ladder, which then falls back due to null documents.
    expect(resolveWorkspaceDir(null, "relative/path")).toEqual({
      dir: fallback,
      usedFallback: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), ".marshal", ".workspace-preference"),
      "fallback",
      { mode: 0o600 },
    );
  });
});

describe("getDocumentsPathOrNull", () => {
  it("returns the path on success", () => {
    mockApp.getPath.mockReturnValue("/Users/test/Documents");

    expect(getDocumentsPathOrNull()).toBe("/Users/test/Documents");
    expect(mockApp.getPath).toHaveBeenCalledWith("documents");
  });

  it("returns null when app.getPath throws (broken cloud-sync folder symlink)", () => {
    // Electron error messages on macOS can carry the resolved-but-missing path.
    mockApp.getPath.mockImplementation(() => {
      throw new Error(
        "Failed to get 'documents' path: /Users/secretuser/Library/CloudStorage/CloudDrive-Personal(2)/Documents",
      );
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getDocumentsPathOrNull()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    // Path-bearing err.message must not leak into the warn output.
    assertNoPathPII(warnSpy);
  });

  it("returns null for non-Error throw values", () => {
    mockApp.getPath.mockImplementation(() => {
      throw "string-error with /Users/secretuser/Documents in it";
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getDocumentsPathOrNull()).toBeNull();
    assertNoPathPII(warnSpy);
  });
});
