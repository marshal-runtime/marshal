// Marshal-owned test
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { grantFolderForPath, isPathUnderAnyDir, isPathWithinDir } from "./permission-path-scope";

const root = path.resolve("/tmp/scope-root");
const sub = path.join(root, "a", "b.txt");

describe("isPathWithinDir", () => {
  it("matches nested paths", () => {
    expect(isPathWithinDir(sub, root)).toBe(true);
  });
  it("does not match the dir itself unless includeSelf", () => {
    expect(isPathWithinDir(root, root)).toBe(false);
    expect(isPathWithinDir(root, root, { includeSelf: true })).toBe(true);
  });
  it("anchors on a separator (/scope-root !== /scope-rootX)", () => {
    expect(isPathWithinDir("/tmp/scope-rootX/c", root)).toBe(false);
  });
  it("normalizes '..' without following symlinks", () => {
    expect(isPathWithinDir(path.join(root, "x", "..", "y.txt"), root)).toBe(true);
  });
});

describe("isPathWithinDir — hardening", () => {
  it("rejects paths containing a null byte", () => {
    expect(isPathWithinDir("/granted\x00/leak.txt", "/granted")).toBe(false);
    expect(isPathWithinDir("/granted/x.txt", "/granted\x00")).toBe(false);
  });

  it("rejects an empty child or dir input", () => {
    expect(isPathWithinDir("", "/granted")).toBe(false);
    expect(isPathWithinDir("/granted/x", "")).toBe(false);
  });

  const isWin = process.platform === "win32";

  it.runIf(!isWin)("Unix root grant includes everything under /", () => {
    expect(isPathWithinDir("/etc/passwd", "/")).toBe(true);
    expect(isPathWithinDir("/", "/", { includeSelf: true })).toBe(true);
  });

  it.runIf(isWin)("Windows drive-root grant includes everything on that drive", () => {
    expect(isPathWithinDir("C:\\Users\\me\\x.txt", "C:\\")).toBe(true);
    expect(isPathWithinDir("c:\\users\\me\\x.txt", "C:\\")).toBe(true);
  });

  it.runIf(isWin)("Windows drive-root grant does NOT cross drives", () => {
    expect(isPathWithinDir("D:\\foo\\x.txt", "C:\\")).toBe(false);
    expect(isPathWithinDir("E:\\anything", "C:\\")).toBe(false);
  });
});

describe("isPathUnderAnyDir", () => {
  it("matches the granted dir itself and nested paths", () => {
    expect(isPathUnderAnyDir(root, [root])).toBe(true);
    expect(isPathUnderAnyDir(sub, ["/tmp/other", root])).toBe(true);
    expect(isPathUnderAnyDir("/tmp/elsewhere/z", [root])).toBe(false);
  });
});

describe("grantFolderForPath", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grant-folder-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns the path itself when it is an existing directory", () => {
    expect(grantFolderForPath(tmp)).toBe(path.resolve(tmp));
  });

  it("returns the parent when the path is an existing file", () => {
    const file = path.join(tmp, "report.pdf");
    fs.writeFileSync(file, "x");
    expect(grantFolderForPath(file)).toBe(path.resolve(tmp));
  });

  it("returns the parent for a non-existent path without throwing", () => {
    const missing = path.join(tmp, "not-created-yet.txt");
    expect(() => grantFolderForPath(missing)).not.toThrow();
    expect(grantFolderForPath(missing)).toBe(path.resolve(tmp));
  });
});
