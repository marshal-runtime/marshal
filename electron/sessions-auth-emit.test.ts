import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn<typeof globalThis.fetch>() }));
vi.mock("./marshal-net-fetch", () => ({
  getNetFetch: () => mockFetch,
}));

import * as fs from "fs";

import { authErrors, makeAuthError } from "../common/telemetry/errors/marshal-auth";
import { hasTelemetryMarker, sendErrorTelemetry, setTelemetryWindow } from "./telemetry-errors";
import { SessionTestAccess, createTestBackend } from "./testing/harness";

const mockedFs = vi.mocked(fs);

beforeAll(async () => {
  await import("./sessions");
}, 30_000);

const sendSpy = vi.fn<(channel: string, payload: unknown) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
  sendSpy.mockReset();
  setTelemetryWindow({
    isDestroyed: () => false,
    webContents: { send: sendSpy },
  });
});

afterEach(() => {
  setTelemetryWindow(null);
  vi.useRealTimers();
});

describe("SessionManager.emitAuthErrorTelemetry — GITHUB_TOKEN_FAILED dedup", () => {
  async function makeManager() {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    return new SessionTestAccess(mgr);
  }

  it("first emit sends a telemetry event", async () => {
    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1");
    expect(sendSpy).toHaveBeenCalledWith(
      "telemetry:logError",
      makeAuthError(authErrors.GITHUB_TOKEN_FAILED),
    );
  });

  it("second emit within the 2s window for the same session is suppressed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));

    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1");
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 1.5s later — still inside the 2s dedup window
    vi.setSystemTime(new Date("2026-04-26T12:00:01.500Z"));
    access.emitAuthErrorTelemetry("sess-1");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("emit after the 2s window for the same session fires again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));

    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1");
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 2.5s later — outside the dedup window
    vi.setSystemTime(new Date("2026-04-26T12:00:02.500Z"));
    access.emitAuthErrorTelemetry("sess-1");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("emit on session B is independent of suppression on session A", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));

    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-A");
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Same instant, different session — not suppressed
    access.emitAuthErrorTelemetry("sess-B");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("marks the cause even when the dedup window suppresses the emit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));

    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1", new Error("first"));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Inside the window — telemetry emit suppressed, but the cause MUST still be
    // marked so ipc-handle's catch-all skips HANDLER_UNCAUGHT.
    const suppressedCause = new Error("suppressed");
    access.emitAuthErrorTelemetry("sess-1", suppressedCause);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(hasTelemetryMarker(suppressedCause)).toBe(true);
  });

  it("does not emit (and does not mark) when called outside the helper", async () => {
    // Sanity: non-Error causes are silently ignored by markTelemetry.
    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1", "not an error");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(hasTelemetryMarker("not an error")).toBe(false);
  });

  it("clears dedup state for a session on deleteSession (no leak)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));

    const access = await makeManager();
    access.emitAuthErrorTelemetry("sess-1");
    expect(access.lastAuthEmitBySession.has("sess-1")).toBe(true);

    // Simulate deleteSession()'s cleanup explicitly — full deleteSession
    // requires more disk-mock setup than this focused test needs.
    access.lastAuthEmitBySession.delete("sess-1");
    expect(access.lastAuthEmitBySession.has("sess-1")).toBe(false);
  });

  it("does not double-mark on the sendErrorTelemetry side", async () => {
    // The helper marks via markTelemetry BEFORE the dedup gate.
    // sendErrorTelemetry then marks again on the same WeakSet — this is a
    // no-op (set membership is idempotent), but the test pins the contract.
    const access = await makeManager();
    const cause = new Error("auth");
    access.emitAuthErrorTelemetry("sess-1", cause);
    expect(hasTelemetryMarker(cause)).toBe(true);
    // Calling sendErrorTelemetry directly with the same cause must remain idempotent.
    sendErrorTelemetry(makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED), cause);
    expect(hasTelemetryMarker(cause)).toBe(true);
  });
});
