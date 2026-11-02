import { describe, expect, it } from "vitest";

import { resolveRuntimeStartupSelection } from "./startup-selection";

describe("resolveRuntimeStartupSelection", () => {
  it("defaults to Claude", () => {
    expect(resolveRuntimeStartupSelection({}, { mockMode: false, gatewayE2E: false })).toEqual({
      requestedRuntimeId: "claude",
      runtimeId: "claude",
    });
  });

  it("uses the persisted runtime ID", () => {
    expect(
      resolveRuntimeStartupSelection(
        { runtimeId: "gateway" },
        { mockMode: false, gatewayE2E: false },
      ),
    ).toEqual({
      requestedRuntimeId: "gateway",
      runtimeId: "gateway",
    });
  });

  it("keeps regular mock mode on Copilot without overwriting the persisted choice", () => {
    expect(
      resolveRuntimeStartupSelection(
        { runtimeId: "gateway" },
        { mockMode: true, gatewayE2E: false },
      ),
    ).toEqual({
      requestedRuntimeId: "gateway",
      runtimeId: "copilot",
    });
  });

  it("allows the explicit Gateway E2E composition to use Gateway in mock mode", () => {
    expect(
      resolveRuntimeStartupSelection({ runtimeId: "gateway" }, { mockMode: true, gatewayE2E: true })
        .runtimeId,
    ).toBe("gateway");
  });

  it("starts Codex when the registered runtime was persisted", () => {
    expect(
      resolveRuntimeStartupSelection(
        { runtimeId: "codex" },
        { mockMode: false, gatewayE2E: false },
      ),
    ).toEqual({
      requestedRuntimeId: "codex",
      runtimeId: "codex",
    });
  });

  it("retains an unknown requested ID for diagnostics while using a safe runtime", () => {
    expect(
      resolveRuntimeStartupSelection(
        { runtimeId: "future-runtime" },
        { mockMode: false, gatewayE2E: false },
      ),
    ).toEqual({
      requestedRuntimeId: "future-runtime",
      runtimeId: "copilot",
    });
  });
});
