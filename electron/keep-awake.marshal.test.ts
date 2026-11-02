// Marshal-owned test
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecFile = vi.fn<(...args: unknown[]) => void>();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { KeepAwakeManager } from "./keep-awake";

type JiggleCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Extract the execFile callback from the last mock call. */
function getJiggleCallback(): JiggleCallback {
  const lastCall = mockExecFile.mock.calls[0];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test helper: mock args are untyped
  return lastCall[3] as JiggleCallback;
}

describe("KeepAwakeManager", () => {
  let ka: KeepAwakeManager;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    ka = new KeepAwakeManager();
  });

  afterEach(() => {
    ka.destroy();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("no-ops on non-Windows platforms", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    ka.acquire("test");
    expect(ka.isActive()).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("starts jiggle timer on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    expect(ka.isActive()).toBe(true);
    // Immediate first jiggle
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("jiggles again on interval", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 1000);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("acquire is idempotent for same reason", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    ka.acquire("heartbeat");
    expect(mockExecFile).toHaveBeenCalledTimes(1); // only one immediate jiggle
  });

  it("release stops timer when last hold is released", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    ka.release("heartbeat");
    expect(ka.isActive()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(mockExecFile).toHaveBeenCalledTimes(1); // no additional calls
  });

  it("stays active when one hold remains after partial release", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    ka.acquire("relay");
    ka.release("heartbeat");
    expect(ka.isActive()).toBe(true);
    ka.release("relay");
    expect(ka.isActive()).toBe(false);
  });

  it("destroy stops the timer and clears all holds", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    ka.destroy();
    expect(ka.isActive()).toBe(false);
    expect(ka.activeReasons()).toHaveLength(0);
  });

  it("activeReasons returns current holds", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    ka.acquire("heartbeat");
    ka.acquire("relay");
    expect(ka.activeReasons()).toEqual(expect.arrayContaining(["heartbeat", "relay"]));
    ka.release("heartbeat");
    expect(ka.activeReasons()).toEqual(["relay"]);
  });

  it("logs ENOENT when powershell.exe is not found", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ka.acquire("heartbeat");
    const cb = getJiggleCallback();
    const err = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    cb(err, "", "");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KeepAwake]"),
      "powershell.exe not found on PATH",
    );
    warnSpy.mockRestore();
  });

  it("logs EACCES when permission is denied", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ka.acquire("heartbeat");
    const cb = getJiggleCallback();
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    cb(err, "", "");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KeepAwake]"),
      "Permission denied running powershell.exe",
    );
    warnSpy.mockRestore();
  });

  it("logs errors without a recognized code using fallback", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ka.acquire("heartbeat");
    const cb = getJiggleCallback();
    cb(new Error("timed out"), "", "");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KeepAwake]"),
      "Mouse jiggle failed (exit):",
      "timed out",
    );
    warnSpy.mockRestore();
  });

  it("logs errors with an unexpected error code", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ka.acquire("heartbeat");
    const cb = getJiggleCallback();
    const err = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    cb(err, "", "");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KeepAwake]"),
      "Mouse jiggle failed (EPERM):",
      "operation not permitted",
    );
    warnSpy.mockRestore();
  });

  it("logs PowerShell stderr output on success", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ka.acquire("heartbeat");
    const cb = getJiggleCallback();
    cb(null, "", "Add-Type : Cannot add type.");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[KeepAwake]"),
      "PowerShell stderr:",
      "Add-Type : Cannot add type.",
    );
    warnSpy.mockRestore();
  });
});
