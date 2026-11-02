import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../app-paths", () => ({
  getAppDataDir: () => "/tmp/test-data",
}));

import { writeDiagnosticEntry } from "../diagnostic-logger";
import { registerDiagnosticsHandlers } from "./diagnostics-ipc";

vi.mock("../diagnostic-logger", () => ({
  writeDiagnosticEntry: vi.fn<() => void>(),
  getLogFilePath: vi.fn<() => string>(() => "/tmp/test.jsonl"),
}));

const mockedWrite = vi.mocked(writeDiagnosticEntry);

describe("diagnostics:log IPC validation", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const recordHeartbeat = vi.fn<
    (webContentsId: number, heartbeat: unknown) => { success: boolean }
  >(() => ({ success: true }));
  const mockIpcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerDiagnosticsHandlers({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic IPC registration test double
      ipcHandle: mockIpcHandle as never,
      rendererResponsivenessMonitor: { recordHeartbeat },
    });
  });

  function callLog(entry: unknown) {
    const handler = handlers.get("diagnostics:log")!;
    return handler(null, entry);
  }

  it("accepts valid entry and calls writeDiagnosticEntry", () => {
    const result = callLog({ level: "error", category: "crash", message: "boom" });
    expect(result).toEqual({ success: true });
    expect(mockedWrite).toHaveBeenCalledOnce();
  });

  it("rejects invalid level", () => {
    const result = callLog({ level: "CRITICAL", category: "crash", message: "boom" });
    expect(result).toEqual({ success: false, error: expect.stringContaining("Invalid level") });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("rejects empty category", () => {
    const result = callLog({ level: "error", category: "", message: "boom" });
    expect(result).toEqual({ success: false, error: expect.stringContaining("Category") });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("rejects empty message", () => {
    const result = callLog({ level: "error", category: "crash", message: "  " });
    expect(result).toEqual({ success: false, error: expect.stringContaining("Message") });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("rejects null payload", () => {
    const result = callLog(null);
    expect(result).toEqual({ success: false, error: expect.stringContaining("Invalid") });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("accepts entry with metadata", () => {
    const result = callLog({
      level: "warn",
      category: "auth",
      message: "expired",
      metadata: { code: 401 },
    });
    expect(result).toEqual({ success: true });
    expect(mockedWrite).toHaveBeenCalledOnce();
  });

  it("routes renderer heartbeat metadata using the sender webContents id", () => {
    const payload = {
      schemaVersion: 1,
      sequence: 3,
      sentAtUnixMs: 1_000,
      frameCount: 42,
      rendererUptimeMs: 900,
      documentVisible: true,
      longTasksSupported: true,
      longTaskCount: 1,
      longTaskTotalDurationMs: 75,
      longTaskMaxDurationMs: 75,
      lastAckRoundTripMs: 8,
    };
    const handler = handlers.get("diagnostics:rendererHeartbeat")!;

    expect(handler({ sender: { id: 17 } }, payload)).toEqual({ success: true });
    expect(recordHeartbeat).toHaveBeenCalledWith(17, payload);
  });
});
