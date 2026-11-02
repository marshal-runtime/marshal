import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { normalizePermissionRequest } from "./permission-request-normalizer";
import type { NormalizedPermissionRequest } from "./permission-request-types";

/** Assert that norm has the expected kind and narrow the type via runtime check. */
function assertKind<K extends NormalizedPermissionRequest["kind"]>(
  norm: NormalizedPermissionRequest,
  kind: K,
): asserts norm is Extract<NormalizedPermissionRequest, { kind: K }> {
  expect(norm.kind).toBe(kind);
}

describe("normalizePermissionRequest", () => {
  describe("shell kind", () => {
    it("extracts fullCommandText as command", () => {
      const norm = normalizePermissionRequest({ kind: "shell", fullCommandText: "git status" });
      assertKind(norm, "shell");
      expect(norm.command).toBe("git status");
    });

    it("falls back to command field", () => {
      const norm = normalizePermissionRequest({ kind: "shell", command: "ls" });
      assertKind(norm, "shell");
      expect(norm.command).toBe("ls");
    });

    it("falls back to cmd field", () => {
      const norm = normalizePermissionRequest({ kind: "shell", cmd: "dir" });
      assertKind(norm, "shell");
      expect(norm.command).toBe("dir");
    });

    it("leaves serverName empty for a command that no built-in shim owns", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        fullCommandText: "example-mcp ask -q hello",
      });
      assertKind(norm, "shell");
      expect(norm.serverName).toBe("");
    });

    it("leaves serverName empty for generic commands", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        fullCommandText: "git log",
      });
      assertKind(norm, "shell");
      expect(norm.serverName).toBe("");
    });

    it("extracts intention from promptRequest", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        promptRequest: { intention: "list files" },
      });
      assertKind(norm, "shell");
      expect(norm.intention).toBe("list files");
    });

    it("falls back to top-level intention", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        intention: "delete file",
      });
      assertKind(norm, "shell");
      expect(norm.intention).toBe("delete file");
    });

    it("extracts commandIdentifiers from promptRequest", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        promptRequest: { commandIdentifiers: ["git status"] },
      });
      assertKind(norm, "shell");
      expect(norm.commandIdentifiers).toEqual(["git status"]);
    });

    it("preserves toolCallId", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        toolCallId: "tc-abc",
        fullCommandText: "ls",
      });
      assertKind(norm, "shell");
      expect(norm.toolCallId).toBe("tc-abc");
    });

    it("respects explicit serverName over command derivation", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        fullCommandText: "example-mcp ask -q hello",
        serverName: "example-mcp",
      });
      assertKind(norm, "shell");
      expect(norm.serverName).toBe("example-mcp");
    });

    it("handles empty command gracefully", () => {
      const norm = normalizePermissionRequest({ kind: "shell" });
      assertKind(norm, "shell");
      expect(norm.command).toBe("");
      expect(norm.serverName).toBe("");
    });

    it("leaves serverName empty for a quoted Windows shim path", () => {
      const norm = normalizePermissionRequest({
        kind: "shell",
        fullCommandText: '"C:\\Users\\First Last\\.marshal\\bin\\example-mcp.cmd" ask -q hello',
      });
      assertKind(norm, "shell");
      expect(norm.serverName).toBe("");
    });
  });

  describe("write kind — sdk origin", () => {
    it("extracts path and marks origin sdk", () => {
      const norm = normalizePermissionRequest({
        kind: "write",
        path: "/tmp/file.txt",
        diff: "- old\n+ new",
      });
      assertKind(norm, "write");
      expect(norm.path).toBe("/tmp/file.txt");
      expect(norm.diff).toBe("- old\n+ new");
      expect(norm.origin).toBe("sdk");
      expect(norm.browserToolName).toBeUndefined();
    });

    it("uses fileName fallback for path", () => {
      const norm = normalizePermissionRequest({
        kind: "write",
        fileName: "a.ts",
      });
      assertKind(norm, "write");
      expect(norm.path).toBe("a.ts");
    });

    it("uses file fallback for path", () => {
      const norm = normalizePermissionRequest({ kind: "write", file: "b.ts" });
      assertKind(norm, "write");
      expect(norm.path).toBe("b.ts");
    });

    it("sets diff to null when missing", () => {
      const norm = normalizePermissionRequest({ kind: "write", path: "/tmp/x" });
      assertKind(norm, "write");
      expect(norm.diff).toBeNull();
    });
  });

  describe("write kind — synthesized-browser origin", () => {
    it("upgrades browser screenshot tool to write with resolved path", () => {
      const norm = normalizePermissionRequest(
        { kind: "mcp", toolName: "playwright-browser_take_screenshot" },
        { resolvePendingBrowserPath: () => "/tmp/screen.png" },
      );
      assertKind(norm, "write");
      expect(norm.path).toBe("/tmp/screen.png");
      expect(norm.origin).toBe("synthesized-browser");
      expect(norm.browserToolName).toBe("playwright-browser_take_screenshot");
    });

    it("upgrades code-execution tool to write with path='*'", () => {
      const norm = normalizePermissionRequest(
        { kind: "mcp", toolName: "playwright-browser_evaluate" },
        { resolvePendingBrowserPath: () => undefined },
      );
      assertKind(norm, "write");
      expect(norm.path).toBe("*");
      expect(norm.origin).toBe("synthesized-browser");
      expect(norm.browserToolName).toBe("playwright-browser_evaluate");
    });

    it("upgrades known write tool with unavailable path to write path='*'", () => {
      const norm = normalizePermissionRequest(
        { kind: "mcp", toolName: "playwright-browser_take_screenshot" },
        { resolvePendingBrowserPath: () => undefined },
      );
      assertKind(norm, "write");
      expect(norm.path).toBe("*");
    });

    it("also upgrades double-underscore prefixed tools", () => {
      const norm = normalizePermissionRequest(
        { kind: "mcp", toolName: "playwright__browser_evaluate" },
        { resolvePendingBrowserPath: () => undefined },
      );
      assertKind(norm, "write");
      expect(norm.path).toBe("*");
    });

    it("keeps non-browser mcp tools as mcp", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "playwright-browser_navigate",
      });
      assertKind(norm, "mcp");
    });
  });

  describe("mcp kind", () => {
    it("extracts toolName, toolArgs, serverName", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "filesystem__read_file",
        serverName: "filesystem",
        arguments: { path: "/tmp/x" },
      });
      assertKind(norm, "mcp");
      expect(norm.toolName).toBe("filesystem__read_file");
      expect(norm.serverName).toBe("filesystem");
      expect(norm.toolArgs.path).toBe("/tmp/x");
    });

    it("falls back to tool field for toolName", () => {
      const norm = normalizePermissionRequest({ kind: "mcp", tool: "my_tool" });
      assertKind(norm, "mcp");
      expect(norm.toolName).toBe("my_tool");
    });

    it("sets serverName to undefined when absent", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "filesystem__read_file",
      });
      assertKind(norm, "mcp");
      expect(norm.serverName).toBeUndefined();
    });

    it("extracts args from arguments field", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "my_tool",
        arguments: { key: "value" },
      });
      assertKind(norm, "mcp");
      expect(norm.toolArgs.key).toBe("value");
    });

    it("reads readOnly flag", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "my_tool",
        readOnly: true,
      });
      assertKind(norm, "mcp");
      expect(norm.readOnly).toBe(true);
    });

    it("coerces empty-string serverName to undefined", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "my_tool",
        serverName: "",
      });
      assertKind(norm, "mcp");
      expect(norm.serverName).toBeUndefined();
    });

    it("preserves toolCallId through normalization", () => {
      const norm = normalizePermissionRequest({
        kind: "mcp",
        toolName: "my_tool",
        toolCallId: "tc-999",
      });
      assertKind(norm, "mcp");
      expect(norm.toolCallId).toBe("tc-999");
    });
  });

  describe("custom-tool kind", () => {
    it("extracts toolName, toolArgs from args", () => {
      const norm = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "createAutomation",
        args: { name: "my-automation" },
      });
      assertKind(norm, "custom-tool");
      expect(norm.toolName).toBe("createAutomation");
      expect(norm.toolArgs.name).toBe("my-automation");
    });

    it("extracts commandIdentifiers from promptRequest", () => {
      const norm = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "example-mcp",
        promptRequest: { commandIdentifiers: ["example-mcp ask"] },
      });
      assertKind(norm, "custom-tool");
      expect(norm.commandIdentifiers).toEqual(["example-mcp ask"]);
    });

    it("collects top-level non-metadata fields into toolArgs when args/arguments absent", () => {
      const norm = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "getEvent",
        eventId: "abc-123",
        intention: "read calendar",
      });
      assertKind(norm, "custom-tool");
      expect(norm.toolArgs["eventId"]).toBe("abc-123");
      expect(norm.toolArgs).not.toHaveProperty("intention"); // intention is metadata — excluded
    });

    it("preserves runtime tool identities; legacy aliases migrate only in persisted settings", () => {
      const legacy = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "mail_send_email",
      });
      assertKind(legacy, "custom-tool");
      expect(legacy.toolName).toBe("mail_send_email");

      // Already-canonical names pass through unchanged.
      const canonical = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "sendEmail",
      });
      assertKind(canonical, "custom-tool");
      expect(canonical.toolName).toBe("sendEmail");

      const repoSelfTool = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "marshal_recall",
      });
      assertKind(repoSelfTool, "custom-tool");
      expect(repoSelfTool.toolName).toBe("marshal_recall");

      const hostSelfTool = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "m_example_sign_in",
      });
      assertKind(hostSelfTool, "custom-tool");
      expect(hostSelfTool.toolName).toBe("m_example_sign_in");

      const externalMcp = normalizePermissionRequest({
        kind: "mcp",
        serverName: "third-party",
        toolName: "mail_send_email",
      });
      assertKind(externalMcp, "mcp");
      expect(externalMcp.toolName).toBe("mail_send_email");
    });

    it("extracts toolArgs from `arguments` field for custom-tool", () => {
      const norm = normalizePermissionRequest({
        kind: "custom-tool",
        toolName: "createAutomation",
        arguments: { name: "Via Arguments", prompt: "test" },
      });
      assertKind(norm, "custom-tool");
      expect(norm.toolArgs["name"]).toBe("Via Arguments");
      expect(norm.toolArgs["prompt"]).toBe("test");
    });
  });

  describe("passthrough kinds", () => {
    it("normalizes read kind", () => {
      const norm = normalizePermissionRequest({ kind: "read", path: "/tmp/x" });
      expect(norm.kind).toBe("read");
    });

    it("normalizes url kind", () => {
      const norm = normalizePermissionRequest({ kind: "url", url: "https://example.com" });
      expect(norm.kind).toBe("url");
    });

    it("normalizes settings kind", () => {
      const norm = normalizePermissionRequest({ kind: "settings" });
      expect(norm.kind).toBe("settings");
    });

    it("normalizes memory kind", () => {
      const norm = normalizePermissionRequest({ kind: "memory", toolName: "store" });
      expect(norm.kind).toBe("memory");
    });

    it("normalizes hook kind", () => {
      const norm = normalizePermissionRequest({ kind: "hook", toolName: "hook" });
      expect(norm.kind).toBe("hook");
    });
  });

  describe("unknown kind fallback", () => {
    it("treats unknown kind as mcp", () => {
      const norm = normalizePermissionRequest({
        kind: "unknown-future-kind",
        toolName: "my_tool",
      });
      expect(norm.kind).toBe("mcp");
    });
  });
});

describe("local filesystem tools normalize to read/write", () => {
  it("listLocalFiles → read with resolved path", () => {
    const r = normalizePermissionRequest({
      kind: "custom-tool",
      toolName: "listLocalFiles",
      toolCallId: "tc1",
      arguments: { path: "~/Downloads" },
    });
    expect(r.kind).toBe("read");
    expect(r).toMatchObject({ path: path.resolve(path.join(os.homedir(), "Downloads")) });
  });

  it("createLocalDirectory → write, origin sdk, with a non-empty toolCallId", () => {
    const r = normalizePermissionRequest({
      kind: "custom-tool",
      toolName: "createLocalDirectory",
      toolCallId: "tc2",
      arguments: { path: "/tmp/new" },
    });
    expect(r).toMatchObject({
      kind: "write",
      origin: "sdk",
      path: path.resolve("/tmp/new"),
      toolCallId: "tc2",
    });
  });

  it("moveLocalPath gates the destination", () => {
    const r = normalizePermissionRequest({
      kind: "custom-tool",
      toolName: "moveLocalPath",
      toolCallId: "tc3",
      arguments: { source: "/tmp/a", destination: "/tmp/b" },
    });
    expect(r).toMatchObject({ kind: "write", path: path.resolve("/tmp/b") });
  });

  it("synthetic write always carries a non-empty toolCallId so sensitive-path-gate runs", () => {
    const r = normalizePermissionRequest({
      kind: "custom-tool",
      toolName: "createLocalDirectory",
      arguments: { path: "/tmp/new" },
    });
    // SENSITIVE_PATH_GATE_RULE skips `write && origin:sdk && !toolCallId`
    // (the MCP-paired case). A Marshal fs write is never MCP-paired, so it must
    // present a non-empty toolCallId.
    expect(r.toolCallId).toBeTruthy();
  });

  it("a non-fs custom tool still normalizes as custom-tool", () => {
    const r = normalizePermissionRequest({
      kind: "custom-tool",
      toolName: "remember",
      arguments: {},
    });
    expect(r.kind).toBe("custom-tool");
  });
});
