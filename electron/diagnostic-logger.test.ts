import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// vi.mock factory is hoisted — can't reference outer variables, so the path
// is duplicated here. TEST_DIR below must match.
vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("./app-paths", async () => {
  const p = await import("path");
  const o = await import("os");
  return { getAppDataDir: () => p.join(o.tmpdir(), "test-diag") };
});

import {
  writeDiagnosticEntry,
  writeDiagnosticEntrySync,
  rotateIfNeeded,
  getLogFilePath,
  flush,
  readLogTail,
  setDiagnosticsEnabledPredicate,
} from "./diagnostic-logger";

const TEST_DIR = path.join(os.tmpdir(), "test-diag");
const LOG_PATH = path.join(TEST_DIR, "marshal-diagnostics.jsonl");
const OLD_PATH = path.join(TEST_DIR, "marshal-diagnostics.jsonl.old");

describe("diagnostic-logger", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Enable diagnostics by default for existing tests
    setDiagnosticsEnabledPredicate(() => true);
    // Clean up any previous test files
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(OLD_PATH);
    } catch {
      /* ignore */
    }
  });

  afterEach(async () => {
    await flush();
    setDiagnosticsEnabledPredicate(null);
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(OLD_PATH);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns the correct log file path", () => {
    expect(getLogFilePath()).toBe(LOG_PATH);
  });

  describe("writeDiagnosticEntry", () => {
    it("writes a JSONL entry to the log file", async () => {
      writeDiagnosticEntry({ level: "error", category: "crash", message: "test crash" });
      await flush();
      const content = fs.readFileSync(LOG_PATH, "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.level).toBe("error");
      expect(entry.category).toBe("crash");
      expect(entry.message).toBe("test crash");
      expect(entry.timestamp).toBeDefined();
    });

    it("appends multiple entries as separate lines", async () => {
      writeDiagnosticEntry({ level: "info", category: "mcp", message: "connected" });
      writeDiagnosticEntry({ level: "warn", category: "auth", message: "token expired" });
      await flush();
      const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).category).toBe("mcp");
      expect(JSON.parse(lines[1]).category).toBe("auth");
    });

    it("includes metadata when provided", async () => {
      writeDiagnosticEntry({
        level: "error",
        category: "crash",
        message: "boom",
        metadata: { errorStack: "at Component (app.tsx:42)" },
      });
      await flush();
      const entry = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8").trim());
      expect(entry.metadata.errorStack).toContain("app.tsx:42");
    });

    it("sanitizes home directory paths in metadata", async () => {
      const home = os.homedir();
      writeDiagnosticEntry({
        level: "error",
        category: "crash",
        message: "test",
        metadata: { stack: `at Component (${home}/Work/m/src/App.tsx:42)` },
      });
      await flush();
      const entry = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8").trim());
      expect(entry.metadata.stack).not.toContain(home);
      expect(entry.metadata.stack).toContain("~/Work/m/src/App.tsx:42");
    });
  });

  describe("rotateIfNeeded", () => {
    it("does nothing when log file does not exist", () => {
      rotateIfNeeded();
      expect(fs.existsSync(OLD_PATH)).toBe(false);
    });

    it("does nothing when log file is under 2MB", () => {
      fs.writeFileSync(LOG_PATH, "x".repeat(1024));
      rotateIfNeeded();
      expect(fs.existsSync(OLD_PATH)).toBe(false);
      expect(fs.existsSync(LOG_PATH)).toBe(true);
    });

    it("rotates when log file exceeds 2MB", () => {
      fs.writeFileSync(LOG_PATH, "x".repeat(2.5 * 1024 * 1024));
      rotateIfNeeded();
      expect(fs.existsSync(OLD_PATH)).toBe(true);
      expect(fs.existsSync(LOG_PATH)).toBe(false);
    });

    it("replaces existing .old file on rotation", () => {
      fs.writeFileSync(OLD_PATH, "old data");
      fs.writeFileSync(LOG_PATH, "x".repeat(2.5 * 1024 * 1024));
      rotateIfNeeded();
      expect(fs.existsSync(OLD_PATH)).toBe(true);
      expect(fs.readFileSync(OLD_PATH, "utf-8")).not.toBe("old data");
      expect(fs.existsSync(LOG_PATH)).toBe(false);
    });

    it("rotates during writes when log exceeds threshold", async () => {
      fs.writeFileSync(LOG_PATH, "x".repeat(2.1 * 1024 * 1024));
      writeDiagnosticEntry({ level: "info", category: "test", message: "after rotation" });
      await flush();
      expect(fs.existsSync(OLD_PATH)).toBe(true);
      const content = fs.readFileSync(LOG_PATH, "utf-8").trim();
      expect(JSON.parse(content).message).toBe("after rotation");
    });

    it("rotates at exactly 2MB boundary", () => {
      fs.writeFileSync(LOG_PATH, "x".repeat(2 * 1024 * 1024));
      rotateIfNeeded();
      expect(fs.existsSync(OLD_PATH)).toBe(true);
      expect(fs.existsSync(LOG_PATH)).toBe(false);
    });
  });

  describe("JSONL round-trip", () => {
    it("writes valid JSONL — each line parses independently", async () => {
      writeDiagnosticEntry({ level: "error", category: "crash", message: "first" });
      writeDiagnosticEntry({ level: "warn", category: "auth", message: "second" });
      writeDiagnosticEntry({ level: "info", category: "mcp", message: "third" });
      await flush();
      const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
      lines.forEach((line) => {
        const entry = JSON.parse(line);
        expect(entry).toHaveProperty("timestamp");
        expect(entry).toHaveProperty("level");
        expect(entry).toHaveProperty("category");
        expect(entry).toHaveProperty("message");
      });
      expect(JSON.parse(lines[0]).message).toBe("first");
      expect(JSON.parse(lines[2]).message).toBe("third");
    });
  });
});

describe("readLogTail", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ok if missing */
    }
  });

  afterEach(() => {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ok */
    }
  });

  it("returns empty string when the log file does not exist", () => {
    expect(readLogTail()).toBe("");
  });

  it("returns empty string for an empty file", () => {
    fs.writeFileSync(LOG_PATH, "");
    expect(readLogTail()).toBe("");
  });

  it("returns full content when file is smaller than maxBytes", () => {
    const content = "line1\nline2\nline3\n";
    fs.writeFileSync(LOG_PATH, content);
    expect(readLogTail(1024)).toBe(content);
  });

  it("drops the partial leading line when file is larger than maxBytes", () => {
    const prefix = "partial-line"; // will be cut by the window
    const line2 = "second-full-line\n";
    const line3 = "third-full-line\n";
    const body = prefix + "\n" + line2 + line3;
    fs.writeFileSync(LOG_PATH, body);
    // maxBytes set so we start inside "partial-line"
    const maxBytes = line2.length + line3.length + 5;
    const result = readLogTail(maxBytes);
    expect(result).not.toContain("partial-line");
    expect(result).toContain("second-full-line");
    expect(result).toContain("third-full-line");
  });

  it("handles multi-byte UTF-8 content without mojibake", () => {
    const content = "日本語テスト\nmore text\n";
    fs.writeFileSync(LOG_PATH, content, "utf8");
    const result = readLogTail(1024);
    expect(result).toContain("日本語テスト");
  });
});

describe("setDiagnosticsEnabledPredicate", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ok */
    }
    // Reset to default (no gate)
    setDiagnosticsEnabledPredicate(null);
  });

  afterEach(async () => {
    await flush();
    setDiagnosticsEnabledPredicate(null);
    try {
      fs.unlinkSync(LOG_PATH);
    } catch {
      /* ok */
    }
  });

  it("suppresses writeDiagnosticEntry when predicate returns false", async () => {
    setDiagnosticsEnabledPredicate(() => false);
    writeDiagnosticEntry({ level: "error", category: "crash", message: "should not appear" });
    await flush();
    expect(fs.existsSync(LOG_PATH)).toBe(false);
  });

  it("allows writeDiagnosticEntry when predicate returns true", async () => {
    setDiagnosticsEnabledPredicate(() => true);
    writeDiagnosticEntry({ level: "info", category: "test", message: "should appear" });
    await flush();
    const content = fs.readFileSync(LOG_PATH, "utf-8").trim();
    expect(JSON.parse(content).message).toBe("should appear");
  });

  it("suppresses writeDiagnosticEntrySync when predicate returns false", () => {
    setDiagnosticsEnabledPredicate(() => false);
    writeDiagnosticEntrySync("crash", "should not appear");
    expect(fs.existsSync(LOG_PATH)).toBe(false);
  });

  it("allows writeDiagnosticEntrySync when predicate returns true", () => {
    setDiagnosticsEnabledPredicate(() => true);
    writeDiagnosticEntrySync("test", "should appear");
    const content = fs.readFileSync(LOG_PATH, "utf-8").trim();
    expect(JSON.parse(content).message).toBe("should appear");
  });

  it("denies writes when predicate is null (safe default)", async () => {
    setDiagnosticsEnabledPredicate(null);
    writeDiagnosticEntry({ level: "info", category: "test", message: "should be denied" });
    await flush();
    expect(fs.existsSync(LOG_PATH)).toBe(false);
  });

  it("responds to predicate changes at runtime", async () => {
    let enabled = true;
    setDiagnosticsEnabledPredicate(() => enabled);

    writeDiagnosticEntry({ level: "info", category: "test", message: "first" });
    await flush();
    expect(fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n")).toHaveLength(1);

    enabled = false;
    writeDiagnosticEntry({ level: "info", category: "test", message: "suppressed" });
    await flush();
    // Still only one line
    expect(fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n")).toHaveLength(1);

    enabled = true;
    writeDiagnosticEntry({ level: "info", category: "test", message: "third" });
    await flush();
    expect(fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n")).toHaveLength(2);
  });
});
