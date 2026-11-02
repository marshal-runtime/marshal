import { describe, expect, it } from "vitest";

import {
  isSessionSandboxConfig,
  resolveSessionSandbox,
  validateRequestedSandbox,
} from "./session-sandbox-policy";

describe("isSessionSandboxConfig", () => {
  it("accepts read-only and workspace-write with optional string roots", () => {
    expect(isSessionSandboxConfig({ mode: "read-only" })).toBe(true);
    expect(isSessionSandboxConfig({ mode: "workspace-write" })).toBe(true);
    expect(
      isSessionSandboxConfig({ mode: "workspace-write", writableRoots: ["/tmp/reports"] }),
    ).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isSessionSandboxConfig(undefined)).toBe(false);
    expect(isSessionSandboxConfig(null)).toBe(false);
    expect(isSessionSandboxConfig("workspace-write")).toBe(false);
    expect(isSessionSandboxConfig([])).toBe(false);
    expect(isSessionSandboxConfig({ mode: "danger-full-access" })).toBe(false);
    expect(isSessionSandboxConfig({ mode: "workspace-write", writableRoots: [1] })).toBe(false);
    expect(isSessionSandboxConfig({ mode: "workspace-write", writableRoots: "/tmp" })).toBe(false);
  });
});

describe("validateRequestedSandbox", () => {
  it("passes through absent values", () => {
    expect(validateRequestedSandbox(undefined, "default")).toBeUndefined();
    expect(validateRequestedSandbox(null, "read-only-reviewer")).toBeUndefined();
  });

  it("keeps explicit workspace-write for ordinary sessions", () => {
    const sandbox = { mode: "workspace-write", writableRoots: ["/tmp/reports"] };
    expect(validateRequestedSandbox(sandbox, undefined)).toEqual(sandbox);
    expect(validateRequestedSandbox(sandbox, "default")).toEqual(sandbox);
  });

  it("rejects workspace-write for read-only-reviewer sessions", () => {
    expect(() =>
      validateRequestedSandbox({ mode: "workspace-write" }, "read-only-reviewer"),
    ).toThrow("read-only-reviewer sessions cannot use a workspace-write sandbox");
  });

  it("allows an explicit read-only sandbox for reviewer sessions", () => {
    expect(validateRequestedSandbox({ mode: "read-only" }, "read-only-reviewer")).toEqual({
      mode: "read-only",
    });
  });

  it("throws on malformed input instead of persisting it", () => {
    expect(() => validateRequestedSandbox({ mode: "danger-full-access" }, "default")).toThrow(
      "Invalid session sandbox config",
    );
    expect(() =>
      validateRequestedSandbox({ mode: "workspace-write", writableRoots: [42] }, "default"),
    ).toThrow("Invalid session sandbox config");
  });
});

describe("resolveSessionSandbox", () => {
  it("returns undefined when the session has no sandbox", () => {
    expect(resolveSessionSandbox(undefined)).toBeUndefined();
    expect(resolveSessionSandbox(null)).toBeUndefined();
    expect(resolveSessionSandbox({ permissionMode: "default" })).toBeUndefined();
  });

  it("preserves explicit workspace-write for ordinary sessions", () => {
    const sandbox = { mode: "workspace-write" as const, writableRoots: ["/tmp/reports"] };
    expect(resolveSessionSandbox({ sandbox })).toEqual(sandbox);
    expect(resolveSessionSandbox({ permissionMode: "default", sandbox })).toEqual(sandbox);
    expect(resolveSessionSandbox({ permissionMode: "allow-all", sandbox })).toEqual(sandbox);
  });

  it("drops stored workspace-write on read-only-reviewer sessions (create and resume path)", () => {
    expect(
      resolveSessionSandbox({
        permissionMode: "read-only-reviewer",
        sandbox: { mode: "workspace-write", writableRoots: ["/anywhere"] },
      }),
    ).toBeUndefined();
  });

  it("keeps an explicit read-only sandbox on reviewer sessions", () => {
    expect(
      resolveSessionSandbox({
        permissionMode: "read-only-reviewer",
        sandbox: { mode: "read-only" },
      }),
    ).toEqual({ mode: "read-only" });
  });

  it("derives full access for allow-all sessions without an explicit sandbox", () => {
    expect(resolveSessionSandbox({ permissionMode: "allow-all" })).toEqual({
      mode: "danger-full-access",
    });
  });

  it("never derives full access for default or reviewer sessions", () => {
    expect(resolveSessionSandbox({ permissionMode: "default" })).toBeUndefined();
    expect(resolveSessionSandbox({ permissionMode: "read-only-reviewer" })).toBeUndefined();
  });

  it("keeps an explicit read-only sandbox on allow-all sessions", () => {
    expect(
      resolveSessionSandbox({ permissionMode: "allow-all", sandbox: { mode: "read-only" } }),
    ).toEqual({ mode: "read-only" });
  });

  it("drops malformed stored sandbox rows", () => {
    expect(
      resolveSessionSandbox({
        permissionMode: "default",
        // Simulates a hand-edited or drifted on-disk row.
        sandbox: { mode: "danger-full-access" },
      }),
    ).toBeUndefined();
  });
});
