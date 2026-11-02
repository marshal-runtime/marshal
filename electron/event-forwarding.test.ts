import { describe, it, expect, vi } from "vitest";

import { createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

vi.mock("./marshal-net-fetch", () => ({
  getNetFetch: () => vi.fn<typeof globalThis.fetch>(),
}));

// Tests the SessionManager multi-listener API (addEventListener/unsubscribe).
// This API is used internally by sendAndCollect() for per-request event collection.
describe("SessionManager addEventListener API", () => {
  it("unsubscribe removes a specific listener", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const receivedEvents: string[] = [];

    mgr.addEventListener((_sid, event) => receivedEvents.push(`a:${event.type}`));
    const unsub = mgr.addEventListener((_sid, event) => receivedEvents.push(`b:${event.type}`));

    mgr.emitEvent("s1", { type: "turn:idle" });
    expect(receivedEvents).toEqual(["a:turn:idle", "b:turn:idle"]);

    receivedEvents.length = 0;
    unsub();

    mgr.emitEvent("s1", { type: "turn:idle" });
    expect(receivedEvents).toEqual(["a:turn:idle"]);
  });

  // Regression: each addEventListener call with a distinct closure creates a new
  // entry in the Set. This is the bug that caused duplicate streaming events on
  // macOS when createWindow() re-ran on dock-click — each reopen added
  // another arrow function. The fix moves listener registration to initAppWiring()
  // (called once in app.whenReady()), making accumulation structurally impossible.
  it("distinct closures accumulate in the listener Set", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    let eventCount = 0;

    // Simulates 3 createWindow() cycles — each creates a NEW arrow function
    mgr.addEventListener(() => {
      eventCount++;
    });
    mgr.addEventListener(() => {
      eventCount++;
    });
    mgr.addEventListener(() => {
      eventCount++;
    });

    mgr.emitEvent("s1", { type: "turn:idle" });
    expect(eventCount).toBe(3);
  });
});
