import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecFile = vi.fn<(...args: unknown[]) => void>();
const mockExecFileSync = vi.fn<(...args: unknown[]) => string>();
const mockExistsSync = vi.fn<(p: string) => boolean>(() => true);

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
}));

describe("platform-security", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    mockExecFile.mockReset();
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((executable) =>
      String(executable).endsWith("whoami.exe")
        ? '"MIDDLEEAST\\user","S-1-5-21-100-200-300-400"\r\n'
        : "Successfully processed 1 files; Failed processing 0 files\r\n",
    );
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  describe("excludeFromBackup", () => {
    it("calls xattr on macOS for existing path", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { excludeFromBackup } = await import("./platform-security");

      excludeFromBackup("/home/user/.marshal/marshal-auth");

      expect(mockExecFile).toHaveBeenCalledWith(
        "xattr",
        [
          "-w",
          "com.apple.metadata:com_apple_backup_excludeItem",
          "com.apple.backupd",
          "/home/user/.marshal/marshal-auth",
        ],
        expect.any(Function),
      );
    });

    it("is a no-op on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const { excludeFromBackup } = await import("./platform-security");

      excludeFromBackup("/home/user/.marshal/marshal-auth");

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("skips nonexistent paths", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExistsSync.mockReturnValue(false);
      const { excludeFromBackup } = await import("./platform-security");

      excludeFromBackup("/nonexistent/path");

      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("logs warning on xattr failure but does not throw", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock: casting callback from unknown[] args
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (err: Error | null) => void; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test mock
        cb(new Error("xattr failed"));
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { excludeFromBackup } = await import("./platform-security");

      expect(() => excludeFromBackup("/home/user/.marshal/marshal-auth")).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[PlatformSecurity]"),
        "Failed to set backup exclusion:",
        "xattr failed",
      );
    });
  });

  describe("excludeMDataFromBackup", () => {
    it("excludes all M-owned directories and files", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { excludeMDataFromBackup } = await import("./platform-security");

      excludeMDataFromBackup("/home/user/.marshal");

      // 6 directories + 8 files = 14 calls
      expect(mockExecFile).toHaveBeenCalledTimes(14);

      // Verify a directory and a file are both included
      // Normalize separators so tests pass on Windows (path.join uses backslashes there)
      const calledPaths = mockExecFile.mock.calls.map(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock: extracting path arg from xattr call
        (call) => ((call[1] as string[])[3] ?? "").replace(/\\/g, "/"),
      );
      expect(calledPaths).toContain("/home/user/.marshal/marshal-auth");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-sessions");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-teams-attachments");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-settings.json");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-github-update-token.enc");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-mcp-servers.json");
      expect(calledPaths).toContain("/home/user/.marshal/marshal-window-state.json");
    });

    it("skips entries that do not exist on disk", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockExistsSync.mockImplementation((p: string) => p.includes("marshal-auth"));
      const { excludeMDataFromBackup } = await import("./platform-security");

      excludeMDataFromBackup("/home/user/.marshal");

      // Only marshal-auth exists
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("secureWriteFileSync", () => {
    it("calls chmodSync after writeFileSync with the specified mode", async () => {
      const mockWriteFileSync = vi.fn<() => void>();
      const mockChmodSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        writeFileSync: mockWriteFileSync,
        chmodSync: mockChmodSync,
        mkdirSync: vi.fn<() => void>(),
        default: {
          writeFileSync: mockWriteFileSync,
          chmodSync: mockChmodSync,
          mkdirSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      const { secureWriteFileSync } = await import("./platform-security");
      secureWriteFileSync("/tmp/test.json", "data", { mode: 0o600 });

      expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/test.json", "data", { mode: 0o600 });
      expect(mockChmodSync).toHaveBeenCalledWith("/tmp/test.json", 0o600);
    });

    it("does not call chmodSync when no mode specified", async () => {
      const mockWriteFileSync = vi.fn<() => void>();
      const mockChmodSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        writeFileSync: mockWriteFileSync,
        chmodSync: mockChmodSync,
        mkdirSync: vi.fn<() => void>(),
        default: {
          writeFileSync: mockWriteFileSync,
          chmodSync: mockChmodSync,
          mkdirSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      const { secureWriteFileSync } = await import("./platform-security");
      secureWriteFileSync("/tmp/test.json", "data");

      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockChmodSync).not.toHaveBeenCalled();
    });

    it("swallows chmod errors silently", async () => {
      const mockWriteFileSync = vi.fn<() => void>();
      const mockChmodSync = vi.fn<() => void>(() => {
        throw new Error("ENOENT");
      });

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        writeFileSync: mockWriteFileSync,
        chmodSync: mockChmodSync,
        mkdirSync: vi.fn<() => void>(),
        default: {
          writeFileSync: mockWriteFileSync,
          chmodSync: mockChmodSync,
          mkdirSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      const { secureWriteFileSync } = await import("./platform-security");
      expect(() => secureWriteFileSync("/tmp/test.json", "data", { mode: 0o600 })).not.toThrow();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("stripSymlinks", () => {
    it("removes symlinks and leaves regular files untouched", async () => {
      const mockReaddirSync = vi.fn<() => unknown[]>();
      const mockRmSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        readdirSync: mockReaddirSync,
        rmSync: mockRmSync,
        mkdirSync: vi.fn<() => void>(),
        writeFileSync: vi.fn<() => void>(),
        chmodSync: vi.fn<() => void>(),
        default: {
          readdirSync: mockReaddirSync,
          rmSync: mockRmSync,
          mkdirSync: vi.fn<() => void>(),
          writeFileSync: vi.fn<() => void>(),
          chmodSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      mockReaddirSync.mockReturnValue([
        { name: "evil-link", parentPath: "/dest", isSymbolicLink: () => true },
        { name: "ok.md", parentPath: "/dest", isSymbolicLink: () => false },
      ]);

      const { stripSymlinks } = await import("./platform-security");
      stripSymlinks("/dest");

      expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining("evil-link"), {
        force: true,
      });
      expect(mockRmSync).not.toHaveBeenCalledWith(
        expect.stringContaining("ok.md"),
        expect.anything(),
      );
    });

    it("removes nested symlinks using parentPath", async () => {
      const mockReaddirSync = vi.fn<() => unknown[]>();
      const mockRmSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        readdirSync: mockReaddirSync,
        rmSync: mockRmSync,
        mkdirSync: vi.fn<() => void>(),
        writeFileSync: vi.fn<() => void>(),
        chmodSync: vi.fn<() => void>(),
        default: {
          readdirSync: mockReaddirSync,
          rmSync: mockRmSync,
          mkdirSync: vi.fn<() => void>(),
          writeFileSync: vi.fn<() => void>(),
          chmodSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      mockReaddirSync.mockReturnValue([
        { name: "secrets", parentPath: "/dest/scripts", isSymbolicLink: () => true },
      ]);

      const { stripSymlinks } = await import("./platform-security");
      stripSymlinks("/dest");

      expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining("secrets"), { force: true });
    });

    it("does not throw when directory does not exist", async () => {
      const mockReaddirSync = vi.fn<() => unknown[]>(() => {
        throw new Error("ENOENT");
      });

      vi.doMock("node:fs", () => ({
        existsSync: () => false,
        readdirSync: mockReaddirSync,
        rmSync: vi.fn<() => void>(),
        mkdirSync: vi.fn<() => void>(),
        writeFileSync: vi.fn<() => void>(),
        chmodSync: vi.fn<() => void>(),
        default: {
          readdirSync: mockReaddirSync,
          rmSync: vi.fn<() => void>(),
          mkdirSync: vi.fn<() => void>(),
          writeFileSync: vi.fn<() => void>(),
          chmodSync: vi.fn<() => void>(),
        },
        promises: {
          writeFile: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          mkdir: vi.fn<() => void>(),
        },
      }));

      const { stripSymlinks } = await import("./platform-security");
      expect(() => stripSymlinks("/nonexistent")).not.toThrow();
    });
  });

  describe("secureMkdirSync", () => {
    it("replaces inherited broad ACLs with current-user and Local System grants on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const mockMkdirSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => false,
        mkdirSync: mockMkdirSync,
        chmodSync: vi.fn<() => void>(),
        writeFileSync: vi.fn<() => void>(),
        default: {
          mkdirSync: mockMkdirSync,
          chmodSync: vi.fn<() => void>(),
          writeFileSync: vi.fn<() => void>(),
        },
        promises: {
          mkdir: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          writeFile: vi.fn<() => void>(),
        },
      }));

      const { secureMkdirSync } = await import("./platform-security");
      secureMkdirSync("C:\\protected", 0o700);

      expect(mockExecFileSync).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/[\\/]System32[\\/]whoami\.exe$/i),
        ["/user", "/fo", "csv", "/nh"],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(mockExecFileSync).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(/[\\/]System32[\\/]icacls\.exe$/i),
        expect.arrayContaining([
          "C:\\protected",
          "/inheritance:r",
          "*S-1-1-0",
          "*S-1-5-11",
          "*S-1-5-32-545",
          "*S-1-5-21-100-200-300-400:(OI)(CI)F",
          "*S-1-5-18:(OI)(CI)F",
        ]),
        expect.objectContaining({ windowsHide: true }),
      );
    });

    it("fails closed when the Windows owner-only ACL cannot be applied", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockExecFileSync.mockImplementation((executable) => {
        if (String(executable).endsWith("whoami.exe")) {
          return '"MIDDLEEAST\\user","S-1-5-21-100-200-300-400"\r\n';
        }
        throw new Error("icacls failed");
      });
      vi.doMock("node:fs", () => ({
        existsSync: () => false,
        mkdirSync: vi.fn<() => void>(),
        chmodSync: vi.fn<() => void>(),
        writeFileSync: vi.fn<() => void>(),
        default: {
          mkdirSync: vi.fn<() => void>(),
          chmodSync: vi.fn<() => void>(),
          writeFileSync: vi.fn<() => void>(),
        },
        promises: {
          mkdir: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          writeFile: vi.fn<() => void>(),
        },
      }));

      const { secureMkdirSync } = await import("./platform-security");
      expect(() => secureMkdirSync("C:\\protected", 0o700)).toThrow("icacls failed");
    });

    it("calls chmodSync after mkdirSync with the specified mode", async () => {
      const mockMkdirSync = vi.fn<() => void>();
      const mockChmodSync = vi.fn<() => void>();

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        mkdirSync: mockMkdirSync,
        chmodSync: mockChmodSync,
        writeFileSync: vi.fn<() => void>(),
        default: {
          mkdirSync: mockMkdirSync,
          chmodSync: mockChmodSync,
          writeFileSync: vi.fn<() => void>(),
        },
        promises: {
          mkdir: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          writeFile: vi.fn<() => void>(),
        },
      }));

      const { secureMkdirSync } = await import("./platform-security");
      secureMkdirSync("/tmp/test-dir", 0o700);

      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-dir", { recursive: true, mode: 0o700 });
      expect(mockChmodSync).toHaveBeenCalledWith("/tmp/test-dir", 0o700);
    });

    it("swallows chmod errors silently", async () => {
      const mockMkdirSync = vi.fn<() => void>();
      const mockChmodSync = vi.fn<() => void>(() => {
        throw new Error("EPERM");
      });

      vi.doMock("node:fs", () => ({
        existsSync: () => true,
        mkdirSync: mockMkdirSync,
        chmodSync: mockChmodSync,
        writeFileSync: vi.fn<() => void>(),
        default: {
          mkdirSync: mockMkdirSync,
          chmodSync: mockChmodSync,
          writeFileSync: vi.fn<() => void>(),
        },
        promises: {
          mkdir: vi.fn<() => void>(),
          chmod: vi.fn<() => void>(),
          writeFile: vi.fn<() => void>(),
        },
      }));

      const { secureMkdirSync } = await import("./platform-security");
      expect(() => secureMkdirSync("/tmp/test-dir", 0o700)).not.toThrow();
    });
  });
});
