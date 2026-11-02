import { describe, it, expect, vi, beforeEach } from "vitest";

import { createMockCopilotAPI } from "@/test-utils";
import type { CopilotAPI } from "@/types/electron";

import { copilotService } from "./copilot";

// We test the real exported singleton. Between tests we call stop() to reset
// its internal state (isInitialized + initPromise).

function mockInit(returnValue: Awaited<ReturnType<CopilotAPI["init"]>>) {
  return vi.fn<CopilotAPI["init"]>().mockResolvedValue(returnValue);
}

beforeEach(async () => {
  // Provide a mock so stop() doesn't throw on destroy()
  if (!window.copilotAPI) {
    window.copilotAPI = createMockCopilotAPI();
  }
  await copilotService.stop();
  // copilotAPI is removed by re-assigning per test; for the "no API" test we
  // need it absent, so we clear it here and let each test install its own.
  window.copilotAPI = undefined!;
});

describe("CopilotService.initialize", () => {
  it("succeeds when copilotAPI.init returns success", async () => {
    const init = mockInit({ success: true, sessionId: "s1" });
    window.copilotAPI = { ...createMockCopilotAPI(), init };

    await expect(copilotService.initialize()).resolves.toBeUndefined();
    expect(copilotService.isReady()).toBe(true);

    // Second call is a no-op — isInitialized short-circuits
    await expect(copilotService.initialize()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("clears initPromise after sync throw so retry is possible", async () => {
    // First call — no copilotAPI available
    await expect(copilotService.initialize()).rejects.toThrow("only available in Electron");
    expect(copilotService.isReady()).toBe(false);

    // Provide the API and retry — should succeed
    const init = mockInit({ success: true, sessionId: "s2" });
    window.copilotAPI = { ...createMockCopilotAPI(), init };

    await expect(copilotService.initialize()).resolves.toBeUndefined();
    expect(copilotService.isReady()).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("clears initPromise after async failure so retry is possible", async () => {
    const init = mockInit({ success: false, error: "auth failed" });
    window.copilotAPI = { ...createMockCopilotAPI(), init };

    await expect(copilotService.initialize()).rejects.toThrow("auth failed");
    expect(copilotService.isReady()).toBe(false);

    // Fix the backend and retry
    init.mockResolvedValue({ success: true, sessionId: "s3" });
    await expect(copilotService.initialize()).resolves.toBeUndefined();
    expect(copilotService.isReady()).toBe(true);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent callers on success", async () => {
    const init = mockInit({ success: true, sessionId: "s4" });
    window.copilotAPI = { ...createMockCopilotAPI(), init };

    const results = await Promise.allSettled([
      copilotService.initialize(),
      copilotService.initialize(),
      copilotService.initialize(),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("rejects all concurrent callers on failure, then allows retry", async () => {
    const init = mockInit({ success: false, error: "down" });
    window.copilotAPI = { ...createMockCopilotAPI(), init };

    const results = await Promise.allSettled([
      copilotService.initialize(),
      copilotService.initialize(),
    ]);

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(init).toHaveBeenCalledTimes(1);

    // Retry succeeds
    init.mockResolvedValue({ success: true, sessionId: "s5" });
    await expect(copilotService.initialize()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(2);
  });
});

describe("CopilotService.abort", () => {
  it("rejects when the cancellation IPC reports failure", async () => {
    const abort = vi
      .fn<CopilotAPI["abort"]>()
      .mockResolvedValue({ success: false, error: "Cancellation timed out. Try again." });
    window.copilotAPI = { ...createMockCopilotAPI(), abort };

    await expect(copilotService.abort("s1")).rejects.toThrow("Cancellation timed out. Try again.");
    expect(abort).toHaveBeenCalledExactlyOnceWith("s1");
  });
});

describe("CopilotService.send", () => {
  it("preserves AbortError identity returned through IPC", async () => {
    const send = vi
      .fn<CopilotAPI["send"]>()
      .mockResolvedValue({ success: false, error: "AbortError: The response was cancelled." });
    window.copilotAPI = { ...createMockCopilotAPI(), send };

    const error = await copilotService.send("hello", "s1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The response was cancelled.",
    });
  });
});
