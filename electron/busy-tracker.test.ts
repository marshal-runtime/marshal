import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { BusySessionTracker } from "./busy-tracker";
import { STUCK_TIMEOUT_MS } from "./session-view-builder";
import { ViewEmissionManager } from "./view-emission-manager";

describe("BusySessionTracker", () => {
  let onStuck: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let tracker: BusySessionTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    onStuck = vi.fn<(sessionId: string) => void>();
    tracker = new BusySessionTracker(onStuck);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // setBusy / setIdle / isBusy
  // ---------------------------------------------------------------------------

  describe("setBusy / setIdle / isBusy", () => {
    it("starts not busy", () => {
      expect(tracker.isBusy("s1")).toBe(false);
    });

    it("setBusy marks as busy", () => {
      tracker.setBusy("s1");
      expect(tracker.isBusy("s1")).toBe(true);
    });

    it("setBusy arms the stuck timer", () => {
      tracker.setBusy("s1");

      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);

      expect(onStuck).toHaveBeenCalledExactlyOnceWith("s1");
      expect(tracker.isBusy("s1")).toBe(false);
    });

    it("setIdle marks as not busy", () => {
      tracker.setBusy("s1");
      tracker.setIdle("s1");
      expect(tracker.isBusy("s1")).toBe(false);
    });

    it("setIdle is a no-op if not busy", () => {
      tracker.setIdle("s1"); // should not throw
      expect(tracker.isBusy("s1")).toBe(false);
    });

    it("tracks multiple sessions independently", () => {
      tracker.setBusy("s1");
      tracker.setBusy("s2");
      tracker.setIdle("s1");
      expect(tracker.isBusy("s1")).toBe(false);
      expect(tracker.isBusy("s2")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // resetActivityTimer
  // ---------------------------------------------------------------------------

  describe("resetActivityTimer", () => {
    it("does not arm timer if session is not busy", () => {
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });

    it("fires onStuck after STUCK_TIMEOUT_MS when session is busy", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      expect(onStuck).not.toHaveBeenCalled();

      vi.advanceTimersByTime(STUCK_TIMEOUT_MS - 1);
      expect(onStuck).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onStuck).toHaveBeenCalledWith("s1");
    });

    it("removes session from busy set when stuck fires", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(tracker.isBusy("s1")).toBe(false);
    });

    it("resets the timer when called again", () => {
      const half = Math.floor(STUCK_TIMEOUT_MS / 2);
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(half);

      // Reset — timer should restart from 0
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(half);
      expect(onStuck).not.toHaveBeenCalled();

      vi.advanceTimersByTime(STUCK_TIMEOUT_MS - half);
      expect(onStuck).toHaveBeenCalledOnce();
    });

    it("does not fire if session becomes idle before timeout", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(Math.floor(STUCK_TIMEOUT_MS / 2));

      tracker.setIdle("s1"); // clears timer via clearActivityTimer
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clearActivityTimer
  // ---------------------------------------------------------------------------

  describe("clearActivityTimer", () => {
    it("cancels a pending stuck timer", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      tracker.clearActivityTimer("s1");
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });

    it("is a no-op if no timer exists", () => {
      expect(() => tracker.clearActivityTimer("s1")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // cleanupSession
  // ---------------------------------------------------------------------------

  describe("cleanupSession", () => {
    it("clears timer and removes from busy set", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");

      tracker.cleanupSession("s1");

      expect(tracker.isBusy("s1")).toBe(false);
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // setIdle also clears activity timer
  // ---------------------------------------------------------------------------

  describe("setIdle clears activity timer", () => {
    it("prevents stuck callback after setIdle", () => {
      tracker.setBusy("s1");
      tracker.resetActivityTimer("s1");
      vi.advanceTimersByTime(Math.floor(STUCK_TIMEOUT_MS / 3));

      tracker.setIdle("s1");
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clearAll
  // ---------------------------------------------------------------------------

  describe("clearAll", () => {
    it("clears all busy sessions and cancels all timers", () => {
      tracker.setBusy("s1");
      tracker.setBusy("s2");
      tracker.resetActivityTimer("s1");
      tracker.resetActivityTimer("s2");

      tracker.clearAll();

      expect(tracker.isBusy("s1")).toBe(false);
      expect(tracker.isBusy("s2")).toBe(false);
      vi.advanceTimersByTime(STUCK_TIMEOUT_MS);
      expect(onStuck).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: BusyTracker + ViewEmission wiring (mirrors SessionManager ctor)
// ---------------------------------------------------------------------------

describe("onStuck → ViewEmission wiring", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stuck timer fires synthetic turn:idle through ViewEmissionManager", () => {
    const viewEmission = new ViewEmissionManager();
    const eventListener = vi.fn<(sessionId: string, event: { type: string }) => void>();
    viewEmission.addEventListener(eventListener);

    // Wire like SessionManager constructor
    const busyTracker = new BusySessionTracker((sessionId) => {
      const syntheticIdle = { type: "turn:idle" as const };
      viewEmission.emitEvent(sessionId, syntheticIdle);
      viewEmission.updateView(sessionId, syntheticIdle);
    });

    busyTracker.setBusy("s1");
    busyTracker.resetActivityTimer("s1");

    // Advance past STUCK_TIMEOUT_MS
    vi.advanceTimersByTime(STUCK_TIMEOUT_MS);

    // Verify the full chain fired
    expect(busyTracker.isBusy("s1")).toBe(false);
    expect(eventListener).toHaveBeenCalledWith("s1", { type: "turn:idle" });
  });
});

// ---------------------------------------------------------------------------
// onChange transition callback (drives live sidebar refresh for transitive
// subagent spinners)
// ---------------------------------------------------------------------------

describe("onChange transition callback", () => {
  let onStuck: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let onChange: ReturnType<typeof vi.fn<(sessionId: string, busy: boolean) => void>>;
  let tracker: BusySessionTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    onStuck = vi.fn<(sessionId: string) => void>();
    onChange = vi.fn<(sessionId: string, busy: boolean) => void>();
    tracker = new BusySessionTracker(onStuck, onChange);
  });

  afterEach(() => vi.useRealTimers());

  it("fires once on idle→busy and once on busy→idle", () => {
    tracker.setBusy("s1");
    tracker.setIdle("s1");
    expect(onChange.mock.calls).toEqual([
      ["s1", true],
      ["s1", false],
    ]);
  });

  it("does not fire on a duplicate setBusy (re-arm)", () => {
    tracker.setBusy("s1");
    tracker.setBusy("s1");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("s1", true);
  });

  it("does not fire on setIdle for a session that was never busy", () => {
    tracker.setIdle("s1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stuck path: no false→true flicker when onStuck re-arms", () => {
    // onStuck re-arms (tools still running) — mirrors SessionManager's behavior.
    onStuck.mockImplementation((id) => tracker.setBusy(id));
    tracker.setBusy("s1");
    onChange.mockClear(); // ignore the initial idle→busy

    vi.advanceTimersByTime(STUCK_TIMEOUT_MS);

    // Re-armed: stays busy, no spurious busy→idle→busy transitions emitted.
    expect(tracker.isBusy("s1")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stuck path: exactly one onChange(false) when onStuck does not re-arm", () => {
    tracker.setBusy("s1");
    onChange.mockClear(); // ignore the initial idle→busy

    vi.advanceTimersByTime(STUCK_TIMEOUT_MS);

    expect(tracker.isBusy("s1")).toBe(false);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("s1", false);
  });
});
