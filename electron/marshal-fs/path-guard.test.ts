// Marshal ownership: relocated module identity.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertRealpathAllowed } from "./path-guard";

let root = "";

beforeEach(async () => {
  // realpath so the scope root matches what assertRealpathAllowed resolves —
  // on macOS os.tmpdir() (/var/...) is a symlink to /private/var/....
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fsguard-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("assertRealpathAllowed", () => {
  const scope = (workspaceDir: string) => ({ workspaceDir, readGrants: [], writeGrants: [] });

  it("rejects an empty path", async () => {
    await expect(assertRealpathAllowed("", "read", scope(root))).rejects.toThrow(/required/i);
  });

  it("returns the real path for an in-scope existing file", async () => {
    const f = path.join(root, "a.txt");
    await fs.writeFile(f, "x");
    await expect(assertRealpathAllowed(f, "read", scope(root))).resolves.toBe(await fs.realpath(f));
  });

  it("denies a symlink whose target is outside scope", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const secret = path.join(outside, "id_rsa");
    await fs.writeFile(secret, "KEY");
    const link = path.join(root, "link");
    await fs.symlink(secret, link);
    await expect(assertRealpathAllowed(link, "read", scope(root))).rejects.toThrow(
      /symlink target outside/i,
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("allows a new (ENOENT) target whose parent is in scope", async () => {
    const target = path.join(root, "newdir");
    await expect(assertRealpathAllowed(target, "write", scope(root))).resolves.toBe(
      path.join(await fs.realpath(root), "newdir"),
    );
  });

  it("allows a deep new target where only a distant ancestor exists", async () => {
    const target = path.join(root, "x", "y", "z");
    await expect(assertRealpathAllowed(target, "write", scope(root))).resolves.toBe(
      path.join(await fs.realpath(root), "x", "y", "z"),
    );
  });

  it("denies a write whose path is outside all roots", async () => {
    const outside = path.join(os.tmpdir(), "definitely-outside-scope");
    await expect(assertRealpathAllowed(outside, "write", scope(root))).rejects.toThrow(
      /outside allowed folders/i,
    );
  });

  it("honors write grants as additional roots", async () => {
    const grant = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "grant-")));
    const target = path.join(grant, "made");
    await expect(
      assertRealpathAllowed(target, "write", {
        workspaceDir: root,
        readGrants: [],
        writeGrants: [grant],
      }),
    ).resolves.toBe(path.join(await fs.realpath(grant), "made"));
    await fs.rm(grant, { recursive: true, force: true });
  });
});
