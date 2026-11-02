import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogEntry, AuditLogInput } from "./audit-log";
import { AuditLogger, buildAuditInput, buildPreHookAuditInput } from "./audit-log";

// Use real permission-policy accessor implementations so buildAuditInput tests
// exercise the actual typed-field extraction paths, not mock stubs.
vi.mock("./permission-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./permission-policy")>();
  return {
    getCommandText: actual.getCommandText,
    getServerName: actual.getServerName,
    getToolName: actual.getToolName,
  };
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-test-"));
}

function makeInput(overrides: Partial<AuditLogInput> = {}): AuditLogInput {
  return {
    sessionId: "test-session",
    kind: "shell",
    toolName: "",
    serverName: "",
    commandText: "ls -la",
    decision: "approved",
    source: "policy-auto-approve",
    sdkResult: "approved",
    ...overrides,
  };
}

function readEntries(logDir: string): AuditLogEntry[] {
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
  const entries: AuditLogEntry[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (line.trim()) entries.push(JSON.parse(line));
    }
  }
  return entries;
}

describe("AuditLogger", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  describe("log()", () => {
    it("writes valid JSONL entries with correct fields", async () => {
      const logger = new AuditLogger({ logDir });
      logger.setUserLogin("testuser");
      logger.log(makeInput());
      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entries[0].userLogin).toBe("testuser");
      expect(entries[0].sessionId).toBe("test-session");
      expect(entries[0].kind).toBe("shell");
      expect(entries[0].commandText).toBe("ls -la");
      expect(entries[0].decision).toBe("approved");
      expect(entries[0].source).toBe("policy-auto-approve");
      expect(entries[0].sdkResult).toBe("approved");
    });

    it("is no-op when disabled", async () => {
      const logger = new AuditLogger({ logDir, enabled: false });
      logger.log(makeInput());
      await logger.flush();

      const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(0);
    });

    it("includes userAction when provided", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ userAction: "allow-type", source: "user-interactive" }));
      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries[0].userAction).toBe("allow-type");
    });

    it("includes toolCallId when provided", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ toolCallId: "tc-42" }));
      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries[0].toolCallId).toBe("tc-42");
    });

    it("never throws on write failure", async () => {
      // Point to a path that will fail
      const badDir = path.join(logDir, "nonexistent", "deep", "path");
      const logger = new AuditLogger({ logDir: badDir });
      logger.log(makeInput());
      // Asserts the promise resolves (i.e. doesn't reject); the resolved
      // value is undefined which is fine — we just want no rejection.
      await expect(logger.flush()).resolves.toBeUndefined();
    });
  });

  describe("flush()", () => {
    it("resolves after all pending writes complete", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ sessionId: "s1" }));
      logger.log(makeInput({ sessionId: "s2" }));
      logger.log(makeInput({ sessionId: "s3" }));

      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.sessionId)).toEqual(["s1", "s2", "s3"]);
    });
  });

  describe("serialization", () => {
    it("serializes concurrent writes without interleaving", async () => {
      const logger = new AuditLogger({ logDir });

      // Fire many concurrent writes
      for (let i = 0; i < 50; i++) {
        logger.log(makeInput({ sessionId: `s-${i}` }));
      }
      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries).toHaveLength(50);
      // Each line should be valid JSON (no interleaving)
      for (const entry of entries) {
        expect(entry.timestamp).toBeDefined();
        expect(entry.sessionId).toMatch(/^s-\d+$/);
      }
    });
  });

  describe("setUserLogin()", () => {
    it("updates identity in subsequent entries", async () => {
      const logger = new AuditLogger({ logDir });

      logger.setUserLogin("user-a");
      logger.log(makeInput({ sessionId: "s1" }));

      logger.setUserLogin("user-b");
      logger.log(makeInput({ sessionId: "s2" }));

      await logger.flush();

      const entries = readEntries(logDir);
      expect(entries[0].userLogin).toBe("user-a");
      expect(entries[1].userLogin).toBe("user-b");
    });
  });

  describe("query()", () => {
    it("returns all entries when no filters", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ sessionId: "s1" }));
      logger.log(makeInput({ sessionId: "s2", decision: "denied" }));
      await logger.flush();

      const results = logger.query({});
      expect(results).toHaveLength(2);
    });

    it("filters by sessionId", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ sessionId: "s1" }));
      logger.log(makeInput({ sessionId: "s2" }));
      await logger.flush();

      const results = logger.query({ sessionId: "s1" });
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("s1");
    });

    it("filters by kind", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ kind: "shell" }));
      logger.log(makeInput({ kind: "mcp" }));
      await logger.flush();

      const results = logger.query({ kind: "mcp" });
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe("mcp");
    });

    it("filters by decision", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ decision: "approved" }));
      logger.log(makeInput({ decision: "denied" }));
      await logger.flush();

      const results = logger.query({ decision: "denied" });
      expect(results).toHaveLength(1);
    });

    it("filters by source", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ source: "policy-auto-approve" }));
      logger.log(makeInput({ source: "user-interactive" }));
      await logger.flush();

      const results = logger.query({ source: "user-interactive" });
      expect(results).toHaveLength(1);
    });

    it("filters by date range", async () => {
      const logger = new AuditLogger({ logDir });
      // Write a file with yesterday's date manually
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      const todayStr = new Date().toISOString().slice(0, 10);

      const oldEntry = { ...makeInput(), timestamp: yesterday.toISOString(), userLogin: "" };
      fs.writeFileSync(
        path.join(logDir, `permissions-${yesterdayStr}.jsonl`),
        JSON.stringify(oldEntry) + "\n",
      );

      logger.log(makeInput());
      await logger.flush();

      // Query only today
      const todayResults = logger.query({ fromDate: todayStr, toDate: todayStr });
      expect(todayResults).toHaveLength(1);

      // Query only yesterday
      const yesterdayResults = logger.query({ fromDate: yesterdayStr, toDate: yesterdayStr });
      expect(yesterdayResults).toHaveLength(1);
    });

    it("returns empty when disabled", () => {
      const logger = new AuditLogger({ logDir, enabled: false });
      expect(logger.query({})).toEqual([]);
    });
  });

  describe("pruneOldLogs()", () => {
    it("removes files older than retention period", () => {
      const logger = new AuditLogger({ logDir });

      // Create a file dated 60 days ago
      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDateStr = oldDate.toISOString().slice(0, 10);
      fs.writeFileSync(path.join(logDir, `permissions-${oldDateStr}.jsonl`), "{}");

      // Create a recent file
      const todayStr = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(logDir, `permissions-${todayStr}.jsonl`), "{}");

      logger.pruneOldLogs(30);

      const remaining = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain(todayStr);
    });

    it("removes both permissions-* and oauth-* files older than retention", () => {
      const logger = new AuditLogger({ logDir });

      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDateStr = oldDate.toISOString().slice(0, 10);
      const todayStr = new Date().toISOString().slice(0, 10);

      // Create old + new files for BOTH log families.
      fs.writeFileSync(path.join(logDir, `permissions-${oldDateStr}.jsonl`), "{}");
      fs.writeFileSync(path.join(logDir, `permissions-${todayStr}.jsonl`), "{}");
      fs.writeFileSync(path.join(logDir, `oauth-${oldDateStr}.jsonl`), "{}");
      fs.writeFileSync(path.join(logDir, `oauth-${todayStr}.jsonl`), "{}");

      logger.pruneOldLogs(30);

      const remaining = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
      expect(remaining).toHaveLength(2);
      expect(remaining).toEqual(
        expect.arrayContaining([`permissions-${todayStr}.jsonl`, `oauth-${todayStr}.jsonl`]),
      );
      expect(remaining).not.toEqual(
        expect.arrayContaining([`permissions-${oldDateStr}.jsonl`, `oauth-${oldDateStr}.jsonl`]),
      );
    });

    it("ignores files matching neither regex (e.g. unrelated .jsonl)", () => {
      const logger = new AuditLogger({ logDir });
      const oldDate = new Date();
      oldDate.setUTCDate(oldDate.getUTCDate() - 60);
      const oldDateStr = oldDate.toISOString().slice(0, 10);
      // A stray file the regex shouldn't match.
      fs.writeFileSync(path.join(logDir, `unrelated-${oldDateStr}.jsonl`), "{}");

      logger.pruneOldLogs(30);

      // Untouched
      expect(fs.existsSync(path.join(logDir, `unrelated-${oldDateStr}.jsonl`))).toBe(true);
    });

    it("is no-op when disabled", () => {
      const logger = new AuditLogger({ logDir, enabled: false });
      expect(() => logger.pruneOldLogs(30)).not.toThrow();
    });
  });

  describe("logOAuth()", () => {
    it("writes oauth lifecycle entry to oauth-YYYY-MM-DD.jsonl with type tag", async () => {
      const logger = new AuditLogger({ logDir });
      logger.setUserLogin("testuser");

      logger.logOAuth({
        event: "mcp-oauth-initiate",
        serverName: "powerbi",
        sessionId: "sess-1",
        alias: "alice@example.com",
        forceReauth: false,
      });
      await logger.flush();

      const todayStr = new Date().toISOString().slice(0, 10);
      const oauthFile = path.join(logDir, `oauth-${todayStr}.jsonl`);
      expect(fs.existsSync(oauthFile)).toBe(true);

      // Permissions file must NOT receive OAuth entries.
      const permFile = path.join(logDir, `permissions-${todayStr}.jsonl`);
      expect(fs.existsSync(permFile)).toBe(false);

      const lines = fs
        .readFileSync(oauthFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.type).toBe("oauth");
      expect(entry.event).toBe("mcp-oauth-initiate");
      expect(entry.serverName).toBe("powerbi");
      expect(entry.sessionId).toBe("sess-1");
      expect(entry.alias).toBe("alice@example.com");
      expect(entry.forceReauth).toBe(false);
      expect(entry.userLogin).toBe("testuser");
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("is no-op when disabled", async () => {
      const logger = new AuditLogger({ logDir, enabled: false });
      logger.logOAuth({
        event: "mcp-oauth-success",
        serverName: "powerbi",
        forceReauth: false,
      });
      await logger.flush();

      const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(0);
    });

    it("captures error and forceReauth on failure entries", async () => {
      const logger = new AuditLogger({ logDir });
      logger.logOAuth({
        event: "mcp-oauth-failure",
        serverName: "powerbi",
        forceReauth: true,
        error: "Token exchange failed",
      });
      await logger.flush();

      const todayStr = new Date().toISOString().slice(0, 10);
      const lines = fs
        .readFileSync(path.join(logDir, `oauth-${todayStr}.jsonl`), "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      const entry = JSON.parse(lines[0]);
      expect(entry.event).toBe("mcp-oauth-failure");
      expect(entry.error).toBe("Token exchange failed");
      expect(entry.forceReauth).toBe(true);
    });
  });

  describe("UTC filenames", () => {
    it("uses UTC date in filename", () => {
      const logger = new AuditLogger({ logDir });
      const todayUTC = new Date().toISOString().slice(0, 10);
      expect(logger.getCurrentLogPath()).toContain(`permissions-${todayUTC}.jsonl`);
    });
  });

  describe("query() edge cases", () => {
    it("filters by toolName", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ toolName: "filesystem_read" }));
      logger.log(makeInput({ toolName: "playwright_click" }));
      await logger.flush();

      const results = logger.query({ toolName: "filesystem_read" });
      expect(results).toHaveLength(1);
      expect(results[0].toolName).toBe("filesystem_read");
    });

    it("skips malformed JSONL lines gracefully", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput({ sessionId: "good" }));
      await logger.flush();

      // Append garbage to the file
      const todayStr = new Date().toISOString().slice(0, 10);
      const filePath = path.join(logDir, `permissions-${todayStr}.jsonl`);
      fs.appendFileSync(filePath, "not valid json\n{truncated\n");

      const results = logger.query({});
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("good");
    });

    it("ignores files with unexpected names", async () => {
      const logger = new AuditLogger({ logDir });
      logger.log(makeInput());
      await logger.flush();

      // Create a file that looks like a backup
      fs.writeFileSync(
        path.join(logDir, "permissions-backup-2024-01-01.jsonl"),
        JSON.stringify(makeInput({ sessionId: "bad" })) + "\n",
      );

      const results = logger.query({});
      expect(results).toHaveLength(1); // Only the real file
    });
  });

  describe("buildAuditInput()", () => {
    it("extracts fields from a shell PermissionRequest", () => {
      const result = buildAuditInput(
        {
          id: "r1",
          sessionId: "s1",
          kind: "shell",
          toolCallId: "tc-1",
          command: "rm -rf /",
          serverName: "",
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        },
        "approved",
        "user-interactive",
        "approved",
        "allow",
      );

      expect(result.sessionId).toBe("s1");
      expect(result.kind).toBe("shell");
      expect(result.commandText).toBe("rm -rf /");
      expect(result.userAction).toBe("allow");
    });

    it("extracts fields from an MCP PermissionRequest", () => {
      const result = buildAuditInput(
        {
          id: "r2",
          sessionId: "s2",
          kind: "mcp",
          toolCallId: "tc-2",
          toolName: "filesystem_read_file",
          serverName: "filesystem",
          toolTitle: undefined,
          toolDescription: undefined,
          toolArgs: {},
          readOnly: false,
        },
        "denied",
        "policy-auto-deny",
        "denied-by-rules",
      );

      expect(result.toolName).toBe("filesystem_read_file");
      expect(result.serverName).toBe("filesystem");
      expect(result.decision).toBe("denied");
      expect(result.userAction).toBeUndefined();
    });
  });

  describe("buildPreHookAuditInput()", () => {
    it("constructs correct AuditLogInput", () => {
      const result = buildPreHookAuditInput({
        sessionId: "s1",
        toolCallId: "tc-1",
        toolName: "filesystem_read",
        serverName: "filesystem",
        kind: "mcp",
        decision: "denied",
        source: "pre-hook-disabled-server",
        sdkResult: "denied-by-rules",
      });

      expect(result.sessionId).toBe("s1");
      expect(result.toolCallId).toBe("tc-1");
      expect(result.toolName).toBe("filesystem_read");
      expect(result.serverName).toBe("filesystem");
      expect(result.kind).toBe("mcp");
      expect(result.decision).toBe("denied");
      expect(result.source).toBe("pre-hook-disabled-server");
      expect(result.commandText).toBe("");
    });

    it("preserves an ambiguous custom-tool name without explicit host provenance", () => {
      const result = buildPreHookAuditInput({
        sessionId: "s1",
        toolName: "marshal_recall",
        serverName: "",
        kind: "custom-tool",
        decision: "approved",
        source: "policy-auto-approve",
        sdkResult: "approved",
      });

      expect(result.toolName).toBe("marshal_recall");
    });

    it("preserves a third-party MCP name that resembles a legacy alias", () => {
      const result = buildPreHookAuditInput({
        sessionId: "s1",
        toolName: "mail_send_email",
        serverName: "third-party",
        kind: "mcp",
        decision: "approved",
        source: "policy-auto-approve",
        sdkResult: "approved",
      });

      expect(result.toolName).toBe("mail_send_email");
    });
  });
});
