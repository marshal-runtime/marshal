import os from "node:os";

import { describe, expect, it } from "vitest";

import { SENSITIVE_PATH_GATE_RULE } from "./sensitive-path-access-gate-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("SENSITIVE_PATH_GATE_RULE", () => {
  it("returns null for shell commands that do not target sensitive paths", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    expect(SENSITIVE_PATH_GATE_RULE.apply(request, ctx)).toBeNull();
  });

  it("skips SDK-emitted write WITHOUT toolCallId (MCP-paired, already gated)", () => {
    const ctx = makeCtx();
    const request = makeRequest({
      kind: "write",
      path: `${os.homedir()}/.ssh/config`,
      diff: null,
      intention: undefined,
      origin: "sdk",
      browserToolName: undefined,
      toolCallId: undefined,
    });
    // No toolCallId → MCP-paired write, concurrent MCP gate already ran → skip
    expect(SENSITIVE_PATH_GATE_RULE.apply(request, ctx)).toBeNull();
  });

  it("gates direct SDK write WITH toolCallId to a sensitive path", () => {
    const ctx = makeCtx();
    const homeDir = os.homedir();
    const request = makeRequest({
      kind: "write",
      path: `${homeDir}/.gitconfig`,
      diff: null,
      intention: undefined,
      origin: "sdk",
      browserToolName: undefined,
      toolCallId: "tc-direct-sdk-1",
    });
    // Has toolCallId → direct SDK write (edit/create via "ask" gate) → run sensitive-path check
    const result = SENSITIVE_PATH_GATE_RULE.apply(request, ctx);
    expect(result).not.toBeNull();
    expect(result?.decision).toBe("prompt");
  });

  it("prompts for synthesized-browser write to sensitive path", () => {
    const ctx = makeCtx();
    const homeDir = os.homedir();
    const sshConfig = `${homeDir}/.ssh/config`;
    const request = makeRequest({
      kind: "write",
      path: sshConfig,
      diff: null,
      intention: undefined,
      origin: "synthesized-browser",
      browserToolName: "browser_file_upload",
      toolCallId: "tc-2",
    });
    const result = SENSITIVE_PATH_GATE_RULE.apply(request, ctx);
    // ~/.ssh/config is a built-in sensitive path; expect the gate to fire
    expect(result).not.toBeNull();
    expect(result?.decision).toBe("prompt");
    expect(result?.auditOutcome).toBe("denied");
  });

  it("fires even when serverConfig.autoApprove is true", () => {
    const ctx = makeCtx({ serverConfig: { enabled: true, autoApprove: true } });
    const result = SENSITIVE_PATH_GATE_RULE.apply(
      makeRequest({
        kind: "write",
        path: `${os.homedir()}/.ssh/config`,
        origin: "synthesized-browser",
        diff: null,
        intention: undefined,
        browserToolName: "browser_take_screenshot",
        toolCallId: undefined,
      }),
      ctx,
    );
    expect(result?.decision).toBe("prompt");
  });

  it("prompts for SDK read of a sensitive path", () => {
    const ctx = makeCtx();
    const homeDir = os.homedir();
    const request = makeRequest({
      kind: "read",
      path: `${homeDir}/.ssh/id_rsa`,
      toolCallId: undefined,
    });
    const result = SENSITIVE_PATH_GATE_RULE.apply(request, ctx);
    expect(result).not.toBeNull();
    expect(result?.decision).toBe("prompt");
    expect(result?.auditOutcome).toBe("denied");
  });

  it("returns null for SDK read of a non-sensitive path", () => {
    const ctx = makeCtx();
    const request = makeRequest({
      kind: "read",
      path: "/tmp/safe-file.txt",
      toolCallId: undefined,
    });
    expect(SENSITIVE_PATH_GATE_RULE.apply(request, ctx)).toBeNull();
  });
});
