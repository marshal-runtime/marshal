import { describe, expect, it, vi } from "vitest";

import { SERVER_AUTO_APPROVE_RULE } from "./configured-server-auto-approval-rule";
import { makeCtx, makeRequest } from "./test-helpers";

const BUILTIN_SHIM_SERVER = "shim-server";

vi.mock("../../common/marshal-permission-servers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../common/marshal-permission-servers")>()),
  BUILTIN_SHELL_SERVERS: new Set(["shim-server"]),
}));

describe("SERVER_AUTO_APPROVE_RULE", () => {
  it("returns null when serverConfig.autoApprove is false", () => {
    const ctx = makeCtx({ serverConfig: { enabled: true, autoApprove: false } });
    const request = makeRequest({ kind: "shell" });
    expect(SERVER_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves non-shell requests when autoApprove is true", () => {
    const ctx = makeCtx({
      serverConfig: { enabled: true, autoApprove: true },
      effectiveServerName: "playwright",
    });
    const request = makeRequest({
      kind: "mcp",
      toolName: "playwright-browser_navigate",
      serverName: "playwright",
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs: {},
      readOnly: false,
      toolCallId: undefined,
    });
    const result = SERVER_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("approves single shell invocation for builtin server with autoApprove", () => {
    const ctx = makeCtx({
      serverConfig: { enabled: true, autoApprove: true },
      effectiveServerName: BUILTIN_SHIM_SERVER,
    });
    const request = makeRequest({
      kind: "shell",
      command: `${BUILTIN_SHIM_SERVER} ask -q 'hello'`,
    });
    const result = SERVER_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
  });

  it("does not approve compound shell invocation for builtin server", () => {
    const ctx = makeCtx({
      serverConfig: { enabled: true, autoApprove: true },
      effectiveServerName: BUILTIN_SHIM_SERVER,
    });
    const request = makeRequest({
      kind: "shell",
      command: `${BUILTIN_SHIM_SERVER} ask ; rm -rf /`,
    });
    // A compound command should not be approved for builtin shell servers
    expect(SERVER_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });
});
