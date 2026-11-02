import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { SessionViewEvent, TurnEvent } from "../common/marshal-ipc-contract";
import { ViewEmissionManager } from "./view-emission-manager";

type EventListener = (sessionId: string, event: TurnEvent) => void;
type ViewListener = (sessionId: string, event: SessionViewEvent) => void;

describe("ViewEmissionManager", () => {
  let manager: ViewEmissionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ViewEmissionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // addEventListener / emitEvent
  // ---------------------------------------------------------------------------

  describe("addEventListener / emitEvent", () => {
    it("calls registered listener on emitEvent", () => {
      const listener = vi.fn<EventListener>();
      manager.addEventListener(listener);
      const event: TurnEvent = { type: "turn:idle" };
      manager.emitEvent("s1", event);
      expect(listener).toHaveBeenCalledWith("s1", event);
    });

    it("calls multiple listeners", () => {
      const a = vi.fn<EventListener>();
      const b = vi.fn<EventListener>();
      manager.addEventListener(a);
      manager.addEventListener(b);
      manager.emitEvent("s1", { type: "turn:idle" });
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it("unsubscribe removes listener", () => {
      const listener = vi.fn<EventListener>();
      const unsub = manager.addEventListener(listener);
      unsub();
      manager.emitEvent("s1", { type: "turn:idle" });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // addViewEventListener
  // ---------------------------------------------------------------------------

  describe("addViewEventListener", () => {
    it("calls view listener on flush", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      // Push an event and flush
      manager.updateView("s1", { type: "turn:idle" });

      // idle is a state-change → should flush immediately
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toBe("s1");
    });

    it("unsubscribe removes view listener", () => {
      const listener = vi.fn<ViewListener>();
      const unsub = manager.addViewEventListener(listener);
      unsub();

      manager.updateView("s1", { type: "turn:idle" });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Session isolation
  // ---------------------------------------------------------------------------

  describe("session isolation", () => {
    it("maintains separate view state per session", () => {
      // Mark s1 as submitted, s2 untouched
      manager.setSubmitted("s1");
      const v1 = manager.getSessionView("s1");
      const v2 = manager.getSessionView("s2");
      expect(v1.view.status).toBe("submitted");
      expect(v2.view.status).toBe("ready");
    });
  });

  // ---------------------------------------------------------------------------
  // updateView — throttle vs flush
  // ---------------------------------------------------------------------------

  describe("updateView", () => {
    it("flushes immediately for state-changing events (e.g. turn:idle)", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.updateView("s1", { type: "turn:idle" });
      // Should fire immediately without needing timer advance
      expect(listener).toHaveBeenCalledOnce();
    });

    it("throttles streaming deltas", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      // Send a streaming delta — should be scheduled, not immediate
      manager.updateView("s1", { type: "turn:text-delta", delta: "hello" });
      expect(listener).not.toHaveBeenCalled();

      vi.advanceTimersByTime(80);
      expect(listener).toHaveBeenCalledOnce();
    });

    it("does not double-schedule throttled emissions", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.updateView("s1", { type: "turn:text-delta", delta: "a" });
      manager.updateView("s1", { type: "turn:text-delta", delta: "b" });
      // Only one timer — single emission after 80ms
      vi.advanceTimersByTime(80);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // setSubmitted
  // ---------------------------------------------------------------------------

  describe("setSubmitted", () => {
    it("marks session as submitted and flushes view", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.setSubmitted("s1");
      expect(listener).toHaveBeenCalledOnce();
      // The view should reflect submitted status
      const view = manager.getSessionView("s1");
      expect(view.view.status).toBe("submitted");
    });

    it("cancels pending throttle timer when flushing", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      // Schedule a throttled emission
      manager.updateView("s1", { type: "turn:text-delta", delta: "hello" });
      expect(listener).not.toHaveBeenCalled();

      // setSubmitted flushes immediately, cancelling the pending timer
      manager.setSubmitted("s1");
      expect(listener).toHaveBeenCalledOnce();

      // Advancing time should not cause a second emission from the old timer
      vi.advanceTimersByTime(80);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // commitUserMessage
  // ---------------------------------------------------------------------------

  describe("commitUserMessage", () => {
    it("emits a single snapshot carrying both submitted status and the new message", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      const message = {
        id: "m1",
        role: "user" as const,
        content: "hello",
        timestamp: "2026-05-15T00:00:00Z",
      };
      manager.commitUserMessage("s1", { type: "turn:message-committed", message });

      // Atomicity is the load-bearing property: peers must never see the new
      // user bubble under the previous turn's status (e.g. "ready") and then
      // a second snapshot with "submitted". One flush, both pieces of state.
      expect(listener).toHaveBeenCalledOnce();
      const [, event] = listener.mock.calls[0];
      expect(event.view.status).toBe("submitted");
      expect(event.committedMessages).toEqual([message]);
    });

    it("cancels any pending throttled emit before flushing", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.updateView("s1", { type: "turn:text-delta", delta: "..." });
      expect(listener).not.toHaveBeenCalled();

      const message = {
        id: "m1",
        role: "user" as const,
        content: "hello",
        timestamp: "2026-05-15T00:00:00Z",
      };
      manager.commitUserMessage("s1", { type: "turn:message-committed", message });
      expect(listener).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(80);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // emitViewError
  // ---------------------------------------------------------------------------

  describe("emitViewError", () => {
    it("applies error event and flushes view", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.emitViewError("s1", "something went wrong");
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionView
  // ---------------------------------------------------------------------------

  describe("getSessionView", () => {
    it("returns default view for unknown session", () => {
      const result = manager.getSessionView("unknown");
      expect(result.view).toBeDefined();
      expect(result.view.status).toBe("ready");
    });

    it("returns current view for session with state", () => {
      // Create a builder by triggering a view update
      manager.setSubmitted("s1");
      const result = manager.getSessionView("s1");
      expect(result.view).toBeDefined();
      expect(result.view.status).toBe("submitted");
    });
  });

  // ---------------------------------------------------------------------------
  // cleanupSession
  // ---------------------------------------------------------------------------

  describe("cleanupSession", () => {
    it("discards accumulated view state", () => {
      // Accumulate recognizable state: submitted + streaming text
      manager.setSubmitted("s1");
      manager.updateView("s1", { type: "turn:text-delta", delta: "hello world" });
      const before = manager.getSessionView("s1").view;
      expect(before.status).toBe("streaming");
      expect(before.streamingText).toContain("hello world");

      // Cleanup destroys the builder — all accumulated state is gone
      manager.cleanupSession("s1");
      const after = manager.getSessionView("s1").view;
      expect(after.status).toBe("ready");
      expect(after.streamingText).toBe("");

      // Prove it's a fresh builder: new state doesn't carry over from before
      manager.setSubmitted("s1");
      expect(manager.getSessionView("s1").view.status).toBe("submitted");
    });

    it("cancels pending throttle timer", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      manager.updateView("s1", { type: "turn:text-delta", delta: "hello" });
      manager.cleanupSession("s1");

      vi.advanceTimersByTime(80);
      // The old timer was cancelled; no emission
      expect(listener).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown session", () => {
      expect(() => manager.cleanupSession("unknown")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // clearAll
  // ---------------------------------------------------------------------------

  describe("clearAll", () => {
    it("clears all builders and cancels all timers", () => {
      const listener = vi.fn<ViewListener>();
      manager.addViewEventListener(listener);

      // Set up state on two sessions, one with a pending timer
      manager.setSubmitted("s1");
      manager.updateView("s2", { type: "turn:text-delta", delta: "hello" });
      listener.mockClear();

      manager.clearAll();

      // Builders are gone — views return defaults
      expect(manager.getSessionView("s1").view.status).toBe("ready");
      expect(manager.getSessionView("s2").view.status).toBe("ready");

      // Pending timer from s2 is cancelled
      vi.advanceTimersByTime(80);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
