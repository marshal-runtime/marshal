import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CommandCenterPrivacyNormalizer } from "./privacy-normalizer";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

describe("CommandCenterPrivacyNormalizer", () => {
  it("does not project raw session ids, paths, commands, or results", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-normalizer-"));
    const normalizer = new CommandCenterPrivacyNormalizer(path.join(dir, "salt.enc"));

    const events = normalizer.backendEvent({
      type: "tool-start",
      sessionId: "raw-session-title-or-id",
      toolCallId: "call-1",
      toolName: "shell",
      serverName: "builtin",
      argKeys: ["command", "cwd"],
      argsShapeHash: normalizer.hashShape(["command", "cwd"]),
    });
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("raw-session-title-or-id");
    expect(serialized).not.toContain("C:\\");
    expect(serialized).not.toContain("rm -rf");
    expect(serialized).not.toContain("commandText");
  });

  it("uses install-local stable salted ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-normalizer-"));
    const saltPath = path.join(dir, "salt.enc");
    const one = new CommandCenterPrivacyNormalizer(saltPath);
    const two = new CommandCenterPrivacyNormalizer(saltPath);

    expect(one.safeId("session", "abc")).toBe(two.safeId("session", "abc"));
    expect(one.safeId("session", "abc")).not.toContain("abc");
  });

  it("classifies unrecognized tools as generic when server-backed and unknown otherwise", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cc-normalizer-"));
    const normalizer = new CommandCenterPrivacyNormalizer(path.join(dir, "salt.enc"));

    expect(
      normalizer.backendEvent({
        type: "tool-start",
        sessionId: "session",
        toolCallId: "builtin-tool",
        toolName: "list_items",
      })[0],
    ).toMatchObject({ type: "tool.observed", kind: "unknown" });
    expect(
      normalizer.backendEvent({
        type: "tool-start",
        sessionId: "session",
        toolCallId: "query-tool",
        toolName: "execute_query",
        serverName: "query-mcp",
      })[0],
    ).toMatchObject({ type: "tool.observed", kind: "generic" });
    expect(
      normalizer.backendEvent({
        type: "tool-start",
        sessionId: "session",
        toolCallId: "custom-tool",
        toolName: "custom_tool",
        serverName: "custom-server",
      })[0],
    ).toMatchObject({ type: "tool.observed", kind: "generic" });
  });
});
