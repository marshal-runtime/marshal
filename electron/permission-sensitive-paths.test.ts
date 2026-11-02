// electron/permission-sensitive-paths.test.ts
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { checkSensitivePath, extractWritePaths, isPathAllowed } from "./sensitive-path-permission-guard";
import { makeRequest as req } from "./policy-rules/test-helpers";

const HOME = os.homedir();

describe("extractWritePaths — write kind", () => {
  it("extracts from path field", () => {
    expect(extractWritePaths(req({ kind: "write", path: "/tmp/a.txt" }))).toEqual(["/tmp/a.txt"]);
  });

  it("returns empty array when no path present", () => {
    expect(extractWritePaths(req({ kind: "write", path: "" }))).toEqual([]);
  });
});

describe("extractWritePaths — mcp kind", () => {
  it("extracts path from edit_file arguments", () => {
    expect(
      extractWritePaths(
        req({
          kind: "mcp",
          toolName: "mcp:filesystem:edit_file",
          toolArgs: { path: path.join(HOME, ".ssh", "config") },
        }),
      ),
    ).toEqual([path.join(HOME, ".ssh", "config")]);
  });

  it("extracts path from write_file arguments", () => {
    expect(
      extractWritePaths(
        req({
          kind: "mcp",
          toolName: "filesystem__write_file",
          toolArgs: { path: "/tmp/out.txt" },
        }),
      ),
    ).toEqual(["/tmp/out.txt"]);
  });

  it("extracts path from create_directory arguments", () => {
    expect(
      extractWritePaths(
        req({
          kind: "mcp",
          toolName: "filesystem__create_directory",
          toolArgs: { path: "/tmp/newdir" },
        }),
      ),
    ).toEqual(["/tmp/newdir"]);
  });

  it("returns empty for read-only mcp tools", () => {
    expect(
      extractWritePaths(
        req({
          kind: "mcp",
          toolName: "mcp:filesystem:read_file",
          toolArgs: { path: "/tmp/x.txt" },
        }),
      ),
    ).toEqual([]);
  });

  it("returns empty for non-filesystem mcp tools", () => {
    expect(
      extractWritePaths(
        req({ kind: "mcp", toolName: "mcp:playwright:browser_navigate", toolArgs: {} }),
      ),
    ).toEqual([]);
  });
});

describe("extractShellWritePaths", () => {
  it("extracts > redirect target", () => {
    const result = extractWritePaths(req({ kind: "shell", command: "echo hello > /tmp/out.txt" }));
    expect(result).toEqual(["/tmp/out.txt"]);
  });

  it("extracts >> redirect target", () => {
    const result = extractWritePaths(
      req({
        kind: "shell",
        command: `echo "Host evil" >> ${path.join(HOME, ".ssh", "config")}`,
      }),
    );
    expect(result).toEqual([path.join(HOME, ".ssh", "config")]);
  });

  it("extracts tee target", () => {
    const result = extractWritePaths(
      req({ kind: "shell", command: "cat file.txt | tee /tmp/copy.txt" }),
    );
    expect(result).toEqual(["/tmp/copy.txt"]);
  });

  it("extracts tee -a target", () => {
    const result = extractWritePaths(
      req({
        kind: "shell",
        command: `echo line | tee -a ${path.join(HOME, ".bashrc")}`,
      }),
    );
    expect(result).toEqual([path.join(HOME, ".bashrc")]);
  });

  it("returns empty for commands with no redirect", () => {
    const result = extractWritePaths(req({ kind: "shell", command: "ls -la" }));
    expect(result).toEqual([]);
  });

  it("returns empty for non-shell kinds", () => {
    expect(extractWritePaths(req({ kind: "read" }))).toEqual([]);
  });
});

describe("isPathAllowed", () => {
  it("matches exact path", () => {
    expect(isPathAllowed("/home/user/.ssh/config", ["/home/user/.ssh/config"])).toBe(true);
  });

  it("matches /* glob (immediate child)", () => {
    expect(isPathAllowed("/home/user/.ssh/config", ["/home/user/.ssh/*"])).toBe(true);
  });

  it("does not match /* glob for nested paths", () => {
    expect(isPathAllowed("/home/user/.ssh/a/b", ["/home/user/.ssh/*"])).toBe(false);
  });

  it("matches /** glob (any descendant)", () => {
    expect(isPathAllowed("/home/user/.ssh/sub/key", ["/home/user/.ssh/**"])).toBe(true);
  });

  it("returns false when list is empty", () => {
    expect(isPathAllowed("/home/user/.ssh/config", [])).toBe(false);
  });
});

describe("checkSensitivePath", () => {
  it("returns hit for write to ~/.ssh/config", () => {
    const hit = checkSensitivePath(
      req({ kind: "write", path: path.join(HOME, ".ssh", "config") }),
      [],
    );
    expect(hit).not.toBeNull();
    expect(hit!.resolvedPath).toBe(path.resolve(path.join(HOME, ".ssh", "config")));
  });

  it("returns hit for write to ~/.gitconfig", () => {
    const hit = checkSensitivePath(req({ kind: "write", path: path.join(HOME, ".gitconfig") }), []);
    expect(hit).not.toBeNull();
  });

  it("returns hit for write to ~/.bashrc", () => {
    const hit = checkSensitivePath(req({ kind: "write", path: path.join(HOME, ".bashrc") }), []);
    expect(hit).not.toBeNull();
  });

  it("returns null for non-sensitive path", () => {
    const hit = checkSensitivePath(req({ kind: "write", path: "/tmp/safe.txt" }), []);
    expect(hit).toBeNull();
  });

  it("returns null when path is in allowedSensitivePaths (exact)", () => {
    const target = path.join(HOME, ".ssh", "config");
    const hit = checkSensitivePath(req({ kind: "write", path: target }), [path.resolve(target)]);
    expect(hit).toBeNull();
  });

  it("returns null when path is covered by /* glob in allowedSensitivePaths", () => {
    const target = path.join(HOME, ".ssh", "config");
    const hit = checkSensitivePath(req({ kind: "write", path: target }), [
      path.resolve(path.join(HOME, ".ssh")) + "/*",
    ]);
    expect(hit).toBeNull();
  });

  it("detects .git/config anywhere in the path", () => {
    const hit = checkSensitivePath(
      req({ kind: "write", path: "/home/user/myrepo/.git/config" }),
      [],
    );
    expect(hit).not.toBeNull();
    expect(hit!.matchedPattern).toBe("**/.git/config");
  });

  it("returns null for shell command with no redirect", () => {
    const hit = checkSensitivePath(req({ kind: "shell", command: "ls -la" }), []);
    expect(hit).toBeNull();
  });

  it("detects shell redirect to ~/.ssh/config", () => {
    const hit = checkSensitivePath(
      req({
        kind: "shell",
        command: `echo "Host evil" >> ${path.join(HOME, ".ssh", "config")}`,
      }),
      [],
    );
    expect(hit).not.toBeNull();
  });

  it("detects mcp edit_file write to ~/.ssh/config", () => {
    const hit = checkSensitivePath(
      req({
        kind: "mcp",
        toolName: "mcp:filesystem:edit_file",
        toolArgs: { path: path.join(HOME, ".ssh", "config") },
      }),
      [],
    );
    expect(hit).not.toBeNull();
  });

  it("detects write to a binary in a PATH directory", () => {
    const binDir = "/controlled/bin";
    const original = process.env["PATH"];
    process.env["PATH"] = binDir;
    try {
      const hit = checkSensitivePath(
        req({ kind: "write", path: path.join(binDir, "malicious") }),
        [],
      );
      expect(hit).not.toBeNull();
      expect(hit!.matchedPattern).toBe("PATH directory");
    } finally {
      process.env["PATH"] = original;
    }
  });

  it("returns null for write outside PATH directories", () => {
    const binDir = "/controlled/bin";
    const original = process.env["PATH"];
    process.env["PATH"] = binDir;
    try {
      const hit = checkSensitivePath(req({ kind: "write", path: "/not/in/path/file.txt" }), []);
      expect(hit).toBeNull();
    } finally {
      process.env["PATH"] = original;
    }
  });
});
