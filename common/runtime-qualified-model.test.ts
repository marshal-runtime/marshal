import { describe, expect, it } from "vitest";

import {
  formatRuntimeQualifiedModel,
  parseRuntimeQualifiedModel,
  resolveSessionExecutionRuntimeId,
  resolveSessionExecutionTargetKey,
} from "./runtime-qualified-model";

describe("parseRuntimeQualifiedModel", () => {
  it("splits a peer runtime qualifier from the runtime-local model id", () => {
    expect(parseRuntimeQualifiedModel("cursor:gpt-5.6-luna")).toEqual({
      runtimeId: "cursor",
      model: "gpt-5.6-luna",
    });
    expect(parseRuntimeQualifiedModel("claude:claude-opus-5-5[1m]")).toEqual({
      runtimeId: "claude",
      model: "claude-opus-5-5[1m]",
    });
  });

  it("splits an account from the runtime qualifier", () => {
    expect(parseRuntimeQualifiedModel("claude@work:opus")).toEqual({
      runtimeId: "claude",
      accountId: "work",
      model: "opus",
    });
    expect(parseRuntimeQualifiedModel("claude@default:opus")).toEqual({
      runtimeId: "claude",
      accountId: "default",
      model: "opus",
    });
  });

  it.each([
    undefined,
    "",
    "gpt-5.6-luna",
    "claude-opus-5-5[1m]",
    "copilot:gpt-5.6",
    "gateway:gpt-5.6",
    "cursor:",
    ":gpt-5.6-luna",
    "claude@:opus",
    "claude@Work:opus",
    "copilot@work:gpt-5.6",
    "claude@work:",
  ])("keeps %j as a plain model id", (model) => {
    expect(parseRuntimeQualifiedModel(model)).toBeNull();
  });
});

describe("resolveSessionExecutionRuntimeId", () => {
  it("runs a runtime-qualified model on its own runtime", () => {
    expect(
      resolveSessionExecutionRuntimeId({ runtimeId: "claude", model: "cursor:gpt-5.6-luna" }),
    ).toBe("cursor");
  });

  it("keeps the session runtime for plain models", () => {
    expect(resolveSessionExecutionRuntimeId({ runtimeId: "claude", model: "gpt-5.6-luna" })).toBe(
      "claude",
    );
    expect(resolveSessionExecutionRuntimeId({ backendOrigin: "gateway" })).toBe("gateway");
  });

  it("ignores the account when naming the runtime", () => {
    expect(
      resolveSessionExecutionRuntimeId({ runtimeId: "cursor", model: "claude@work:opus" }),
    ).toBe("claude");
  });
});

describe("resolveSessionExecutionTargetKey", () => {
  it("keys sessions by runtime and account", () => {
    expect(
      resolveSessionExecutionTargetKey({ runtimeId: "claude", model: "claude@work:opus" }),
    ).toBe("claude@work");
    expect(resolveSessionExecutionTargetKey({ runtimeId: "claude", model: "opus" })).toBe("claude");
  });

  it("gives the original account one key however the model spells it", () => {
    for (const model of ["opus", "claude:opus", "claude@default:opus"]) {
      expect(resolveSessionExecutionTargetKey({ runtimeId: "claude", model })).toBe("claude");
    }
  });
});

describe("formatRuntimeQualifiedModel", () => {
  it("round-trips accounts and drops the original account", () => {
    expect(
      formatRuntimeQualifiedModel({ runtimeId: "claude", accountId: "work", model: "opus" }),
    ).toBe("claude@work:opus");
    expect(formatRuntimeQualifiedModel({ runtimeId: "codex", model: "gpt-5.5" })).toBe(
      "codex:gpt-5.5",
    );
  });
});
