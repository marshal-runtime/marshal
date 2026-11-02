import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testDouble } from "../../../testing/harness";
import { registerPreferencesHandlers } from "./register";

type PreferencesDeps = Parameters<typeof registerPreferencesHandlers>[0];

function setupHandlers(prefsPath: string) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  };

  registerPreferencesHandlers({
    ipcHandle: testDouble<PreferencesDeps["ipcHandle"]>(ipcHandle),
    prefsPath,
    // Disable the debounce so persistence is synchronous in tests; the
    // round-trip "set then re-create handlers and read back" assertions rely
    // on the file being on disk before setupHandlers() runs again.
    persistDebounceMs: 0,
  });

  return { handlers };
}

describe("registerPreferencesHandlers", () => {
  let tmpDir: string;
  let prefsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-test-"));
    prefsPath = path.join(tmpDir, "marshal-preferences.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("gracefully handles corrupt JSON prefs file", () => {
    fs.writeFileSync(prefsPath, "not-valid-json{{{");
    const { handlers } = setupHandlers(prefsPath);
    const result = handlers.get("preferences:get")!({}, "lastUpdateCheck");
    expect(result).toEqual({ success: true, value: null });
  });

  describe("preferences:get", () => {
    it("returns null for an unset key", () => {
      const { handlers } = setupHandlers(prefsPath);
      const result = handlers.get("preferences:get")!({}, "lastUpdateCheck");
      expect(result).toEqual({ success: true, value: null });
    });

    it("returns the value after it has been set", () => {
      const { handlers } = setupHandlers(prefsPath);
      handlers.get("preferences:set")!({}, "lastUpdateCheck", "1700000000000");
      const result = handlers.get("preferences:get")!({}, "lastUpdateCheck");
      expect(result).toEqual({ success: true, value: "1700000000000" });
    });

    it("returns null for unknown key", () => {
      const { handlers } = setupHandlers(prefsPath);
      const result = handlers.get("preferences:get")!({}, "unknown-key");
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe("preferences:set", () => {
    it("returns success when setting an allowed key", () => {
      const { handlers } = setupHandlers(prefsPath);
      const result = handlers.get("preferences:set")!({}, "lastUpdateCheck", "1700000000000");
      expect(result).toEqual({ success: true });
    });

    it("rejects unknown keys", () => {
      const { handlers } = setupHandlers(prefsPath);
      const result = handlers.get("preferences:set")!({}, "arbitrary-key", "value");
      expect(result).toEqual({ success: false, error: "Unknown preference key: arbitrary-key" });
    });

    it("persists values to disk so a fresh handler reads them back", () => {
      const { handlers } = setupHandlers(prefsPath);
      handlers.get("preferences:set")!({}, "lastUpdateCheck", "1700000000000");

      // Re-register handlers to simulate app restart (reads from file)
      const { handlers: freshHandlers } = setupHandlers(prefsPath);
      const result = freshHandlers.get("preferences:get")!({}, "lastUpdateCheck");
      expect(result).toEqual({ success: true, value: "1700000000000" });
    });

    it("deletes a key when value is null", () => {
      const { handlers } = setupHandlers(prefsPath);
      handlers.get("preferences:set")!({}, "lastUpdateCheck", "1700000000000");
      handlers.get("preferences:set")!({}, "lastUpdateCheck", null);
      const result = handlers.get("preferences:get")!({}, "lastUpdateCheck");
      expect(result).toEqual({ success: true, value: null });
    });

    it("deleted key is absent from persisted file", () => {
      const { handlers } = setupHandlers(prefsPath);
      handlers.get("preferences:set")!({}, "lastUpdateCheck", "2024-01-01");
      handlers.get("preferences:set")!({}, "lastUpdateCheck", null);

      const { handlers: freshHandlers } = setupHandlers(prefsPath);
      const result = freshHandlers.get("preferences:get")!({}, "lastUpdateCheck");
      expect(result).toEqual({ success: true, value: null });
    });

    it("accepts cocreate.zoom as an allowed key", () => {
      const { handlers } = setupHandlers(prefsPath);
      const setResult = handlers.get("preferences:set")!({}, "cocreate.zoom", "1.25");
      expect(setResult).toEqual({ success: true });
      const getResult = handlers.get("preferences:get")!({}, "cocreate.zoom");
      expect(getResult).toEqual({ success: true, value: "1.25" });
    });
  });

  describe("debounced persistence", () => {
    it("coalesces successive sets into a single disk write within the debounce window", async () => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      };
      registerPreferencesHandlers({
        ipcHandle: testDouble<PreferencesDeps["ipcHandle"]>(ipcHandle),
        prefsPath,
        persistDebounceMs: 30,
      });

      const set = handlers.get("preferences:set")!;
      // Three rapid writes (mimics holding Ctrl+= to repeat zoom-in).
      set({}, "cocreate.zoom", "1.1");
      set({}, "cocreate.zoom", "1.25");
      set({}, "cocreate.zoom", "1.5");

      // File should NOT exist yet — all three writes are still pending.
      expect(fs.existsSync(prefsPath)).toBe(false);

      // Wait for the trailing-edge timer to fire.
      await new Promise((r) => setTimeout(r, 80));

      // After the debounce, the file exists with the *last* value only.
      expect(fs.existsSync(prefsPath)).toBe(true);
      const raw: unknown = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      expect(raw).toMatchObject({ "cocreate.zoom": "1.5" });
    });

    it("flush() persists pending writes synchronously (for use during quit)", () => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      };
      const handle = registerPreferencesHandlers({
        ipcHandle: testDouble<PreferencesDeps["ipcHandle"]>(ipcHandle),
        prefsPath,
        persistDebounceMs: 5_000, // long enough that it would normally still be pending
      });

      handlers.get("preferences:set")!({}, "cocreate.zoom", "1.5");
      // Pending — not on disk yet.
      expect(fs.existsSync(prefsPath)).toBe(false);

      handle.flush();

      // After flush, the value is on disk without waiting for the timer.
      expect(fs.existsSync(prefsPath)).toBe(true);
      const raw: unknown = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      expect(raw).toMatchObject({ "cocreate.zoom": "1.5" });
    });

    it("flush() is a no-op when no write is pending", () => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      };
      const handle = registerPreferencesHandlers({
        ipcHandle: testDouble<PreferencesDeps["ipcHandle"]>(ipcHandle),
        prefsPath,
        persistDebounceMs: 300,
      });

      // No set calls — nothing pending. Should not throw and should not create the file.
      expect(() => handle.flush()).not.toThrow();
      expect(fs.existsSync(prefsPath)).toBe(false);
    });
  });
});
