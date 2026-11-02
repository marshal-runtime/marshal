import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ensureBase, loadConfig, writeDefaultConfigIfMissing } from "../src/config.ts";
import { configPath, sessionsDir } from "../src/paths.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "macp-cfg-"));
  process.env.MARSHAL_ACP_HOME = tmp;
});

afterEach(async () => {
  delete process.env.MARSHAL_ACP_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when config.json is missing", async () => {
    const cfg = await loadConfig();
    expect(cfg.defaultRuntime).toBe("claude");
    expect(cfg.defaultPermissionProfile).toBe("default");
    expect(cfg.maxLifetimeMs).toBeGreaterThan(0);
  });

  it("applies field defaults for missing keys but honors set values", async () => {
    await ensureBase();
    await fs.writeFile(
      configPath(),
      JSON.stringify({ defaultRuntime: "copilot", maxLifetimeMs: 5000 }),
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.defaultRuntime).toBe("copilot");
    expect(cfg.maxLifetimeMs).toBe(5000);
    // defaultPermissionProfile keeps the schema default since the file
    // didn't set it.
    expect(cfg.defaultPermissionProfile).toBe("default");
  });

  it("throws on malformed JSON (not silently falls back)", async () => {
    await ensureBase();
    await fs.writeFile(configPath(), "{not json", "utf8");
    await expect(loadConfig()).rejects.toThrow();
  });
});

describe("writeDefaultConfigIfMissing", () => {
  it("writes a config when none exists and reports `true`", async () => {
    await ensureBase();
    const wrote = await writeDefaultConfigIfMissing();
    expect(wrote).toBe(true);
    const stat = await fs.stat(configPath());
    expect(stat.isFile()).toBe(true);
  });

  it("does not overwrite an existing config and reports `false`", async () => {
    await ensureBase();
    await fs.writeFile(configPath(), JSON.stringify({ defaultRuntime: "copilot" }), "utf8");
    const wrote = await writeDefaultConfigIfMissing();
    expect(wrote).toBe(false);
    const cfg = await loadConfig();
    expect(cfg.defaultRuntime).toBe("copilot");
  });
});

describe("ensureBase", () => {
  it("creates the base dir and the sessions subdir", async () => {
    await ensureBase();
    const sessions = await fs.stat(sessionsDir());
    expect(sessions.isDirectory()).toBe(true);
  });
});
