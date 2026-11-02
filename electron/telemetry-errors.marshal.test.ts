// Marshal-owned test
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../common/marshal-logger";
import { authErrors, makeAuthError } from "../common/telemetry/errors/marshal-auth";
import { hasTelemetryMarker, sendErrorTelemetry, setTelemetryWindow } from "./telemetry-errors";

function makeWindowStub(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    // eslint-disable-next-line vitest/require-mock-type-parameters
    webContents: { send: vi.fn() },
  };
}

const SAMPLE_ERROR = makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED);

afterEach(() => {
  setTelemetryWindow(null);
});

describe("sendErrorTelemetry", () => {
  it("sends the error payload via webContents.send", () => {
    const win = makeWindowStub();
    setTelemetryWindow(win);
    sendErrorTelemetry(SAMPLE_ERROR);
    expect(win.webContents.send).toHaveBeenCalledWith("telemetry:logError", SAMPLE_ERROR);
  });

  it("is a no-op when window is null", () => {
    // no window set
    expect(() => sendErrorTelemetry(SAMPLE_ERROR)).not.toThrow();
  });

  it("is a no-op when window is destroyed", () => {
    const win = makeWindowStub(true);
    setTelemetryWindow(win);
    sendErrorTelemetry(SAMPLE_ERROR);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("marks an Error cause so hasTelemetryMarker returns true", () => {
    const win = makeWindowStub();
    setTelemetryWindow(win);
    const cause = new Error("boom");
    sendErrorTelemetry(SAMPLE_ERROR, cause);
    expect(hasTelemetryMarker(cause)).toBe(true);
  });

  it("does NOT mark the cause when window is unavailable (so ipc-handle's fallback still fires)", () => {
    // no window set — event would be dropped
    const cause = new Error("boom");
    sendErrorTelemetry(SAMPLE_ERROR, cause);
    expect(hasTelemetryMarker(cause)).toBe(false);
  });

  it("does NOT mark the cause when window is destroyed", () => {
    const win = makeWindowStub(true);
    setTelemetryWindow(win);
    const cause = new Error("boom");
    sendErrorTelemetry(SAMPLE_ERROR, cause);
    expect(hasTelemetryMarker(cause)).toBe(false);
  });

  it("silently skips marking when cause is not an Error", () => {
    const win = makeWindowStub();
    setTelemetryWindow(win);
    sendErrorTelemetry(SAMPLE_ERROR, "string cause");
    expect(hasTelemetryMarker("string cause")).toBe(false);
    expect(win.webContents.send).toHaveBeenCalled();
  });

  it("does not throw when called with no cause", () => {
    const win = makeWindowStub();
    setTelemetryWindow(win);
    expect(() => sendErrorTelemetry(SAMPLE_ERROR)).not.toThrow();
    expect(win.webContents.send).toHaveBeenCalled();
  });
});

describe("hasTelemetryMarker", () => {
  it("returns false for non-Error / non-object values", () => {
    expect(hasTelemetryMarker(null)).toBe(false);
    expect(hasTelemetryMarker(undefined)).toBe(false);
    expect(hasTelemetryMarker("string")).toBe(false);
    expect(hasTelemetryMarker(42)).toBe(false);
  });

  it("returns false for an unmarked Error", () => {
    expect(hasTelemetryMarker(new Error("fresh"))).toBe(false);
  });
});

describe("telemetryEventSink", () => {
  it("forwards log.event entries via webContents.send when window is live", () => {
    const win = makeWindowStub();
    setTelemetryWindow(win);

    const log = createLogger("Test");
    log.event("LlmTokenUsage", { model: "gpt-4o", inputTokens: 100 });

    expect(win.webContents.send).toHaveBeenCalledWith("telemetry:logEvent", {
      scenario: "LlmTokenUsage",
      fields: { model: "gpt-4o", inputTokens: 100 },
    });
  });

  it("is a no-op when window is null", () => {
    setTelemetryWindow(null);

    const log = createLogger("Test");
    // Should not throw
    expect(() => log.event("Scenario", { key: "val" })).not.toThrow();
  });

  it("is a no-op when window is destroyed", () => {
    const win = makeWindowStub(true);
    setTelemetryWindow(win);

    const log = createLogger("Test");
    log.event("Scenario", { key: "val" });

    expect(win.webContents.send).not.toHaveBeenCalledWith("telemetry:logEvent", expect.anything());
  });
});
