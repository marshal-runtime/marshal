import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateLegacyAppDataEntries,
  resolveLegacyPersistedPath,
  resolveWorktreesDir,
} from "./persisted-paths";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-persisted-paths-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateLegacyAppDataEntries", () => {
  it("migrates legacy files, directories, and nested process diagnostics", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, "m-settings.json"), '{"theme":"dark"}');
    fs.mkdirSync(path.join(root, "m-sessions"));
    fs.writeFileSync(path.join(root, "m-sessions", "sessions-index.json"), "{}");
    fs.mkdirSync(path.join(root, "m-crashes", "watchdog"), { recursive: true });
    fs.writeFileSync(path.join(root, "m-crashes", "m-process-heartbeat.json"), "{}");
    fs.writeFileSync(path.join(root, "m-crashes", "watchdog", "m-process-watchdog.jsonl"), "");

    migrateLegacyAppDataEntries(root);

    expect(fs.readFileSync(path.join(root, "marshal-settings.json"), "utf8")).toBe(
      '{"theme":"dark"}',
    );
    expect(fs.existsSync(path.join(root, "marshal-sessions", "sessions-index.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(root, "marshal-crashes", "marshal-process-heartbeat.json")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, "marshal-crashes", "watchdog", "marshal-process-watchdog.jsonl"),
      ),
    ).toBe(true);
    // Copied, not moved: ~/.marshal is shared with the co-installed predecessor
    // that still reads the legacy names.
    expect(fs.readFileSync(path.join(root, "m-settings.json"), "utf8")).toBe('{"theme":"dark"}');
    expect(fs.existsSync(path.join(root, "m-sessions", "sessions-index.json"))).toBe(true);
  });

  it("does not rename m-worktrees because active git worktree links contain absolute paths", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "m-worktrees"));

    migrateLegacyAppDataEntries(root);

    expect(fs.existsSync(path.join(root, "m-worktrees"))).toBe(true);
    expect(fs.existsSync(path.join(root, "marshal-worktrees"))).toBe(false);
  });
});

describe("resolveLegacyPersistedPath", () => {
  it("uses the current path when both current and legacy data exist", () => {
    const root = makeTempDir();
    const current = path.join(root, "marshal-settings.json");
    const legacy = path.join(root, "m-settings.json");
    fs.writeFileSync(current, "current");
    fs.writeFileSync(legacy, "legacy");

    expect(resolveLegacyPersistedPath(current, legacy)).toBe(current);
    expect(fs.readFileSync(current, "utf8")).toBe("current");
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy");
  });

  it("can fall back without renaming paths that embed external absolute references", () => {
    const root = makeTempDir();
    const current = path.join(root, "marshal-worktrees");
    const legacy = path.join(root, "m-worktrees");
    fs.mkdirSync(legacy);

    expect(resolveWorktreesDir(root)).toBe(legacy);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(current)).toBe(false);
  });
});
