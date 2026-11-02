import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
    openPath: vi.fn<(path: string) => Promise<string>>(() => Promise.resolve("")),
  },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    realpathSync: vi.fn<(p: string) => string>((p) => p),
    statSync: vi.fn<(p: string) => { isDirectory: () => boolean }>(() => ({
      isDirectory: () => false,
    })),
  };
});

import * as fs from "fs";

import { shell } from "electron";

import { openExternalSafe, openLocalFileSafe } from "./open-external";

describe("openExternalSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["http://example.com", "https://example.com", "mailto:user@example.com"])(
    "opens allowed URL: %s",
    (url) => {
      openExternalSafe(url);
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    },
  );

  it.each(["file:///etc/passwd", "ftp://example.com", "data:text/html,<h1>x</h1>", "custom://foo"])(
    "blocks disallowed protocol: %s",
    (url) => {
      openExternalSafe(url);
      expect(shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it("ignores malformed URL", () => {
    openExternalSafe("not a url");
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("ignores empty string", () => {
    openExternalSafe("");
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("openLocalFileSafe", () => {
  const WORKSPACE = path.join(os.tmpdir(), "test-workspace");
  const mockedOpenPath = vi.mocked(shell.openPath);
  const mockedRealpathSync = vi.mocked(fs.realpathSync);
  const mockedStatSync = vi.mocked(fs.statSync);

  /** Convert an absolute path to a local-file:// URL (cross-platform) */
  function toLocalFileUrl(filePath: string): string {
    return pathToFileURL(filePath).href.replace(/^file:/, "local-file:");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpathSync returns the path as-is, statSync says "not a directory"
    mockedRealpathSync.mockImplementation((p) => String(p));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial Stats mock
    mockedStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  it("opens a file inside the workspace", async () => {
    const filePath = path.join(WORKSPACE, "notes", "readme.txt");
    mockedRealpathSync.mockReturnValue(filePath);

    const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
    expect(result.success).toBe(true);
    expect(mockedOpenPath).toHaveBeenCalledWith(filePath);
  });

  it("opens a directory inside the workspace", async () => {
    const dirPath = path.join(WORKSPACE, "notes");
    mockedRealpathSync.mockReturnValue(dirPath);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial Stats mock
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = await openLocalFileSafe(toLocalFileUrl(dirPath), WORKSPACE);
    expect(result.success).toBe(true);
    expect(mockedOpenPath).toHaveBeenCalledWith(dirPath);
  });

  it("opens safe files outside the workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), "other-dir", "secret.txt");
    mockedRealpathSync.mockReturnValue(outsidePath);

    const result = await openLocalFileSafe(toLocalFileUrl(outsidePath), WORKSPACE);
    expect(result.success).toBe(true);
    expect(mockedOpenPath).toHaveBeenCalledWith(outsidePath);
  });

  it("opens a safe symlink target outside the workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), "other-dir", "shadow.txt");
    mockedRealpathSync.mockReturnValue(outsidePath);

    const result = await openLocalFileSafe(
      toLocalFileUrl(path.join(WORKSPACE, "link.txt")),
      WORKSPACE,
    );
    expect(result.success).toBe(true);
    expect(mockedOpenPath).toHaveBeenCalledWith(outsidePath);
  });

  it.each([".exe", ".bat", ".cmd", ".ps1", ".sh", ".lnk", ".msi", ".scr", ".app", ".hta", ".svg"])(
    "blocks non-allowlisted extension: %s",
    async (ext) => {
      const filePath = path.join(WORKSPACE, `malware${ext}`);
      mockedRealpathSync.mockReturnValue(filePath);

      const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Blocked file type");
      expect(mockedOpenPath).not.toHaveBeenCalled();
    },
  );

  it("blocks macOS bundle directories (.app) even though isDirectory is true", async () => {
    const filePath = path.join(WORKSPACE, "evil.app");
    mockedRealpathSync.mockReturnValue(filePath);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial Stats mock
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked file type");
  });

  it.each([".txt", ".md", ".pdf", ".png", ".json", ".csv", ".docx", ".html", ".htm"])(
    "allows safe extension: %s",
    async (ext) => {
      const filePath = path.join(WORKSPACE, `doc${ext}`);
      mockedRealpathSync.mockReturnValue(filePath);

      const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
      expect(result.success).toBe(true);
    },
  );

  it.each(["Dockerfile", "Makefile", "LICENSE", "README"])(
    "allows workspace-contained extensionless file: %s",
    async (name) => {
      const filePath = path.join(WORKSPACE, name);
      mockedRealpathSync.mockReturnValue(filePath);

      const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
      expect(result.success).toBe(true);
    },
  );

  it("blocks extensionless files outside the workspace", async () => {
    const filePath = path.join(os.tmpdir(), "other-dir", "extensionless-binary");
    mockedRealpathSync.mockReturnValue(filePath);

    const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("extensionless file outside workspace");
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  it("blocks workspace symlinks targeting extensionless files outside the workspace", async () => {
    const linkPath = path.join(WORKSPACE, "linked-tool");
    const targetPath = path.join(os.tmpdir(), "other-dir", "extensionless-binary");
    mockedRealpathSync.mockReturnValue(targetPath);

    const result = await openLocalFileSafe(toLocalFileUrl(linkPath), WORKSPACE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("extensionless file outside workspace");
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });

  it("allows directory with a dot in its name", async () => {
    const dirPath = path.join(WORKSPACE, "release.v2");
    mockedRealpathSync.mockReturnValue(dirPath);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial Stats mock
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = await openLocalFileSafe(toLocalFileUrl(dirPath), WORKSPACE);
    expect(result.success).toBe(true);
  });

  it("handles case-insensitive local-file protocol", async () => {
    const filePath = path.join(WORKSPACE, "doc.txt");
    mockedRealpathSync.mockReturnValue(filePath);

    const result = await openLocalFileSafe(`LOCAL-FILE:///${filePath}`, WORKSPACE);
    expect(result.success).toBe(true);
  });

  it("returns error when file does not exist", async () => {
    mockedRealpathSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = await openLocalFileSafe(
      toLocalFileUrl(path.join(WORKSPACE, "missing.txt")),
      WORKSPACE,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error for malformed URL", async () => {
    const result = await openLocalFileSafe("not-a-url", WORKSPACE);
    expect(result.success).toBe(false);
  });

  it("propagates shell.openPath error", async () => {
    const filePath = path.join(WORKSPACE, "doc.txt");
    mockedRealpathSync.mockReturnValue(filePath);
    mockedOpenPath.mockResolvedValue("Failed to open");

    const result = await openLocalFileSafe(toLocalFileUrl(filePath), WORKSPACE);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to open");
  });

  it("rejects non-local-file protocol", async () => {
    const result = await openLocalFileSafe("https://example.com", WORKSPACE);
    expect(result.success).toBe(false);
  });
});
